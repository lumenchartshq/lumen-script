import type { CallNode, ExpressionNode, FunctionDeclarationNode, FunctionParameterNode, MethodDeclarationNode, ProgramNode, StatementNode } from "./ast.js";
import { boundBuiltinArguments } from "./call-analysis.js";
import { callableName } from "./expression-names.js";
import type { PineSemanticModel, ValueOrigin } from "./semantic-binder.js";

interface Value {
  readonly inputs: Value[];
  boolean: boolean;
  readonly requiresMissing: boolean;
  maps?: ReadonlySet<symbol>;
}

interface Scope {
  readonly values: Map<ValueOrigin, Value>;
  readonly maps: Map<ValueOrigin, ReadonlySet<symbol>>;
  readonly owner: symbol;
  readonly caller?: Scope;
}

interface MapRead {
  readonly maps: ReadonlySet<symbol>;
  readonly order: number;
}

interface MapIteration {
  readonly collection: ExpressionNode;
  readonly owner: symbol;
  readonly access: MapRead;
}

const plotCalls = new Set([
  "barcolor", "bgcolor", "fill", "hline", "plot", "plotarrow", "plotbar", "plotcandle", "plotchar", "plotshape",
]);
const outputCalls = new Set([
  "alert", "alertcondition", "log.error", "log.info", "log.warning", "line.new", "label.new", "box.new", "table.new",
  "linefill.new", "polyline.new",
]);
const collectionMutatorsWithResult = new Set(["pop", "shift", "remove"]);
const mapMutators = new Set(["put", "put_all", "remove", "clear"]);

function value(inputs: Value[] = [], boolean = false, requiresMissing = false, maps?: ReadonlySet<symbol>): Value {
  return { inputs, boolean, requiresMissing, ...(maps === undefined ? {} : { maps }) };
}

function mergeMaps(maps: Iterable<ReadonlySet<symbol> | undefined>): ReadonlySet<symbol> | undefined {
  let merged: Set<symbol> | undefined;
  for (const entries of maps) {
    if (entries === undefined) continue;
    merged ??= new Set();
    for (const identity of entries) merged.add(identity);
  }
  return merged;
}

interface ObservedValues {
  readonly requiresMissingBooleans: boolean;
  readonly liveMapIterations: ReadonlySet<ExpressionNode>;
  readonly observedRequests: ReadonlySet<CallNode>;
  readonly unusedMethodReceivers: ReadonlySet<FunctionParameterNode>;
}

