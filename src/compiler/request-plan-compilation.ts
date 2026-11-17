import { requestOptionResolver } from "./request-option-values.js";
import { compileStartupProgram } from "./compile-startup-program.js";
import { requestChildDependencies } from "./request-child-dependencies.js";
import { lex } from "./lexer.js";
import { PINE_CALLABLE_METADATA, type PineCompatibility, type Diagnostic, type PineVersion, type SourceRange, PINE_COMPATIBILITY, isStrictPineCompatibility } from "../contracts/index.js";
import type { CallNode, ExpressionNode, FunctionDeclarationNode, MethodDeclarationNode, ProgramNode, StatementNode } from "./ast.js";
import type { PineSemanticModel } from "./semantic-binder.js";
import type { CompileRequest, CompileResult, CompiledRequestPlan } from "./compiled-program.js";
import { collectCallNodes, walkPineAst } from "./ast-walk.js";
import { collectLegacyCallNodes } from "./legacy-call-discovery.js";
import { analyzeObservedValues } from "./observable-values.js";
import { staticCallableName, boundBuiltinArguments } from "./call-analysis.js";

const MAX_STATIC_REQUEST_CONTEXTS = 40;
export interface RequestPlanCompilation {
  readonly requestIds: ReadonlyMap<number, string | null>;
  readonly requestPlans: readonly CompiledRequestPlan[];
  readonly diagnostics: readonly Diagnostic[];
  readonly fatal: boolean;
}

/** The same semantic selector decision used when lowering executable requests. */
export function dynamicRequestRanges(parsed: ProgramNode, semantic: PineSemanticModel): readonly SourceRange[] {
  const allowDynamic = allowsDynamicRequests(parsed, semantic);
  return collectRequestCalls(parsed, PINE_COMPATIBILITY.strict)
    .filter((node) => classifyRequestSelectors(parsed, node, semantic, PINE_COMPATIBILITY.strict, allowDynamic).dynamic)
    .map((node) => node.range);
}

