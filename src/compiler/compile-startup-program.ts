import type { InputDefinition } from "../contracts/index.js";
import type { CallNode, DeclarationNode, ExpressionNode, FunctionDeclarationNode, IfStatementNode, MethodDeclarationNode, ProgramNode, StatementNode } from "./ast.js";
import type { PineSemanticModel } from "./semantic-binder.js";
import type { StartupNode, StartupProgramV1 } from "./startup-program.js";
import { startupProgramWithinBudget } from "./startup-program.js";
import { findMutatedDeclarations } from "./declaration-mutations.js";
import { collectCallNodes, walkPineAst } from "./ast-walk.js";
import { staticCallableName } from "./call-analysis.js";
import { inputDescriptorOptions } from "./input-metadata.js";
import { evaluateConstant } from "./constant-evaluator.js";

type Binding = { readonly blocked: true } | { readonly slot: number } | { readonly expression: ExpressionNode; readonly scope: Scope } | { readonly declaration: DeclarationNode; readonly scope: Scope };
type Scope = ReadonlyMap<string, Binding>;
type Callable = FunctionDeclarationNode | MethodDeclarationNode;
const pureCalls = new Set(["int", "float", "math.abs", "math.sign", "math.floor", "math.ceil", "math.min", "math.max"]);
const binary = new Set(["+", "-", "*", "/", "%", "and", "or", "==", "!=", "<", "<=", ">", ">="]);
class UnsupportedStartup extends Error {}

export interface StartupProgramOptions {
  /** `number` also admits float expressions and `input.float()`. */
  readonly expected?: "int" | "number";
  /** Footprint arguments validate the final expression, not each input's default. */
  readonly allowNegativeInputDefaults?: boolean;
  /**
   * Resolves an inline `input.*()` call to the id the generated program already
   * registered. Unresolved inline inputs become new descriptor inputs.
   */
  readonly inputIdAt?: (offset: number) => string | undefined;
}

