import { walkPineAst } from "./ast-walk.js";
import { generateValueBlock } from "./block-codegen.js";
import { inputDefaultValue, inferInputType, inputDescriptorDiagnostics, inputDescriptorOptions, staticInputValue } from "./input-metadata.js";
import { methodReferenceTypeNames, methodRequiredSignature } from "./method-signature.js";
import { callableName, memberName } from "./expression-names.js";
import { evaluateConstant } from "./constant-evaluator.js";
import { RuntimeRequirementCollector } from "./runtime-requirements.js";
import type { PineRuntimeRequirements } from "../contracts/index.js";
import type { SourceRange, AlertDefinition, PineCompatibility, Diagnostic, InputDefinition, PineFormat, PineScale, PineValue, PineVersion, PlotDefinition, ProgramDescriptor, StrategyConfig } from "../contracts/index.js";
import { PINE_BACKFILLABLE_CALLS,
  PINE_PRODUCTION_CALLABLE_METADATA as PINE_CALLABLE_METADATA,
  PINE_FILL_CALL_SIGNATURES,
  PINE_MARKET_FIELDS,
  PINE_PLOT_CALL_SIGNATURES,
  PINE_V5_STRATEGY_CALL_SIGNATURES,
  PINE_TIME_COMPONENT_FIELDS,
  PINE_ZERO_ARGUMENT_CALLS,
  PINE_MAIN_TIMEFRAME_GAPS_INPUT_ID,
  PINE_MAIN_TIMEFRAME_INPUT_ID,
  pineBuiltinCatalog,
  isPineShadowingNamespaceConstant,
  pineNamespaceCallRoots,
  pineRuntimeFields,
  isStrictPineCompatibility,
} from "../contracts/index.js";
import type { CallArgumentNode, CallNode, ExpressionNode, FunctionDeclarationNode, MethodDeclarationNode, ProgramNode, StatementNode } from "./ast.js";
import { PINE_DRAWING_CALL_SIGNATURES as drawingCallSignatures, PINE_STRATEGY_CALL_SIGNATURES as strategyCallSignatures } from "../contracts/index.js";
import { bindBuiltinCallArguments, bindCallArguments, type CallArgumentBinding } from "./argument-binding.js";
import type { PineSemanticModel } from "./semantic-binder.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

export interface GeneratedProgram {
  readonly generatedSource: string;
  readonly callSites: Readonly<Record<number, SourceRange>>;
  readonly variableNames: readonly string[];
  readonly indicatorTitle: string;
  readonly descriptor: ProgramDescriptor;
  /** Descriptor input ids keyed by the source offset of their `input.*()` call. */
  readonly inputIdsByOffset: ReadonlyMap<number, string>;
  readonly runtimeRequirements: PineRuntimeRequirements;
  readonly diagnostics: readonly Diagnostic[];
}

const marketFields = new Set<string>(PINE_MARKET_FIELDS);
const extendedHistoryFields = new Set(["open", "high", "low", "close", "time"]);
const targetedHistoryFields = new Set(["open", "high", "low", "close", "volume", "time"]);
const timeComponentFields = new Set<string>(PINE_TIME_COMPONENT_FIELDS);
const zeroArgumentCalls = new Set<string>(PINE_ZERO_ARGUMENT_CALLS);
const backfillableTaCalls = new Set<string>(PINE_BACKFILLABLE_CALLS);
const baseNamespaceRoots = [
  "adjustment", "alert", "barmerge", "barstate", "chart", "color", "currency", "display", "extend", "format", "location", "position", "scale", "shape", "size", "strategy", "syminfo", "text", "timeframe", "xloc", "yloc",
] as const;
const runtimeCallSignatures: Readonly<Record<string, readonly string[]>> = {
  bool: ["value"],
  color: ["value"],
  fixnan: ["source"],
  float: ["value"],
  int: ["value"],
  na: ["value"],
  nz: ["source", "replacement"],
  "runtime.error": ["message"],
  string: ["value"],
  time: ["timeframe", "session", "timezone", "bars_back", "timeframe_bars_back"],
  time_close: ["timeframe", "session", "timezone", "bars_back", "timeframe_bars_back"],
  "timeframe.change": ["timeframe"],
};
const runtimeOptionalParameters: Readonly<Record<string, readonly string[]>> = {
  nz: ["replacement"],
  time: ["session", "timezone", "bars_back", "timeframe_bars_back"],
  time_close: ["session", "timezone", "bars_back", "timeframe_bars_back"],
};
const currentProfileRuntimeCalls = new Set(["time", "time_close", "timeframe.change"]);
const globalOnlyCalls = new Set<string>([
  "alertcondition", "barcolor", "bgcolor", "fill", "hline", "indicator", "library", "plot", "plotarrow", "plotbar", "plotcandle", "plotchar", "plotshape", "strategy",
]);