/** Lower request expressions; orchestration owns recursive compilation/cache. */
export function compileRequestPlans(
  parsed: ProgramNode,
  request: CompileRequest,
  semantic: PineSemanticModel,
  parsedVersion: PineVersion,
  compileChild: (request: CompileRequest) => CompileResult,
  observedCallSites?: ReadonlySet<CallNode>,
): RequestPlanCompilation {
    const productionProfile = isStrictPineCompatibility(request.compatibility);
    const allowDynamic = allowsDynamicRequests(parsed, semantic);
    const declarationHistoryFloor = productionProfile
      ? positiveDeclarationHistoryFloor(parsed, semantic) : 0;
    const requestCalls = collectRequestCalls(parsed, request.compatibility).map((node) => ({
      node,
      selectors: classifyRequestSelectors(parsed, node, semantic, request.compatibility, allowDynamic),
    }));
    const canDiscard = productionProfile && parsedVersion === 6 && !allowDynamic
      && requestCalls.some(({ selectors }) => selectors.dynamic && selectors.symbolSelector !== undefined && selectors.timeframeSelector !== undefined);
    const observedRequests = canDiscard ? observedCallSites ?? analyzeObservedValues(parsed, semantic).observedRequests : undefined;
    if (productionProfile) {
      const contexts = new Set<string>();
      for (const { node, selectors } of requestCalls) {
        if (selectors.dynamic) continue;
        contexts.add(requestContextKey(parsed, request.source, node, semantic, request.compatibility));
        if (contexts.size > MAX_STATIC_REQUEST_CONTEXTS) {
          return { requestIds: new Map(), requestPlans: [], fatal: true,
            diagnostics: [{
              severity: "error",
              code: "SCRIPT3022",
              message: `Script uses more than ${String(MAX_STATIC_REQUEST_CONTEXTS)} unique request contexts; Lumen Script supports at most ${String(MAX_STATIC_REQUEST_CONTEXTS)}`,
              range: node.range,
            }],
          };
        }
      }
    }
    const requestIds = new Map<number, string | null>();
    const requestContextIds = new Map<string, string>();
    const requestPlans: CompiledRequestPlan[] = [];
    const requestDiagnostics: Diagnostic[] = [];
    for (const [index, { node, selectors }] of requestCalls.entries()) {
      const { orderedArguments, symbolSelector, timeframeSelector, dynamic } = selectors;
      const discarded = observedRequests !== undefined && dynamic && symbolSelector !== undefined && timeframeSelector !== undefined
        && !observedRequests.has(node);
      const expressionNode = orderedArguments[2];
      if ((!productionProfile && (symbolSelector === undefined || timeframeSelector === undefined)) || expressionNode === undefined) {
        requestDiagnostics.push({ severity: "error", code: "SCRIPT2012", message: "Request symbol and timeframe must be literals or input-backed string variables", range: node.range });
        continue;
      }
      if (!discarded && dynamic && capturesLocalRequestExpression(parsed, node, expressionNode)) {
        requestDiagnostics.push({ severity: "error", code: "SCRIPT2012", message: "Dynamic request expressions cannot capture local loop or block bindings", range: expressionNode.range });
        continue;
      }
      if (productionProfile && !dynamic) {
        const captureError = unsupportedRequestCaptureChain(parsed, node);
        if (captureError !== undefined) {
          return { requestIds: new Map(), requestPlans: [], fatal: true,
            diagnostics: [{ severity: "error", code: "SCRIPT2012", message: captureError, range: node.range }],
          };
        }
      }
      const id = `request-${String(index)}`;
      const kind = node.callee.kind === "member" && node.callee.property === "security_lower_tf" ? "security_lower_tf" : "security";
      // Reuse exact lexical calls. Evaluated dynamic selections are accounted
      // for by the engine when execution first reaches them.
      const contextKey = requestContextKey(parsed, request.source, node, semantic, request.compatibility);
      const existingId = requestContextIds.get(contextKey);
      if (!discarded && existingId !== undefined) {
        requestIds.set(node.range.start.offset, existingId);
        continue;
      }
      const option = productionProfile ? requestOptionResolver(parsed, node, semantic) : (value: ExpressionNode | undefined) => value;
      if (productionProfile) {
        const ignoreInvalidSymbolNode = orderedArguments[kind === "security" ? 5 : 3];
        const currencyNode = orderedArguments[kind === "security" ? 6 : 4];
        validateStaticRequestOptions(kind, option(ignoreInvalidSymbolNode), option(currencyNode), requestDiagnostics);
      }
      const gapsNode = option(productionProfile
        ? kind === "security" ? orderedArguments[3] : undefined
        : node.arguments.find((argument) => argument.name === "gaps")?.value ?? node.arguments[3]?.value);
      const lookaheadNode = option(productionProfile
        ? kind === "security" ? orderedArguments[4] : undefined
        : node.arguments.find((argument) => argument.name === "lookahead")?.value ?? node.arguments[4]?.value);
      const ignoreInvalidTimeframeNode = option(kind === "security_lower_tf"
        ? productionProfile ? orderedArguments[5] : node.arguments.find((argument) => argument.name === "ignore_invalid_timeframe")?.value ?? node.arguments[5]?.value
        : undefined);
      const calcBarsCountNode = option(productionProfile
        ? orderedArguments[kind === "security_lower_tf" ? 6 : 7]
        : node.arguments.find((argument) => argument.name === "calc_bars_count")?.value ?? node.arguments[kind === "security_lower_tf" ? 6 : 7]?.value);
      const startupProgram = productionProfile && calcBarsCountNode !== undefined && calcBarsCountNode.kind !== "literal"
        ? compileStartupProgram(parsed, node, calcBarsCountNode, semantic)
        : undefined;
      if (productionProfile) validateResolvedRequestOptions(gapsNode, lookaheadNode, ignoreInvalidTimeframeNode, startupProgram === undefined ? calcBarsCountNode : undefined, requestDiagnostics);
      if (discarded) {
        requestIds.set(node.range.start.offset, null);
        continue;
      }
      const calcBarsCount = positiveLiteralNumber(calcBarsCountNode);
      const childSource = buildRequestChildSource(parsed, request.source, node, expressionNode, parsedVersion, id, request.compatibility, declarationHistoryFloor, !dynamic);
      const child = compileChild({ source: childSource, compatibility: request.compatibility });
      if (child.program === undefined) {
        requestDiagnostics.push({ severity: "error", code: "SCRIPT2013", message: `Unable to compile child request expression: ${child.diagnostics[0]?.message ?? "unknown error"}`, range: expressionNode.range });
        continue;
      }
      requestIds.set(node.range.start.offset, id);
      requestContextIds.set(contextKey, id);
      requestPlans.push(Object.freeze({
        ...(productionProfile ? { sourceRange: node.range } : {}),
        id,
        kind,
        ...(dynamic ? { dynamic: true } : {}),
        symbol: symbolSelector?.defaultValue ?? "",
        timeframe: timeframeSelector?.defaultValue ?? "",
        ...(symbolSelector?.inputId === undefined ? {} : { symbolInputId: symbolSelector?.inputId }),
        ...(symbolSelector?.inputTitle === undefined ? {} : { symbolInputTitle: symbolSelector?.inputTitle }),
        ...(timeframeSelector?.inputId === undefined ? {} : { timeframeInputId: timeframeSelector?.inputId }),
        ...(timeframeSelector?.inputTitle === undefined ? {} : { timeframeInputTitle: timeframeSelector?.inputTitle }),
        gaps: productionProfile ? gapsNode?.kind === "literal" && (gapsNode.value === true || gapsNode.value === "barmerge.gaps_on") : enumEnabled(gapsNode, "gaps_on"),
        lookahead: productionProfile ? lookaheadNode?.kind === "literal" && (lookaheadNode.value === true || lookaheadNode.value === "barmerge.lookahead_on") : enumEnabled(lookaheadNode, "lookahead_on"),
        ignoreInvalidTimeframe: literalBoolean(ignoreInvalidTimeframeNode),
        ...(calcBarsCount === undefined ? {} : { calcBarsCount }),
        ...(startupProgram === undefined ? {} : { startupProgram }),
        tupleArity: expressionNode.kind === "tuple" ? expressionNode.elements.length : 0,
        program: child.program,
      }));
    }
  return { requestIds, requestPlans, diagnostics: requestDiagnostics, fatal: false };
}