/** Lower only bounded pure syntax. Scopes are compiler-local; emitted reads use unique slots. */
export function compileStartupProgram(program: ProgramNode, request: CallNode, expression: ExpressionNode, semantic: PineSemanticModel, options: StartupProgramOptions = {}): StartupProgramV1 | undefined {
  const type = semantic.typeOf(expression);
  const admittedKind = type.kind === "int" || (options.expected === "number" && type.kind === "float");
  if (program.version !== 6 || !admittedKind || type.qualifier === "series") return undefined;
  const mutated = findMutatedDeclarations(program);
  const globals = new Map<string, Binding>();
  const inlineInputs: InputDefinition[] = [];
  const visiting = new Set<Callable | DeclarationNode>();
  let slots = 0;
  let remaining = 256;
  const fail = (): never => { throw new UnsupportedStartup(); };
  const spend = (depth: number) => { if (--remaining < 0 || depth > 32) fail(); };
  const declarations = program.statements.filter((node): node is DeclarationNode => node.kind === "declaration" && node.range.start.offset < request.range.start.offset);
  for (const declaration of declarations) globals.set(declaration.name, { declaration, scope: new Map(globals) });

  function argumentsFor(callable: Callable, call: CallNode): readonly (ExpressionNode | undefined)[] {
    const bound = semantic.callBindingAt(call.range.start.offset, call.range.end.offset);
    if (!bound) return fail();
    if (callable.kind === "method" && call.callee.kind === "member") {
      const candidates = semantic.methodCandidatesAt(call.range.start.offset, call.range.end.offset);
      if (!candidates || candidates.size !== 1 || !candidates.has(callable)) return fail();
      return [call.callee.object, ...bound.ordered];
    }
    return bound.ordered;
  }

  function lowerBlock(statements: readonly StatementNode[], parent: Scope, depth: number): StartupNode {
    spend(depth);
    const last = statements.at(-1);
    if (!last) return fail();
    const local = new Map(parent);
    const bindings: { id: number; value: StartupNode }[] = [];
    for (const statement of statements.slice(0, -1)) {
      spend(depth + 1);
      if (statement.kind !== "declaration" || statement.persistence !== "bar" || mutated.has(statement)) return fail();
      const value = lower(statement.value, local, depth + 1);
      const id = slots++;
      bindings.push({ id, value });
      local.set(statement.name, { slot: id });
    }
    const result = last.kind === "expression"
      ? lower(last.expression, local, depth + 1)
      : last.kind === "if" ? lowerTerminalIf(last, local, depth + 1) : fail();
    return bindings.length === 0 ? result : { kind: "let", bindings, result };
  }

  function lowerTerminalIf(statement: IfStatementNode, scope: Scope, depth: number): StartupNode {
    spend(depth);
    const testType = semantic.typeOf(statement.test);
    if (statement.alternate.length === 0 || testType.kind !== "bool" || testType.qualifier === "series") return fail();
    return {
      kind: "conditional",
      test: lower(statement.test, scope, depth + 1),
      consequent: lowerBlock(statement.consequent, scope, depth + 1),
      alternate: lowerBlock(statement.alternate, scope, depth + 1),
    };
  }

  function lower(node: ExpressionNode, scope: Scope, depth: number, inputId?: string): StartupNode {
    spend(depth);
    if (node.kind === "literal") return node.value === null ? fail() : { kind: "literal", value: node.value };
    if (node.kind === "identifier") {
      const binding = scope.get(node.name);
      if (!binding || "blocked" in binding) return fail();
      if ("slot" in binding) return { kind: "slot", id: binding.slot };
      if ("expression" in binding) return lower(binding.expression, binding.scope, depth + 1);
      const declaration = binding.declaration;
      if (declaration.persistence !== "bar" || mutated.has(declaration) || visiting.has(declaration)) return fail();
      visiting.add(declaration);
      const value = lower(declaration.value, binding.scope, depth + 1, declaration.name);
      visiting.delete(declaration);
      return value;
    }
    if (node.kind === "member" && node.object.kind === "identifier") {
      const namespace = node.object.name;
      if (scope.has(namespace)) return fail();
      if (namespace === "syminfo" && ["type", "ticker", "tickerid", "currency", "mintick", "pointvalue"].includes(node.property)
        || namespace === "timeframe" && ["period", "main_period"].includes(node.property)) {
        return { kind: "metadata", namespace, field: node.property };
      }
      return fail();
    }
    if (node.kind === "unary" && ["+", "-", "not"].includes(node.operator)) return { kind: "unary", operator: node.operator, argument: lower(node.argument, scope, depth + 1) };
    if (node.kind === "binary" && binary.has(node.operator)) return { kind: "binary", operator: node.operator, left: lower(node.left, scope, depth + 1), right: lower(node.right, scope, depth + 1) };
    if (node.kind === "conditional") return { kind: "conditional", test: lower(node.test, scope, depth + 1), consequent: lower(node.consequent, scope, depth + 1), alternate: lower(node.alternate, scope, depth + 1) };
    if (node.kind !== "call") return fail();
    const name = staticCallableName(node.callee);
    if (name === "input.int" || name === "input.float") {
      const bound = semantic.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered;
      const defaultNode = bound?.[0];
      const defaultValue = defaultNode && evaluateConstant(defaultNode, { identifier: () => undefined, arguments: (call) => semantic.callBindingAt(call.range.start.offset, call.range.end.offset)?.ordered ?? [], integerDivision: () => false });
      if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue) || (!options.allowNegativeInputDefaults && defaultValue < 0)
        || name === "input.int" && !Number.isSafeInteger(defaultValue)) return fail();
      const titleNode = bound?.[1];
      const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : "";
      const registeredId = inputId ?? options.inputIdAt?.(node.range.start.offset);
      const id = registeredId ?? `request-count-${String(node.range.start.offset)}`;
      const inputType = name === "input.int" ? "int" : "float";
      if (registeredId === undefined) inlineInputs.push({ id, type: inputType, title, defaultValue, ...inputDescriptorOptions(node, inputType, new Map(), new Map()) });
      return { kind: "input", id, title, defaultValue, valueType: inputType };
    }
    if (name === "math.round") {
      const bound = semantic.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered;
      const argument = bound?.[0];
      if (!argument || bound?.slice(1).some((value) => value !== undefined)) return fail();
      return { kind: "call", name, arguments: [lower(argument, scope, depth + 1)] };
    }
    if (pureCalls.has(name)) {
      const bound = semantic.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered;
      if (!bound || bound.some((argument) => argument === undefined)) return fail();
      return { kind: "call", name, arguments: bound.map((argument) => lower(argument!, scope, depth + 1)) };
    }
    const callable = program.statements.find((statement): statement is FunctionDeclarationNode => statement.kind === "function" && statement.name === name);
    if (!callable || visiting.has(callable)) return fail();
    visiting.add(callable);
    const bound = argumentsFor(callable, node);
    const local = new Map(globals);
    const bindings: { id: number; value: StartupNode }[] = [];
    for (const [index, parameter] of callable.parameters.entries()) {
      const argument = bound[index] ?? parameter.defaultValue;
      if (!argument) return fail();
      const value = lower(argument, bound[index] ? scope : globals, depth + 1);
      const id = slots++;
      bindings.push({ id, value });
      local.set(parameter.name, { slot: id });
    }
    const last = callable.body.at(-1);
    if (!last) return fail();
    for (const statement of callable.body.slice(0, -1)) {
      spend(depth + 1);
      if (statement.kind !== "declaration" || statement.persistence !== "bar" || mutated.has(statement)) return fail();
      const value = lower(statement.value, local, depth + 1);
      const id = slots++;
      bindings.push({ id, value });
      local.set(statement.name, { slot: id });
    }
    const result = last.kind === "expression"
      ? lower(last.expression, local, depth + 1)
      : last.kind === "if" ? lowerTerminalIf(last, local, depth + 1) : fail();
    visiting.delete(callable);
    return { kind: "let", bindings, result };
  }

  const calls = collectCallNodes(program);
  const resolving = new Set<Callable>();
  function scopeAt(target: CallNode, depth: number): Scope {
    spend(depth);
    const scope = new Map(globals);
    const container = program.statements.find((statement) => statement.range.start.offset <= target.range.start.offset && statement.range.end.offset >= target.range.end.offset);
    if (container?.kind === "function" || container?.kind === "method") {
      if (resolving.has(container)) return fail();
      resolving.add(container);
      const callers = calls.filter((call) => (call.range.start.offset < container.range.start.offset || call.range.end.offset > container.range.end.offset)
        && (call.callee.kind === "identifier" && call.callee.name === container.name || call.callee.kind === "member" && call.callee.property === container.name));
      if (callers.length !== 1) return fail();
      const caller = callers[0]!;
      const callerScope = scopeAt(caller, depth + 1);
      const actuals = argumentsFor(container, caller);
      // Actuals retain their caller scope; defaults belong to the defining global scope.
      for (const [index, parameter] of container.parameters.entries()) {
        const value = actuals[index] ?? parameter.defaultValue;
        if (value) scope.set(parameter.name, { expression: value, scope: actuals[index] ? callerScope : globals });
      }
      for (const statement of container.body) {
        if (statement.range.end.offset >= target.range.start.offset) break;
        if (statement.kind === "declaration") scope.set(statement.name, { declaration: statement, scope: new Map(scope) });
      }
      resolving.delete(container);
    }
    // Block-local captures remain unsupported, but do not reject unrelated global reads.
    walkPineAst(program, (node) => {
      if (node.range.start.offset > target.range.start.offset || node.range.end.offset < target.range.end.offset) return;
      if (!["if", "if_expression", "while", "while_expression", "for", "for_expression", "for_in", "for_in_expression", "switch"].includes(node.kind)) return;
      if (node.kind === "for" || node.kind === "for_expression") scope.set(node.variable, { blocked: true });
      if (node.kind === "for_in" || node.kind === "for_in_expression") for (const name of node.variables) scope.set(name, { blocked: true });
      walkPineAst(program, (child) => {
        if (child.range.start.offset < node.range.start.offset || child.range.end.offset >= target.range.start.offset) return;
        if (child.kind === "declaration") scope.set(child.name, { blocked: true });
        if (child.kind === "tuple_declaration") for (const name of child.names) scope.set(name, { blocked: true });
      });
    });
    return scope;
  }

  try {
    const scope = scopeAt(request, 1);
    const bindings: { id: number; value: StartupNode }[] = [];
    const result = lower(expression, scope, 1);
    const root: StartupNode = { kind: "let", bindings, result };
    if (!startupProgramWithinBudget(root)) return undefined;
    return { version: 1, expression: root, inlineInputs, range: expression.range };
  } catch (error) {
    if (error instanceof UnsupportedStartup) return undefined;
    throw error;
  }
}
