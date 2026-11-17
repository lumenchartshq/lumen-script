import type { CallNode, ExpressionNode } from "./ast.js";

export type ConstantValue = string | number | boolean;
export interface ConstantEvaluationContext {
  identifier(name: string): ConstantValue | undefined;
  member?(node: ExpressionNode): ConstantValue | undefined;
  arguments(node: CallNode): readonly (ExpressionNode | undefined)[];
  integerDivision(node: ExpressionNode): boolean;
}

/** Bounded, side-effect-free folding. Unknown calls never execute user code. */
export function evaluateConstant(node: ExpressionNode, context: ConstantEvaluationContext): ConstantValue | undefined {
  let remaining = 4096;
  const visit = (value: ExpressionNode | undefined, depth = 0): ConstantValue | undefined => {
    if (!value || --remaining < 0 || depth > 128) return undefined;
    const next = (child: ExpressionNode | undefined) => visit(child, depth + 1);
    if (value.kind === "literal") return value.value ?? undefined;
    if (value.kind === "identifier") return context.identifier(value.name);
    if (value.kind === "member") return context.member?.(value);
    if (value.kind === "conditional") {
      const condition = next(value.test);
      return typeof condition === "boolean" ? next(condition ? value.consequent : value.alternate) : undefined;
    }
    if (value.kind === "unary") {
      const argument = next(value.argument);
      if (value.operator === "not" && typeof argument === "boolean") return !argument;
      if (typeof argument === "number") return value.operator === "-" ? -argument : argument;
      return undefined;
    }
    if (value.kind === "binary") {
      const left = next(value.left);
      if (value.operator === "and" && left === false) return false;
      if (value.operator === "or" && left === true) return true;
      const right = next(value.right);
      if (left === undefined || right === undefined) return undefined;
      if (value.operator === "==") return left === right;
      if (value.operator === "!=") return left !== right;
      if (value.operator === "+" && typeof left === "string" && typeof right === "string") return left.length + right.length <= 100_000 ? left + right : undefined;
      if (typeof left === "boolean" && typeof right === "boolean") {
        if (value.operator === "and") return left && right;
        if (value.operator === "or") return left || right;
      }
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      switch (value.operator) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return context.integerDivision(value) ? Math.trunc(left / right) : left / right;
        case "%": return left % right;
        case "<": return left < right;
        case ">": return left > right;
        case "<=": return left <= right;
        case ">=": return left >= right;
      }
    }
    if (value.kind === "call") {
      const callee = value.callee;
      const name = callee.kind === "identifier" ? callee.name
        : callee.kind === "member" && callee.object.kind === "identifier" ? `${callee.object.name}.${callee.property}` : undefined;
      if (name === undefined) return undefined;
      const args = context.arguments(value).map(next);
      const first = args[0];
      if (typeof first === "string" && first.length <= 100_000) {
        if (name === "str.lower") return first.replace(/[A-Z]/gu, (character) => character.toLowerCase());
        if (name === "str.upper") return first.replace(/[a-z]/gu, (character) => character.toUpperCase());
        if (name === "str.trim") return first.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
        if (name === "str.length") return Array.from(first).length;
      }
      if (typeof first !== "number" || !Number.isFinite(first)) return undefined;
      switch (name) {
        case "int": return Math.trunc(first);
        case "float": return first;
        case "math.abs": return Math.abs(first);
        case "math.sign": return Math.sign(first);
        case "math.floor": return Math.floor(first);
        case "math.ceil": return Math.ceil(first);
        case "math.min": return args.every((arg) => typeof arg === "number" && Number.isFinite(arg)) ? Math.min(...args as number[]) : undefined;
        case "math.max": return args.every((arg) => typeof arg === "number" && Number.isFinite(arg)) ? Math.max(...args as number[]) : undefined;
      }
    }
    return undefined;
  };
  return visit(node);
}
