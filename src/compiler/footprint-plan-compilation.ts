import type { Diagnostic, PineCompatibility, SourceRange } from "../contracts/index.js";
import { PINE_FOOTPRINT_DEFAULTS, isStrictPineCompatibility } from "../contracts/index.js";
import type { CallNode, ExpressionNode, ProgramNode } from "./ast.js";
import { collectCallNodes, walkPineAst } from "./ast-walk.js";
import { boundBuiltinArguments, staticCallableName } from "./call-analysis.js";
import { compileStartupProgram, type StartupProgramOptions } from "./compile-startup-program.js";
import type { CompiledFootprintArgument, CompiledFootprintPlan, CompiledRequestPlan } from "./compiled-program.js";
import type { PineSemanticModel } from "./semantic-binder.js";

export interface FootprintPlanCompilation {
  readonly plan?: CompiledFootprintPlan;
  readonly diagnostics: readonly Diagnostic[];
}

const excludedContainerKinds = new Set([
  "function", "method", "if", "if_expression", "while", "while_expression", "for", "for_expression",
  "for_in", "for_in_expression", "switch", "conditional",
]);

/**
 * @param inputIdAt resolves inline `input.*()` arguments to the ids the generated
 *   program registered, so startup evaluation reads the same overrides as the script.
 */
export function compileFootprintPlan(
  program: ProgramNode,
  compatibility: PineCompatibility,
  semantic: PineSemanticModel,
  requestPlans: readonly CompiledRequestPlan[],
  inputIdAt: (offset: number) => string | undefined,
): FootprintPlanCompilation {
  if (!isStrictPineCompatibility(compatibility)) return { diagnostics: [] };
  const nested = requestPlans.find((plan) => plan.program.footprintPlan !== undefined);
  if (nested !== undefined) {
    return { diagnostics: [error(nested.sourceRange, "request.footprint() is not supported inside request.security() expressions")] };
  }
  const calls = collectCallNodes(program).filter((call) => staticCallableName(call.callee) === "request.footprint");
  if (calls.length === 0) return { diagnostics: [] };
  if (calls.length > 1) return { diagnostics: [error(calls[1]!.range, "A script may contain only one request.footprint() call site")] };
  const call = calls[0]!;
  if (program.version !== 6) return { diagnostics: [error(call.range, "request.footprint() requires version 6")] };
  if (isExcludedContext(program, call)) {
    return { diagnostics: [error(call.range, "request.footprint() must be a static call on the main chart dataset; functions, methods, loops, and conditional contexts are unsupported")] };
  }
  const ordered = boundBuiltinArguments(call, semantic);
  const compileArgument = (expression: ExpressionNode | undefined, expected: "int" | "number", fallback?: number) => expression === undefined
    ? constant(fallback)
    : compileFootprintArgument(program, call, expression, semantic, { expected, inputIdAt, allowNegativeInputDefaults: true });
  const ticksPerRow = compileArgument(ordered[0], "int");
  const vaPercent = compileArgument(ordered[1], "number", PINE_FOOTPRINT_DEFAULTS.vaPercent);
  const imbalancePercent = compileArgument(ordered[2], "number", PINE_FOOTPRINT_DEFAULTS.imbalancePercent);
  if (ticksPerRow === undefined || vaPercent === undefined || imbalancePercent === undefined) {
    return { diagnostics: [error(call.range, "Footprint arguments must be literals or startup-evaluable simple numeric inputs")] };
  }
  return {
    diagnostics: [],
    plan: Object.freeze({ id: "footprint-0", sourceRange: call.range, ticksPerRow, vaPercent, imbalancePercent }),
  };
}

function compileFootprintArgument(
  program: ProgramNode,
  call: CallNode,
  expression: ExpressionNode,
  semantic: PineSemanticModel,
  options: StartupProgramOptions,
): CompiledFootprintArgument | undefined {
  if (expression.kind === "identifier" && expression.name === "na") return constant(Number.NaN);
  if (expression.kind === "literal" && typeof expression.value === "number" && Number.isFinite(expression.value)) {
    return constant(expression.value);
  }
  const startupProgram = compileStartupProgram(program, call, expression, semantic, options);
  return startupProgram === undefined ? undefined : Object.freeze({ kind: "startup", program: startupProgram });
}

function constant(value: number | undefined): CompiledFootprintArgument | undefined {
  return value === undefined ? undefined : Object.freeze({ kind: "constant", value });
}

function isExcludedContext(program: ProgramNode, call: CallNode): boolean {
  const contains = (node: { readonly range: SourceRange }) => node.range.start.offset <= call.range.start.offset && node.range.end.offset >= call.range.end.offset;
  let excluded = false;
  walkPineAst(program, (node) => {
    if (node !== call && contains(node) && excludedContainerKinds.has(node.kind)) excluded = true;
  });
  return excluded;
}

function error(range: SourceRange | undefined, message: string): Diagnostic {
  return { severity: "error", code: "SCRIPT2031", message, ...(range === undefined ? {} : { range }) };
}