export function generate(
  program: ProgramNode,
  requestIds: ReadonlyMap<number, string | null> = new Map(),
  compatibility: PineCompatibility = PINE_COMPATIBILITY.legacy,
  semantic?: PineSemanticModel,
  dynamicRequestIds: ReadonlySet<string> = new Set(),
  allowLumenChartsHistoricalFillSchedule = false,
  normalizeV5Booleans = false,
  liveMapIterations: ReadonlySet<ExpressionNode> = new Set(),
): GeneratedProgram {
  const variables = new Map<string, number>();
  const variableTypes = new Map<string, "bool" | "color" | "float" | "int" | "string">();
  const variableNames: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const productionProfile = isStrictPineCompatibility(compatibility);
  const modernV6 = productionProfile && program.version === 6;
  const singleIterationLoops = new WeakSet<ExpressionNode>();
  if (productionProfile) walkPineAst(program, (node) => {
    if (node.kind === "declaration" && node.persistence !== "bar" && ["for_expression", "for_in_expression", "while_expression"].includes(node.value.kind)) singleIterationLoops.add(node.value);
  });
  const catalog = pineBuiltinCatalog(compatibility);
  const runtimeFields = new Set<string>(pineRuntimeFields(compatibility));
  const namespaceCallRoots = new Set<string>(pineNamespaceCallRoots(compatibility));
  const knownBuiltinCalls = new Set<string>(catalog.builtins);
  const knownBuiltinVariables = new Set<string>(catalog.variables);
  const knownNamespaceRoots = new Set<string>([...baseNamespaceRoots, ...namespaceCallRoots, ...(productionProfile ? ["session"] : [])]);
  const strictNamespaceVariableRoots = new Set<string>(["barstate", "chart", "syminfo", "timeframe", ...(productionProfile ? ["session"] : [])]);
  const callSites: Record<number, SourceRange> = {};
  let nextCallId = 0;
  let nextPlotId = 0;
  let nextAlertId = 0;
  let nextAlertConditionId = 0;
  let indicatorTitle = "";
  let indicatorShortTitle: string | undefined;
  let declarationKind: ProgramDescriptor["kind"] = "indicator";
  let overlay = false;
  let format: PineFormat = "inherit";
  let precision = 10;
  let precisionSpecified = false;
  let scale: PineScale = "right";
  let scaleExplicit = false;
  let behindChart = true;
  let explicitPlotZOrder = false;
  let timeframe: string | undefined;
  let timeframeSpecified = false;
  let timeframeGaps: boolean | undefined;
  let timeframeGapsSpecified = false;
  let maxBarsBack: number | undefined;
  let dynamicRequests = program.version === 6;
  let maxLinesCount = 50;
  let maxBoxesCount = 50;
  let maxLabelsCount = 50;
  let maxPolylinesCount = 50;
  let strategyConfig: StrategyConfig | undefined;
  const inputs: InputDefinition[] = [];
  const inputVariableIds = new Map<number, string>();
  const inputIdsByOffset = new Map<number, string>();
  // Provider-backed references are typed statically, so `fp.delta()` lowers to
  // `footprint.delta(fp)` and an `na` receiver fails like the namespace form.
  const providerReferenceNamespace = (receiver: ExpressionNode): "footprint" | "volume_row" | undefined => {
    if (!productionProfile) return undefined;
    const type = semantic?.typeOf(receiver);
    if (type?.kind !== "reference") return undefined;
    return type.name === "footprint" || type.name === "volume_row" ? type.name : undefined;
  };
  const arrayReceiverHint = (receiver: ExpressionNode): string =>
    productionProfile && semantic?.typeOf(receiver).kind === "array" ? ',"array"' : "";
  const plots: PlotDefinition[] = [];
  const alerts: AlertDefinition[] = [];
  let plotCount = 0;
  let plotLimitReported = false;
  const requirements = new RuntimeRequirementCollector(compatibility);
  let historySamples: { readonly byBar: boolean; readonly reads: Map<ExpressionNode, string>; readonly records: string[] } | undefined;
  /** Production builtins sampled at the start of every bar (see RuntimeContext.sampleBuiltins). */
  const sampledBuiltins = new Set<string>();
  const sampledBuiltin = (name: string, offset: string): string => {
    sampledBuiltins.add(name);
    requirements.record(name);
    return `r.builtin(${JSON.stringify(name)},${offset})`;
  };
  const countPlots = (count: number, node: ExpressionNode): void => {
    if (!productionProfile || count <= 0) return;
    plotCount += count;
    if (plotCount > 64 && !plotLimitReported) {
      plotLimitReported = true;
      diagnostics.push({
        severity: "error",
        code: "SCRIPT3020",
        message: `Script uses ${String(plotCount)} plot counts; Lumen Script supports at most 64`,
        range: node.range,
      });
    }
  };
  const functions = new Map<string, FunctionDeclarationNode>();
  const methods = new Map<string, MethodDeclarationNode[]>();
  const methodReferenceTypes = methodReferenceTypeNames(program.statements);
  const types = new Map<string, Extract<StatementNode, { kind: "type" }>>();
  const enums = new Set<string>();
  const enumValues = new Map<string, string>();
  const enumDomains = new Map<string, readonly string[]>();
  const topLevelValues = new Map<string, ExpressionNode>();
  const targetedHistoryLimits = new Map<string, number>();
  const functionHistoryLimits = new Map<FunctionDeclarationNode | MethodDeclarationNode, Map<string, number>>();
  let activeFunctionHistoryLimits: ReadonlyMap<string, number> | undefined;
  const countPlotOptions = (
    base: number,
    ordered: readonly (ExpressionNode | undefined)[],
    signature: readonly string[],
    optionNames: readonly string[],
  ): number => base + optionNames.filter((name) => isNonConstPlotExpression(ordered[signature.indexOf(name)], topLevelValues, new Set(), semantic)).length;
  const chartPointVariables = new Set<string>();
  collectChartPointVariables(program.statements, chartPointVariables);
  if (productionProfile) validateGlobalCalls(program.statements, diagnostics);

  const bindArguments = (
    callable: string,
    args: readonly CallArgumentNode[],
    range: ExpressionNode["range"],
    signature?: readonly string[],
    optionalParameters?: readonly string[],
    overloads?: readonly (readonly string[])[],
  ): readonly (ExpressionNode | undefined)[] => {
    if (!productionProfile) return signature === undefined ? args.map((argument) => argument.value) : orderCallArguments(signature, args);
    const semanticBinding = semantic?.callBindingAt(range.start.offset, range.end.offset);
    if (semanticBinding !== undefined) return semanticBinding.ordered;
    if (signature === undefined) return bindBuiltinCallArguments(callable, args, PINE_CALLABLE_METADATA[callable], range, diagnostics).ordered;
    return bindCallArguments({
      callable,
      arguments: args,
      signature,
      ...(optionalParameters === undefined ? {} : { optionalParameters }),
      ...(overloads === undefined ? {} : { overloads }),
      ...(PINE_CALLABLE_METADATA[callable]?.variadicParameter === undefined ? {} : { variadicParameter: PINE_CALLABLE_METADATA[callable].variadicParameter }),
      range,
      diagnostics,
    }).ordered;
  };

  for (const statement of program.statements) {
    if (statement.kind === "enum") {
      enums.add(statement.name);
      for (const field of statement.fields) enumValues.set(`${statement.name}.${field.name}`, field.title);
      enumDomains.set(statement.name, Object.freeze(statement.fields.map((field) => field.title)));
    } else if (statement.kind === "type") {
      if (types.has(statement.name)) diagnostics.push({ severity: "error", code: "SCRIPT2012", message: `Type '${statement.name}' is already declared`, range: statement.range });
      else types.set(statement.name, statement);
    } else if (statement.kind === "method") {
      const receiverType = statement.parameters[0]?.dataType;
      const overloads = methods.get(statement.name) ?? [];
      if (receiverType === undefined) diagnostics.push({ severity: "error", code: "SCRIPT2013", message: `Method '${statement.name}' requires a typed receiver`, range: statement.range });
      else if (overloads.some((method) => methodRequiredSignature(method, methodReferenceTypes) === methodRequiredSignature(statement, methodReferenceTypes))) diagnostics.push({ severity: "error", code: "SCRIPT2013", message: `Method '${statement.name}' has a duplicate required signature for '${receiverType}'`, range: statement.range });
      else {
        overloads.push(statement);
        methods.set(statement.name, overloads);
      }
    } else if (statement.kind === "function") {
      if (functions.has(statement.name)) diagnostics.push({ severity: "error", code: "SCRIPT2005", message: `Function '${statement.name}' is already declared`, range: statement.range });
      else functions.set(statement.name, statement);
    } else if (statement.kind === "declaration") {
      topLevelValues.set(statement.name, statement.value);
      if (variables.has(statement.name)) diagnostics.push({ severity: "error", code: "SCRIPT2003", message: `Variable '${statement.name}' is already declared`, range: statement.range });
      else {
        variables.set(statement.name, variables.size);
        if (statement.dataType !== undefined && ["bool", "color", "float", "int", "string"].includes(statement.dataType)) {
          variableTypes.set(statement.name, statement.dataType as "bool" | "color" | "float" | "int" | "string");
        }
        else {
          const semanticKind = semantic?.symbolTypes.get(statement.name)?.kind;
          const inferred = semantic !== undefined
            ? semanticKind !== undefined && ["bool", "color", "float", "int", "string"].includes(semanticKind)
              ? semanticKind as "bool" | "color" | "float" | "int" | "string"
              : undefined
            : legacyStaticType(statement.value, variableTypes);
          if (inferred !== undefined) variableTypes.set(statement.name, inferred);
        }
        variableNames.push(statement.name);
        if (isChartPointExpression(statement.value, chartPointVariables)) chartPointVariables.add(statement.name);
        if (statement.value.kind === "call") {
          const inputName = callableName(statement.value.callee);
          if (inputName === "input" || inputName.startsWith("input.")) inputVariableIds.set(statement.value.range.start.offset, statement.name);
        }
      }
    } else if (statement.kind === "tuple_declaration") {
      for (const name of statement.names) {
        if (name === "_") continue;
        if (variables.has(name)) diagnostics.push({ severity: "error", code: "SCRIPT2003", message: `Variable '${name}' is already declared`, range: statement.range });
        else {
          variables.set(name, variables.size);
          variableNames.push(name);
        }
      }
    }
  }

  if (productionProfile) {
    const callableScopes = program.statements.filter((statement): statement is FunctionDeclarationNode | MethodDeclarationNode =>
      statement.kind === "function" || statement.kind === "method");
    const localCounts = new Map<FunctionDeclarationNode | MethodDeclarationNode, Map<string, number>>();
    for (const definition of callableScopes) {
      const counts = new Map<string, number>();
      const count = (name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1); };
      for (const parameter of definition.parameters) count(parameter.name);
      walkPineAst({ version: program.version, statements: definition.body }, (node) => {
        if (node.kind === "declaration") count(node.name);
        if (node.kind === "tuple_declaration") for (const name of node.names) count(name);
        if (node.kind === "for" || node.kind === "for_expression") count(node.variable);
        if (node.kind === "for_in" || node.kind === "for_in_expression") for (const name of node.variables) count(name);
      });
      localCounts.set(definition, counts);
      functionHistoryLimits.set(definition, new Map());
    }
    const blockLocalNames = new Set<string>();
    for (const statement of program.statements) {
      if (statement.kind === "function" || statement.kind === "method" || statement.kind === "declaration" || statement.kind === "tuple_declaration") continue;
      walkPineAst({ version: program.version, statements: [statement] }, (node) => {
        if (node.kind === "declaration") blockLocalNames.add(node.name);
        if (node.kind === "tuple_declaration") for (const name of node.names) blockLocalNames.add(name);
        if (node.kind === "for" || node.kind === "for_expression") blockLocalNames.add(node.variable);
        if (node.kind === "for_in" || node.kind === "for_in_expression") for (const name of node.variables) blockLocalNames.add(name);
      });
    }
    walkPineAst(program, (node) => {
      if (node.kind !== "call" || callableName(node.callee) !== "max_bars_back" || functions.has("max_bars_back")) return;
      const [target, size] = bindArguments("max_bars_back", node.arguments, node.range, ["var", "num"]);
      const definition = callableScopes.find((candidate) =>
        node.range.start.offset > candidate.range.start.offset && node.range.end.offset <= candidate.range.end.offset);
      const localCount = target?.kind === "identifier" ? localCounts.get(definition!)?.get(target.name) ?? 0 : 0;
      const supportedGlobal = target?.kind === "identifier" && !blockLocalNames.has(target.name)
        && (targetedHistoryFields.has(target.name) || variables.has(target.name));
      if (target?.kind !== "identifier" || semantic?.typeOf(target).qualifier !== "series"
        || localCount > 1 || (localCount === 1 && definition === undefined)
        || (localCount === 0 && !supportedGlobal)) {
        diagnostics.push({ severity: "error", code: "SCRIPT2018", message: "max_bars_back() target must have an unambiguous series history identity", range: target?.range ?? node.range });
        return;
      }
      const constant = size === undefined ? undefined : semantic?.constantValueOf(size) ?? evaluateConstant(size, {
        identifier: () => undefined,
        arguments: (call) => call.arguments.map((argument) => argument.value),
        integerDivision: (candidate) => candidate.kind === "binary" && candidate.operator === "/"
          && candidate.forceFloatDivision !== true && program.version === 5
          && semantic?.typeOf(candidate.left).kind === "int" && semantic.typeOf(candidate.left).qualifier === "const"
          && semantic?.typeOf(candidate.right).kind === "int" && semantic.typeOf(candidate.right).qualifier === "const",
      });
      if (size === undefined || semantic?.typeOf(size).kind !== "int" || typeof constant !== "number"
        || !Number.isInteger(constant) || constant < 1 || constant > 5000) {
        diagnostics.push({ severity: "error", code: "SCRIPT2018", message: "max_bars_back() size must be a constant integer from 1 to 5000", range: size?.range ?? node.range });
        return;
      }
      const limits = localCount === 1 ? functionHistoryLimits.get(definition!)! : targetedHistoryLimits;
      limits.set(target.name, Math.max(limits.get(target.name) ?? 0, constant));
    });
  }

  const expression = (node: ExpressionNode, locals: ReadonlyMap<string, string> = new Map(), scope?: string): string => {
    const emitted = emitExpression(node, locals, scope);
    return normalizeV5Booleans && (semantic?.typeOf(node).kind === "bool" || semantic?.v5BooleanMissingValues.has(node))
      ? `r.truthy(${emitted})`
      : emitted;
  };

  const emitExpression = (node: ExpressionNode, locals: ReadonlyMap<string, string>, scope?: string): string => {
    switch (node.kind) {
      case "literal":
        return node.value === null ? "NaN" : JSON.stringify(node.value);
      case "identifier": {
        const local = locals.get(node.name);
        if (local !== undefined) return `${local}.get(0)`;
        const id = variables.get(node.name);
        if (id !== undefined) return `r.get(${id})`;
        if (marketFields.has(node.name)) return `r.data(${JSON.stringify(node.name)})`;
        if (timeComponentFields.has(node.name)) {
          const callId = nextCallId++;
        if (productionProfile) callSites[callId] = node.range;
          return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(node.name)},[])`;
        }
        if (runtimeFields.has(node.name)) {
          requirements.record(node.name);
          return `r.constant(${JSON.stringify(node.name)})`;
        }
        if (node.name === "bar_index") return "r.barIndex";
        diagnostics.push({ severity: "error", code: "SCRIPT2001", message: `Unknown identifier '${node.name}'`, range: node.range });
        return "NaN";
      }
      case "member": {
        const name = memberName(node);
        const root = memberRootIdentifier(node);
        const enumValue = enumValues.get(name);
        if (enumValue !== undefined) return JSON.stringify(enumValue);
        if (zeroArgumentCalls.has(name)) {
          if (productionProfile) return sampledBuiltin(name, "0");
          const callId = nextCallId++;
        if (productionProfile) callSites[callId] = node.range;
          return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[])`;
        }
        if (productionProfile && isPineShadowingNamespaceConstant(name)) {
          requirements.record(name);
          return `r.constant(${JSON.stringify(name)})`;
        }
        if (root === undefined || locals.has(root) || variables.has(root)) {
          const receiver = expression(node.object, locals, scope);
          const field = JSON.stringify(node.property);
          const receiverType = semantic?.typeOf(node.object);
          if (modernV6 && receiverType?.kind === "udt" && receiverType.name !== undefined) {
            const fieldId = nextCallId++;
            callSites[fieldId] = node.range;
            return `r.objectField(${scopedCallId(scope, fieldId)},${receiver},${JSON.stringify(receiverType.name)},${field})`;
          }
          return `r.property(${receiver},${field})`;
        }
        if (productionProfile && !knownBuiltinVariables.has(name)) {
          if (!knownNamespaceRoots.has(root) || strictNamespaceVariableRoots.has(root)) {
            diagnostics.push({ severity: "error", code: "SCRIPT2015", message: `Unknown namespace variable '${name}'`, range: node.range });
            return "NaN";
          }
        }
        requirements.record(name);
        return `r.constant(${JSON.stringify(name)})`;
      }
      case "history": {
        const rawOffset = expression(node.offset, locals, scope);
        const offsetId = productionProfile ? nextCallId++ : 0;
        if (productionProfile) callSites[offsetId] = node.offset.range;
        const extendedHistory = node.value.kind === "identifier"
          && extendedHistoryFields.has(node.value.name)
          && !locals.has(node.value.name)
          && !variables.has(node.value.name);
        const sourceName = node.value.kind === "identifier" ? node.value.name : undefined;
        const localSource = sourceName !== undefined && locals.has(sourceName);
        const sourceId = sourceName === undefined ? undefined : localSource
          ? `String(${scope ?? '"root"'})+${JSON.stringify(`:local:${sourceName}`)}`
          : variables.has(sourceName) ? JSON.stringify(`global:${String(variables.get(sourceName))}`)
            : marketFields.has(sourceName) ? JSON.stringify(`market:${sourceName}`) : undefined;
        const minimum = sourceName === undefined ? 0 : localSource
          ? activeFunctionHistoryLimits?.get(sourceName) ?? 0 : targetedHistoryLimits.get(sourceName) ?? 0;
        const offset = productionProfile
          ? `r.historyOffset(${offsetId},${rawOffset},${extendedHistory ? 10000 : 5000}${sourceId === undefined ? "" : `,${sourceId},${String(minimum)}`})`
          : rawOffset;
        const result = (value: string): string => modernV6 && semantic?.typeOf(node.value).kind === "bool" ? `r.truthy(${value})` : value;
        if (node.value.kind === "identifier") {
          const local = locals.get(node.value.name);
          if (local !== undefined) return result(`${local}.get(${offset})`);
          const id = variables.get(node.value.name);
          if (id !== undefined) return result(`r.get(${id},${offset})`);
          if (marketFields.has(node.value.name)) return result(`r.data(${JSON.stringify(node.value.name)},${offset})`);
          // Builtins derived from the bar position have a value on every bar,
          // even when this expression only runs on some of them.
          if (productionProfile && node.value.name === "bar_index") return `r.barIndexAt(${offset})`;
          if (productionProfile && timeComponentFields.has(node.value.name)) {
            const callId = nextCallId++;
            callSites[callId] = node.range;
            return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(node.value.name)},[r.data("time",${offset})])`;
          }
        }
        const builtinName = productionProfile ? builtinVariableName(node.value, locals) : undefined;
        if (builtinName !== undefined) {
          if (builtinName === "time_tradingday" || builtinName.startsWith("session.")) {
            requirements.record(builtinName);
            return result(`r.sessionHistory(${JSON.stringify(builtinName)},${offset})`);
          }
          return result(sampledBuiltin(builtinName, offset));
        }
        const direct = directSeriesHistory(node.value, offset, locals);
        if (direct !== undefined) return result(direct);
        // Call-free operands sample when the enclosing expression is entered,
        // even when a ternary in that expression skips the read.
        if (historySamples !== undefined && callFreeExpression(node.value)) {
          const samples = historySamples;
          let recordId = samples.reads.get(node);
          const indexArgument = samples.byBar ? ",true" : "";
          if (recordId === undefined) {
            recordId = scopedCallId(scope, nextCallId++);
            const value = expression(node.value, locals, scope);
            samples.reads.set(node, recordId);
            samples.records.push(`r.recordHistory(${recordId},${value}${indexArgument})`);
          }
          return result(`r.readRecordedHistory(${recordId},${offset}${indexArgument})`);
        }
        const historyId = nextCallId++;
        return result(`r.history(${scopedCallId(scope, historyId)},${expression(node.value, locals, scope)},${offset})`);
      }
      case "unary":
        return `r.unary(${JSON.stringify(node.operator)},${expression(node.argument, locals, scope)})`;
      case "binary": {
        const left = expression(node.left, locals, scope);
        if (modernV6 && node.operator === "and") return `(r.truthy(${left})?r.truthy(${expression(node.right, locals, scope)}):false)`;
        if (modernV6 && node.operator === "or") return `(r.truthy(${left})?true:r.truthy(${expression(node.right, locals, scope)}))`;
        const legacyIntegerDivision = !productionProfile
          && expressionPrimitiveType(node.left, variableTypes, semantic) === "int"
          && expressionPrimitiveType(node.right, variableTypes, semantic) === "int";
        const leftType = semantic?.typeOf(node.left);
        const rightType = semantic?.typeOf(node.right);
        const productionV5ConstIntegerDivision = productionProfile
          && program.version === 5
          && leftType?.kind === "int"
          && leftType.qualifier === "const"
          && rightType?.kind === "int"
          && rightType.qualifier === "const";
        const operator = node.operator === "/" && node.forceFloatDivision !== true && (legacyIntegerDivision || productionV5ConstIntegerDivision)
          ? "__idiv"
          : node.operator;
        return `r.binary(${JSON.stringify(operator)},${left},${expression(node.right, locals, scope)})`;
      }
      case "conditional":
        return `(r.truthy(${expression(node.test, locals, scope)})?${expression(node.consequent, locals, scope)}:${expression(node.alternate, locals, scope)})`;
      case "if_expression": {
        const consequentScope = scopedCallId(scope, nextCallId++);
        const alternateScope = scopedCallId(scope, nextCallId++);
        // The reference platform folds a const if separately from its runtime branch.
        const runtimeBool = modernV6 && semantic?.typeOf(node).kind === "bool" && semantic.typeOf(node.test).qualifier !== "const";
        const fallback = runtimeBool ? "false" : "NaN";
        return `(()=>{if(r.truthy(${expression(node.test, locals, scope)})){${expressionBranch(node.consequent, locals, consequentScope)}}else{${node.alternate.length === 0 ? `return ${fallback};` : expressionBranch(node.alternate, locals, alternateScope)}}})()`;
      }
      case "while_expression": {
        const suffix = String(node.range.start.offset);
        const result = `$loopResult${suffix}`;
        const once = singleIterationLoops.has(node);
        const first = `$loopFirst${suffix}`;
        const initializeOnce = once ? `let ${first}=true;` : "";
        const enterOnce = once ? `${first}=false;` : "";
        return `(()=>{let ${result}=NaN;${initializeOnce}while(${once ? `${first}&&` : ""}r.truthy(${evaluatedExpression(node.test, locals, scope, historySamples?.byBar)})){${enterOnce}r.loop();${loopExpressionBlock(node.body, result, locals, scope)}}return ${result};})()`;
      }
      case "for_expression": {
        const suffix = String(node.range.start.offset);
        const result = `$loopResult${suffix}`;
        const once = singleIterationLoops.has(node);
        const first = `$loopFirst${suffix}`;
        const initializeOnce = once ? `let ${first}=true;` : "";
        const enterOnce = once ? `${first}=false;` : "";
        const counter = `i${suffix}`;
        const reference = `ir${suffix}`;
        const from = `from${suffix}`;
        const to = `to${suffix}`;
        const step = `step${suffix}`;
        const loopLocals = new Map(locals);
        loopLocals.set(node.variable, reference);
        const defaultStep = productionProfile ? "1" : `${from}<=${to}?1:-1`;
        const bound = productionProfile ? "rangeBound" : "integerSigned";
        const stepExpression = node.step === undefined ? defaultStep : evaluatedExpression(node.step, locals, scope, historySamples?.byBar);
        const startExpression = evaluatedExpression(node.start, locals, scope, historySamples?.byBar);
        const endExpression = evaluatedExpression(node.end, locals, scope, historySamples?.byBar);
        const stepValue = productionProfile ? `r.rangeStep(${from},${to},${stepExpression})` : `r.integerSigned(${stepExpression})`;
        const toBinding = modernV6 ? "let" : "const";
        const update = modernV6
          ? `${counter}+=${step},${to}=r.${bound}(${endExpression})`
          : `${counter}+=${step}`;
        return `(()=>{let ${result}=NaN;${initializeOnce}const ${from}=r.${bound}(${startExpression});${toBinding} ${to}=r.${bound}(${endExpression});const ${step}=${stepValue};for(let ${counter}=${from};${once ? `${first}&&` : ""}(${step}>=0?${counter}<=${to}:${counter}>=${to});${once ? "" : update}){${enterOnce}r.loop();const ${reference}=r.valueRef(${counter});${loopExpressionBlock(node.body, result, loopLocals, scope)}}return ${result};})()`;
      }
      case "for_in_expression": {
        const suffix = String(node.range.start.offset);
        const result = `$loopResult${suffix}`;
        const once = singleIterationLoops.has(node);
        const first = `$loopFirst${suffix}`;
        const initializeOnce = once ? `let ${first}=true;` : "";
        const enterOnce = once ? `${first}=false;` : "";
        const collection = `collection${suffix}`;
        const counter = `i${suffix}`;
        const valueReference = `iv${suffix}`;
        const loopLocals = new Map(locals);
        if (node.variables.length === 1) loopLocals.set(node.variables[0]!, valueReference);
        else {
          loopLocals.set(node.variables[0]!, `ii${suffix}`);
          loopLocals.set(node.variables[1]!, valueReference);
        }
        const bindings = node.variables.length === 1
          ? `const ${valueReference}=r.valueRef(${collection}[${counter}]);`
          : `const ii${suffix}=r.valueRef(r.iterationKey(${collection},${counter}));const ${valueReference}=r.valueRef(r.iterationValue(${collection},${counter}));`;
        const liveValues = liveMapIterations.has(node.collection) ? ",true" : "";
        return `(()=>{let ${result}=NaN;${initializeOnce}const ${collection}=r.iterable(${evaluatedExpression(node.collection, locals, scope, historySamples?.byBar)}${liveValues});for(let ${counter}=0;${once ? `${first}&&` : ""}${counter}<${collection}.length;${counter}+=1){${enterOnce}r.loop();${bindings}${loopExpressionBlock(node.body, result, loopLocals, scope)}}return ${result};})()`;
      }
      case "switch": {
        const discriminant = node.discriminant === undefined ? undefined : `const $switch=${expression(node.discriminant, locals, scope)};`;
        const cases = node.cases.map((entry) => {
          const branchScope = scopedCallId(scope, nextCallId++);
          if (entry.test === undefined) return `{${expressionBranch(entry.body, locals, branchScope)}}`;
          const test = expression(entry.test, locals, scope);
          const condition = discriminant === undefined ? `r.truthy(${test})` : `r.truthy(r.binary("==",$switch,${test}))`;
          return `if(${condition}){${expressionBranch(entry.body, locals, branchScope)}}`;
        });
        const fallback = modernV6 && semantic?.typeOf(node).kind === "bool" ? "false" : "NaN";
        return `(()=>{${discriminant ?? ""}${cases.join("else ")}return ${fallback};})()`;
      }
      case "tuple":
        return `[${node.elements.map((element) => expression(element, locals, scope)).join(",")}]`;
      case "call": {
        const name = callableName(node.callee);
        const callId = nextCallId++;
        if (productionProfile) callSites[callId] = node.range;
        const typeName = name.endsWith(".new") ? name.slice(0, -4) : "";
        const type = types.get(typeName);
        if (type !== undefined) {
          const ordered = semantic?.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered
            ?? bindArguments(typeName, node.arguments, node.range, type.fields.map((field) => field.name),
              type.fields.filter((field) => productionProfile || field.defaultValue !== undefined).map((field) => field.name));
          const fields = type.fields.map((field, index) => {
            const value = ordered[index] ?? field.defaultValue;
            const fallback = productionProfile && field.dataType === "bool" ? "false" : "NaN";
            return `${JSON.stringify(field.name)}:${value === undefined ? fallback : expression(value, locals, scope)}`;
          });
          return `r.object(${JSON.stringify(typeName)},{${fields.join(",")}})`;
        }
        const copyTypeName = name.endsWith(".copy") ? name.slice(0, -5) : "";
        if (types.has(copyTypeName)) {
          const source = bindArguments(name, node.arguments, node.range, ["source"])[0];
          return source === undefined ? "NaN" : `r.copyObject(${expression(source, locals, scope)},${JSON.stringify(copyTypeName)})`;
        }
        if (name === "request.security" || name === "request.security_lower_tf") {
          bindArguments(name, node.arguments, node.range);
          const requestId = requestIds.get(node.range.start.offset);
          if (requestId === null) return "NaN";
          if (requestId === undefined) {
            diagnostics.push({ severity: "error", code: "SCRIPT2011", message: "request.security requires a compiled child plan", range: node.range });
            return "NaN";
          }
          if (dynamicRequestIds.has(requestId)) {
            const ordered = bindArguments(name, node.arguments, node.range);
            return `r.dynamicRequest(${JSON.stringify(requestId)},${expression(ordered[0]!, locals, scope)},${expression(ordered[1]!, locals, scope)})`;
          }
          return `r.request(${JSON.stringify(requestId)})`;
        }
        if (productionProfile && name === "max_bars_back" && !functions.has(name)) {
          bindArguments(name, node.arguments, node.range, ["var", "num"]);
          return "NaN";
        }
        if (name === "alert") {
          const ordered = bindArguments(name, node.arguments, node.range);
          const message = ordered[0];
          const frequency = ordered[1];
          const alertId = `alert_${String(nextAlertId++)}`;
          return `r.alert(${JSON.stringify(alertId)},${expression(message ?? { kind: "literal", value: "", range: node.range }, locals, scope)},${frequency === undefined ? "undefined" : expression(frequency, locals, scope)})`;
        }
        if (name === "alertcondition") {
          const ordered = bindArguments(name, node.arguments, node.range);
          const condition = ordered[0];
          const titleNode = ordered[1];
          const messageNode = ordered[2];
          const resolvedString = (value: ExpressionNode | undefined): string | undefined => {
            if (value === undefined) return undefined;
            const constant = productionProfile ? semantic?.constantValueOf(value) : declarationStaticValue(value);
            return typeof constant === "string" ? constant : undefined;
          };
          if (productionProfile) {
            for (const [optionName, optionNode] of [["title", titleNode], ["message", messageNode]] as const) {
              if (optionNode !== undefined && resolvedString(optionNode) === undefined) {
                diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `alertcondition() ${optionName} must resolve to a constant string for stable alert metadata`, range: optionNode.range });
              }
            }
          }
          const alertId = `alertcondition_${String(nextAlertConditionId++)}`;
          const title = resolvedString(titleNode) ?? "";
          const message = resolvedString(messageNode) ?? "";
          countPlots(1, node);
          alerts.push({ id: alertId, title, message });
          return `r.alertCondition(${JSON.stringify(alertId)},${expression(condition ?? { kind: "literal", value: false, range: node.range }, locals, scope)},${expression(titleNode ?? { kind: "literal", value: "", range: node.range }, locals, scope)},${expression(messageNode ?? { kind: "literal", value: "", range: node.range }, locals, scope)})`;
        }
        const strategySignature = productionProfile && program.version === 5
          ? PINE_V5_STRATEGY_CALL_SIGNATURES[name]
          : strategyCallSignatures[name];
        const builtinSignature = drawingCallSignature(name, node, chartPointVariables) ?? strategySignature;
        if (builtinSignature !== undefined) {
          const definition = PINE_CALLABLE_METADATA[name];
          const optional = productionProfile && program.version === 5 && builtinSignature.at(-1) === "when"
            ? [...(definition?.optionalParameters ?? []), "when"]
            : definition?.optionalParameters;
          const ordered = bindArguments(name, node.arguments, node.range, builtinSignature, optional);
          return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${ordered.map((argument) => argument === undefined ? "undefined" : expression(argument, locals, scope)).join(",")}])`;
        }
        const receiverCall = node.callee.kind === "member"
          && (node.callee.object.kind !== "identifier" || locals.has(node.callee.object.name) || variables.has(node.callee.object.name));
        const genericArguments = functions.has(name) || methods.has(name) || runtimeCallSignatures[name] !== undefined || receiverCall
          ? node.arguments.map((argument) => argument.value)
          : bindArguments(name, node.arguments, node.range);
        const args = genericArguments.map((argument) => argument === undefined ? "undefined" : expression(argument, locals, scope));
        if (name === "plot") {
          const plotId = `plot-${nextPlotId++}`;
          const signature = PINE_PLOT_CALL_SIGNATURES.plot!;
          const ordered = bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA.plot?.optionalParameters);
          const titleNode = ordered[1];
          const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 2, (value) => expression(value, locals, scope));
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          countPlots(countPlotOptions(1, ordered, signature, ["color"]), node);
          plots.push({ id: plotId, title });
          return `r.plot(${JSON.stringify(plotId)},${expression(ordered[0] ?? { kind: "literal", value: null, range: node.range }, locals, scope)},${JSON.stringify(title)},{${optionEntries.join(",")}})`;
        }
        if (name === "hline" && productionProfile) {
          const plotId = `plot-${nextPlotId++}`;
          const signature = PINE_CALLABLE_METADATA.hline!.parameters;
          const ordered = bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA.hline?.optionalParameters);
          const staticTitle = ordered[1] && staticInputValue(ordered[1], enumValues, topLevelValues, new Set(), semantic);
          const title = typeof staticTitle === "string" ? staticTitle : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 2, (value) => expression(value, locals, scope));
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          plots.push({ id: plotId, title });
          return `r.hline(${JSON.stringify(plotId)},${expression(ordered[0]!, locals, scope)},${JSON.stringify(title)},{${optionEntries.join(",")}})`;
        }
        if (name === "fill") {
          const plotId = `plot-${nextPlotId++}`;
          const semanticSignature = semantic?.callBindingAt(node.range.start.offset, node.range.end.offset)?.signature;
          const gradient = semanticSignature?.includes("top_value")
            ?? node.arguments.some((argument) => ["top_value", "bottom_value", "top_color", "bottom_color"].includes(argument.name ?? ""));
          const hline = semanticSignature?.includes("hline1")
            ?? node.arguments.some((argument) => ["hline1", "hline2"].includes(argument.name ?? ""));
          const signature = semanticSignature ?? (gradient
            ? hline ? PINE_FILL_CALL_SIGNATURES.gradientHline : PINE_FILL_CALL_SIGNATURES.gradient
            : hline ? PINE_FILL_CALL_SIGNATURES.hline : PINE_FILL_CALL_SIGNATURES.plot);
          const ordered = bindArguments(name, node.arguments, node.range, signature, signature.slice(2));
          const titleNode = ordered[gradient ? 6 : 3];
          const staticTitle = titleNode && staticInputValue(titleNode, enumValues, topLevelValues, new Set(), semantic);
          const title = typeof staticTitle === "string" ? staticTitle : "Fill";
          const options = callOptions(node, signature, 2, (value) => expression(value, locals, scope));
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          // A constant fill is free in Pine's plot-count budget.  Series
          // colors add one count; we conservatively charge only the forms
          // that are statically known to be series.
          const colorNodes = gradient ? [ordered[4], ordered[5]] : [ordered[2]];
          if (colorNodes.some((colorNode) => isSeriesExpression(colorNode, topLevelValues, new Set(), semantic))) countPlots(1, node);
          plots.push({ id: plotId, title });
          return `r.fill(${JSON.stringify(plotId)},${ordered[0] === undefined ? "NaN" : expression(ordered[0], locals, scope)},${ordered[1] === undefined ? "NaN" : expression(ordered[1], locals, scope)},${JSON.stringify(title)},{${optionEntries.join(",")}})`;
        }
        if (node.callee.kind === "member") {
          const overloads = methods.get(node.callee.property);
          const selected = semantic?.methodCandidatesAt(node.range.start.offset, node.range.end.offset);
          if (overloads !== undefined && (selected?.size !== 1 || !selected.has(undefined))) {
            return userMethodDispatch(
              node.callee.object,
              node.callee.property,
              node.arguments,
              selected === undefined ? overloads : overloads.filter((method) => [...selected].some((candidate) => candidate !== undefined && candidate.range.start.offset === method.range.start.offset)),
              callId,
              locals,
              scope,
              semantic?.callBindingAt(node.range.start.offset, node.range.end.offset),
            );
          }
          if (productionProfile && node.callee.property === "copy") {
            const receiver = semantic?.typeOf(node.callee.object);
            const type = receiver?.kind === "udt" && receiver.name !== undefined ? types.get(receiver.name) : undefined;
            const field = type?.fields[0];
            if (type !== undefined && field !== undefined) {
              const value = expression(node.callee.object, locals, scope);
              const location = `{id:${scopedCallId(scope, callId)},name:${JSON.stringify(field.name)}}`;
              return `r.copyObject(${value},${JSON.stringify(type.name)},${location})`;
            }
          }
          const namespaceRoot = memberRootIdentifier(node.callee);
          if (namespaceRoot !== undefined && namespaceCallRoots.has(namespaceRoot)) {
            if (productionProfile && currentProfileRuntimeCalls.has(name) && runtimeCallSignatures[name] !== undefined) {
              const ordered = bindArguments(name, node.arguments, node.range, runtimeCallSignatures[name], runtimeOptionalParameters[name]);
              return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${ordered.map((argument) => argument === undefined ? "undefined" : expression(argument, locals, scope)).join(",")}])`;
            }
            const typedArrayConstructor = memberName(node.callee) === "array.new"
              && node.callee.typeArguments?.[0] !== undefined
              && (types.has(node.callee.typeArguments[0]) || enums.has(node.callee.typeArguments[0]));
            if (productionProfile && !knownBuiltinCalls.has(name) && !typedArrayConstructor) {
              diagnostics.push({ severity: "error", code: "SCRIPT2015", message: `Unknown namespace callable '${name}'`, range: node.range });
              return "NaN";
            }
            const source = genericArguments[0];
            if (modernV6 && name === "str.tostring" && args[0] !== undefined) {
              const type = semantic?.typeOf(source);
              if (type?.kind === "bool" && type.qualifier === "const") args[0] = `r.truthy(${args[0]})`;
            }
            const sourceReference = source === undefined ? undefined : seriesReferenceExpression(source, locals);
            if (sourceReference !== undefined && backfillableTaCalls.has(name)) {
              return `r.callWithSource(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${args.join(",")}],${sourceReference})`;
            }
            if (productionProfile && name === "array.join" && isFloatArray(source)) {
              if (args.length === 1) args.push("undefined");
              args.push(JSON.stringify("float"));
            }
            if (productionProfile && name === "matrix.new") {
              const element = semantic?.typeOf(node).arguments?.[0]?.kind;
              args.push(JSON.stringify(element === "int" || element === "float" ? element : "other"));
            }
            if (productionProfile && ["matrix.sum", "matrix.diff", "matrix.mult"].includes(name)
              && ["matrix", "array"].includes(semantic?.typeOf(node).kind ?? "")) {
              args.push(JSON.stringify(semantic?.typeOf(node).arguments?.[0]?.kind));
            }
            return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${args.join(",")}])`;
          }
        }
        if (node.callee.kind === "member" && node.callee.object.kind === "identifier") {
          const receiverName = node.callee.object.name;
          if (locals.has(receiverName) || variables.has(receiverName)) {
            const receiverArgs = receiverCallArguments(node, locals, scope);
            const providerNamespace = providerReferenceNamespace(node.callee.object);
            if (providerNamespace !== undefined) {
              return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(`${providerNamespace}.${node.callee.property}`)},[${[expression(node.callee.object, locals, scope), ...receiverArgs].join(",")}])`;
            }
            if (productionProfile && ["sum", "diff", "mult"].includes(node.callee.property)
              && ["matrix", "array"].includes(semantic?.typeOf(node).kind ?? "")) receiverArgs.push(JSON.stringify(semantic?.typeOf(node).arguments?.[0]?.kind));
            return `r.method(${scopedCallId(scope, callId)},${expression(node.callee.object, locals, scope)},${JSON.stringify(node.callee.property)},[${receiverArgs.join(",")}]${arrayReceiverHint(node.callee.object)})`;
          }
        }
        if (node.callee.kind === "member" && node.callee.object.kind !== "identifier") {
          const receiverArgs = receiverCallArguments(node, locals, scope);
          const providerNamespace = providerReferenceNamespace(node.callee.object);
          if (providerNamespace !== undefined) {
            return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(`${providerNamespace}.${node.callee.property}`)},[${[expression(node.callee.object, locals, scope), ...receiverArgs].join(",")}])`;
          }
          if (productionProfile && ["sum", "diff", "mult"].includes(node.callee.property)
            && ["matrix", "array"].includes(semantic?.typeOf(node).kind ?? "")) receiverArgs.push(JSON.stringify(semantic?.typeOf(node).arguments?.[0]?.kind));
          return `r.method(${scopedCallId(scope, callId)},${expression(node.callee.object, locals, scope)},${JSON.stringify(node.callee.property)},[${receiverArgs.join(",")}]${arrayReceiverHint(node.callee.object)})`;
        }
        const userFunction = functions.get(name);
        if (userFunction !== undefined) {
          const key = scopedCallId(scope, callId);
          const orderedArguments = bindArguments(
            name,
            node.arguments,
            node.range,
            userFunction.parameters.map((parameter) => parameter.name),
            userFunction.parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name),
          );
          const references = orderedArguments.map((argument, index) => argument === undefined ? "undefined" : `r.argumentRef(${key},${index},${expression(argument, locals, scope)})`);
          return `${functionName(name)}(${key},${references.join(",")})`;
        }
        const directMethods = methods.get(name);
        const directReceiver = node.arguments[0]?.value;
        if (directMethods !== undefined && directReceiver !== undefined) {
          const selected = semantic?.methodCandidatesAt(node.range.start.offset, node.range.end.offset);
          return userMethodDispatch(
            directReceiver,
            name,
            node.arguments.slice(1),
            selected === undefined ? directMethods : directMethods.filter((method) => [...selected].some((candidate) => candidate !== undefined && candidate.range.start.offset === method.range.start.offset)),
            callId,
            locals,
            scope,
            semantic?.callBindingAt(node.range.start.offset, node.range.end.offset),
          );
        }
        if (name === "input" || name.startsWith("input.")) {
          const title = node.arguments.find((argument) => argument.name === "title")?.value ?? node.arguments[1]?.value;
          const resolvedTitle = staticInputValue(title, enumValues, topLevelValues, new Set(), semantic);
          const titleValue = typeof resolvedTitle === "string" ? resolvedTitle : "";
          const defaultNode = node.arguments.find((argument) => argument.name === "defval")?.value ?? node.arguments[0]?.value;
          const inputType = name === "input" ? inferInputType(defaultNode, semantic) : name.slice("input.".length) as InputDefinition["type"];
          const defaultValue = inputDefaultValue(defaultNode, inputType, enumValues, topLevelValues, semantic);
          const inputId = inputVariableIds.get(node.range.start.offset) ?? `input-${inputs.length}`;
          const descriptorOptions = inputDescriptorOptions(node, inputType, enumValues, topLevelValues, semantic);
          const enumTypeName = inputType === "enum" ? semantic?.typeOf(defaultNode).name : undefined;
          const implicitEnumOptions = productionProfile && descriptorOptions.options === undefined && enumTypeName !== undefined
            ? enumDomains.get(enumTypeName)
            : undefined;
          const definition: InputDefinition = {
            id: inputId,
            type: inputType,
            title: titleValue,
            defaultValue,
            ...descriptorOptions,
            ...(implicitEnumOptions === undefined ? {} : { options: implicitEnumOptions }),
          };
          inputs.push(definition);
          inputIdsByOffset.set(node.range.start.offset, inputId);
          if (productionProfile) diagnostics.push(...inputDescriptorDiagnostics(node, definition));
          return `r.input(${JSON.stringify(inputId)},${JSON.stringify(titleValue)},${defaultNode === undefined ? "NaN" : expression(defaultNode, locals, scope)},${JSON.stringify(inputType)})`;
        }
        const strictScalarStateCall = name === "fixnan" || name === "nz";
        if (runtimeCallSignatures[name] !== undefined && (productionProfile || (!strictScalarStateCall && !currentProfileRuntimeCalls.has(name)))) {
          const ordered = bindArguments(name, node.arguments, node.range, runtimeCallSignatures[name], runtimeOptionalParameters[name]);
          const runtimeArguments = ordered.map((argument) => argument === undefined ? "undefined" : expression(argument, locals, scope));
          if (productionProfile && name === "nz") {
            runtimeArguments.push(JSON.stringify(semantic?.typeOf(ordered[0]).kind ?? "unknown"));
          }
          return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${runtimeArguments.join(",")}])`;
        }
        if (productionProfile && !knownBuiltinCalls.has(name)) {
          diagnostics.push({
            severity: "error",
            code: "SCRIPT2015",
            message: node.callee.kind === "member" ? `Unknown namespace callable '${name}'` : `Unknown callable '${name}'`,
            range: node.range,
          });
          return "NaN";
        }
        return `r.call(${scopedCallId(scope, callId)},${JSON.stringify(name)},[${args.join(",")}])`;
      }
    }
  };

  function withHistorySamples(
    emit: () => string,
    byBar: boolean,
    combine: (records: readonly string[], emitted: string) => string,
  ): string {
    if (!productionProfile) return emit();
    const outer = historySamples;
    const records: string[] = [];
    historySamples = { byBar, reads: new Map(), records };
    const emitted = emit();
    historySamples = outer;
    return records.length === 0 ? emitted : combine(records, emitted);
  }

  /** Emit history samples at the expression's evaluation point, before its effects. */
  function evaluatedExpression(node: ExpressionNode, locals?: ReadonlyMap<string, string>, scope?: string, byBar = scope === undefined): string {
    return withHistorySamples(() => {
      const value = expression(node, locals, scope);
      const coercion = semantic?.v5BooleanCoercions.get(node);
      if (coercion === undefined) return value;
      const castId = nextCallId++;
      callSites[castId] = node.range;
      const input = coercion === "truncate" ? `r.call(${scopedCallId(scope, castId)},"int",[${value}])` : value;
      return `r.call(${scopedCallId(scope, castId)},"bool",[${input}])`;
    }, byBar, (records, value) => `(${records.join(",")},${value})`);
  }

  /** Visual statements can use one option in both metadata and point output. Sample it once. */
  function evaluatedVisual(emit: () => string): string {
    return withHistorySamples(emit, true, (records, statement) => `${records.join(";")};${statement}`);
  }

  /** A nested history read is eligible only if its value and offset are also call-free. */
  function callFreeExpression(node: ExpressionNode): boolean {
    switch (node.kind) {
      case "literal":
      case "identifier":
        return true;
      case "member":
        return callFreeExpression(node.object);
      case "unary":
        return callFreeExpression(node.argument);
      case "binary":
        return callFreeExpression(node.left) && callFreeExpression(node.right);
      case "history":
        return callFreeExpression(node.value) && callFreeExpression(node.offset);
      case "conditional":
        return callFreeExpression(node.test) && callFreeExpression(node.consequent) && callFreeExpression(node.alternate);
      default:
        return false;
    }
  }

  /** The builtin variable a history operand names, when it is a runtime constant or zero-argument call. */
  function builtinVariableName(node: ExpressionNode, locals: ReadonlyMap<string, string>): string | undefined {
    if (node.kind === "identifier") {
      if (locals.has(node.name) || variables.has(node.name)) return undefined;
      return runtimeFields.has(node.name) ? node.name : undefined;
    }
    if (node.kind !== "member") return undefined;
    const name = memberName(node);
    const root = memberRootIdentifier(node);
    if (root === undefined || locals.has(root) || variables.has(root) || enumValues.has(name)) return undefined;
    if (zeroArgumentCalls.has(name) || isPineShadowingNamespaceConstant(name)) return name;
    return knownBuiltinVariables.has(name) && knownNamespaceRoots.has(root) ? name : undefined;
  }

  function directSeriesHistory(node: ExpressionNode, offset: string, locals: ReadonlyMap<string, string>): string | undefined {
    const properties: string[] = [];
    let root = node;
    while (root.kind === "member") {
      properties.unshift(root.property);
      root = root.object;
    }
    if (properties.length === 0 || root.kind !== "identifier") return undefined;
    const local = locals.get(root.name);
    const variable = variables.get(root.name);
    let value = local !== undefined
      ? `${local}.get(${offset})`
      : variable !== undefined
        ? `r.get(${variable},${offset})`
        : marketFields.has(root.name)
          ? `r.data(${JSON.stringify(root.name)},${offset})`
          : undefined;
    if (value === undefined) return undefined;
    for (const property of properties) value = `r.property(${value},${JSON.stringify(property)})`;
    return value;
  }

  function seriesReferenceExpression(node: ExpressionNode, locals: ReadonlyMap<string, string>): string | undefined {
    if (node.kind !== "identifier") return undefined;
    const local = locals.get(node.name);
    if (local !== undefined) return local;
    const variable = variables.get(node.name);
    if (variable !== undefined) return `r.variableRef(${variable})`;
    return marketFields.has(node.name) ? `r.dataRef(${JSON.stringify(node.name)})` : undefined;
  }

  function isFloatArray(node: ExpressionNode | undefined): boolean {
    const type = semantic?.typeOf(node);
    return type?.kind === "array" && type.arguments?.[0]?.kind === "float";
  }

  function receiverCallArguments(
    node: CallNode,
    locals: ReadonlyMap<string, string>,
    scope?: string,
  ): string[] {
    const property = node.callee.kind === "member" ? node.callee.property : "";
    const args = node.arguments;
    const builtin = builtinReceiverCallDefinition(property, args);
    const signature = drawingReceiverCallSignature(property, args) ?? builtin?.signature;
    const ordered = signature === undefined
      ? (productionProfile && args.some((argument) => argument.name !== undefined)
        ? bindArguments(property, args, node.range)
        : args.map((argument) => argument.value))
      : bindArguments(builtin?.callable ?? property, args, node.range, signature, builtin?.optionalParameters);
    const emitted = ordered.map((argument) => argument === undefined ? "undefined" : expression(argument, locals, scope));
    if (productionProfile && property === "join" && node.callee.kind === "member" && isFloatArray(node.callee.object)) {
      if (emitted.length === 0) emitted.push("undefined");
      emitted.push(JSON.stringify("float"));
    }
    return emitted;
  }

  function userMethodDispatch(
    receiver: ExpressionNode,
    name: string,
    args: readonly CallArgumentNode[],
    overloads: readonly MethodDeclarationNode[],
    callId: number,
    locals: ReadonlyMap<string, string>,
    scope?: string,
    semanticBinding?: CallArgumentBinding,
  ): string {
    const key = scopedCallId(scope, callId);
    const declaredReceiver = overloads[0]?.parameters[0]?.dataType;
    const inferredReceiver = semantic?.typeOf(receiver);
    const staticallySelected = semanticBinding !== undefined && overloads.length === 1 && declaredReceiver !== undefined
      && (isStaticPrimitiveReceiver(declaredReceiver) || (modernV6
        && (inferredReceiver?.kind === "udt" || inferredReceiver?.kind === "enum")
        && inferredReceiver.name === declaredReceiver));
    const branches = overloads.map((definition) => {
      const receiverType = definition.parameters[0]!.dataType!;
      const methodArguments = semanticBinding?.ordered ?? bindArguments(
          name,
          args,
          receiver.range,
          definition.parameters.slice(1).map((parameter) => parameter.name),
          definition.parameters.slice(1).filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name),
        );
      const orderedArguments = [receiver, ...methodArguments];
      const references = orderedArguments.map((argument, index) => {
        if (argument === undefined) return "undefined";
        const value = index === 0 ? "$receiver" : expression(argument, locals, scope);
        return `r.argumentRef(${key},${index},${value})`;
      });
      if (staticallySelected) {
        return `${methodFunctionName(definition, methods.get(name) ?? overloads, methodReferenceTypes)}(${key},${references.join(",")})`;
      }
      return `r.objectType($receiver)===${JSON.stringify(receiverType)}?${methodFunctionName(definition, methods.get(name) ?? overloads, methodReferenceTypes)}(${key},${references.join(",")}):`;
    });
    const fallbackArgs = args.map((argument) => expression(argument.value, locals, scope));
    const fallback = `r.method(${key},$receiver,${JSON.stringify(name)},[${fallbackArgs.join(",")}]${arrayReceiverHint(receiver)})`;
    return `(($receiver)=>${branches.join("")}${staticallySelected ? "" : fallback})(${expression(receiver, locals, scope)})`;
  }

  const valueBlockContext = {
    expression: (node: ExpressionNode, locals: ReadonlyMap<string, string>, scope?: string) =>
      evaluatedExpression(node, locals, scope, false),
    childScope: (scope?: string) => scopedCallId(scope, nextCallId++),
    globalId: (name: string) => variables.get(name),
    diagnostics,
  };

  function expressionBranch(block: readonly ProgramNode["statements"][number][], locals: ReadonlyMap<string, string>, scope?: string): string {
    if (productionProfile) return `let $blockResult=NaN;${generateValueBlock(block, "$blockResult", locals, scope, valueBlockContext)}return $blockResult;`;
    const code: string[] = [];
    const branchLocals = new Map(locals);
    const declarations = block.filter((statement): statement is Extract<StatementNode, { kind: "declaration" }> => statement.kind === "declaration");
    for (const declaration of declarations) branchLocals.set(declaration.name, `$branchLocal${String(declaration.range.start.offset)}`);
    for (const [index, statement] of block.entries()) {
      const isLast = index === block.length - 1;
      if (statement.kind === "declaration") {
        const local = branchLocals.get(statement.name)!;
        code.push(`const ${local}=r.localRef(${scope ?? String(nextCallId++)},${String(declarations.indexOf(statement))},()=>${expression(statement.value, branchLocals, scope)},${JSON.stringify(statement.persistence)});`);
      } else if (statement.kind === "expression") code.push(`${isLast ? "return " : ""}${expression(statement.expression, branchLocals, scope)};`);
      else if (statement.kind === "assignment") {
        const local = branchLocals.get(statement.name);
        const id = variables.get(statement.name);
        if (local !== undefined) code.push(`r.assignRef(${local},${expression(statement.value, branchLocals, scope)});`);
        else if (id !== undefined) code.push(`r.set(${id},${expression(statement.value, branchLocals, scope)});`);
        else diagnostics.push({ severity: "error", code: "SCRIPT2004", message: `Unknown variable '${statement.name}'`, range: statement.range });
      } else if (statement.kind === "member_assignment") {
        code.push(`${emitMemberAssignment(statement, expression, branchLocals, scope)};`);
      } else if (statement.kind === "if") {
        const consequentScope = scopedCallId(scope, nextCallId++);
        const alternateScope = scopedCallId(scope, nextCallId++);
        code.push(`if(r.truthy(${expression(statement.test, branchLocals, scope)})){${expressionBranch(statement.consequent, branchLocals, consequentScope)}}else{${expressionBranch(statement.alternate, branchLocals, alternateScope)}}`);
      } else if (statement.kind === "once") {
        const onceScope = scopedCallId(scope, nextCallId++);
        code.push(`if(r.once(${onceScope},()=>${expression(statement.test, branchLocals, scope)})){${expressionBranch(statement.body, branchLocals, onceScope)}r.commitOnce(${onceScope});}`);
      } else {
        diagnostics.push({ severity: "error", code: "SCRIPT2009", message: "Declarations inside if expressions are not supported yet", range: statement.range });
      }
    }
    if (block.at(-1)?.kind !== "expression" && block.at(-1)?.kind !== "if") code.push("return NaN;");
    return code.join("");
  }

  function loopExpressionBlock(block: readonly StatementNode[], result: string, locals: ReadonlyMap<string, string>, scope?: string, captureResult = true): string {
    if (productionProfile) return generateValueBlock(block, result, locals, scope, valueBlockContext, 1, captureResult);
    const code: string[] = [];
    for (const statement of block) {
      if (statement.kind === "expression") code.push(`${result}=${expression(statement.expression, locals, scope)};`);
      else if (statement.kind === "assignment") {
        const local = locals.get(statement.name);
        const id = variables.get(statement.name);
        if (local !== undefined) code.push(`r.assignRef(${local},${expression(statement.value, locals, scope)});`);
        else if (id !== undefined) code.push(`r.set(${id},${expression(statement.value, locals, scope)});`);
        else diagnostics.push({ severity: "error", code: "SCRIPT2004", message: `Unknown variable '${statement.name}'`, range: statement.range });
      } else if (statement.kind === "member_assignment") code.push(`${emitMemberAssignment(statement, expression, locals, scope)};`);
      else if (statement.kind === "if") code.push(`if(r.truthy(${expression(statement.test, locals, scope)})){${loopExpressionBlock(statement.consequent, result, locals, scope)}}else{${loopExpressionBlock(statement.alternate, result, locals, scope)}}`);
      else if (statement.kind === "once") {
        const onceScope = scopedCallId(scope, nextCallId++);
        code.push(`if(r.once(${onceScope},()=>${expression(statement.test, locals, scope)})){${loopExpressionBlock(statement.body, result, locals, onceScope, false)}r.commitOnce(${onceScope});}`);
      }
      else if (statement.kind === "break" || statement.kind === "continue") code.push(`${statement.kind};`);
      else diagnostics.push({ severity: "error", code: "SCRIPT2009", message: "This statement is not supported inside a loop expression yet", range: statement.range });
    }
    return code.join("");
  }

  const functionDefinitions: string[] = [];
  const callableDefinitions = [
    ...[...functions.values()].map((definition) => ({ definition, emittedName: functionName(definition.name) })),
    ...[...methods.values()].flatMap((overloads) => overloads.map((definition) => ({ definition, emittedName: methodFunctionName(definition, overloads, methodReferenceTypes) }))),
  ];
  for (const { definition, emittedName } of callableDefinitions) {
    activeFunctionHistoryLimits = functionHistoryLimits.get(definition);
    const locals = new Map(definition.parameters.map((parameter, index) => [parameter.name, `p${index}`]));
    const parameters = definition.parameters.map((parameter, index) => {
      const fallback = parameter.defaultValue === undefined ? "r.valueRef(NaN)" : `r.valueRef(${expression(parameter.defaultValue, locals, "$scope")})`;
      return `p${index}=${fallback}`;
    });
    const allocator: FunctionLocalAllocator = {
      nextId: 0,
      parameterCount: definition.parameters.length,
      slots: new Map(),
    };
    const body = productionProfile
      ? `let $functionResult=NaN;${generateValueBlock(definition.body, "$functionResult", locals, "$scope", valueBlockContext)}return $functionResult;`
      : functionStatementBlock(
      definition.body,
      locals,
      "$scope",
      expression,
      diagnostics,
      allocator,
      0,
      true,
      false,
      modernV6,
      productionProfile,
    );
    functionDefinitions.push(`const ${emittedName}=($scope,${parameters.join(",")})=>{${body}};`);
  }
  activeFunctionHistoryLimits = undefined;

  const statements: string[] = [];
  for (const statement of program.statements) {
    if (statement.kind === "function" || statement.kind === "method" || statement.kind === "type" || statement.kind === "enum") continue;
    if (statement.kind === "tuple_declaration") {
      const temporary = `$tuple${String(statement.range.start.offset)}`;
      statements.push(`const ${temporary}=${evaluatedExpression(statement.value)};`);
      for (const [index, name] of statement.names.entries()) {
        if (name === "_") continue;
        const id = variables.get(name);
        if (id !== undefined) statements.push(`r.set(${id},r.tupleGet(${temporary},${String(index)}));`);
      }
      continue;
    }
    if (statement.kind === "declaration") {
      const id = variables.get(statement.name);
      if (id === undefined) continue;
      const value = evaluatedExpression(statement.value);
      const persistenceMode = productionProfile && statement.persistence === "varip" ? ',"varip"' : "";
      statements.push(statement.persistence === "bar" ? `r.set(${id},${value});` : `r.setPersistent(${id},()=>${value}${persistenceMode});`);
      continue;
    }
    if (statement.kind === "assignment") {
      const id = variables.get(statement.name);
      if (id === undefined) diagnostics.push({ severity: "error", code: "SCRIPT2004", message: `Unknown variable '${statement.name}'`, range: statement.range });
      else statements.push(`r.set(${id},${evaluatedExpression(statement.value)});`);
      continue;
    }
    if (statement.kind === "member_assignment") {
      statements.push(`${emitMemberAssignment(statement, evaluatedExpression)};`);
      continue;
    }
    if (statement.kind === "if") {
      statements.push(`if(r.truthy(${evaluatedExpression(statement.test)})){${topLevelBlock(statement.consequent, evaluatedExpression, variables, diagnostics, new Map(), 0, undefined, modernV6, productionProfile, liveMapIterations)}}else{${topLevelBlock(statement.alternate, evaluatedExpression, variables, diagnostics, new Map(), 0, undefined, modernV6, productionProfile, liveMapIterations)}}`);
      continue;
    }
    if (statement.kind === "once") {
      const onceScope = JSON.stringify(`once:${String(statement.range.start.offset)}`);
      statements.push(`if(r.once(${onceScope},()=>${evaluatedExpression(statement.test)})){${topLevelBlock(statement.body, evaluatedExpression, variables, diagnostics, new Map(), 0, onceScope, modernV6, productionProfile, liveMapIterations)}r.commitOnce(${onceScope});}`);
      continue;
    }
    if (statement.kind === "while" || statement.kind === "for" || statement.kind === "for_in") {
      statements.push(topLevelBlock([statement], evaluatedExpression, variables, diagnostics, new Map(), 0, undefined, modernV6, productionProfile, liveMapIterations));
      continue;
    }
    if (statement.kind === "break" || statement.kind === "continue") {
      diagnostics.push({ severity: "error", code: "SCRIPT2010", message: `'${statement.kind}' is only valid inside a loop`, range: statement.range });
      continue;
    }
    if (statement.kind !== "expression") continue;
    const node = statement.expression;
    if (node.kind === "call") {
      const name = callableName(node.callee);
      if (name === "indicator" || name === "strategy" || (productionProfile && name === "library")) {
        const declarationSignature = name === "indicator"
          ? indicatorDeclarationSignature
          : name === "strategy"
            ? strategyDeclarationSignature
            : libraryDeclarationSignature;
        const ordered = bindArguments(name, node.arguments, node.range, declarationSignature, declarationSignature.slice(1));
        const resolveOption = (optionNode: ExpressionNode | undefined): PineValue | undefined => {
          if (optionNode === undefined) return undefined;
          if (!productionProfile) return declarationStaticValue(optionNode);
          const constant = semantic?.constantValueOf(optionNode);
          if (constant !== undefined) return constant;
          if (optionNode.kind === "member" && optionNode.object.kind === "identifier"
            && ["currency", "format", "scale", "strategy"].includes(optionNode.object.name)) {
            return declarationStaticValue(optionNode);
          }
          return undefined;
        };
        if (name === "library") {
          diagnostics.push({
            severity: "error",
            code: "SCRIPT2017",
            message: "library() is a valid global declaration, but Lumen Script does not execute or export library programs",
            range: node.range,
          });
          continue;
        }
        declarationKind = name;
        const declarationOption = (optionName: string): ExpressionNode | undefined => ordered[declarationSignature.indexOf(optionName as never)];
        if (name === "strategy") {
          const fillRecalculationNode = declarationOption("calc_on_order_fills");
          const fillRecalculationValue = fillRecalculationNode === undefined
            ? undefined : declarationStaticValue(fillRecalculationNode);
          if (productionProfile && fillRecalculationNode !== undefined && fillRecalculationValue !== false
            && (!allowLumenChartsHistoricalFillSchedule || fillRecalculationValue !== true)) {
            diagnostics.push({
              severity: "error",
              code: "SCRIPT2019",
              message: allowLumenChartsHistoricalFillSchedule
                ? "The Lumen Charts historical fill schedule requires calc_on_order_fills=true as a literal"
                : "strategy() calc_on_order_fills is unsupported because Lumen Script does not recalculate after fills; omit it or use literal false",
              range: fillRecalculationNode.range,
            });
          }
          if (allowLumenChartsHistoricalFillSchedule) {
            for (const optionName of strategyDeclarationSignature) {
              const optionNode = declarationOption(optionName);
              if (optionNode !== undefined && declarationStaticValue(optionNode) === undefined) {
                diagnostics.push({
                  severity: "error",
                  code: "SCRIPT2020",
                  message: `The Lumen Charts historical fill schedule requires ${optionName} to use a literal or namespace constant`,
                  range: optionNode.range,
                });
              }
            }
            const requiredOptions = [
              ["calc_on_every_tick", false],
              ["process_orders_on_close", false],
              ["use_bar_magnifier", false],
              ["fill_orders_on_standard_ohlc", false],
              ["margin_long", 100],
              ["margin_short", 100],
              ["backtest_fill_limits_assumption", 0],
              ["currency", "NONE"],
            ] as const;
            for (const [optionName, requiredValue] of requiredOptions) {
              const optionNode = declarationOption(optionName);
              if (optionNode !== undefined && declarationStaticValue(optionNode) !== requiredValue) {
                diagnostics.push({
                  severity: "error",
                  code: "SCRIPT2020",
                  message: `The Lumen Charts historical fill schedule requires ${optionName} to be omitted or the literal ${String(requiredValue)}`,
                  range: optionNode.range,
                });
              }
            }
          }
          strategyConfig = extractStrategyConfig(node, productionProfile, program.version, resolveOption);
        }
        const titleNode = declarationOption("title");
        const resolvedTitle = resolveOption(titleNode);
        if (typeof resolvedTitle === "string") indicatorTitle = resolvedTitle;
        const value = (optionName: string): PineValue | undefined => resolveOption(declarationOption(optionName));
        if (productionProfile) {
          for (const optionName of declarationSignature) {
            const optionNode = declarationOption(optionName);
            if (optionNode !== undefined && optionName !== "max_bars_back" && value(optionName) === undefined) {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} must be a literal or namespace constant`, range: optionNode.range });
            }
          }
          for (const optionName of ["title", "shorttitle", "timeframe", "currency"]) {
            const optionNode = declarationOption(optionName);
            if (optionNode !== undefined && typeof value(optionName) !== "string") {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} must be a constant string`, range: optionNode.range });
            }
          }
          for (const optionName of ["overlay", "timeframe_gaps", "explicit_plot_zorder", "dynamic_requests", "behind_chart", "calc_on_order_fills", "calc_on_every_tick", "process_orders_on_close", "use_bar_magnifier", "fill_orders_on_standard_ohlc"]) {
            const optionNode = declarationOption(optionName);
            if (optionNode !== undefined && typeof value(optionName) !== "boolean") {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} must be a constant boolean`, range: optionNode.range });
            }
          }
          for (const [optionName, choices] of [
            ["format", ["inherit", "price", "percent", "volume"]],
            ["scale", ["left", "right", "none"]],
            ["default_qty_type", ["fixed", "cash", "percent_of_equity"]],
            ["commission_type", ["percent", "cash_per_order", "cash_per_contract"]],
            ["close_entries_rule", ["FIFO", "ANY"]],
          ] as const) {
            const optionNode = declarationOption(optionName);
            if (optionNode !== undefined && !choices.includes(value(optionName) as never)) {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} has an unsupported value`, range: optionNode.range });
            }
          }
          for (const [optionName, minimum, maximum] of [
            ["precision", 0, 16], ["max_lines_count", 1, 500], ["max_labels_count", 1, 500],
            ["max_boxes_count", 1, 500], ["max_polylines_count", 1, 100],
            ["pyramiding", 0, 1000], ["slippage", 0, 1000000],
            ["backtest_fill_limits_assumption", 0, 1000000],
          ] as const) {
            const optionNode = declarationOption(optionName);
            if (optionNode === undefined) continue;
            const resolved = value(optionName);
            if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} must be an integer from ${minimum} to ${maximum}`, range: optionNode.range });
            }
          }
          for (const optionName of ["initial_capital", "default_qty_value", "commission_value", "margin_long", "margin_short", "risk_free_rate"]) {
            const optionNode = declarationOption(optionName);
            if (optionNode === undefined) continue;
            const resolved = value(optionName);
            if (typeof resolved !== "number" || !Number.isFinite(resolved) || (optionName !== "risk_free_rate" && resolved < 0)) {
              diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `${name}() ${optionName} must be a finite${optionName === "risk_free_rate" ? "" : " nonnegative"} number`, range: optionNode.range });
            }
          }
          for (const optionName of ["calc_on_every_tick", "fill_orders_on_standard_ohlc"]) {
            const optionNode = declarationOption(optionName);
            if (optionNode !== undefined && value(optionName) === true) {
              diagnostics.push({ severity: "error", code: "SCRIPT2020", message: `${name}() ${optionName}=true is unsupported in OHLC execution`, range: optionNode.range });
            }
          }
        }
        const shortTitleValue = value("shorttitle");
        if (typeof shortTitleValue === "string" && shortTitleValue) indicatorShortTitle = shortTitleValue;
        const overlayValue = value("overlay");
        if (typeof overlayValue === "boolean") overlay = overlayValue;
        const precisionValue = value("precision");
        if (typeof precisionValue === "number") {
          precision = Math.max(0, Math.trunc(precisionValue));
          precisionSpecified = true;
        }
        const formatValue = value("format");
        if (formatValue === "inherit" || formatValue === "price" || formatValue === "percent" || formatValue === "volume") format = formatValue;
        scaleExplicit = declarationOption("scale") !== undefined;
        const scaleValue = value("scale");
        if (scaleValue === "left" || scaleValue === "right" || scaleValue === "none") scale = scaleValue;
        const behindChartValue = value("behind_chart");
        if (typeof behindChartValue === "boolean") behindChart = behindChartValue;
        const explicitPlotZOrderValue = value("explicit_plot_zorder");
        if (typeof explicitPlotZOrderValue === "boolean") explicitPlotZOrder = explicitPlotZOrderValue;
        const dynamicRequestsValue = value("dynamic_requests");
        if (typeof dynamicRequestsValue === "boolean") dynamicRequests = dynamicRequestsValue;
        const maxBarsBackNode = declarationOption("max_bars_back");
        const maxBarsBackValue = productionProfile && maxBarsBackNode !== undefined
          ? semantic?.constantValueOf(maxBarsBackNode) ?? evaluateConstant(maxBarsBackNode, {
            identifier: () => undefined,
            arguments: (call) => call.arguments.map((argument) => argument.value),
            integerDivision: (candidate) => candidate.kind === "binary" && candidate.operator === "/"
              && candidate.forceFloatDivision !== true && program.version === 5
              && semantic?.typeOf(candidate.left).kind === "int" && semantic.typeOf(candidate.left).qualifier === "const"
              && semantic.typeOf(candidate.right).kind === "int" && semantic.typeOf(candidate.right).qualifier === "const",
          })
          : value("max_bars_back");
        if (productionProfile && maxBarsBackNode !== undefined
          && (semantic?.typeOf(maxBarsBackNode).kind !== "int" || typeof maxBarsBackValue !== "number"
            || !Number.isInteger(maxBarsBackValue) || maxBarsBackValue < 0 || maxBarsBackValue > 5000)) {
          diagnostics.push({ severity: "error", code: "SCRIPT2018", message: "Declaration max_bars_back must be a constant integer from 0 to 5000", range: maxBarsBackNode.range });
        } else if (typeof maxBarsBackValue === "number" && Number.isFinite(maxBarsBackValue)) maxBarsBack = maxBarsBackValue;
        if (name === "indicator") {
          timeframeSpecified = declarationOption("timeframe") !== undefined;
          const timeframeValue = value("timeframe");
          if (typeof timeframeValue === "string") timeframe = timeframeValue;
          timeframeGapsSpecified = declarationOption("timeframe_gaps") !== undefined;
          const timeframeGapsValue = value("timeframe_gaps");
          if (typeof timeframeGapsValue === "boolean") timeframeGaps = timeframeGapsValue;
          if (timeframeSpecified) {
            inputs.push(Object.freeze({
              id: PINE_MAIN_TIMEFRAME_INPUT_ID,
              type: "timeframe",
              title: "Timeframe",
              defaultValue: timeframe ?? "",
              group: "Calculation",
            }));
            inputs.push(Object.freeze({
              id: PINE_MAIN_TIMEFRAME_GAPS_INPUT_ID,
              type: "bool",
              title: "Wait for timeframe closes",
              defaultValue: timeframeGaps ?? true,
              group: "Calculation",
            }));
          }
        }
        const drawingLimit = (optionName: string, fallback: number, maximum: number): number => {
          const constant = value(optionName);
          return constant !== undefined
            && typeof constant === "number"
            ? Math.min(maximum, Math.max(1, Math.trunc(constant)))
            : fallback;
        };
        maxLinesCount = drawingLimit("max_lines_count", maxLinesCount, 500);
        maxLabelsCount = drawingLimit("max_labels_count", maxLabelsCount, 500);
        maxBoxesCount = drawingLimit("max_boxes_count", maxBoxesCount, 500);
        maxPolylinesCount = drawingLimit("max_polylines_count", maxPolylinesCount, 100);
        continue;
      }
      if (name === "plotbar" || name === "plotcandle") {
        statements.push(evaluatedVisual(() => {
          const plotId = `plot-${nextPlotId++}`;
          const signature = PINE_PLOT_CALL_SIGNATURES[name]!;
          const ordered = bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA[name]?.optionalParameters);
          const titleNode = ordered[4];
          const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 5, expression);
          const pointKeys = name === "plotbar" ? ["color"] : ["color", "wickcolor", "bordercolor"];
          const pointEntries = pointKeys
            .filter((key) => options.has(key))
            .map((key) => `${JSON.stringify(key)}:${options.get(key)}`);
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          const values = [0, 1, 2, 3].map((index) => expression(ordered[index] ?? { kind: "literal", value: null, range: node.range }));
          countPlots(countPlotOptions(4, ordered, signature, name === "plotbar" ? ["color"] : ["color", "wickcolor", "bordercolor"]), node);
          plots.push({ id: plotId, title });
          return `r.visual(${JSON.stringify(plotId)},${JSON.stringify(name === "plotbar" ? "bar" : "candle")},[${values.join(",")}],${JSON.stringify(title)},{${optionEntries.join(",")}},{${pointEntries.join(",")}});`;
        }));
        continue;
      }
      if (name === "plotchar" || name === "plotshape") {
        statements.push(evaluatedVisual(() => {
          const plotId = `plot-${nextPlotId++}`;
          const signature = PINE_PLOT_CALL_SIGNATURES[name]!;
          const ordered = bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA[name]?.optionalParameters);
          const titleNode = ordered[1];
          const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 2, expression);
          if (productionProfile) {
            if (!options.has("color")) options.set("color", JSON.stringify("#2962FF"));
            if (name === "plotchar" && !options.has("char")) options.set("char", JSON.stringify("★"));
            if (name === "plotshape" && !options.has("style")) options.set("style", JSON.stringify("shape_xcross"));
          }
          const pointKeys = name === "plotchar"
            ? productionProfile
              ? ["char", "color", "text", "textcolor", "location", "size", "offset"]
              : ["char", "color", "textcolor", "location", "size", "offset"]
            : ["text", "textcolor", "color", "offset", "style", "location", "size"];
          const pointEntries = pointKeys
            .filter((key) => options.has(key))
            .map((key) => `${JSON.stringify(key === "style" ? "shape" : key)}:${options.get(key)}`);
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          countPlots(countPlotOptions(1, ordered, signature, ["color", "textcolor"]), node);
          plots.push({ id: plotId, title });
          return `r.visual(${JSON.stringify(plotId)},${JSON.stringify(name === "plotchar" ? "char" : "shape")},${expression(ordered[0] ?? { kind: "literal", value: null, range: node.range })},${JSON.stringify(title)},{${optionEntries.join(",")}},{${pointEntries.join(",")}});`;
        }));
        continue;
      }
      if (name === "plotarrow") {
        statements.push(evaluatedVisual(() => {
          const plotId = `plot-${nextPlotId++}`;
          const signature = PINE_PLOT_CALL_SIGNATURES.plotarrow!;
          const ordered = bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA[name]?.optionalParameters);
          const titleNode = ordered[1];
          const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 2, expression);
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          const value = expression(ordered[0] ?? { kind: "literal", value: null, range: node.range });
          countPlots(countPlotOptions(1, ordered, signature, ["colorup", "colordown"]), node);
          plots.push({ id: plotId, title });
          return `r.arrow(${JSON.stringify(plotId)},${value},${JSON.stringify(title)},{${optionEntries.join(",")}});`;
        }));
        continue;
      }
      if (name === "bgcolor" || name === "barcolor") {
        statements.push(evaluatedVisual(() => {
          const plotId = `plot-${nextPlotId++}`;
          const signature = name === "bgcolor"
            ? ["color", "offset", "editable", "show_last", "title", "display", "force_overlay"]
            : ["color", "offset", "editable", "show_last", "title", "display"];
          bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA[name]?.optionalParameters);
          const titleNode = node.arguments.find((argument) => argument.name === "title")?.value ?? node.arguments[4]?.value;
          const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
          const options = callOptions(node, signature, 0, expression);
          const colorNode = node.arguments.find((argument) => argument.name === "color")?.value ?? node.arguments[0]?.value ?? { kind: "literal", value: null, range: node.range };
          const color = expression(colorNode);
          const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
          countPlots(1, node);
          plots.push({ id: plotId, title });
          const kind = JSON.stringify(name === "bgcolor" ? "background" : "barcolor");
          const visual = `r.visual(${JSON.stringify(plotId)},${kind},__visualColor,${JSON.stringify(title)},{${optionEntries.join(",")}},{"color":__visualColor});`;
          return productionProfile
            ? `{const __visualColor=${color};${visual}}`
            : `r.visual(${JSON.stringify(plotId)},${kind},r.truthy(${color}),${JSON.stringify(title)},{${optionEntries.join(",")}},{"color":${color}});`;
        }));
        continue;
      }
      if (name === "hline" && !productionProfile) {
        const plotId = `plot-${nextPlotId++}`;
        const signature = ["price", "title", "color", "linestyle", "linewidth", "editable", "display"];
        bindArguments(name, node.arguments, node.range, signature, PINE_CALLABLE_METADATA.hline?.optionalParameters);
        const titleNode = node.arguments.find((argument) => argument.name === "title")?.value ?? node.arguments[1]?.value;
        const title = titleNode?.kind === "literal" && typeof titleNode.value === "string" ? titleNode.value : defaultPlotTitle(plotId);
        const options = callOptions(node, signature, 2, expression);
        const priceNode = node.arguments.find((argument) => argument.name === "price")?.value ?? node.arguments[0]?.value ?? { kind: "literal", value: null, range: node.range };
        const optionEntries = [...options.entries()].map(([key, value]) => `${JSON.stringify(key)}:${value}`);
        const color = options.get("color");
        plots.push({ id: plotId, title });
        statements.push(`r.visual(${JSON.stringify(plotId)},"hline",${expression(priceNode)},${JSON.stringify(title)},{${optionEntries.join(",")}}${color === undefined ? ",{}" : `,{"color":${color}}`});`);
        continue;
      }
    }
    statements.push(`${evaluatedExpression(node)};`);
  }

  return {
    callSites: Object.freeze(callSites),
    generatedSource: `"use strict";return (r)=>{${functionDefinitions.join("")}${sampledBuiltins.size === 0 ? "" : `r.sampleBuiltins(${JSON.stringify([...sampledBuiltins])});`}${statements.join("")}};`,
    variableNames,
    indicatorTitle,
    descriptor: Object.freeze({
      version: program.version as PineVersion,
      kind: declarationKind,
      title: indicatorTitle,
      ...(productionProfile && indicatorShortTitle ? { shortTitle: indicatorShortTitle } : {}),
      overlay,
      format,
      precision,
      ...(precisionSpecified ? { precisionSpecified: true } : {}),
      scale,
      ...(productionProfile ? { scaleExplicit } : {}),
      behindChart,
      explicitPlotZOrder,
      ...(timeframe === undefined ? {} : { timeframe }),
      ...(timeframeSpecified ? { timeframeSpecified: true } : {}),
      ...(timeframeGaps === undefined ? {} : { timeframeGaps }),
      ...(timeframeGapsSpecified ? { timeframeGapsSpecified: true } : {}),
      ...(maxBarsBack === undefined ? {} : { maxBarsBack }),
      dynamicRequests,
      drawingLimits: Object.freeze({ lines: maxLinesCount, boxes: maxBoxesCount, labels: maxLabelsCount, polylines: maxPolylinesCount }),
      inputs: Object.freeze(inputs),
      plots: Object.freeze(plots),
      alerts: Object.freeze(alerts),
      ...(strategyConfig === undefined ? {} : { strategy: Object.freeze(strategyConfig) }),
    }),
    inputIdsByOffset,
    runtimeRequirements: requirements.snapshot(),
    diagnostics,
  };
}