function allowsDynamicRequests(program: ProgramNode, semantic: PineSemanticModel): boolean {
  const declaration = program.statements.find(isDeclarationCall);
  if (declaration?.kind === "expression" && declaration.expression.kind === "call") {
    const binding = semantic.callBindings.get(declaration.expression);
    const index = binding?.signature?.indexOf("dynamic_requests") ?? -1;
    const option = index < 0 ? undefined : semantic.constantValueOf(binding?.ordered[index]);
    if (typeof option === "boolean") return option;
  }
  return program.version === 6;
}

function classifyRequestSelectors(program: ProgramNode, node: CallNode, semantic: PineSemanticModel, compatibility: PineCompatibility, allowDynamic: boolean) {
  const orderedArguments = isStrictPineCompatibility(compatibility)
    ? boundBuiltinArguments(node, semantic)
    : node.arguments.map((argument) => argument.value);
  const symbolSelector = resolveRequestStringSelector(orderedArguments[0], program, node.range.start.offset,
    new Set(["input.symbol", "input.string"]), compatibility, semantic);
  const timeframeSelector = resolveRequestStringSelector(orderedArguments[1], program, node.range.start.offset,
    new Set(["input.timeframe", "input.string"]), compatibility, semantic);
  return {
    orderedArguments,
    symbolSelector,
    timeframeSelector,
    dynamic: isStrictPineCompatibility(compatibility)
      && (symbolSelector === undefined || timeframeSelector === undefined || locallyExecutedRequest(program, node, allowDynamic)),
  };
}

