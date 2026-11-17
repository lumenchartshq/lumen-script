import type { DeclarationNode, ExpressionNode, ProgramNode, StatementNode } from "./ast.js";

/**
 * Tracks declaration identity through lexical scopes before type inference.
 * Null bindings intentionally mask outer declarations for parameters, tuples,
 * and loop variables. A new AST kind must explicitly choose its traversal here.
 */
interface MutationScope {
  readonly parent?: MutationScope;
  readonly declarations: Map<string, DeclarationNode | null>;
}

export function findMutatedDeclarations(program: ProgramNode): ReadonlySet<DeclarationNode> {
  const mutated = new Set<DeclarationNode>();
  const root: MutationScope = { declarations: new Map() };
  walkMutationStatements(program.statements, root, mutated);
  for (const statement of program.statements) {
    if (statement.kind !== "function" && statement.kind !== "method") continue;
    const scope = mutationChildScope(root);
    for (const parameter of statement.parameters) scope.declarations.set(parameter.name, null);
    walkMutationStatements(statement.body, scope, mutated);
  }
  return mutated;
}

function walkMutationStatements(
  statements: readonly StatementNode[],
  scope: MutationScope,
  mutated: Set<DeclarationNode>,
): void {
  for (const statement of statements) {
    switch (statement.kind) {
      case "enum":
      case "type":
      case "function":
      case "method":
      case "break":
      case "continue":
        break;
      case "declaration":
        scope.declarations.set(statement.name, statement);
        walkMutationExpression(statement.value, scope, mutated);
        break;
      case "tuple_declaration":
        for (const name of statement.names) if (name !== "_") scope.declarations.set(name, null);
        walkMutationExpression(statement.value, scope, mutated);
        break;
      case "assignment": {
        const declaration = lookupMutationDeclaration(scope, statement.name);
        if (declaration) mutated.add(declaration);
        walkMutationExpression(statement.value, scope, mutated);
        break;
      }
      case "member_assignment":
        walkMutationExpression(statement.object, scope, mutated);
        walkMutationExpression(statement.value, scope, mutated);
        break;
      case "expression":
        walkMutationExpression(statement.expression, scope, mutated);
        break;
      case "if":
        walkMutationExpression(statement.test, scope, mutated);
        walkMutationStatements(statement.consequent, mutationChildScope(scope), mutated);
        walkMutationStatements(statement.alternate, mutationChildScope(scope), mutated);
        break;
      case "once":
        walkMutationExpression(statement.test, scope, mutated);
        walkMutationStatements(statement.body, mutationChildScope(scope), mutated);
        break;
      case "while":
        walkMutationExpression(statement.test, scope, mutated);
        walkMutationStatements(statement.body, mutationChildScope(scope), mutated);
        break;
      case "for": {
        walkMutationExpression(statement.start, scope, mutated);
        walkMutationExpression(statement.end, scope, mutated);
        if (statement.step) walkMutationExpression(statement.step, scope, mutated);
        const loop = mutationChildScope(scope);
        loop.declarations.set(statement.variable, null);
        walkMutationStatements(statement.body, loop, mutated);
        break;
      }
      case "for_in": {
        walkMutationExpression(statement.collection, scope, mutated);
        const loop = mutationChildScope(scope);
        for (const name of statement.variables) loop.declarations.set(name, null);
        walkMutationStatements(statement.body, loop, mutated);
        break;
      }
      default:
        assertNever(statement);
    }
  }
}

function walkMutationExpression(
  node: ExpressionNode,
  scope: MutationScope,
  mutated: Set<DeclarationNode>,
): void {
  switch (node.kind) {
    case "literal":
    case "identifier":
      break;
    case "member":
      walkMutationExpression(node.object, scope, mutated);
      break;
    case "call":
      walkMutationExpression(node.callee, scope, mutated);
      for (const argument of node.arguments) walkMutationExpression(argument.value, scope, mutated);
      break;
    case "history":
      walkMutationExpression(node.value, scope, mutated);
      walkMutationExpression(node.offset, scope, mutated);
      break;
    case "unary":
      walkMutationExpression(node.argument, scope, mutated);
      break;
    case "binary":
      walkMutationExpression(node.left, scope, mutated);
      walkMutationExpression(node.right, scope, mutated);
      break;
    case "conditional":
      walkMutationExpression(node.test, scope, mutated);
      walkMutationExpression(node.consequent, scope, mutated);
      walkMutationExpression(node.alternate, scope, mutated);
      break;
    case "tuple":
      for (const element of node.elements) walkMutationExpression(element, scope, mutated);
      break;
    case "if_expression":
      walkMutationExpression(node.test, scope, mutated);
      walkMutationStatements(node.consequent, mutationChildScope(scope), mutated);
      walkMutationStatements(node.alternate, mutationChildScope(scope), mutated);
      break;
    case "while_expression":
      walkMutationExpression(node.test, scope, mutated);
      walkMutationStatements(node.body, mutationChildScope(scope), mutated);
      break;
    case "for_expression": {
      walkMutationExpression(node.start, scope, mutated);
      walkMutationExpression(node.end, scope, mutated);
      if (node.step) walkMutationExpression(node.step, scope, mutated);
      const loop = mutationChildScope(scope);
      loop.declarations.set(node.variable, null);
      walkMutationStatements(node.body, loop, mutated);
      break;
    }
    case "for_in_expression": {
      walkMutationExpression(node.collection, scope, mutated);
      const loop = mutationChildScope(scope);
      for (const name of node.variables) loop.declarations.set(name, null);
      walkMutationStatements(node.body, loop, mutated);
      break;
    }
    case "switch":
      if (node.discriminant) walkMutationExpression(node.discriminant, scope, mutated);
      for (const entry of node.cases) {
        if (entry.test) walkMutationExpression(entry.test, scope, mutated);
        walkMutationStatements(entry.body, mutationChildScope(scope), mutated);
      }
      break;
    default:
      assertNever(node);
  }
}

function mutationChildScope(parent: MutationScope): MutationScope {
  return { parent, declarations: new Map() };
}

function lookupMutationDeclaration(scope: MutationScope, name: string): DeclarationNode | null | undefined {
  for (let current: MutationScope | undefined = scope; current; current = current.parent) {
    if (current.declarations.has(name)) return current.declarations.get(name);
  }
  return undefined;
}

function assertNever(node: never): never {
  throw new Error(`Unsupported AST kind in mutation analysis: ${JSON.stringify(node)}`);
}