function callOptions(
  node: Extract<ExpressionNode, { kind: "call" }>,
  signature: readonly string[],
  firstOption: number,
  expression: ExpressionGenerator,
): Map<string, string> {
  const options = new Map<string, string>();
  for (const [index, argument] of node.arguments.entries()) {
    const name = argument.name ?? signature[index];
    if (name !== undefined && signature.indexOf(name) >= firstOption && name !== "title") options.set(name, expression(argument.value));
  }
  return options;
}

function functionName(name: string): string {
  return `fn_${name}`;
}

function isStaticPrimitiveReceiver(receiverType: string): boolean {
  return ["bool", "color", "float", "int", "string"].includes(receiverType)
    || ["array<", "map<", "matrix<"].some((prefix) => receiverType.startsWith(prefix))
    || receiverType.endsWith("[]");
}

function methodFunctionName(method: MethodDeclarationNode, overloads: readonly MethodDeclarationNode[], referenceTypes: ReadonlySet<string>): string {
  const receiverType = method.parameters[0]!.dataType!;
  const safeReceiver = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(receiverType)
    ? receiverType : `$${encodeMethodSignature(receiverType)}`;
  const base = `method_${safeReceiver}_${method.name}`;
  if (overloads.filter((other) => other.parameters[0]?.dataType === receiverType).length === 1) return base;
  return `${base}$${encodeMethodSignature(methodRequiredSignature(method, referenceTypes))}`;
}