interface RequestStringSelector {
  readonly defaultValue: string;
  readonly inputId?: string;
  readonly inputTitle?: string;
}

function resolveRequestStringSelector(
  node: ExpressionNode | undefined,
  program: ProgramNode,
  beforeOffset: number,
  allowedInputs: ReadonlySet<string>,
  compatibility: PineCompatibility,
  semantic: PineSemanticModel,
): RequestStringSelector | undefined {
  if (node?.kind === "literal" && typeof node.value === "string") return { defaultValue: node.value };
  if (node?.kind === "member" && node.object.kind === "identifier") {
    const name = `${node.object.name}.${node.property}`;
    if (name === "syminfo.tickerid" || name === "syminfo.ticker" || name === "timeframe.period" || name === "timeframe.main_period") return { defaultValue: "" };
  }
  if (node?.kind === "identifier") {
    if (isStrictPineCompatibility(compatibility) && semantic.expressionTypes.get(node)?.qualifier === "series") return undefined;
    const declaration = [...program.statements].reverse().find((statement) => statement.kind === "declaration" && statement.name === node.name && statement.range.end.offset < beforeOffset);
    if (declaration?.kind !== "declaration") return undefined;
    const selector = resolveRequestStringSelector(declaration.value, program, declaration.range.start.offset, allowedInputs, compatibility, semantic);
    if (selector === undefined) return undefined;
    return declaration.value.kind === "call" && allowedInputs.has(staticCallableName(declaration.value.callee))
      ? { ...selector, inputId: declaration.name }
      : selector;
  }
  if (node?.kind !== "call") return undefined;
  const inputName = staticCallableName(node.callee);
  if (!allowedInputs.has(inputName)) return undefined;
  const orderedArguments = isStrictPineCompatibility(compatibility)
    ? boundBuiltinArguments(node, semantic)
    : node.arguments.map((argument) => argument.value);
  const defaultNode = orderedArguments[0];
  if (defaultNode?.kind !== "literal" || typeof defaultNode.value !== "string") return undefined;
  const titleNode = orderedArguments[1];
  return {
    defaultValue: defaultNode.value,
    ...(titleNode?.kind === "literal" && typeof titleNode.value === "string" ? { inputTitle: titleNode.value } : {}),
  };
}

function buildRequestChildSource(
  program: ProgramNode,
  source: string,
  requestCall: CallNode,
  expression: ExpressionNode,
  version: PineVersion,
  id: string,
  compatibility: PineCompatibility,
  declarationHistoryFloor: number,
  captureCallable = true,
): string {
  const callable = containingCallable(program, requestCall.range.start.offset);
  if (captureCallable && callable !== undefined) {
    const nested = buildNestedRequestChildSource(program, source, callable, requestCall, expression, version, id, compatibility, declarationHistoryFloor);
    if (nested !== undefined) return nested;
  }
  const containing = program.statements.find((statement) => statement.range.start.offset <= requestCall.range.start.offset && statement.range.end.offset >= requestCall.range.end.offset);
  const prefix = program.statements.filter((statement) => {
    if (isDeclarationCall(statement)) return false;
    if (statement === containing) return false;
    return statement.kind === "function" || containing === undefined || statement.range.end.offset <= containing.range.start.offset;
  });
  const dependencies = isStrictPineCompatibility(compatibility)
    ? requestChildDependencies(program, prefix, [{ kind: "expression", expression, range: expression.range }])
    : prefix;
  const prefixSource = dependencies.map((statement) => source.slice(statement.range.start.offset, statement.range.end.offset)).join("\n");
  const expressionSource = source.slice(expression.range.start.offset, expression.range.end.offset);
  return `//@version=${String(version)}\n${requestChildDeclaration(id, declarationHistoryFloor)}\n${prefixSource.length === 0 ? "" : `${prefixSource}\n`}__request = ${expressionSource}`;
}