/** Trace values that reach chart outputs and other observable effects. */
export function analyzeObservedValues(program: ProgramNode, semantic: PineSemanticModel): ObservedValues {
  const globals: Scope = { values: new Map(), maps: new Map(), owner: Symbol() };
  const roots: Value[] = [];
  const plots: Value[] = [];
  const mapEffects: Value[] = [];
  const mapReads = new Map<Value, MapRead>();
  const mapIterations = new Map<Value, MapIteration>();
  const mapOwners = new Map<symbol, symbol>();
  const callableResults = new Set<Value>();
  const requestResults = new Map<Value, CallNode>();
  const unusedMethodReceivers = new Set<FunctionParameterNode>();
  let nextRead = 0;
  const functions = new Map(program.statements.flatMap((node) => node.kind === "function" ? [[node.name, node]] : []));

  function binding(origin: ValueOrigin | undefined, scope: Scope): Value {
    if (origin === undefined) return value();
    const known = scope.values.get(origin) ?? globals.values.get(origin);
    if (known !== undefined) return known;
    const placeholder = value();
    globals.values.set(origin, placeholder);
    return placeholder;
  }

  function mapBinding(origin: ValueOrigin | undefined, scope: Scope): ReadonlySet<symbol> | undefined {
    if (origin === undefined) return undefined;
    for (let current: Scope | undefined = scope; current !== undefined; current = current.caller) {
      const maps = current.maps.get(origin);
      if (maps !== undefined) return maps;
    }
    return undefined;
  }

  function define(origin: ValueOrigin, result: Value, scope: Scope, controls: readonly Value[]): void {
    const variable = scope.values.get(origin) ?? value();
    variable.boolean ||= result.boolean;
    variable.inputs.push(result, ...controls);
    scope.values.set(origin, variable);
    if (result.maps !== undefined) scope.maps.set(origin, result.maps);
  }

  function alternatives(scope: Scope, branches: readonly ((branch: Scope) => Value)[]): Value[] {
    if (branches.length === 1) return [branches[0]!(scope)];
    const alternatives = branches.map((branch) => {
      const state: Scope = { ...scope, maps: new Map(scope.maps) };
      return { result: branch(state), maps: state.maps };
    });
    for (const state of alternatives) {
      for (const origin of state.maps.keys()) {
        const maps = mergeMaps(alternatives.map((branch) => branch.maps.get(origin)));
        if (maps !== undefined) scope.maps.set(origin, maps);
      }
    }
    return alternatives.map(({ result }) => result);
  }

  function readMap(result: Value, maps: ReadonlySet<symbol>): MapRead {
    const access = { maps, order: nextRead++ };
    mapReads.set(result, access);
    return access;
  }

  function block(statements: readonly StatementNode[], scope: Scope, controls: readonly Value[]): Value {
    let result = value();
    for (const statement of statements) {
      switch (statement.kind) {
        case "declaration":
        case "tuple_declaration":
          result = expression(statement.value, scope, controls);
          define(statement.value, result, scope, controls);
          break;
        case "assignment": {
          result = expression(statement.value, scope, controls);
          const target = semantic.assignmentOrigins.get(statement);
          if (target !== undefined) {
            binding(target, scope).inputs.push(result, ...controls);
            if (result.maps !== undefined || scope.maps.has(target)) scope.maps.set(target, result.maps ?? new Set());
          }
          break;
        }
        case "member_assignment":
          result = expression(statement.value, scope, controls);
          roots.push(result, expression(statement.object, scope, controls), ...controls);
          break;
        case "expression":
          result = expression(statement.expression, scope, controls);
          break;
        case "if":
        case "once":
        case "while":
        case "for":
        case "for_in":
          result = controlFlow(statement, scope, controls);
          break;
        case "function": case "method": case "enum": case "type": case "break": case "continue":
          result = value();
          break;
      }
    }
    return result;
  }

  function constant(node: ExpressionNode): string | number | boolean | undefined {
    return node.kind === "literal" ? node.value ?? undefined : semantic.constantValueOf(node);
  }

  function controlFlow(
    node: Extract<StatementNode | ExpressionNode, { kind: "if" | "if_expression" | "once" | "while" | "while_expression" | "for" | "for_expression" | "for_in" | "for_in_expression" | "switch" }>,
    scope: Scope,
    controls: readonly Value[],
  ): Value {
    switch (node.kind) {
      case "if":
      case "if_expression": {
        const test = expression(node.test, scope, controls);
        const selected = constant(node.test);
        const nested = [...controls, test];
        const branches: ((branch: Scope) => Value)[] = [];
        if (selected === undefined || selected) branches.push((branch) => block(node.consequent, branch, nested));
        if (!selected) branches.push((branch) => block(node.alternate, branch, nested));
        const results = alternatives(scope, branches);
        return value([test, ...results], false, false, mergeMaps(results.map((result) => result.maps)));
      }
      case "once":
      case "while":
      case "while_expression": {
        const test = expression(node.test, scope, controls);
        const selected = constant(node.test);
        if (selected !== undefined && !selected) return value([test]);
        const nested = [...controls, test];
        const results = alternatives(scope, [() => value(), (branch) => block(node.body, branch, nested)]);
        return value([test, ...results], false, false, mergeMaps(results.map((result) => result.maps)));
      }
      case "for":
      case "for_expression": {
        const start = expression(node.start, scope, controls);
        const bounds = [start, expression(node.end, scope, controls)];
        if (node.step !== undefined) bounds.push(expression(node.step, scope, controls));
        define(node.start, start, scope, controls);
        const nested = [...controls, ...bounds];
        const results = alternatives(scope, [() => value(), (branch) => block(node.body, branch, nested)]);
        return value([...bounds, ...results], false, false, mergeMaps(results.map((result) => result.maps)));
      }
      case "for_in":
      case "for_in_expression": {
        const collection = expression(node.collection, scope, controls);
        const iteration = value([collection]);
        if (collection.maps !== undefined) {
          const access = readMap(iteration, collection.maps);
          mapIterations.set(iteration, { collection: node.collection, owner: scope.owner, access });
        }
        define(node.collection, iteration, scope, controls);
        const nested = [...controls, iteration];
        const results = alternatives(scope, [() => value(), (branch) => block(node.body, branch, nested)]);
        return value([iteration, ...results], false, false, mergeMaps(results.map((result) => result.maps)));
      }
      case "switch": {
        const tests: Value[] = [];
        const branches: ((branch: Scope) => Value)[] = [];
        let exhaustive = false;
        const discriminant = node.discriminant === undefined ? undefined : constant(node.discriminant);
        if (node.discriminant !== undefined) tests.push(expression(node.discriminant, scope, controls));
        for (const arm of node.cases) {
          if (arm.test === undefined) {
            const nested = [...controls, ...tests];
            branches.push((branch) => block(arm.body, branch, nested));
            exhaustive = true;
            break;
          }
          const test = constant(arm.test);
          let matched: boolean | undefined;
          if (test !== undefined) {
            if (node.discriminant === undefined) matched = Boolean(test);
            else if (discriminant !== undefined) matched = discriminant === test;
          }
          tests.push(expression(arm.test, scope, [...controls, ...tests]));
          if (matched !== false) {
            const nested = [...controls, ...tests];
            branches.push((branch) => block(arm.body, branch, nested));
          }
          if (matched === true) {
            exhaustive = true;
            break;
          }
        }
        if (!exhaustive) branches.push(() => value());
        const bodies = alternatives(scope, branches);
        return value([...tests, ...bodies], false, false, mergeMaps(bodies.map((body) => body.maps)));
      }
    }
  }

  function call(node: CallNode, scope: Scope, controls: readonly Value[]): Value {
    const name = callableName(node.callee);
    const args = new Map(node.arguments.map(({ value: argument }) => [argument, expression(argument, scope, controls)]));
    const fn = functions.get(name);
    const methods = semantic.methodCandidates.get(node);
    const firstArgument = node.arguments[0]?.value;
    let receiver: Value | undefined;
    if (node.callee.kind === "member") receiver = expression(node.callee.object, scope, controls);
    else if (methods !== undefined && firstArgument !== undefined) receiver = args.get(firstArgument);
    const candidates: readonly (FunctionDeclarationNode | MethodDeclarationNode | undefined)[] = fn === undefined ? [...methods ?? []] : [fn];
    const ordered = boundBuiltinArguments(node, semantic);
    const results = candidates.flatMap((candidate) => {
      if (candidate === undefined) return [];
      const local: Scope = { values: new Map(), maps: new Map(), owner: Symbol(), caller: scope };
      for (const [index, parameter] of candidate.parameters.entries()) {
        const arg = ordered[candidate.kind === "method" ? index - 1 : index];
        const provided = arg === undefined ? undefined : args.get(arg);
        const argument = index === 0 && candidate.kind === "method" ? receiver : provided;
        const defaultValue = parameter.defaultValue;
        const input = argument ?? (defaultValue === undefined ? value() : expression(defaultValue, globals, controls));
        define(parameter, input, local, controls);
      }
      const effectStart = roots.length;
      const plotStart = plots.length;
      const mapEffectStart = mapEffects.length;
      const result = block(candidate.body, local, controls);
      const receiverParameter = candidate.kind === "method" ? candidate.parameters[0] : undefined;
      if (receiverParameter !== undefined && !unusedMethodReceivers.has(receiverParameter)) {
        const binding = local.values.get(receiverParameter);
        const outputs = [result, ...roots.slice(effectStart), ...plots.slice(plotStart), ...mapEffects.slice(mapEffectStart)];
        if (binding !== undefined && !observed(outputs).has(binding)) unusedMethodReceivers.add(receiverParameter);
      }
      callableResults.add(result);
      return [result];
    });
    if (candidates.length > 0 && !candidates.includes(undefined)) {
      return value(results, results.some((result) => result.boolean), false, mergeMaps(results.map((result) => result.maps)));
    }

    const arguments_ = [...args.values()];
    if (receiver !== undefined) arguments_.push(receiver);
    const kind = semantic.typeOf(node).kind;
    if (plotCalls.has(name)) plots.push(...arguments_, ...controls);
    if (kind === "void" || outputCalls.has(name) || (node.callee.kind === "member" &&
      collectionMutatorsWithResult.has(node.callee.property) &&
      (name.startsWith("array.") || semantic.typeOf(node.callee.object).kind === "array"))) {
      roots.push(...arguments_, ...controls);
    }
    const argument = ordered[0];
    const first = argument === undefined ? undefined : args.get(argument);
    const result = value([...results, ...arguments_], kind === "bool", name === "na" && first?.boolean === true);
    if (name === "request.security" || name === "request.security_lower_tf") {
      roots.push(...arguments_, ...controls);
      requestResults.set(result, node);
    }
    const receiverMaps = name.startsWith("map.") ? first?.maps : receiver?.maps;
    if (receiverMaps !== undefined && node.callee.kind === "member") {
      if (kind !== "void") readMap(result, receiverMaps);
      if (mapMutators.has(node.callee.property)) mapEffects.push(...arguments_, ...controls);
    }
    return result;
  }

  function expression(node: ExpressionNode, scope: Scope, controls: readonly Value[]): Value {
    const visit = (input: ExpressionNode): Value => expression(input, scope, controls);
    const type = semantic.typeOf(node).kind;
    let result: Value;
    switch (node.kind) {
      case "literal": result = value(); break;
      case "identifier": {
        const origin = semantic.valueOrigins.get(node);
        const definition = binding(origin, scope);
        result = value([definition], type === "unknown" && definition.boolean, false, mapBinding(origin, scope));
        break;
      }
      case "member": result = value([visit(node.object)]); break;
      case "call": result = call(node, scope, controls); break;
      case "unary": result = value([visit(node.argument)]); break;
      case "binary": {
        const left = visit(node.left);
        if (program.version === 6 && (node.operator === "and" || node.operator === "or")) {
          const selected = constant(node.left);
          const skipped = node.operator === "and" ? selected === false : selected === true;
          result = value(skipped ? [left] : [left, expression(node.right, scope, [...controls, left])]);
        } else {
          result = value([left, visit(node.right)]);
        }
        break;
      }
      case "history": {
        const base = visit(node.value);
        result = value([base, visit(node.offset)], base.boolean, base.boolean);
        break;
      }
      case "tuple": result = value(node.elements.map(visit)); break;
      case "conditional": {
        const test = visit(node.test);
        const selected = constant(node.test);
        const nested = [...controls, test];
        const branches: ((branch: Scope) => Value)[] = [];
        if (selected === undefined || selected) branches.push((branch) => expression(node.consequent, branch, nested));
        if (!selected) branches.push((branch) => expression(node.alternate, branch, nested));
        const results = alternatives(scope, branches);
        result = value([test, ...results], false, false, mergeMaps(results.map((branch) => branch.maps)));
        break;
      }
      case "if_expression": case "while_expression": case "for_expression": case "for_in_expression": case "switch":
        result = controlFlow(node, scope, controls);
        break;
    }
    result.boolean ||= type === "bool";
    if (type === "map" && result.maps === undefined) {
      const identity = Symbol();
      mapOwners.set(identity, scope.owner);
      result.maps = new Set([identity]);
    }
    return result;
  }

  block(program.statements, globals, []);
  const seen = observed([...roots, ...plots]);
  const observedEffects = mapEffects.length === 0 ? seen : observed([...roots, ...plots, ...mapEffects]);
  const observedRequests = new Set<CallNode>();
  for (const [result, call] of requestResults) {
    if (observedEffects.has(result)) observedRequests.add(call);
  }
  const liveMapIterations = new Set<ExpressionNode>();
  if (mapIterations.size > 0) {
    const plotted = observed(plots);
    const returned = observed([...callableResults].filter((result) => observedEffects.has(result)));
    const lastRead = new Map<symbol, number>();
    for (const read of observedEffects) {
      const access = mapReads.get(read);
      if (access === undefined) continue;
      for (const map of access.maps) lastRead.set(map, Math.max(lastRead.get(map) ?? -1, access.order));
    }
    const snapshots = new Set<ExpressionNode>();
    for (const [iteration, { collection, owner, access }] of mapIterations) {
      const feedsOutput = owner === globals.owner ? plotted.has(iteration) : returned.has(iteration);
      const ownsMap = [...access.maps].every((map) => mapOwners.get(map) === owner);
      const readAgain = [...access.maps].some((map) => (lastRead.get(map) ?? -1) > access.order);
      if (!feedsOutput || !ownsMap || readAgain) liveMapIterations.add(collection);
      else snapshots.add(collection);
    }
    for (const collection of snapshots) liveMapIterations.delete(collection);
  }
  return {
    requiresMissingBooleans: [...seen].some((entry) => entry.requiresMissing),
    liveMapIterations,
    observedRequests,
    unusedMethodReceivers,
  };
}

function observed(roots: readonly Value[]): ReadonlySet<Value> {
  const pending = [...roots];
  const visited = new Set<Value>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const input of current.inputs) pending.push(input);
  }
  return visited;
}