function encodeMethodSignature(signature: string): string {
  return Array.from(signature, (character) => character.codePointAt(0)!.toString(16)).join("_");
}

function scopedCallId(scope: string | undefined, callId: number): string {
  return scope === undefined ? String(callId) : `r.scope(${scope},${callId})`;
}

function orderCallArguments(signature: readonly string[], args: readonly { readonly name?: string; readonly value: ExpressionNode }[]): readonly (ExpressionNode | undefined)[] {
  const result: (ExpressionNode | undefined)[] = [];
  let positional = 0;
  for (const argument of args) {
    if (argument.name === undefined) {
      result[positional] = argument.value;
      positional += 1;
    } else {
      const index = signature.indexOf(argument.name);
      if (index >= 0) result[index] = argument.value;
    }
  }
  return signature.map((_, index) => result[index]);
}

function validateGlobalCalls(statements: readonly StatementNode[], diagnostics: Diagnostic[]): void {
  const declarationCalls = new Set(["indicator", "strategy", "library"]);
  const directDeclarations = statements.filter((statement): statement is Extract<StatementNode, { kind: "expression" }> =>
    statement.kind === "expression"
    && statement.expression.kind === "call"
    && declarationCalls.has(callableName(statement.expression.callee)),
  );
  if (directDeclarations.length !== 1) {
    const range = directDeclarations[1]?.range ?? directDeclarations[0]?.range ?? statements[0]?.range;
    diagnostics.push({
      severity: "error",
      code: "SCRIPT2016",
      message: directDeclarations.length === 0
        ? "A script must declare exactly one global indicator(), strategy(), or library()"
        : "A script may declare only one global indicator(), strategy(), or library()",
      ...(range === undefined ? {} : { range }),
    });
  }

  const visitExpression = (node: ExpressionNode, local: boolean, declarationStatement = false): void => {
    if (node.kind === "call") {
      const name = callableName(node.callee);
      if (declarationCalls.has(name) && (local || !declarationStatement)) {
        diagnostics.push({ severity: "error", code: "SCRIPT2016", message: `'${name}()' must be the single global declaration statement`, range: node.range });
      } else if (globalOnlyCalls.has(name) && local) {
        diagnostics.push({ severity: "error", code: "SCRIPT2016", message: `'${name}()' is only allowed in global scope`, range: node.range });
      }
      for (const argument of node.arguments) visitExpression(argument.value, local);
      return;
    }
    if (node.kind === "member") {
      visitExpression(node.object, local);
      return;
    }
    if (node.kind === "history") {
      visitExpression(node.value, local);
      visitExpression(node.offset, local);
      return;
    }
    if (node.kind === "unary") {
      visitExpression(node.argument, local);
      return;
    }
    if (node.kind === "binary") {
      visitExpression(node.left, local);
      visitExpression(node.right, local);
      return;
    }
    if (node.kind === "conditional") {
      visitExpression(node.test, local);
      visitExpression(node.consequent, local);
      visitExpression(node.alternate, local);
      return;
    }
    if (node.kind === "tuple") {
      for (const element of node.elements) visitExpression(element, local);
      return;
    }
    if (node.kind === "if_expression") {
      visitExpression(node.test, local);
      visitStatements(node.consequent, true);
      visitStatements(node.alternate, true);
      return;
    }
    if (node.kind === "while_expression") {
      visitExpression(node.test, local);
      visitStatements(node.body, true);
      return;
    }
    if (node.kind === "for_expression") {
      visitExpression(node.start, local);
      visitExpression(node.end, local);
      if (node.step !== undefined) visitExpression(node.step, local);
      visitStatements(node.body, true);
      return;
    }
    if (node.kind === "for_in_expression") {
      visitExpression(node.collection, local);
      visitStatements(node.body, true);
      return;
    }
    if (node.kind === "switch") {
      if (node.discriminant !== undefined) visitExpression(node.discriminant, local);
      for (const entry of node.cases) {
        if (entry.test !== undefined) visitExpression(entry.test, local);
        visitStatements(entry.body, true);
      }
    }
  };

  const visitStatements = (block: readonly StatementNode[], local: boolean): void => {
    for (const statement of block) {
      if (statement.kind === "expression") visitExpression(statement.expression, local, !local);
      else if (statement.kind === "declaration" || statement.kind === "tuple_declaration") visitExpression(statement.value, local);
      else if (statement.kind === "assignment") visitExpression(statement.value, local);
      else if (statement.kind === "member_assignment") {
        visitExpression(statement.object, local);
        visitExpression(statement.value, local);
      } else if (statement.kind === "if") {
        visitExpression(statement.test, local);
        visitStatements(statement.consequent, true);
        visitStatements(statement.alternate, true);
      } else if (statement.kind === "while") {
        visitExpression(statement.test, local);
        visitStatements(statement.body, true);
      } else if (statement.kind === "for") {
        visitExpression(statement.start, local);
        visitExpression(statement.end, local);
        if (statement.step !== undefined) visitExpression(statement.step, local);
        visitStatements(statement.body, true);
      } else if (statement.kind === "for_in") {
        visitExpression(statement.collection, local);
        visitStatements(statement.body, true);
      } else if (statement.kind === "function" || statement.kind === "method") {
        visitStatements(statement.body, true);
      }
    }
  };
  visitStatements(statements, false);
}