function positiveDeclarationHistoryFloor(program: ProgramNode, semantic: PineSemanticModel): number {
  const declaration = program.statements.find((statement) => isDeclarationCall(statement));
  if (declaration?.kind !== "expression" || declaration.expression.kind !== "call") return 0;
  const call = declaration.expression;
  const name = staticCallableName(call.callee);
  const index = PINE_CALLABLE_METADATA[name]?.parameters.indexOf("max_bars_back") ?? -1;
  const option = index < 0 ? undefined : boundBuiltinArguments(call, semantic)[index];
  if (option === undefined || semantic.typeOf(option).kind !== "int" || semantic.typeOf(option).qualifier !== "const") return 0;
  const value = semantic.constantValueOf(option);
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 5000 ? value : 0;
}

function requestChildDeclaration(id: string, declarationHistoryFloor: number): string {
  return `indicator("${id}"${declarationHistoryFloor > 0 ? `, max_bars_back=${String(declarationHistoryFloor)}` : ""})`;
}

type CallableDeclaration = FunctionDeclarationNode | MethodDeclarationNode;

/** A lexical request ID cannot select a different child expression per written caller yet. */
function unsupportedRequestCaptureChain(program: ProgramNode, requestCall: CallNode): string | undefined {
  const allCalls = collectCallNodes(program);
  const visited = new Set<CallableDeclaration>();
  let callable = containingCallable(program, requestCall.range.start.offset);
  for (let depth = 0; callable !== undefined && depth < 32; depth += 1) {
    const currentCallable = callable;
    if (visited.has(currentCallable)) return "Recursive request capture chains are unsupported";
    visited.add(currentCallable);
    if (allCalls.some((call) => call.range.start.offset >= currentCallable.range.start.offset
      && call.range.end.offset <= currentCallable.range.end.offset && invokesCallable(call, currentCallable))) {
      return "Recursive request capture chains are unsupported";
    }
    const invocations = allCalls.filter((call) => (
      (call.range.start.offset < currentCallable.range.start.offset || call.range.end.offset > currentCallable.range.end.offset)
      && invokesCallable(call, currentCallable)
    ));
    if (invocations.length > 1) return "Request expressions in functions with multiple written callers require independent capture plans";
    if (invocations.length === 0) {
      return currentCallable.parameters.some((parameter) => parameter.defaultValue === undefined)
        ? "Request capture requires a written caller for each required function parameter"
        : undefined;
    }
    callable = containingCallable(program, invocations[0]!.range.start.offset);
  }
  return callable === undefined ? undefined : "Request capture chains deeper than 32 calls are unsupported";
}

