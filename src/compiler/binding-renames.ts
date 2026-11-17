import { isPineShadowingNamespaceConstant, type SourceRange, PINE_COMPATIBILITY } from "../contracts/index.js";
import type { ExpressionNode, StatementNode } from "./ast.js";
import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { bindProgram } from "./semantic-binder.js";

export function pineGlobalBindings(source: string): readonly { name: string; kind: StatementNode["kind"] }[] {
  const program = parse(source, /^\s*\/\/@version\s*=\s*5\s*$/mu.test(source) ? 5 : 6, PINE_COMPATIBILITY.strict);
  return program.statements.flatMap<{ name: string; kind: StatementNode["kind"] }>((node) => {
    if (node.kind === "tuple_declaration") return node.names.filter((name) => name !== "_").map((name) => ({ name, kind: node.kind }));
    if (["declaration", "function", "method", "type", "enum"].includes(node.kind) && "name" in node) return [{ name: node.name, kind: node.kind }];
    return [];
  });
}

export interface PineBindingRename { readonly name: string; readonly replacement: string }

/** Rename module globals by lexical ownership, leaving field/argument names intact. */
export function renamePineBindings(source: string, renames: readonly PineBindingRename[], namespace?: { name: string; resolve: (member: string) => string }): string {
  const names = new Map(renames.map((entry) => [entry.name, entry.replacement]));
  const version = /^\s*\/\/@version\s*=\s*5\s*$/mu.test(source) ? 5 : 6;
  const program = parse(source, version, PINE_COMPATIBILITY.strict);
  const methodSemantic = program.statements.some((node) => node.kind === "method" && names.has(node.name))
    ? bindProgram(program, PINE_COMPATIBILITY.strict) : undefined;
  const tokens = lex(source, PINE_COMPATIBILITY.strict);
  const edits = new Map<number, { end: number; value: string }>();
  const within = (range: SourceRange, end = range.end.offset) => {
    let low = 0;
    let high = tokens.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tokens[middle]!.range.start.offset < range.start.offset) low = middle + 1;
      else high = middle;
    }
    const selected = [];
    for (let index = low; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.range.start.offset >= end) break;
      selected.push(token);
    }
    return selected;
  };
  const edit = (name: string, range: SourceRange, locals: ReadonlySet<string>) => {
    const value = names.get(name);
    if (value !== undefined && !locals.has(name)) edits.set(range.start.offset, { end: range.end.offset, value });
  };
  const qualified = (items: ReturnType<typeof within>, limit = items.length) => {
    if (!namespace) return;
    for (let index = 0; index < limit - 2; index += 1) {
      const alias = items[index]!;
      const member = items[index + 2]!;
      if (alias.value !== namespace.name || items[index + 1]?.value !== "." || member.kind !== "identifier") continue;
      edits.set(alias.range.start.offset, { end: member.range.end.offset, value: namespace.resolve(member.value) });
      index += 2;
    }
  };
  const header = (name: string, range: SourceRange, end: number, renameName: boolean) => {
    const all = within(range, end);
    qualified(all);
    const items = all.filter((token) => token.kind === "identifier");
    let declaration = -1;
    for (const [index, token] of items.entries()) if (token.value === name) declaration = index;
    for (const [index, token] of items.entries()) {
      if (index < declaration || (index === declaration && renameName)) edit(token.value, token.range, new Set());
    }
  };
  const expression = (node: ExpressionNode, locals: ReadonlySet<string>): void => {
    switch (node.kind) {
      case "literal": return;
      case "identifier": edit(node.name, node.range, locals); return;
      case "member": {
        if (namespace && node.object.kind === "identifier" && node.object.name === namespace.name && !locals.has(namespace.name)) {
          edits.set(node.range.start.offset, { end: node.range.end.offset, value: namespace.resolve(node.property) });
          return;
        }
        const name = memberName(node);
        if (name && isPineShadowingNamespaceConstant(name)) return;
        expression(node.object, locals);
        return;
      }
      case "call": {
        const method = methodSemantic?.methodBindings.get(node);
        if (method !== undefined && node.callee.kind === "member") {
          if (names.has(method.name) && methodSemantic?.methodCandidates.get(node)?.has(undefined)) throw new Error(`Polymorphic builtin and user method '${method.name}' cannot be linked safely`);
          const methodName = node.callee.property;
          const property = within(node.callee.range).reverse().find((token) => token.value === methodName);
          if (property) edit(method.name, property.range, new Set());
        }
        expression(node.callee, locals);
        if (node.callee.kind === "member" && node.callee.typeArguments) {
          const callTokens = within(node.range);
          const open = callTokens.findIndex((token) => token.value === "(");
          qualified(callTokens, open < 0 ? callTokens.length : open);
          let generic = false;
          for (const token of within(node.range)) {
            if (token.value === "(") break;
            if (token.value === "<") generic = true;
            else if (generic && token.kind === "identifier") edit(token.value, token.range, new Set());
          }
        }
        for (const arg of node.arguments) expression(arg.value, locals);
        return;
      }
      case "history": expression(node.value, locals); expression(node.offset, locals); return;
      case "unary": expression(node.argument, locals); return;
      case "binary": expression(node.left, locals); expression(node.right, locals); return;
      case "conditional": expression(node.test, locals); expression(node.consequent, locals); expression(node.alternate, locals); return;
      case "tuple": for (const element of node.elements) expression(element, locals); return;
      case "if_expression": expression(node.test, locals); block(node.consequent, locals); block(node.alternate, locals); return;
      case "switch":
        if (node.discriminant) expression(node.discriminant, locals);
        for (const branch of node.cases) { if (branch.test) expression(branch.test, locals); block(branch.body, locals); }
        return;
      case "for_expression": case "for_in_expression": case "while_expression": loop(node, locals); return;
    }
  };
  const loop = (node: Extract<StatementNode | ExpressionNode, { kind: "for" | "for_in" | "while" | "for_expression" | "for_in_expression" | "while_expression" }>, locals: ReadonlySet<string>) => {
    const scope = new Set(locals);
    if (node.kind === "for" || node.kind === "for_expression") {
      expression(node.start, locals); expression(node.end, locals);
      if (node.step) expression(node.step, locals);
      scope.add(node.variable);
    } else if (node.kind === "for_in" || node.kind === "for_in_expression") {
      expression(node.collection, locals);
      for (const name of node.variables) scope.add(name);
    } else expression(node.test, locals);
    block(node.body, scope);
  };
  const block = (statements: readonly StatementNode[], outer: ReadonlySet<string>, global = false): void => {
    const locals = new Set(outer);
    for (const node of statements) {
      switch (node.kind) {
        case "declaration":
          expression(node.value, locals);
          header(node.name, node.range, node.value.range.start.offset, global);
          if (!global || namespace) locals.add(node.name);
          break;
        case "tuple_declaration":
          expression(node.value, locals);
          for (const token of within(node.range, node.value.range.start.offset)) {
            if (global && token.kind === "identifier" && node.names.includes(token.value)) edit(token.value, token.range, new Set());
          }
          if (!global || namespace) for (const name of node.names) locals.add(name);
          break;
        case "assignment": {
          const target = within(node.range).find((token) => token.value === node.name);
          if (target) edit(node.name, target.range, locals);
          expression(node.value, locals); break;
        }
        case "member_assignment": expression(node.object, locals); expression(node.value, locals); break;
        case "expression": expression(node.expression, locals); break;
        case "if": expression(node.test, locals); block(node.consequent, locals); block(node.alternate, locals); break;
        case "for": case "for_in": case "while": loop(node, locals); break;
        case "function": case "method": {
          const name = within(node.range).find((token) => token.value === node.name);
          if (name && global) edit(node.name, name.range, new Set());
          for (const parameter of node.parameters) {
            header(parameter.name, parameter.range, parameter.defaultValue?.range.start.offset ?? parameter.range.end.offset, false);
            if (parameter.defaultValue) expression(parameter.defaultValue, new Set());
          }
          block(node.body, new Set([...locals, ...node.parameters.map((parameter) => parameter.name)]));
          break;
        }
        case "type": {
          const name = within(node.range).find((token) => token.value === node.name);
          if (name) edit(node.name, name.range, new Set());
          for (const field of node.fields) {
            header(field.name, field.range, field.defaultValue?.range.start.offset ?? field.range.end.offset, false);
            if (field.defaultValue) expression(field.defaultValue, locals);
          }
          break;
        }
        case "enum": {
          const name = within(node.range).find((token) => token.value === node.name);
          if (name) edit(node.name, name.range, new Set());
          break;
        }
        case "break": case "continue": break;
      }
    }
  };
  block(program.statements, new Set(), true);
  let result = source;
  for (const [start, { end, value }] of [...edits].sort(([left], [right]) => right - left)) result = result.slice(0, start) + value + result.slice(end);
  return result;
}

function memberName(node: ExpressionNode): string | undefined {
  if (node.kind === "identifier") return node.name;
  if (node.kind !== "member") return undefined;
  const root = memberName(node.object);
  return root === undefined ? undefined : `${root}.${node.property}`;
}