const indicatorDeclarationSignature = [
  "title", "shorttitle", "overlay", "format", "precision", "scale", "max_bars_back", "timeframe",
  "timeframe_gaps", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count",
  "max_polylines_count", "dynamic_requests", "behind_chart",
] as const;

const strategyDeclarationSignature = [
  "title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding", "calc_on_order_fills",
  "calc_on_every_tick", "max_bars_back", "backtest_fill_limits_assumption", "default_qty_type", "default_qty_value",
  "initial_capital", "currency", "slippage", "commission_type", "commission_value", "process_orders_on_close",
  "close_entries_rule", "margin_long", "margin_short", "explicit_plot_zorder", "max_lines_count", "max_labels_count",
  "max_boxes_count", "risk_free_rate", "use_bar_magnifier", "fill_orders_on_standard_ohlc", "max_polylines_count",
  "dynamic_requests", "behind_chart",
] as const;

const libraryDeclarationSignature = ["title", "overlay", "dynamic_requests"] as const;

function declarationStaticValue(node: ExpressionNode | undefined): PineValue | undefined {
  if (node?.kind === "literal") return node.value;
  if (node?.kind === "member") return node.property;
  if (node?.kind === "unary" && (node.operator === "+" || node.operator === "-") && node.argument.kind === "literal" && typeof node.argument.value === "number") {
    return node.operator === "-" ? -node.argument.value : node.argument.value;
  }
  return undefined;
}