function buildNestedRequestChildSource(
  program: ProgramNode,
  source: string,
  initialCallable: CallableDeclaration,
  requestCall: CallNode,
  expression: ExpressionNode,
  version: PineVersion,
  id: string,
  compatibility: PineCompatibility,
  declarationHistoryFloor: number,
): string | undefined {
  const allCalls = compatibility === PINE_COMPATIBILITY.legacy ? collectLegacyCallNodes(program) : collectCallNodes(program);
  const captureDefinitions: string[] = [];
  const captureRoots: StatementNode[] = [{ kind: "expression", expression, range: expression.range }];
  const capturedCallables = new Set<CallableDeclaration>();
  let callable = initialCallable;
  let targetOffset = requestCall.range.start.offset;
  let capturedExpression = source.slice(expression.range.start.offset, expression.range.end.offset);
  let boundaryOffset = callable.range.start.offset;

  for (let depth = 0; depth < 32; depth += 1) {
    if (capturedCallables.has(callable)) return undefined;
    capturedCallables.add(callable);
    const captureName = `__request_capture_${id.replaceAll("-", "_")}_${String(depth)}`;
    const prefixBody = callable.body.filter((statement) => statement.range.end.offset < targetOffset);
    captureRoots.push({ ...callable, body: prefixBody });
    captureDefinitions.push(renderCallableCapture(callable, prefixBody, captureName, capturedExpression, source));
    const invocations = allCalls
      .filter((call) => call.range.start.offset < callable.range.start.offset || call.range.end.offset > callable.range.end.offset)
      .filter((call) => invokesCallable(call, callable))
      .sort((left, right) => left.range.start.offset - right.range.start.offset);
    const invocation = invocations[0];
    if (invocation === undefined) {
      if (callable.parameters.some((parameter) => parameter.defaultValue === undefined)) return undefined;
      capturedExpression = `${captureName}()`;
      boundaryOffset = callable.range.start.offset;
      break;
    }
    captureRoots.push({ kind: "expression", expression: invocation, range: invocation.range });
    capturedExpression = renderCaptureInvocation(invocation, captureName, source);
    boundaryOffset = invocation.range.start.offset;
    const caller = containingCallable(program, invocation.range.start.offset);
    if (caller === undefined) break;
    callable = caller;
    targetOffset = invocation.range.start.offset;
  }

  const containing = program.statements.find((statement) => statement.range.start.offset <= boundaryOffset && statement.range.end.offset >= boundaryOffset);
  const prefix = program.statements.filter((statement) => {
    if (isDeclarationCall(statement) || capturedCallables.has(statement as CallableDeclaration)) return false;
    if (statement.kind === "function" || statement.kind === "method") return false;
    return containing === undefined || statement.range.end.offset <= containing.range.start.offset;
  });
  const dependencies = isStrictPineCompatibility(compatibility)
    ? requestChildDependencies(program, prefix, captureRoots)
    : prefix;
  const prefixSource = dependencies.map((statement) => source.slice(statement.range.start.offset, statement.range.end.offset)).join("\n");
  return `//@version=${String(version)}\n${requestChildDeclaration(id, declarationHistoryFloor)}\n${prefixSource.length === 0 ? "" : `${prefixSource}\n`}${captureDefinitions.join("\n")}\n__request = ${capturedExpression}`;
}

function containingCallable(program: ProgramNode, offset: number): CallableDeclaration | undefined {
  return program.statements.find((statement): statement is CallableDeclaration => (
    (statement.kind === "function" || statement.kind === "method")
    && statement.range.start.offset <= offset
    && statement.range.end.offset >= offset
  ));
}

function renderCallableCapture(
  callable: CallableDeclaration,
  prefixStatements: readonly StatementNode[],
  captureName: string,
  capturedExpression: string,
  source: string,
): string {
  const parameters = callable.parameters.map((parameter) => source.slice(parameter.range.start.offset, parameter.range.end.offset)).join(", ");
  const body = [
    ...prefixStatements.map((statement) => indentSource(source.slice(statement.range.start.offset, statement.range.end.offset))),
    indentSource(capturedExpression),
  ];
  return `${callable.kind === "method" ? "method " : ""}${captureName}(${parameters}) =>\n${body.join("\n")}`;
}

function renderCaptureInvocation(call: CallNode, captureName: string, source: string): string {
  const args = call.arguments.map((argument) => {
    const value = source.slice(argument.value.range.start.offset, argument.value.range.end.offset);
    return argument.name === undefined ? value : `${argument.name} = ${value}`;
  }).join(", ");
  if (call.callee.kind === "member") {
    const receiver = source.slice(call.callee.object.range.start.offset, call.callee.object.range.end.offset);
    return `${receiver}.${captureName}(${args})`;
  }
  return `${captureName}(${args})`;
}

function invokesCallable(call: CallNode, callable: CallableDeclaration): boolean {
  if (callable.kind === "function") return call.callee.kind === "identifier" && call.callee.name === callable.name;
  return (call.callee.kind === "member" && call.callee.property === callable.name)
    || (call.callee.kind === "identifier" && call.callee.name === callable.name);
}

