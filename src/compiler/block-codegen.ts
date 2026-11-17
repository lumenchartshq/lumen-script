import type { Diagnostic } from "../contracts/index.js";
import type { ExpressionNode, StatementNode } from "./ast.js";

export interface BlockGeneratorContext {
  expression(node: ExpressionNode, locals: ReadonlyMap<string, string>, scope?: string): string;
  childScope(scope?: string): string;
  globalId(name: string): number | undefined;
  readonly diagnostics: Diagnostic[];
}

/** Production expression/function blocks share lexical and return semantics. */
export function generateValueBlock(
  statements: readonly StatementNode[],
  result: string,
  locals: ReadonlyMap<string, string>,
  scope: string | undefined,
  context: BlockGeneratorContext,
  loopDepth = 0,
  captureResult = true,
): string {
  const code: string[] = [];
  const bindings = new Map(locals);
  const declared = new Set<string>();
  const emit = (node: ExpressionNode) => context.expression(node, bindings, scope);
  const declare = (name: string, local: string, statement: StatementNode): void => {
    if (declared.has(name)) context.diagnostics.push({ severity: "error", code: "SCRIPT2006", message: `Local '${name}' is already declared`, range: statement.range });
    declared.add(name);
    bindings.set(name, local);
  };
  for (const [index, statement] of statements.entries()) {
    const capture = captureResult && index === statements.length - 1;
    const prefix = capture ? `${result}=` : "";
    const suffix = String(statement.range.start.offset);
    switch (statement.kind) {
      case "declaration": {
        // Emit the initializer before exposing the new binding to its scope.
        const value = emit(statement.value);
        const local = `$blockLocal${suffix}`;
        declare(statement.name, local, statement);
        code.push(`const ${local}=r.localRef(${context.childScope(scope)},0,()=>${value},${JSON.stringify(statement.persistence)});`);
        if (capture) code.push(`${result}=${local}.get(0);`);
        break;
      }
      case "tuple_declaration": {
        const tuple = `$blockTuple${suffix}`;
        code.push(`const ${tuple}=${emit(statement.value)};`);
        for (const [position, name] of statement.names.entries()) {
          if (name === "_") continue;
          const local = `${tuple}_${String(position)}`;
          declare(name, local, statement);
          code.push(`const ${local}=r.localRef(${context.childScope(scope)},0,()=>r.tupleGet(${tuple},${String(position)}),"bar");`);
        }
        if (capture) code.push(`${result}=${tuple};`);
        break;
      }
      case "expression": code.push(`${prefix}${emit(statement.expression)};`); break;
      case "assignment": {
        const local = bindings.get(statement.name);
        const global = context.globalId(statement.name);
        if (local !== undefined) code.push(`${prefix}r.assignRef(${local},${emit(statement.value)});`);
        else if (global !== undefined) code.push(`${prefix}r.set(${String(global)},${emit(statement.value)});`);
        else context.diagnostics.push({ severity: "error", code: "SCRIPT2004", message: `Unknown variable '${statement.name}'`, range: statement.range });
        break;
      }
      case "member_assignment": {
        const receiver = emit(statement.object);
        const property = JSON.stringify(statement.property);
        const value = emit(statement.value);
        code.push(statement.operator === undefined
          ? `${prefix}r.setProperty(${receiver},${property},${value});`
          : `${prefix}r.updateProperty(${receiver},${property},${JSON.stringify(statement.operator)},${value});`);
        break;
      }
      case "if": {
        // Commit only if the branch completes. break/continue retain the last
        // completed iteration's value instead of an intermediate expression.
        const branch = `$blockResult${suffix}`;
        code.push(`let ${branch}=NaN;if(r.truthy(${emit(statement.test)})){${generateValueBlock(statement.consequent, branch, bindings, scope, context, loopDepth, capture)}}else{${generateValueBlock(statement.alternate, branch, bindings, scope, context, loopDepth, capture)}}${capture ? `${result}=${branch};` : ""}`);
        break;
      }
      case "once": {
        const onceScope = context.childScope(scope);
        code.push(`if(r.once(${onceScope},()=>${emit(statement.test)})){${generateValueBlock(statement.body, result, bindings, onceScope, context, loopDepth, false)}r.commitOnce(${onceScope});}`);
        if (capture) code.push(`${result}=NaN;`);
        break;
      }
      case "for": code.push(`${prefix}${emit({ ...statement, kind: "for_expression" })};`); break;
      case "for_in": code.push(`${prefix}${emit({ ...statement, kind: "for_in_expression" })};`); break;
      case "while": code.push(`${prefix}${emit({ ...statement, kind: "while_expression" })};`); break;
      case "break":
      case "continue":
        if (loopDepth > 0) code.push(`${statement.kind};`);
        else context.diagnostics.push({ severity: "error", code: "SCRIPT2010", message: `'${statement.kind}' is only valid inside a loop`, range: statement.range });
        break;
      default: context.diagnostics.push({ severity: "error", code: "SCRIPT2008", message: "Nested callable and type declarations are not supported", range: statement.range });
    }
  }
  return code.join("");
}