function extractStrategyConfig(node: Extract<ExpressionNode, { kind: "call" }>, productionProfile: boolean, version: PineVersion, resolveOption = declarationStaticValue): StrategyConfig {
  const ordered = orderCallArguments(strategyDeclarationSignature, node.arguments);
  const value = (name: typeof strategyDeclarationSignature[number]): PineValue | undefined => {
    const argument = ordered[strategyDeclarationSignature.indexOf(name)];
    return resolveOption(argument);
  };
  const numberValue = (name: typeof strategyDeclarationSignature[number], fallback: number): number => {
    const resolved = value(name);
    return typeof resolved === "number" && Number.isFinite(resolved) ? resolved : fallback;
  };
  const stringValue = (name: typeof strategyDeclarationSignature[number], fallback: string): string => {
    const resolved = value(name);
    return typeof resolved === "string" ? resolved : fallback;
  };
  const qtyType = stringValue("default_qty_type", "fixed");
  const commissionType = stringValue("commission_type", "percent");
  const closeEntriesRule = stringValue("close_entries_rule", "FIFO");
  const defaultMargin = productionProfile && version === 5 ? 0 : 100;
  return {
    initial_capital: numberValue("initial_capital", 1_000_000),
    // Pine's currency.NONE default follows the chart's symbol currency.  Keep
    // the frozen profile's USD default stable, while preserving NONE in the
    // current descriptor for runtime/public-result resolution.
    currency: stringValue("currency", productionProfile ? "NONE" : "USD"),
    pyramiding: Math.max(1, Math.trunc(numberValue("pyramiding", 1))),
    default_qty_type: qtyType === "cash" || qtyType === "percent_of_equity" ? qtyType : "fixed",
    default_qty_value: numberValue("default_qty_value", 1),
    slippage: numberValue("slippage", 0),
    commission_type: commissionType === "cash_per_order" || commissionType === "cash_per_contract" ? commissionType : "percent",
    commission_value: numberValue("commission_value", 0),
    process_orders_on_close: value("process_orders_on_close") === true,
    margin_long: Math.max(0, numberValue("margin_long", defaultMargin)),
    margin_short: Math.max(0, numberValue("margin_short", defaultMargin)),
    calc_on_order_fills: value("calc_on_order_fills") === true,
    calc_on_every_tick: value("calc_on_every_tick") === true,
    backtest_fill_limits_assumption: Math.max(0, Math.trunc(numberValue("backtest_fill_limits_assumption", 0))),
    close_entries_rule: closeEntriesRule === "ANY" ? "ANY" : "FIFO",
    risk_free_rate: numberValue("risk_free_rate", 2),
    use_bar_magnifier: value("use_bar_magnifier") === true,
    fill_orders_on_standard_ohlc: value("fill_orders_on_standard_ohlc") === true,
  };
}