function indentSource(value: string): string {
  return value.split("\n").map((line) => `    ${line}`).join("\n");
}

function isDeclarationCall(statement: StatementNode): boolean {
  if (statement.kind !== "expression" || statement.expression.kind !== "call") return false;
  const callee = statement.expression.callee;
  return callee.kind === "identifier" && (callee.name === "indicator" || callee.name === "strategy" || callee.name === "library");
}

function literalBoolean(node: ExpressionNode | undefined): boolean {
  return node?.kind === "literal" && node.value === true;
}

function positiveLiteralNumber(node: ExpressionNode | undefined): number | undefined {
  return node?.kind === "literal" && typeof node.value === "number" && node.value > 0 ? node.value : undefined;
}

function enumEnabled(node: ExpressionNode | undefined, enabledProperty: string): boolean {
  if (node?.kind === "literal" && typeof node.value === "boolean") return node.value;
  return node?.kind === "member" && node.property === enabledProperty;
}

/**
 * The static request gateway has no typed invalid-symbol error nor an
 * authoritative historical FX-rate source.  Keep the default Pine behavior
 * executable, but reject every request for behavior the gateway cannot prove
 * it can honor.  This intentionally applies only to the dated compatibility
 * profile; the frozen profile retains its historical generated output.
 */
function validateStaticRequestOptions(
  kind: CompiledRequestPlan["kind"],
  ignoreInvalidSymbol: ExpressionNode | undefined,
  currency: ExpressionNode | undefined,
  diagnostics: Diagnostic[],
): void {
  const callable = kind === "security" ? "request.security" : "request.security_lower_tf";
  if (ignoreInvalidSymbol !== undefined && !(ignoreInvalidSymbol.kind === "literal" && ignoreInvalidSymbol.value === false)) {
    diagnostics.push({
      severity: "error",
      code: "SCRIPT2018",
      message: `${callable}() ignore_invalid_symbol is unsupported because Lumen Script cannot distinguish an invalid symbol from a data-gateway failure`,
      range: ignoreInvalidSymbol.range,
    });
  }
  if (currency !== undefined && !isCurrencyNone(currency)) {
    diagnostics.push({
      severity: "error",
      code: "SCRIPT2018",
      message: `${callable}() currency is unsupported because Lumen Script has no authoritative historical currency-rate provider`,
      range: currency.range,
    });
  }
}

function isCurrencyNone(node: ExpressionNode): boolean {
  return (node.kind === "member" && node.property.toUpperCase() === "NONE")
    || (node.kind === "literal" && typeof node.value === "string" && ["NONE", "CURRENCY.NONE"].includes(node.value.toUpperCase()));
}

function collectRequestCalls(program: ProgramNode, compatibility: PineCompatibility): CallNode[] {
  const calls = compatibility === PINE_COMPATIBILITY.legacy ? collectLegacyCallNodes(program) : collectCallNodes(program);
  return calls.filter((node) => (
    node.callee.kind === "member"
    && node.callee.object.kind === "identifier"
    && node.callee.object.name === "request"
    && (node.callee.property === "security" || node.callee.property === "security_lower_tf")
  ));
}

function requestContextKey(program: ProgramNode, source: string, node: CallNode, semantic: PineSemanticModel, compatibility?: PineCompatibility): string {
  const scope = containingCallable(program, node.range.start.offset);
  const scopeKey = scope === undefined ? "global" : `${scope.kind}:${String(scope.range.start.offset)}`;
  const callable = staticCallableName(node.callee);
  const argumentsByParameter = boundBuiltinArguments(node, semantic);
  if (isStrictPineCompatibility(compatibility)) {
    const argumentsKey = argumentsByParameter.map((argument) => argument === undefined ? null
      : lex(source.slice(argument.range.start.offset, argument.range.end.offset), compatibility)
        .filter((token) => token.kind !== "newline" && token.kind !== "eof")
        .map((token) => [token.kind, token.value]));
    return JSON.stringify([scopeKey, callable, argumentsKey]);
  }
  const argumentKey = argumentsByParameter.map((argument) => argument === undefined
    ? "<default>"
    : source.slice(argument.range.start.offset, argument.range.end.offset).replace(/\s+/gu, "")).join("\u0000");
  return `${scopeKey}\u0000${callable}\u0000${argumentKey}`;
}

