import type { CallNode, ExpressionNode, ProgramNode, StatementNode } from "./ast.js";

/** Sealed 0.9.31 discovery; production uses the exhaustive AST walker. */
export function collectLegacyCallNodes(program: ProgramNode): CallNode[] {
  const calls: CallNode[] = [];
  const expression = (node: ExpressionNode): void => {
    if (node.kind === "call") {
      calls.push(node);
      expression(node.callee);
      for (const argument of node.arguments) expression(argument.value);
    } else if (node.kind === "member") expression(node.object);
    else if (node.kind === "history") { expression(node.value); expression(node.offset); }
    else if (node.kind === "unary") expression(node.argument);
    else if (node.kind === "binary") { expression(node.left); expression(node.right); }
    else if (node.kind === "conditional") { expression(node.test); expression(node.consequent); expression(node.alternate); }
    else if (node.kind === "if_expression") { expression(node.test); statements(node.consequent); statements(node.alternate); }
    else if (node.kind === "while_expression") { expression(node.test); statements(node.body); }
    else if (node.kind === "for_expression") { expression(node.start); expression(node.end); if (node.step !== undefined) expression(node.step); statements(node.body); }
    else if (node.kind === "for_in_expression") { expression(node.collection); statements(node.body); }
    else if (node.kind === "switch") { if (node.discriminant !== undefined) expression(node.discriminant); for (const entry of node.cases) { if (entry.test !== undefined) expression(entry.test); statements(entry.body); } }
    else if (node.kind === "tuple") for (const element of node.elements) expression(element);
  };
  const statement = (node: StatementNode): void => {
    if (node.kind === "declaration" || node.kind === "assignment" || node.kind === "tuple_declaration") expression(node.value);
    else if (node.kind === "expression") expression(node.expression);
    else if (node.kind === "function" || node.kind === "method") statements(node.body);
    else if (node.kind === "if") { expression(node.test); statements(node.consequent); statements(node.alternate); }
    else if (node.kind === "while") { expression(node.test); statements(node.body); }
    else if (node.kind === "for") { expression(node.start); expression(node.end); if (node.step !== undefined) expression(node.step); statements(node.body); }
    else if (node.kind === "for_in") { expression(node.collection); statements(node.body); }
  };
  const statements = (nodes: readonly StatementNode[]): void => { for (const node of nodes) statement(node); };
  statements(program.statements);
  return calls;
}
