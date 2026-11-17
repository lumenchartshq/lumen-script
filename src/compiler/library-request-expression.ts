import type { Diagnostic } from "../contracts/index.js";
import type { CallNode, ExpressionNode, FunctionDeclarationNode, MethodDeclarationNode, ProgramNode, StatementNode } from "./ast.js";
import { staticCallableName } from "./call-analysis.js";
import type { PineSemanticModel } from "./semantic-binder.js";

type Callable = FunctionDeclarationNode | MethodDeclarationNode;
type State = Map<string, boolean>;
interface FlowResult { readonly returned: boolean; readonly mutatedParameters: ReadonlySet<string> }

const collectionMutators = new Set([
  "push", "pop", "unshift", "shift", "set", "clear", "concat", "reverse", "insert", "remove", "fill", "sort",
  "put", "put_all", "add_row", "add_col", "remove_row", "remove_col", "reshape", "swap_rows", "swap_columns",
]);
const requestNames = new Set(["request.security", "request.security_lower_tf"]);

/** Trace parameter dependence through lexical writes and bound private calls before admitting library requests. */
export function validateLibraryRequestExpressions(
  program: ProgramNode,
  exported: readonly Callable[],
  semantic: PineSemanticModel,
): readonly Diagnostic[] {
  const functions = new Map(program.statements.filter((node): node is FunctionDeclarationNode => node.kind === "function")
    .map((node) => [node.name, node]));
  const diagnostics: Diagnostic[] = [];
  const reported = new Set<number>();
  const active = new Set<string>();

  const requestExpression = (call: CallNode): ExpressionNode | undefined => {
    if (!requestNames.has(staticCallableName(call.callee))) return undefined;
    let positional = 0;
    return call.arguments.find((argument) => {
      const index = argument.name === undefined ? positional++ : ["symbol", "timeframe", "expression"].indexOf(argument.name);
      return index === 2;
    })?.value;
  };

  const analyze = (callable: Callable, taintedParameters: ReadonlySet<string>): FlowResult => {
    const key = `${String(callable.range.start.offset)}:${[...taintedParameters].sort().join(",")}`;
    if (active.has(key)) return { returned: true, mutatedParameters: new Set(callable.parameters.map((item) => item.name)) };
    active.add(key);
    const state: State = new Map(callable.parameters.map((parameter) => [parameter.name, taintedParameters.has(parameter.name)]));
    const mutatedParameters = new Set<string>();
    const parameterNames = new Set(callable.parameters.map((parameter) => parameter.name));
    const aliases = new Map<string, Set<string>>();
    const copyAliases = (): Map<string, Set<string>> => new Map([...aliases].map(([name, linked]) => [name, new Set(linked)]));
    const restoreAliases = (snapshot: ReadonlyMap<string, ReadonlySet<string>>): void => {
      aliases.clear();
      for (const [name, linked] of snapshot) aliases.set(name, new Set(linked));
    };
    const joinAliases = (snapshot: ReadonlyMap<string, ReadonlySet<string>>): void => {
      for (const [name, linked] of snapshot) {
        const current = aliases.get(name) ?? new Set<string>();
        for (const other of linked) current.add(other);
        aliases.set(name, current);
      }
    };
    const unlinkAlias = (name: string): void => {
      for (const linked of aliases.get(name) ?? []) aliases.get(linked)?.delete(name);
      aliases.delete(name);
    };
    const linkAlias = (name: string, source: ExpressionNode): void => {
      if (source.kind !== "identifier") return;
      if (!["array", "map", "matrix", "udt", "reference"].includes(semantic.typeOf(source).kind)) return;
      const left = aliases.get(name) ?? new Set<string>();
      const right = aliases.get(source.name) ?? new Set<string>();
      left.add(source.name);
      right.add(name);
      aliases.set(name, left);
      aliases.set(source.name, right);
    };
    const mark = (name: string, bindings: State, tainted: boolean): void => {
      if (!tainted) return;
      const pending = [name];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        bindings.set(current, true);
        if (parameterNames.has(current)) mutatedParameters.add(current);
        pending.push(...(aliases.get(current) ?? []));
      }
    };
    const receiverName = (node: ExpressionNode): string | undefined => {
      if (node.kind === "identifier") return node.name;
      if (node.kind === "member") return receiverName(node.object);
      return undefined;
    };
    const merge = (target: State, branch: State): boolean => {
      let changed = false;
      for (const [name, prior] of target) {
        if (prior || branch.get(name) !== true) continue;
        target.set(name, true);
        changed = true;
      }
      return changed;
    };
    const evaluate = (node: ExpressionNode, bindings: State, control = false): boolean => {
      switch (node.kind) {
        case "literal": return false;
        case "identifier": return bindings.get(node.name) === true;
        case "member": return evaluate(node.object, bindings, control);
        case "history": return [evaluate(node.value, bindings, control), evaluate(node.offset, bindings, control)].some(Boolean);
        case "unary": return evaluate(node.argument, bindings, control);
        case "binary": return [evaluate(node.left, bindings, control), evaluate(node.right, bindings, control)].some(Boolean);
        case "conditional": return [evaluate(node.test, bindings, control), evaluate(node.consequent, bindings, control), evaluate(node.alternate, bindings, control)].some(Boolean);
        case "tuple": return node.elements.map((item) => evaluate(item, bindings, control)).some(Boolean);
        case "call": {
          const receiver = node.callee.kind === "member" ? evaluate(node.callee.object, bindings, control) : false;
          const argumentTaints = node.arguments.map((argument) => evaluate(argument.value, bindings, control));
          const expression = requestExpression(node);
          if (expression !== undefined && evaluate(expression, bindings, control) && !reported.has(node.range.start.offset)) {
            reported.add(node.range.start.offset);
            diagnostics.push({ severity: "error", code: "SCRIPT2123", message: "A library request expression cannot depend on an exported function parameter", range: expression.range });
          }
          const targets: Callable[] = [];
          if (node.callee.kind === "identifier") {
            const target = functions.get(node.callee.name);
            if (target) targets.push(target);
          } else {
            const selected = semantic.methodBindings.get(node);
            if (selected) targets.push(selected);
            else for (const candidate of semantic.methodCandidates.get(node) ?? []) if (candidate) targets.push(candidate);
          }
          let result = targets.length === 0 && (receiver || argumentTaints.some(Boolean));
          for (const target of targets) {
            const passed = new Set<string>();
            const ordered = semantic.callBindings.get(node)?.ordered;
            const argumentsByParameter = ordered ?? target.parameters.slice(target.kind === "method" ? 1 : 0).map((parameter, index) =>
              node.arguments.find((argument) => argument.name === parameter.name)?.value
              ?? node.arguments.filter((argument) => argument.name === undefined)[index]?.value);
            if (target.kind === "method" && receiver) passed.add(target.parameters[0]!.name);
            for (const [index, parameter] of target.parameters.entries()) {
              if (target.kind === "method" && index === 0) continue;
              const argument = argumentsByParameter[index - (target.kind === "method" ? 1 : 0)];
              if (argument && evaluate(argument, bindings, control)) passed.add(parameter.name);
            }
            const flow = analyze(target, passed);
            result ||= flow.returned;
            for (const [index, parameter] of target.parameters.entries()) {
              if (!flow.mutatedParameters.has(parameter.name)) continue;
              const argument = target.kind === "method" && index === 0 ? node.callee.kind === "member" ? node.callee.object : undefined
                : argumentsByParameter[index - (target.kind === "method" ? 1 : 0)];
              const name = argument && receiverName(argument);
              if (name) mark(name, bindings, true);
            }
          }
          const name = staticCallableName(node.callee);
          const method = node.callee.kind === "member" ? node.callee.property : name.slice(name.indexOf(".") + 1);
          const collectionReceiver = node.callee.kind === "member"
            && ["array", "map", "matrix"].includes(semantic.typeOf(node.callee.object).kind);
          const collectionNamespace = /^(?:array|map|matrix)\./u.test(name);
          if ((collectionReceiver || collectionNamespace) && collectionMutators.has(method) && (argumentTaints.some(Boolean) || receiver || control)) {
            const object = collectionNamespace ? node.arguments[0]?.value
              : node.callee.kind === "member" ? node.callee.object : undefined;
            const name = object && receiverName(object);
            if (name) mark(name, bindings, true);
          }
          return result;
        }
        case "if_expression": return branch(node.test, node.consequent, node.alternate, bindings, control);
        case "while_expression": return loop(node.body, bindings, evaluate(node.test, bindings, control), control);
        case "for_expression": return countedLoop(node, bindings, control);
        case "for_in_expression": return iteratedLoop(node, bindings, control);
        case "switch": {
          const selected = node.discriminant === undefined ? false : evaluate(node.discriminant, bindings, control);
          const initialAliases = copyAliases();
          const values = node.cases.map((entry) => {
            restoreAliases(initialAliases);
            const test = entry.test === undefined ? false : evaluate(entry.test, bindings, control);
            const copy = new Map(bindings);
            const value = statements(entry.body, copy, control || selected || test, true);
            merge(bindings, copy);
            return { value, aliases: copyAliases() };
          });
          restoreAliases(initialAliases);
          for (const entry of values) joinAliases(entry.aliases);
          return [selected, ...values.map((entry) => entry.value)].some(Boolean);
        }
      }
    };
    const branch = (test: ExpressionNode, consequent: readonly StatementNode[], alternate: readonly StatementNode[], bindings: State, control: boolean): boolean => {
      const tested = evaluate(test, bindings, control);
      const initialAliases = copyAliases();
      const yes = new Map(bindings);
      const no = new Map(bindings);
      const yesValue = statements(consequent, yes, control || tested, true);
      const yesAliases = copyAliases();
      restoreAliases(initialAliases);
      const noValue = statements(alternate, no, control || tested, true);
      const noAliases = copyAliases();
      restoreAliases(yesAliases);
      joinAliases(noAliases);
      merge(bindings, yes);
      merge(bindings, no);
      return tested || yesValue || noValue;
    };
    const loop = (body: readonly StatementNode[], bindings: State, dependent: boolean, control: boolean, induction?: readonly string[]): boolean => {
      const retained = new Map(bindings);
      let result = dependent;
      for (let pass = 0; pass < 32; pass += 1) {
        const priorAliases = copyAliases();
        const inside = new Map(retained);
        for (const name of induction ?? []) inside.set(name, dependent || control);
        result = statements(body, inside, control || dependent, true) || result;
        joinAliases(priorAliases);
        if (!merge(retained, inside)) break;
        if (pass === 31) {
          for (const name of retained.keys()) retained.set(name, true);
          const saturated = new Map(retained);
          for (const name of induction ?? []) saturated.set(name, true);
          result = statements(body, saturated, true, true) || result;
          merge(retained, saturated);
        }
      }
      merge(bindings, retained);
      return result;
    };
    const countedLoop = (node: Extract<ExpressionNode, { kind: "for_expression" }> | Extract<StatementNode, { kind: "for" }>, bindings: State, control: boolean): boolean => {
      const dependent = [evaluate(node.start, bindings, control), evaluate(node.end, bindings, control), node.step === undefined ? false : evaluate(node.step, bindings, control)].some(Boolean);
      return loop(node.body, bindings, dependent, control, [node.variable]);
    };
    const iteratedLoop = (node: Extract<ExpressionNode, { kind: "for_in_expression" }> | Extract<StatementNode, { kind: "for_in" }>, bindings: State, control: boolean): boolean =>
      loop(node.body, bindings, evaluate(node.collection, bindings, control), control, node.variables);
    const statements = (body: readonly StatementNode[], bindings: State, control: boolean, scoped = false): boolean => {
      const originalBindings = scoped ? new Map(bindings) : undefined;
      const originalAliases = scoped ? copyAliases() : undefined;
      const declared = new Set<string>();
      let last = false;
      for (const node of body) {
        switch (node.kind) {
          case "declaration":
            last = evaluate(node.value, bindings, control);
            if (scoped) { declared.add(node.name); unlinkAlias(node.name); }
            bindings.set(node.name, last || control);
            linkAlias(node.name, node.value);
            break;
          case "tuple_declaration":
            last = evaluate(node.value, bindings, control);
            for (const name of node.names) if (name !== "_") {
              if (scoped) { declared.add(name); unlinkAlias(name); }
              bindings.set(name, last || control);
            }
            break;
          case "assignment":
            last = evaluate(node.value, bindings, control);
            unlinkAlias(node.name);
            bindings.set(node.name, last || control);
            linkAlias(node.name, node.value);
            break;
          case "member_assignment": {
            const object = evaluate(node.object, bindings, control);
            const changed = evaluate(node.value, bindings, control);
            const name = receiverName(node.object);
            if (name) mark(name, bindings, changed || control);
            last = object || changed;
            break;
          }
          case "expression": last = evaluate(node.expression, bindings, control); break;
          case "if": last = branch(node.test, node.consequent, node.alternate, bindings, control); break;
          case "while": last = loop(node.body, bindings, evaluate(node.test, bindings, control), control); break;
          case "for": last = countedLoop(node, bindings, control); break;
          case "for_in": last = iteratedLoop(node, bindings, control); break;
          default: break;
        }
      }
      if (scoped && originalBindings && originalAliases) for (const name of declared) {
        unlinkAlias(name);
        for (const linked of originalAliases.get(name) ?? []) {
          const previous = aliases.get(name) ?? new Set<string>();
          previous.add(linked);
          aliases.set(name, previous);
          const neighbor = aliases.get(linked) ?? new Set<string>();
          neighbor.add(name);
          aliases.set(linked, neighbor);
        }
        if (originalBindings.has(name)) bindings.set(name, originalBindings.get(name)!);
        else bindings.delete(name);
      }
      return last;
    };
    const returned = statements(callable.body, state, false);
    active.delete(key);
    return { returned, mutatedParameters };
  };

  for (const callable of exported) analyze(callable, new Set(callable.parameters.map((parameter) => parameter.name)));
  return diagnostics;
}
