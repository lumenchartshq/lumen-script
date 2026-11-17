import { compileRequestPlans } from "./request-plan-compilation.js";
import { compileFootprintPlan } from "./footprint-plan-compilation.js";
export type { StartupNode, StartupProgramV1, StartupScalar } from "./startup-program.js";
import type { CompileRequest, CompileResult, CompiledProgram, CompiledRequestPlan } from "./compiled-program.js";
export type { CompileRequest, CompileResult, CompiledFootprintArgument, CompiledFootprintPlan, CompiledProgram, CompiledRequestPlan } from "./compiled-program.js";
import { validateStaticTableLimits, validateMainTimeframeSideEffects } from "./static-program-validation.js";
import { mergeRuntimeRequirements } from "./runtime-requirements.js";
import { validatePineLibraryPublicationSource, type PineLibraryPublicationValidation } from "./library-publication-validation.js";
export { validatePineLibraryRequestPolicy } from "./library-request-policy.js";
import type { PineRuntimeRequirements, ProgramDescriptor } from "../contracts/index.js";
export type { PineRuntimeRequirements } from "../contracts/index.js";
import { generate } from "./codegen.js";
import { PineSyntaxError } from "./lexer.js";
import { parse } from "./parser.js";
import { bindProgram } from "./semantic-binder.js";
import { analyzeObservedValues } from "./observable-values.js";
import { isStrictPineCompatibility } from "../contracts/index.js";

/** Emits an ES module whose default export is a precompiled bar executor. */
export function emitExecutorModule(program: CompiledProgram): string {
  return `const createPineExecutor=()=>{${program.generatedSource}};\nexport default createPineExecutor();\n`;
}

type CompilationContext =
  | { readonly kind: "authored" }
  | { readonly kind: "request-capture"; readonly normalizeV5Booleans: boolean };

export function compile(request: CompileRequest): CompileResult {
  return compileWithCache(request, new Map(), { kind: "authored" });
}