function capturesLocalRequestExpression(program: ProgramNode, call: CallNode, expression: ExpressionNode): boolean {
  const container = program.statements.find((statement) => statement.range.start.offset <= call.range.start.offset && statement.range.end.offset >= call.range.end.offset);
  if (container === undefined) return false;
  const locals = new Set<string>();
  walkPineAst({ version: program.version, statements: [container] }, (node) => {
    if (node === container && node.kind === "declaration") return;
    if (node.range.start.offset >= call.range.start.offset) return;
    if (node.kind === "function" || node.kind === "method") for (const parameter of node.parameters) locals.add(parameter.name);
    if (node.kind === "declaration" || node.kind === "assignment") locals.add(node.name);
    if (node.kind === "tuple_declaration") for (const name of node.names) locals.add(name);
    if (node.kind === "for" || node.kind === "for_expression") locals.add(node.variable);
    if (node.kind === "for_in" || node.kind === "for_in_expression") for (const name of node.variables) locals.add(name);
  });
  let captures = false;
  walkPineAst({ version: program.version, statements: [{ kind: "expression", expression, range: expression.range }] }, (node) => {
    if (node.kind === "identifier" && locals.has(node.name)) captures = true;
  });
  return captures;
}

function locallyExecutedRequest(program: ProgramNode, call: CallNode, allowDynamic: boolean): boolean {
  let local = false;
  const contains = (node: { range: CallNode["range"] }) => node.range.start.offset <= call.range.start.offset && node.range.end.offset >= call.range.end.offset;
  walkPineAst(program, (node) => {
    if (!contains(node)) return;
    if (node.kind === "if" || node.kind === "if_expression") local ||= [...node.consequent, ...node.alternate].some(contains);
    if (node.kind === "for" || node.kind === "for_in" || node.kind === "while" || node.kind === "for_expression" || node.kind === "for_in_expression" || node.kind === "while_expression") local ||= node.body.some(contains);
    if (node.kind === "switch") local ||= node.cases.some((entry) => entry.body.some(contains) || (entry.test !== undefined && contains(entry.test)));
    if (node.kind === "conditional" && (allowDynamic || (program.version === 6 && node.test.kind !== "literal"))) {
      local ||= contains(node.consequent) || contains(node.alternate);
    }
    if (node.kind === "binary" && (node.operator === "and" || node.operator === "or")) local ||= contains(node.right);
  });
  return local;
}


function validateResolvedRequestOptions(gaps: ExpressionNode | undefined, lookahead: ExpressionNode | undefined, ignoreTimeframe: ExpressionNode | undefined, count: ExpressionNode | undefined, diagnostics: Diagnostic[]): void {
  const check = (name: string, node: ExpressionNode | undefined, valid: (value: string | number | boolean | null) => boolean) => {
    if (node === undefined || (node.kind === "literal" && valid(node.value))) return;
    diagnostics.push({ severity: "error", code: "SCRIPT2018", message: `Request ${name} must be a supported constant value; runtime-selected options are not supported yet`, range: node.range });
  };
  check("gaps", gaps, (value) => typeof value === "boolean" || value === "barmerge.gaps_on" || value === "barmerge.gaps_off");
  check("lookahead", lookahead, (value) => typeof value === "boolean" || value === "barmerge.lookahead_on" || value === "barmerge.lookahead_off");
  check("ignore_invalid_timeframe", ignoreTimeframe, (value) => typeof value === "boolean");
  check("calc_bars_count", count, (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
