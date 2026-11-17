import type { CallNode, ExpressionNode, ProgramNode } from "./ast.js";
import { findMutatedDeclarations } from "./declaration-mutations.js";
import { walkPineAst } from "./ast-walk.js";
import { boundBuiltinArguments, staticCallableName } from "./call-analysis.js";
import { evaluateConstant, type ConstantValue } from "./constant-evaluator.js";
import type { PineSemanticModel } from "./semantic-binder.js";

/** Fold immutable globals; never substitute a same-named local or input default. */
export function requestOptionResolver(program: ProgramNode, call: CallNode, semantic: PineSemanticModel): (node: ExpressionNode | undefined) => ExpressionNode | undefined {
  const values = new Map<string, ConstantValue>();
  const mutated = findMutatedDeclarations(program);
  const locals = new Set<string>();
  const container = program.statements.find((node) => node.range.start.offset <= call.range.start.offset && node.range.end.offset >= call.range.end.offset);
  if (container) walkPineAst({ ...program, statements: [container] }, (node) => {
    if (node === container || node.range.start.offset >= call.range.start.offset) return;
    if (node.kind === "declaration" || node.kind === "assignment") locals.add(node.name);
    if (node.kind === "tuple_declaration") for (const name of node.names) locals.add(name);
    if (node.kind === "for" || node.kind === "for_expression") locals.add(node.variable);
    if (node.kind === "for_in" || node.kind === "for_in_expression") for (const name of node.variables) locals.add(name);
  });
  if (container?.kind === "function" || container?.kind === "method") for (const parameter of container.parameters) locals.add(parameter.name);
  const context = {
    identifier: (name: string) => locals.has(name) ? undefined : values.get(name),
    member: (node: ExpressionNode): ConstantValue | undefined => {
      const name = staticCallableName(node);
      return ["barmerge.gaps_on", "barmerge.gaps_off", "barmerge.lookahead_on", "barmerge.lookahead_off", "currency.NONE"].includes(name) ? name : undefined;
    },
    arguments: (node: CallNode) => boundBuiltinArguments(node, semantic),
    integerDivision: (node: ExpressionNode) => program.version === 5 && semantic.typeOf(node).kind === "int",
  };
  for (const node of program.statements) {
    if (node.range.start.offset >= call.range.start.offset) break;
    if (node.kind !== "declaration" || mutated.has(node)) continue;
    const value = evaluateConstant(node.value, context);
    if (value !== undefined) values.set(node.name, value);
  }
  return (node) => {
    if (node === undefined) return undefined;
    const value = evaluateConstant(node, context);
    return value === undefined ? node : { kind: "literal", value, range: node.range };
  };
}