function drawingCallSignature(
  name: string,
  node: Extract<ExpressionNode, { kind: "call" }>,
  chartPointVariables: ReadonlySet<string>,
): readonly string[] | undefined {
  const firstArgument = node.arguments[0]?.value;
  const named = new Set(node.arguments.flatMap((argument) => argument.name === undefined ? [] : [argument.name]));
  const pointOverload = firstArgument !== undefined && isChartPointExpression(firstArgument, chartPointVariables);
  if (name === "line.new" && (pointOverload || named.has("first_point") || named.has("second_point"))) {
    return ["first_point", "second_point", "xloc", "extend", "color", "style", "width", "force_overlay"];
  }
  if (name === "box.new" && (pointOverload || named.has("top_left") || named.has("bottom_right"))) {
    return ["top_left", "bottom_right", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"];
  }
  if (name === "label.new" && (pointOverload || named.has("point"))) {
    return ["point", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"];
  }
  return drawingCallSignatures[name];
}

function drawingReceiverCallSignature(property: string, args: readonly CallArgumentNode[]): readonly string[] | undefined {
  if (!args.some((argument) => argument.name !== undefined)) return undefined;
  const namedArguments = new Set(args.flatMap((argument) => argument.name === undefined ? [] : [argument.name]));
  const positionalCount = args.filter((argument) => argument.name === undefined).length;
  const candidates = Object.entries(drawingCallSignatures)
    .filter(([name]) => name.endsWith(`.${property}`))
    .map(([, signature]) => signature.slice(1))
    .filter((signature) => positionalCount <= signature.length && [...namedArguments].every((name) => signature.includes(name)));
  const first = candidates[0];
  if (first === undefined) return undefined;
  return candidates.every((candidate) => candidate.length === first.length && candidate.every((name, index) => name === first[index]))
    ? first
    : undefined;
}

function builtinReceiverCallDefinition(
  property: string,
  args: readonly CallArgumentNode[],
): { readonly callable: string; readonly signature: readonly string[]; readonly optionalParameters: readonly string[] } | undefined {
  if (!args.some((argument) => argument.name !== undefined)) return undefined;
  const named = new Set(args.flatMap((argument) => argument.name === undefined ? [] : [argument.name]));
  const positionalCount = args.filter((argument) => argument.name === undefined).length;
  const candidates = Object.entries(PINE_CALLABLE_METADATA)
    .filter(([callable, definition]) => callable.endsWith(`.${property}`) && definition.signatureStatus === "complete")
    .map(([callable, definition]) => ({
      callable,
      signature: definition.parameters.slice(1),
      optionalParameters: (definition.optionalParameters ?? []).filter((parameter) => definition.parameters.slice(1).includes(parameter)),
    }))
    .filter((candidate) => positionalCount <= candidate.signature.length && [...named].every((name) => candidate.signature.includes(name)));
  const first = candidates[0];
  if (first === undefined) return undefined;
  return candidates.every((candidate) => candidate.signature.length === first.signature.length && candidate.signature.every((name, index) => name === first.signature[index]))
    ? first
    : undefined;
}

function isChartPointExpression(node: ExpressionNode, chartPointVariables: ReadonlySet<string>): boolean {
  return (node.kind === "call" && callableName(node.callee).startsWith("chart.point."))
    || (node.kind === "identifier" && chartPointVariables.has(node.name));
}

function collectChartPointVariables(statements: readonly StatementNode[], result: Set<string>): void {
  for (const statement of statements) {
    if (statement.kind === "declaration") {
      if (statement.dataType === "chart.point" || isChartPointExpression(statement.value, result)) result.add(statement.name);
    } else if (statement.kind === "function" || statement.kind === "method" || statement.kind === "while" || statement.kind === "for" || statement.kind === "for_in") {
      collectChartPointVariables(statement.body, result);
    } else if (statement.kind === "if") {
      collectChartPointVariables(statement.consequent, result);
      collectChartPointVariables(statement.alternate, result);
    }
  }
}

type ExpressionGenerator = (node: ExpressionNode, locals?: ReadonlyMap<string, string>, scope?: string) => string;

interface FunctionLocalAllocator {
  nextId: number;
  parameterCount: number;
  slots: Map<string, number>;
}

function emitMemberAssignment(
  statement: Extract<StatementNode, { kind: "member_assignment" }>,
  expression: ExpressionGenerator,
  locals: ReadonlyMap<string, string> = new Map(),
  scope?: string,
): string {
  const receiver = expression(statement.object, locals, scope);
  const value = expression(statement.value, locals, scope);
  return statement.operator === undefined
    ? `r.setProperty(${receiver},${JSON.stringify(statement.property)},${value})`
    : `r.updateProperty(${receiver},${JSON.stringify(statement.property)},${JSON.stringify(statement.operator)},${value})`;
}

function functionStatementBlock(
  statements: readonly StatementNode[],
  locals: ReadonlyMap<string, string>,
  scope: string,
  expression: ExpressionGenerator,
  diagnostics: Diagnostic[],
  allocator: FunctionLocalAllocator,
  loopDepth = 0,
  returnLast = false,
  allowShadowing = true,
  dynamicLoopBounds = false,
  strictRangeLoops = false,
): string {
  if (statements.length === 0) return returnLast ? "return NaN;" : "";
  const code: string[] = [];
  const blockLocals = new Map(locals);
  const blockDeclarations = new Set<string>();
  const declareLocal = (name: string, range: StatementNode["range"]): string | undefined => {
    if (blockDeclarations.has(name) || (!allowShadowing && locals.has(name))) {
      diagnostics.push({ severity: "error", code: "SCRIPT2006", message: `Local '${name}' is already declared`, range });
      return undefined;
    }
    const local = `l${String(allocator.nextId)}`;
    allocator.slots.set(local, allocator.parameterCount + allocator.nextId);
    allocator.nextId += 1;
    blockDeclarations.add(name);
    blockLocals.set(name, local);
    return local;
  };
  for (const [index, statement] of statements.entries()) {
    const returnsValue = returnLast && index === statements.length - 1;
    if (statement.kind === "declaration") {
      const initializerLocals = new Map(blockLocals);
      const local = declareLocal(statement.name, statement.range);
      if (local !== undefined) code.push(`const ${local}=r.localRef(${scope},${String(allocator.slots.get(local))},()=>${expression(statement.value, initializerLocals, scope)},${JSON.stringify(statement.persistence)});`);
    } else if (statement.kind === "tuple_declaration") {
      const temporary = `$tuple${String(statement.range.start.offset)}`;
      code.push(`const ${temporary}=${expression(statement.value, blockLocals, scope)};`);
      for (const [tupleIndex, name] of statement.names.entries()) {
        if (name === "_") continue;
        const local = declareLocal(name, statement.range);
        if (local !== undefined) code.push(`const ${local}=r.localRef(${scope},${String(allocator.slots.get(local))},()=>r.tupleGet(${temporary},${String(tupleIndex)}),"bar");`);
      }
    } else if (statement.kind === "assignment") {
      const local = blockLocals.get(statement.name);
      if (local === undefined) diagnostics.push({ severity: "error", code: "SCRIPT2007", message: `Functions cannot assign unknown or global variable '${statement.name}'`, range: statement.range });
      else code.push(`r.assignRef(${local},${expression(statement.value, blockLocals, scope)});`);
    } else if (statement.kind === "member_assignment") {
      code.push(`${emitMemberAssignment(statement, expression, blockLocals, scope)};`);
    } else if (statement.kind === "expression") {
      code.push(`${returnsValue ? "return " : ""}${expression(statement.expression, blockLocals, scope)};`);
    } else if (statement.kind === "if") {
      code.push(`if(r.truthy(${expression(statement.test, blockLocals, scope)})){${functionStatementBlock(statement.consequent, blockLocals, scope, expression, diagnostics, allocator, loopDepth, returnsValue, true, dynamicLoopBounds, strictRangeLoops)}}else{${functionStatementBlock(statement.alternate, blockLocals, scope, expression, diagnostics, allocator, loopDepth, returnsValue, true, dynamicLoopBounds, strictRangeLoops)}}`);
    } else if (statement.kind === "once") {
      const onceScope = `r.scope(${scope},${String(statement.range.start.offset)})`;
      code.push(`if(r.once(${onceScope},()=>${expression(statement.test, blockLocals, scope)})){${functionStatementBlock(statement.body, blockLocals, onceScope, expression, diagnostics, allocator, loopDepth, false, true, dynamicLoopBounds, strictRangeLoops)}r.commitOnce(${onceScope});}`);
    } else if (statement.kind === "while") {
      code.push(`while(r.truthy(${expression(statement.test, blockLocals, scope)})){r.loop();${functionStatementBlock(statement.body, blockLocals, scope, expression, diagnostics, allocator, loopDepth + 1, false, true, dynamicLoopBounds, strictRangeLoops)}}`);
    } else if (statement.kind === "for") {
      const suffix = String(statement.range.start.offset);
      const counter = `i${suffix}`;
      const reference = `ir${suffix}`;
      const from = `from${suffix}`;
      const to = `to${suffix}`;
      const step = `step${suffix}`;
      const loopLocals = new Map(blockLocals);
      loopLocals.set(statement.variable, reference);
      const defaultStep = strictRangeLoops ? "1" : `${from}<=${to}?1:-1`;
      const bound = strictRangeLoops ? "rangeBound" : "integerSigned";
      const stepExpression = statement.step === undefined ? defaultStep : expression(statement.step, blockLocals, scope);
      const startExpression = expression(statement.start, blockLocals, scope);
      const endExpression = expression(statement.end, blockLocals, scope);
      const stepValue = strictRangeLoops ? `r.rangeStep(${from},${to},${stepExpression})` : `r.integerSigned(${stepExpression})`;
      const toBinding = dynamicLoopBounds ? "let" : "const";
      const update = dynamicLoopBounds
        ? `${counter}+=${step},${to}=r.${bound}(${endExpression})`
        : `${counter}+=${step}`;
      code.push(`{const ${from}=r.${bound}(${startExpression});${toBinding} ${to}=r.${bound}(${endExpression});const ${step}=${stepValue};for(let ${counter}=${from};${step}>=0?${counter}<=${to}:${counter}>=${to};${update}){r.loop();const ${reference}=r.valueRef(${counter});${functionStatementBlock(statement.body, loopLocals, scope, expression, diagnostics, allocator, loopDepth + 1, false, true, dynamicLoopBounds, strictRangeLoops)}}}`);
    } else if (statement.kind === "for_in") {
      const suffix = String(statement.range.start.offset);
      const collection = `collection${suffix}`;
      const counter = `i${suffix}`;
      const loopLocals = new Map(blockLocals);
      const valueReference = `iv${suffix}`;
      if (statement.variables.length === 1) loopLocals.set(statement.variables[0]!, valueReference);
      else {
        loopLocals.set(statement.variables[0]!, `ii${suffix}`);
        loopLocals.set(statement.variables[1]!, valueReference);
      }
      const bindings = statement.variables.length === 1
        ? `const ${valueReference}=r.valueRef(${collection}[${counter}]);`
        : `const ii${suffix}=r.valueRef(r.iterationKey(${collection},${counter}));const ${valueReference}=r.valueRef(r.iterationValue(${collection},${counter}));`;
      code.push(`{const ${collection}=r.iterable(${expression(statement.collection, blockLocals, scope)});for(let ${counter}=0;${counter}<${collection}.length;${counter}+=1){r.loop();${bindings}${functionStatementBlock(statement.body, loopLocals, scope, expression, diagnostics, allocator, loopDepth + 1, false, true, dynamicLoopBounds, strictRangeLoops)}}}`);
    } else if (statement.kind === "break" || statement.kind === "continue") {
      if (loopDepth === 0) diagnostics.push({ severity: "error", code: "SCRIPT2010", message: `'${statement.kind}' is only valid inside a loop`, range: statement.range });
      else code.push(`${statement.kind};`);
    } else {
      diagnostics.push({ severity: "error", code: "SCRIPT2008", message: "Nested function declarations are not supported", range: statement.range });
    }
  }
  if (returnLast && !["expression", "if"].includes(statements.at(-1)?.kind ?? "")) code.push("return NaN;");
  return code.join("");
}

function topLevelBlock(
  statements: readonly StatementNode[],
  expression: ExpressionGenerator,
  variables: ReadonlyMap<string, number>,
  diagnostics: Diagnostic[],
  locals: ReadonlyMap<string, string> = new Map(),
  loopDepth = 0,
  scope = JSON.stringify(`block:${String(statements[0]?.range.start.offset ?? 0)}`),
  dynamicLoopBounds = false,
  strictRangeLoops = false,
  liveMapIterations: ReadonlySet<ExpressionNode> = new Set(),
): string {
  const code: string[] = [];
  const blockLocals = new Map(locals);
  const declarations = statements.filter((statement): statement is Extract<StatementNode, { kind: "declaration" }> => statement.kind === "declaration");
  for (const declaration of declarations) blockLocals.set(declaration.name, `$blockLocal${String(declaration.range.start.offset)}`);
  for (const statement of statements) {
    if (statement.kind === "declaration") {
      const local = blockLocals.get(statement.name)!;
      const initializerLocals = new Map(blockLocals);
      const shadowed = locals.get(statement.name);
      if (shadowed === undefined) initializerLocals.delete(statement.name);
      else initializerLocals.set(statement.name, shadowed);
      code.push(`const ${local}=r.localRef(${scope},${String(declarations.indexOf(statement))},()=>${expression(statement.value, initializerLocals, scope)},${JSON.stringify(statement.persistence)});`);
    } else if (statement.kind === "assignment") {
      const local = blockLocals.get(statement.name);
      const id = variables.get(statement.name);
      if (local !== undefined) code.push(`r.assignRef(${local},${expression(statement.value, blockLocals, scope)});`);
      else if (id !== undefined) code.push(`r.set(${id},${expression(statement.value, blockLocals, scope)});`);
      else diagnostics.push({ severity: "error", code: "SCRIPT2004", message: `Unknown variable '${statement.name}'`, range: statement.range });
    } else if (statement.kind === "member_assignment") code.push(`${emitMemberAssignment(statement, expression, blockLocals, scope)};`);
    else if (statement.kind === "expression") code.push(`${expression(statement.expression, blockLocals, scope)};`);
    else if (statement.kind === "if") {
      const consequentScope = JSON.stringify(`block:${String(statement.consequent[0]?.range.start.offset ?? statement.range.start.offset)}:if`);
      const alternateScope = JSON.stringify(`block:${String(statement.alternate[0]?.range.start.offset ?? statement.range.start.offset)}:else`);
      code.push(`if(r.truthy(${expression(statement.test, blockLocals, scope)})){${topLevelBlock(statement.consequent, expression, variables, diagnostics, blockLocals, loopDepth, consequentScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}}else{${topLevelBlock(statement.alternate, expression, variables, diagnostics, blockLocals, loopDepth, alternateScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}}`);
    } else if (statement.kind === "once") {
      const onceScope = JSON.stringify(`once:${String(statement.range.start.offset)}`);
      code.push(`if(r.once(${onceScope},()=>${expression(statement.test, blockLocals, scope)})){${topLevelBlock(statement.body, expression, variables, diagnostics, blockLocals, loopDepth, onceScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}r.commitOnce(${onceScope});}`);
    } else if (statement.kind === "while") {
      const bodyScope = JSON.stringify(`block:${String(statement.body[0]?.range.start.offset ?? statement.range.start.offset)}:while`);
      code.push(`while(r.truthy(${expression(statement.test, blockLocals, scope)})){r.loop();${topLevelBlock(statement.body, expression, variables, diagnostics, blockLocals, loopDepth + 1, bodyScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}}`);
    }
    else if (statement.kind === "for") {
      const suffix = String(statement.range.start.offset);
      const counter = `i${suffix}`;
      const reference = `ir${suffix}`;
      const from = `from${suffix}`;
      const to = `to${suffix}`;
      const step = `step${suffix}`;
      const loopLocals = new Map(blockLocals);
      loopLocals.set(statement.variable, reference);
      const defaultStep = strictRangeLoops ? "1" : `${from}<=${to}?1:-1`;
      const bound = strictRangeLoops ? "rangeBound" : "integerSigned";
      const stepExpression = statement.step === undefined ? defaultStep : expression(statement.step, blockLocals, scope);
      const startExpression = expression(statement.start, blockLocals, scope);
      const endExpression = expression(statement.end, blockLocals, scope);
      const bodyScope = JSON.stringify(`block:${String(statement.body[0]?.range.start.offset ?? statement.range.start.offset)}:for`);
      const stepValue = strictRangeLoops ? `r.rangeStep(${from},${to},${stepExpression})` : `r.integerSigned(${stepExpression})`;
      const toBinding = dynamicLoopBounds ? "let" : "const";
      const update = dynamicLoopBounds
        ? `${counter}+=${step},${to}=r.${bound}(${endExpression})`
        : `${counter}+=${step}`;
      code.push(`{const ${from}=r.${bound}(${startExpression});${toBinding} ${to}=r.${bound}(${endExpression});const ${step}=${stepValue};for(let ${counter}=${from};${step}>=0?${counter}<=${to}:${counter}>=${to};${update}){r.loop();const ${reference}=r.valueRef(${counter});${topLevelBlock(statement.body, expression, variables, diagnostics, loopLocals, loopDepth + 1, bodyScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}}}`);
    } else if (statement.kind === "for_in") {
      const suffix = String(statement.range.start.offset);
      const collection = `collection${suffix}`;
      const counter = `i${suffix}`;
      const loopLocals = new Map(blockLocals);
      const valueReference = `iv${suffix}`;
      if (statement.variables.length === 1) loopLocals.set(statement.variables[0]!, valueReference);
      else {
        loopLocals.set(statement.variables[0]!, `ii${suffix}`);
        loopLocals.set(statement.variables[1]!, valueReference);
      }
      const bodyScope = JSON.stringify(`block:${String(statement.body[0]?.range.start.offset ?? statement.range.start.offset)}:for-in`);
      const bindings = statement.variables.length === 1
        ? `const ${valueReference}=r.valueRef(${collection}[${counter}]);`
        : `const ii${suffix}=r.valueRef(r.iterationKey(${collection},${counter}));const ${valueReference}=r.valueRef(r.iterationValue(${collection},${counter}));`;
      const liveValues = liveMapIterations.has(statement.collection) ? ",true" : "";
      code.push(`{const ${collection}=r.iterable(${expression(statement.collection, blockLocals, scope)}${liveValues});for(let ${counter}=0;${counter}<${collection}.length;${counter}+=1){r.loop();${bindings}${topLevelBlock(statement.body, expression, variables, diagnostics, loopLocals, loopDepth + 1, bodyScope, dynamicLoopBounds, strictRangeLoops, liveMapIterations)}}}`);
    } else if (statement.kind === "break" || statement.kind === "continue") {
      if (loopDepth === 0) diagnostics.push({ severity: "error", code: "SCRIPT2010", message: `'${statement.kind}' is only valid inside a loop`, range: statement.range });
      else code.push(`${statement.kind};`);
    }
  }
  return code.join("");
}

/** Sealed legacy-profile fallback; the current profile consumes semantic annotations. */
function legacyStaticType(
  node: ExpressionNode,
  variables: ReadonlyMap<string, "bool" | "color" | "float" | "int" | "string">,
): "bool" | "color" | "float" | "int" | "string" | undefined {
  if (node.kind === "literal") {
    if (typeof node.value === "number") return node.numericType ?? "float";
    if (typeof node.value === "string") return "string";
    if (typeof node.value === "boolean") return "bool";
    return undefined;
  }
  if (node.kind === "identifier") return variables.get(node.name);
  if (node.kind === "unary") return node.operator === "not" ? "bool" : legacyStaticType(node.argument, variables);
  if (node.kind === "binary") {
    if (["==", "!=", "<", "<=", ">", ">=", "and", "or"].includes(node.operator)) return "bool";
    const left = legacyStaticType(node.left, variables);
    const right = legacyStaticType(node.right, variables);
    if (left === "float" || right === "float") return "float";
    if (left === "int" && right === "int") return "int";
  }
  return undefined;
}

function expressionPrimitiveType(
  node: ExpressionNode,
  variables: ReadonlyMap<string, "bool" | "color" | "float" | "int" | "string">,
  semantic?: PineSemanticModel,
): "bool" | "color" | "float" | "int" | "string" | undefined {
  if (semantic !== undefined) {
    const kind = semantic.typeOf(node).kind;
    return ["bool", "color", "float", "int", "string"].includes(kind)
      ? kind as "bool" | "color" | "float" | "int" | "string"
      : undefined;
  }
  return legacyStaticType(node, variables);
}

/**
 * Pine charges a plot count for a fill only when its color is a series. This
 * deliberately answers only the static cases we can prove; ambiguous values
 * are left uncharged rather than rejecting a valid script on a guess.
 */
function isSeriesExpression(
  node: ExpressionNode | undefined,
  topLevelValues: ReadonlyMap<string, ExpressionNode>,
  visiting = new Set<string>(),
  semantic?: PineSemanticModel,
): boolean {
  if (node !== undefined && semantic !== undefined) return semantic.typeOf(node).qualifier === "series";
  if (node === undefined || node.kind === "literal") return false;
  if (node.kind === "identifier") {
    if (marketFields.has(node.name) || node.name === "bar_index") return true;
    if (visiting.has(node.name)) return false;
    const value = topLevelValues.get(node.name);
    if (value === undefined) return false;
    visiting.add(node.name);
    const result = isSeriesExpression(value, topLevelValues, visiting, semantic);
    visiting.delete(node.name);
    return result;
  }
  if (node.kind === "member") {
    const name = memberName(node);
    if (name.startsWith("color.") || name.startsWith("display.") || name.startsWith("format.")) return false;
    return isSeriesExpression(node.object, topLevelValues, visiting, semantic);
  }
  if (node.kind === "history") return true;
  if (node.kind === "unary") return isSeriesExpression(node.argument, topLevelValues, visiting, semantic);
  if (node.kind === "binary") return isSeriesExpression(node.left, topLevelValues, visiting, semantic) || isSeriesExpression(node.right, topLevelValues, visiting, semantic);
  if (node.kind === "conditional") return isSeriesExpression(node.test, topLevelValues, visiting, semantic)
    || isSeriesExpression(node.consequent, topLevelValues, visiting, semantic)
    || isSeriesExpression(node.alternate, topLevelValues, visiting, semantic);
  if (node.kind === "call") {
    const name = callableName(node.callee);
    if (name === "input" || name.startsWith("input.")) return false;
    if (name === "color.new" || name === "color.rgb") return node.arguments.some((argument) => isSeriesExpression(argument.value, topLevelValues, visiting, semantic));
    return true;
  }
  if (node.kind === "tuple") return node.elements.some((element) => isSeriesExpression(element, topLevelValues, visiting, semantic));
  return true;
}

/**
 * Plot color options consume another plot count whenever their qualifier is
 * stronger than `const`. Unlike fill(), this includes input/simple colors.
 * Unknown expressions are charged conservatively so an unsupported static
 * inference cannot let a script exceed the reference platform's hard limit at runtime.
 */
function isNonConstPlotExpression(
  node: ExpressionNode | undefined,
  topLevelValues: ReadonlyMap<string, ExpressionNode>,
  visiting = new Set<string>(),
  semantic?: PineSemanticModel,
): boolean {
  if (node !== undefined && semantic !== undefined) return semantic.typeOf(node).qualifier !== "const";
  if (node === undefined || node.kind === "literal") return false;
  if (node.kind === "identifier") {
    if (node.name === "na") return false;
    if (marketFields.has(node.name) || node.name === "bar_index") return true;
    if (visiting.has(node.name)) return true;
    const value = topLevelValues.get(node.name);
    if (value === undefined) return true;
    visiting.add(node.name);
    const result = isNonConstPlotExpression(value, topLevelValues, visiting, semantic);
    visiting.delete(node.name);
    return result;
  }
  if (node.kind === "member") {
    const name = memberName(node);
    if (name.startsWith("color.") || name.startsWith("display.") || name.startsWith("format.")) return false;
    return true;
  }
  if (node.kind === "history") return true;
  if (node.kind === "unary") return isNonConstPlotExpression(node.argument, topLevelValues, visiting, semantic);
  if (node.kind === "binary") return isNonConstPlotExpression(node.left, topLevelValues, visiting, semantic)
    || isNonConstPlotExpression(node.right, topLevelValues, visiting, semantic);
  if (node.kind === "conditional") return isNonConstPlotExpression(node.test, topLevelValues, visiting, semantic)
    || isNonConstPlotExpression(node.consequent, topLevelValues, visiting, semantic)
    || isNonConstPlotExpression(node.alternate, topLevelValues, visiting, semantic);
  if (node.kind === "call") {
    const name = callableName(node.callee);
    if (name === "color.new" || name === "color.rgb") {
      return node.arguments.some((argument) => isNonConstPlotExpression(argument.value, topLevelValues, visiting, semantic));
    }
    return true;
  }
  if (node.kind === "tuple") return node.elements.some((element) => isNonConstPlotExpression(element, topLevelValues, visiting, semantic));
  return true;
}

function memberRootIdentifier(node: Extract<ExpressionNode, { kind: "member" }>): string | undefined {
  if (node.object.kind === "identifier") return node.object.name;
  if (node.object.kind === "member") return memberRootIdentifier(node.object);
  return undefined;
}

function defaultPlotTitle(plotId: string): string {
  return `#${plotId.slice("plot-".length)}`;
}
