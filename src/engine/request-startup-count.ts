import type { CompiledRequestPlan, ExpressionNode } from "../compiler/index.js";
import type { PineValue, SessionOptions } from "../contracts/index.js";
import { PineRuntimeError } from "../runtime/index.js";
import { evaluateStartupProgram } from "./evaluate-startup-program.js";

type Scalar = string | number | boolean;

/** Resolve a simple count once from admitted session inputs and chart metadata. */
export function requestStartupCount(plan: CompiledRequestPlan, options: SessionOptions, inputs: Readonly<Record<string, PineValue>>): number | undefined {
  if (plan.startupProgram !== undefined) return evaluateStartupProgram(plan.startupProgram, options, inputs);
  const startup = plan.startupCount;
  if (startup === undefined) return plan.calcBarsCount;
  let remaining = 256;
  const visiting = new Set<string>();
  const evaluate = (node: ExpressionNode, depth = 0, parameters: ReadonlyMap<string, Scalar> = new Map()): Scalar | undefined => {
    if (--remaining < 0 || depth > 32) return undefined;
    const next = (child: ExpressionNode): Scalar | undefined => evaluate(child, depth + 1, parameters);
    if (node.kind === "literal") return node.value ?? undefined;
    if (node.kind === "identifier") {
      if (parameters.has(node.name)) return parameters.get(node.name);
      if (visiting.has(node.name)) return undefined;
      const definition = startup.declarations[node.name];
      if (definition === undefined) return undefined;
      visiting.add(node.name);
      const value = next(definition);
      visiting.delete(node.name);
      return value;
    }
    if (node.kind === "member" && node.object.kind === "identifier") {
      if (node.object.name === "timeframe") return options.timeframe ?? "";
      if (node.object.name === "syminfo") {
        const value = options.symbolInfo?.[node.property];
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
      }
    }
    if (node.kind === "unary") {
      const value = next(node.argument);
      if (node.operator === "not") return typeof value === "boolean" ? !value : undefined;
      return typeof value === "number" ? node.operator === "-" ? -value : value : undefined;
    }
    if (node.kind === "conditional") {
      const test = next(node.test);
      return typeof test === "boolean" ? next(test ? node.consequent : node.alternate) : undefined;
    }
    if (node.kind === "binary") {
      const left = next(node.left);
      if (node.operator === "and" && left === false) return false;
      if (node.operator === "or" && left === true) return true;
      const right = next(node.right);
      if (left === undefined || right === undefined) return undefined;
      if (node.operator === "==") return left === right;
      if (node.operator === "!=") return left !== right;
      if (typeof left === "boolean" && typeof right === "boolean") {
        if (node.operator === "and") return left && right;
        if (node.operator === "or") return left || right;
      }
      if (typeof left !== "number" || typeof right !== "number") return undefined;
      switch (node.operator) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
      }
    }
    if (node.kind !== "call") return undefined;
    const name = node.callee.kind === "identifier" ? node.callee.name
      : node.callee.kind === "member" && node.callee.object.kind === "identifier" ? `${node.callee.object.name}.${node.callee.property}` : "";
    if (name === "input.int") {
      const id = startup.inputIds[node.range.start.offset];
      if (id === undefined) return undefined;
      const titleNode = node.arguments.find((argument) => argument.name === "title")?.value ?? node.arguments[1]?.value;
      const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : undefined;
      const override = Object.hasOwn(inputs, id) ? inputs[id] : title === undefined ? undefined : inputs[title];
      if (override !== undefined) return typeof override === "number" ? override : undefined;
      const defaultNode = node.arguments.find((argument) => argument.name === "defval")?.value ?? node.arguments[0]?.value;
      return defaultNode === undefined ? undefined : next(defaultNode);
    }
    const userFunction = startup.functions[name];
    if (userFunction !== undefined) {
      const values = userFunction.parameters.map((parameter, index) => {
        const argument = node.arguments.find((entry) => entry.name === parameter)?.value
          ?? node.arguments.filter((entry) => entry.name === undefined)[index]?.value;
        return argument === undefined ? undefined : next(argument);
      });
      if (values.some((value) => value === undefined)) return undefined;
      return evaluate(userFunction.expression, depth + 1, new Map(userFunction.parameters.map((parameter, index) => [parameter, values[index]!] as const)));
    }
    const values = node.arguments.map((argument) => next(argument.value));
    if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return undefined;
    const first = values[0];
    if (first === undefined) return undefined;
    switch (name) {
      case "int": return Math.trunc(first);
      case "float": return first;
      case "math.abs": return Math.abs(first);
      case "math.sign": return Math.sign(first);
      case "math.floor": return Math.floor(first);
      case "math.ceil": return Math.ceil(first);
      case "math.min": return Math.min(...values);
      case "math.max": return Math.max(...values);
    }
    return undefined;
  };
  const callerValues = new Map<string, Scalar>();
  for (const [name, expression] of Object.entries(startup.callerBindings)) {
    const value = evaluate(expression);
    if (value === undefined) throw new PineRuntimeError("Request calc_bars_count could not resolve a simple caller argument", "request.security", startup.range);
    callerValues.set(name, value);
  }
  for (const [name, expression] of Object.entries(startup.localBindings)) {
    const value = evaluate(expression, 0, callerValues);
    if (value === undefined) throw new PineRuntimeError("Request calc_bars_count could not resolve a simple local binding", "request.security", startup.range);
    callerValues.set(name, value);
  }
  const value = evaluate(startup.expression, 0, callerValues);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PineRuntimeError("Request calc_bars_count must resolve to a nonnegative simple int", "request.security", startup.range);
  }
  return value === 0 ? undefined : value;
}
