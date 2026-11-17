import type { ProgramNode, StatementNode } from "./ast.js";
import { walkPineAst } from "./ast-walk.js";
import { staticCallableName } from "./call-analysis.js";

/** Select the global dataflow needed in a requested context, not earlier plots. */
export function requestChildDependencies(program: ProgramNode, candidates: readonly StatementNode[], roots: readonly StatementNode[]): readonly StatementNode[] {
  const definitions = new Map<string, StatementNode>();
  for (const statement of candidates) for (const name of declaredNames(statement)) definitions.set(name, statement);
  const reads = (statement: StatementNode): Set<string> => {
    const names = new Set<string>();
    walkPineAst({ version: program.version, statements: [statement] }, (node) => {
      if (node.kind === "identifier" && definitions.has(node.name)) names.add(node.name);
      if (node.kind === "call" && node.callee.kind === "member" && definitions.has(node.callee.property)) names.add(node.callee.property);
    });
    return names;
  };
  const references = new Map(candidates.map((statement) => [statement, reads(statement)]));
  const expandedReads = (names: ReadonlySet<string>): Set<string> => {
    const expanded = new Set(names);
    const pending = [...names];
    while (pending.length > 0) {
      const definition = definitions.get(pending.pop()!);
      if (definition === undefined) continue;
      for (const name of references.get(definition) ?? []) {
        if (expanded.has(name)) continue;
        expanded.add(name);
        pending.push(name);
      }
    }
    return expanded;
  };
  const needed = new Set(roots.flatMap((root) => [...reads(root)]));
  const selected = new Set<StatementNode>();
  const touchesNeeded = (statement: StatementNode): boolean => {
    let touches = false;
    walkPineAst({ version: program.version, statements: [statement] }, (node) => {
      if (node.kind === "assignment" && needed.has(node.name)) touches = true;
      if (node.kind === "member_assignment" && [...reads({ kind: "expression", expression: node.object, range: node.object.range })].some((name) => needed.has(name))) touches = true;
      if (node.kind !== "call") return;
      const name = staticCallableName(node.callee);
      // Request/plot/TA calls do not mutate parent bindings. Collection/receiver
      // calls and user callables can mutate objects needed by the expression.
      const callable = definitions.get(name);
      const receiver = node.callee.kind === "member" && node.callee.object.kind === "identifier" ? node.callee.object.name : undefined;
      const mayMutate = /^(?:array|map|matrix)\./u.test(name) || (receiver !== undefined && definitions.has(receiver)) || callable?.kind === "function" || callable?.kind === "method";
      if (!mayMutate) return;
      const callReads = expandedReads(reads({ kind: "expression", expression: node, range: node.range }));
      if ([...callReads].some((entry) => needed.has(entry))) touches = true;
      if (callable !== undefined && [...expandedReads(references.get(callable) ?? new Set())].some((entry) => needed.has(entry))) touches = true;
    });
    return touches;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of candidates) {
      if (selected.has(statement)) continue;
      const definitionNeeded = declaredNames(statement).some((name) => needed.has(name));
      const typeDeclaration = statement.kind === "type" || statement.kind === "enum";
      // An uncalled function's body must not cause its request calls to preload.
      const callable = statement.kind === "function" || statement.kind === "method";
      if (!definitionNeeded && !typeDeclaration && (callable || !touchesNeeded(statement))) continue;
      selected.add(statement);
      for (const name of references.get(statement) ?? []) needed.add(name);
      changed = true;
    }
  }
  return candidates.filter((statement) => selected.has(statement));
}

function declaredNames(statement: StatementNode): readonly string[] {
  if (statement.kind === "tuple_declaration") return statement.names;
  if (["declaration", "function", "method", "type", "enum"].includes(statement.kind) && "name" in statement) return [statement.name];
  return [];
}