function compileWithCache(request: CompileRequest, cache: Map<string, CompileResult>, context: CompilationContext): CompileResult {
  const authored = context.kind === "authored";
  const inheritedV5Mode = authored ? undefined : context.normalizeV5Booleans;
  const contextKey = authored ? context.kind : `${context.kind}:${String(context.normalizeV5Booleans)}`;
  const cacheKey = `${request.compatibility}\u0000${request.historicalFillSchedule ?? ""}\u0000${contextKey}\u0000${request.source}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const complete = (result: CompileResult): CompileResult => {
    cache.set(cacheKey, result);
    return result;
  };
  if (request.historicalFillSchedule !== undefined && request.historicalFillSchedule !== "lumencharts-v1") {
    return complete({ diagnostics: [{ severity: "error", code: "SCRIPT2020", message: "Unknown historical fill schedule" }] });
  }
  const marker = request.source.match(/^\s*\/\/@version\s*=\s*(\d+)\s*$/mu);
  if (marker === null) return complete({ diagnostics: [{ severity: "error", code: "SCRIPT1001", message: "The script must declare //@version=5 or //@version=6" }] });
  const parsedVersion = Number(marker[1]);
  if (parsedVersion !== 5 && parsedVersion !== 6) return complete({ diagnostics: [{ severity: "error", code: "SCRIPT1002", message: `Unsupported script version ${parsedVersion}; expected 5 or 6` }] });
  try {
    const parsed = parse(request.source, parsedVersion, request.compatibility);
    const semantic = bindProgram(parsed, request.compatibility);
    if (semantic.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return complete({ diagnostics: semantic.diagnostics });
    }
    const strict = isStrictPineCompatibility(request.compatibility);
    const analyzeV5Booleans = parsedVersion === 5 && authored && !semantic.v5RequiresMissingBooleans;
    // A request capture may omit parts of an original method that used its receiver.
    const hasMethods = authored && parsed.statements.some((statement) => statement.kind === "method");
    const observedValues = strict && (analyzeV5Booleans || semantic.hasMapIteration || hasMethods)
      ? analyzeObservedValues(parsed, semantic)
      : undefined;
    if (hasMethods && observedValues && observedValues.unusedMethodReceivers.size > 0) {
      return complete({
        diagnostics: [...semantic.diagnostics, ...[...observedValues.unusedMethodReceivers].map((receiver): CompileResult["diagnostics"][number] => ({
          severity: "error",
          code: "SCRIPT2140",
          message: `The '${receiver.name}' argument is not used. The first method argument should be used.`,
          range: receiver.range,
        }))],
      });
    }
    const normalizeV5Booleans = strict && parsedVersion === 5
      && (inheritedV5Mode ?? (!semantic.v5RequiresMissingBooleans && !observedValues?.requiresMissingBooleans));
    const staticLimitDiagnostics = strict
      ? validateStaticTableLimits(parsed, semantic)
      : [];
    const requests = compileRequestPlans(parsed, request, semantic, parsedVersion,
      (child) => compileWithCache(child, cache, { kind: "request-capture", normalizeV5Booleans }), observedValues?.observedRequests);
    if (requests.fatal) return complete({ diagnostics: requests.diagnostics });
    const { requestIds, requestPlans, diagnostics: requestDiagnostics } = requests;
    const generated = generate(
      parsed,
      requestIds,
      request.compatibility,
      strict ? semantic : undefined,
      new Set(requestPlans.filter((plan) => plan.dynamic).map((plan) => plan.id)),
      request.historicalFillSchedule === "lumencharts-v1",
      normalizeV5Booleans,
      observedValues?.liveMapIterations,
    );
    if (!generated.descriptor.dynamicRequests && requestPlans.some((plan) => plan.dynamic)) {
      const range = requestPlans.find((plan) => plan.dynamic)?.sourceRange;
      return complete({ diagnostics: [{ severity: "error", code: "SCRIPT2012", message: "Series request selectors require dynamic_requests=true", ...(range === undefined ? {} : { range }) }] });
    }
    const mainTimeframeDiagnostics = isStrictPineCompatibility(request.compatibility) && generated.descriptor.timeframeSpecified
      ? validateMainTimeframeSideEffects(parsed)
      : [];
    const historicalFillDiagnostics = validateHistoricalFillSchedule(
      request, parsedVersion, generated.descriptor, requestPlans, generated.runtimeRequirements,
    );
    const footprint = compileFootprintPlan(parsed, request.compatibility, semantic, requestPlans,
      (offset) => generated.inputIdsByOffset.get(offset));
    const diagnostics = [...semantic.diagnostics, ...staticLimitDiagnostics, ...requestDiagnostics, ...footprint.diagnostics,
      ...generated.diagnostics, ...mainTimeframeDiagnostics, ...historicalFillDiagnostics];
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return complete({ diagnostics });
    const childRequirements = requestPlans.map((plan) => ({ ...plan.program.runtimeRequirements, usesDatasetTail: plan.program.runtimeRequirements.usesDatasetTail || plan.calcBarsCount !== undefined || plan.startupCount !== undefined || plan.startupProgram !== undefined }));
    const inlineInputs = requestPlans.flatMap((plan) => plan.startupProgram?.inlineInputs ?? plan.startupCount?.inlineInputs ?? []);
    const descriptor = inlineInputs.length === 0 ? generated.descriptor
      : Object.freeze({ ...generated.descriptor, inputs: Object.freeze([...generated.descriptor.inputs, ...inlineInputs]) });
    const program = Object.freeze({
      compatibility: request.compatibility,
      version: parsedVersion,
      source: request.source,
      generatedSource: generated.generatedSource,
      ...(isStrictPineCompatibility(request.compatibility) ? { callSites: generated.callSites } : {}),
      variableNames: Object.freeze([...generated.variableNames]),
      indicatorTitle: generated.indicatorTitle,
      descriptor,
      requestPlans: Object.freeze(requestPlans),
      ...(footprint.plan === undefined ? {} : { footprintPlan: footprint.plan }),
      runtimeRequirements: mergeRuntimeRequirements(request.compatibility, [generated.runtimeRequirements, ...childRequirements]),
      ...(request.historicalFillSchedule === undefined
        ? {} : { historicalFillSchedule: request.historicalFillSchedule }),
    }) as CompiledProgram;
    return complete({ program, descriptor, diagnostics });
  } catch (error) {
    if (error instanceof PineSyntaxError) return complete({ diagnostics: [{ severity: "error", code: "SCRIPT1003", message: error.message, range: error.range }] });
    throw error;
  }
}

function validateHistoricalFillSchedule(
  request: CompileRequest,
  version: 5 | 6,
  descriptor: ProgramDescriptor,
  requestPlans: readonly CompiledRequestPlan[],
  requirements: PineRuntimeRequirements,
): CompileResult["diagnostics"] {
  if (request.historicalFillSchedule === undefined) return [];
  const strategy = descriptor?.strategy;
  const accepted = isStrictPineCompatibility(request.compatibility) && version === 6
    && descriptor?.kind === "strategy" && strategy?.calc_on_order_fills === true
    && !strategy.calc_on_every_tick && !strategy.process_orders_on_close
    && !strategy.use_bar_magnifier && !strategy.fill_orders_on_standard_ohlc
    && strategy.margin_long === 100 && strategy.margin_short === 100
    && strategy.currency === "NONE"
    && strategy.backtest_fill_limits_assumption === 0
    && requestPlans.length === 0 && !requirements.usesDatasetTail && !requirements.usesExecutionClock
    && !requirements.usesChartType && !requirements.usesVisibleRange;
  return accepted ? [] : [{
    severity: "error",
    code: "SCRIPT2020",
    message: "The Lumen Charts historical fill schedule admits only a v6 strategy with literal calc_on_order_fills=true, default margin, and no requests, every-tick, close-order, magnifier, dataset-tail, execution-clock, chart-type, or visible-range dependencies",
  }];
}

export { lex, PineSyntaxError } from "./lexer.js";
export { parse } from "./parser.js";
export type * from "./ast.js";

export { hasUnresolvedImports } from './import-analysis.js';
export { PINE_COMPILER_DIGEST, PINE_CATALOG_DIGEST } from './identity.js';

export { renamePineReceiverMethods } from "./receiver-method-renames.js";
export { renamePineBindings, pineGlobalBindings } from "./binding-renames.js";
export { stripPineLibraryDemonstration } from "./library-import-execution.js";

export { validatePineLibraryExports } from "./library-export-validation.js";
export function validatePineLibraryPublication(source: string, name: string): PineLibraryPublicationValidation {
  return validatePineLibraryPublicationSource(source, name, compile);
}
