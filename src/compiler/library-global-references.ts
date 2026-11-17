import type { ExpressionNode, FunctionDeclarationNode, IdentifierNode, MethodDeclarationNode, StatementNode } from "./ast.js";

type Callable = FunctionDeclarationNode | MethodDeclarationNode;

/** Find global references by lexical ownership, including expression blocks. */
export function libraryGlobalReferences(callable: Callable, globals: ReadonlySet<string>): readonly IdentifierNode[] {
  const references: IdentifierNode[] = [];
  const reference = (name: string, range: IdentifierNode["range"], locals: ReadonlySet<string>) => {
    if (globals.has(name) && !locals.has(name)) references.push({ kind: "identifier", name, range });
  };
  const expression = (node: ExpressionNode, locals: ReadonlySet<string>): void => {
    switch (node.kind) {
      case "literal": return;
      case "identifier": reference(node.name, node.range, locals); return;
      case "member": expression(node.object, locals); return;
      case "call":
        expression(node.callee, locals);
        for (const argument of node.arguments) expression(argument.value, locals);
        return;
      case "history": expression(node.value, locals); expression(node.offset, locals); return;
      case "unary": expression(node.argument, locals); return;
      case "binary": expression(node.left, locals); expression(node.right, locals); return;
      case "conditional":
        expression(node.test, locals);
        expression(node.consequent, locals);
        expression(node.alternate, locals);
        return;
      case "tuple": for (const element of node.elements) expression(element, locals); return;
      case "if_expression":
        expression(node.test, locals);
        statements(node.consequent, new Set(locals));
        statements(node.alternate, new Set(locals));
        return;
      case "while_expression":
        expression(node.test, locals);
        statements(node.body, new Set(locals));
        return;
      case "for_expression": case "for_in_expression": loop(node, locals); return;
      case "switch":
        if (node.discriminant) expression(node.discriminant, locals);
        for (const branch of node.cases) {
          if (branch.test) expression(branch.test, locals);
          statements(branch.body, new Set(locals));
        }
        return;
      default: return assertNever(node);
    }
  };
  const loop = (node: Extract<StatementNode | ExpressionNode, { kind: "for" | "for_in" | "for_expression" | "for_in_expression" }>, locals: ReadonlySet<string>) => {
    const inside = new Set(locals);
    if (node.kind === "for" || node.kind === "for_expression") {
      expression(node.start, locals);
      expression(node.end, locals);
      if (node.step) expression(node.step, locals);
      inside.add(node.variable);
    } else {
      expression(node.collection, locals);
      for (const name of node.variables) inside.add(name);
    }
    statements(node.body, inside);
  };
  const statements = (body: readonly StatementNode[], locals: Set<string>): void => {
    for (const node of body) {
      switch (node.kind) {
        case "enum": case "type": case "function": case "method": case "break": case "continue": break;
        case "declaration": expression(node.value, locals); locals.add(node.name); break;
        case "tuple_declaration":
          expression(node.value, locals);
          for (const name of node.names) if (name !== "_") locals.add(name);
          break;
        case "assignment":
          reference(node.name, node.range, locals);
          expression(node.value, locals);
          break;
        case "member_assignment": expression(node.object, locals); expression(node.value, locals); break;
        case "expression": expression(node.expression, locals); break;
        case "if":
          expression(node.test, locals);
          statements(node.consequent, new Set(locals));
          statements(node.alternate, new Set(locals));
          break;
        case "once": expression(node.test, locals); statements(node.body, new Set(locals)); break;
        case "while": expression(node.test, locals); statements(node.body, new Set(locals)); break;
        case "for": case "for_in": loop(node, locals); break;
        default: assertNever(node);
      }
    }
  };
  const locals = new Set(callable.parameters.map((parameter) => parameter.name));
  for (const parameter of callable.parameters) if (parameter.defaultValue) expression(parameter.defaultValue, locals);
  statements(callable.body, locals);
  return references;
}

function assertNever(node: never): never {
  throw new Error(`Unsupported AST kind in library capture analysis: ${JSON.stringify(node)}`);
}
