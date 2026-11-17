import type { CallNode, ExpressionNode, ProgramNode, StatementNode } from "./ast.js";

type AstNode = StatementNode | ExpressionNode;

/** Exhaustive source-order traversal, independent of binding and scope policy. */
export function walkPineAst(program: ProgramNode, visit: (node: AstNode) => void): void {
  const pending: AstNode[] = [...program.statements].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    visit(node);
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
  }
}

export function collectCallNodes(program: ProgramNode): CallNode[] {
  const calls: CallNode[] = [];
  walkPineAst(program, (node) => { if (node.kind === "call") calls.push(node); });
  return calls;
}

function childNodes(node: AstNode): readonly AstNode[] {
  switch (node.kind) {
    case "literal": case "identifier": case "enum": case "break": case "continue": return [];
    case "declaration": case "assignment": case "tuple_declaration": return [node.value];
    case "member_assignment": return [node.object, node.value];
    case "expression": return [node.expression];
    case "type": return node.fields.flatMap((field) => field.defaultValue === undefined ? [] : [field.defaultValue]);
    case "function": case "method": return [...node.parameters.flatMap((parameter) => parameter.defaultValue === undefined ? [] : [parameter.defaultValue]), ...node.body];
    case "if": case "if_expression": return [node.test, ...node.consequent, ...node.alternate];
    case "once": case "while": case "while_expression": return [node.test, ...node.body];
    case "for": case "for_expression": return [node.start, node.end, ...(node.step === undefined ? [] : [node.step]), ...node.body];
    case "for_in": case "for_in_expression": return [node.collection, ...node.body];
    case "call": return [node.callee, ...node.arguments.map((argument) => argument.value)];
    case "member": return [node.object];
    case "history": return [node.value, node.offset];
    case "unary": return [node.argument];
    case "binary": return [node.left, node.right];
    case "conditional": return [node.test, node.consequent, node.alternate];
    case "tuple": return node.elements;
    case "switch": return [...(node.discriminant === undefined ? [] : [node.discriminant]), ...node.cases.flatMap((entry) => [...(entry.test === undefined ? [] : [entry.test]), ...entry.body])];
    default: return exhaustiveNode(node);
  }
}

function exhaustiveNode(value: never): never {
  throw new Error(`Unsupported AST kind in traversal: ${String(value)}`);
}
