import type { SourceRange, PineCompatibility, Diagnostic, InputDefinition, PineVersion, ProgramDescriptor, PineRuntimeRequirements } from "../contracts/index.js";
import type { ExpressionNode } from "./ast.js";
import type { StartupProgramV1 } from "./startup-program.js";

declare const programBrand: unique symbol;



export interface CompiledRequestPlan {
  readonly dynamic?: boolean;
  readonly sourceRange?: SourceRange;
  readonly id: string;
  readonly kind: "security" | "security_lower_tf";
  readonly symbol: string;
  readonly timeframe: string;
  readonly symbolInputId?: string;
  readonly symbolInputTitle?: string;
  readonly timeframeInputId?: string;
  readonly timeframeInputTitle?: string;
  readonly gaps: boolean;
  readonly lookahead: boolean;
  readonly ignoreInvalidTimeframe: boolean;
  readonly calcBarsCount?: number;
  readonly startupProgram?: StartupProgramV1;
  readonly startupCount?: {
    readonly expression: ExpressionNode;
    readonly declarations: Readonly<Record<string, ExpressionNode>>;
    readonly callerBindings: Readonly<Record<string, ExpressionNode>>;
    readonly localBindings: Readonly<Record<string, ExpressionNode>>;
    readonly inputIds: Readonly<Record<number, string>>;
    readonly inlineInputs: readonly InputDefinition[];
    readonly functions: Readonly<Record<string, { readonly parameters: readonly string[]; readonly expression: ExpressionNode }>>;
    readonly range: SourceRange;
  };
  readonly tupleArity: number;
  readonly program: CompiledProgram;
}

export type CompiledFootprintArgument =
  | { readonly kind: "constant"; readonly value: number }
  | { readonly kind: "startup"; readonly program: StartupProgramV1 };

export interface CompiledFootprintPlan {
  readonly id: "footprint-0";
  readonly sourceRange: SourceRange;
  readonly ticksPerRow: CompiledFootprintArgument;
  readonly vaPercent: CompiledFootprintArgument;
  readonly imbalancePercent: CompiledFootprintArgument;
}

export interface CompiledProgram {
  readonly [programBrand]: true;
  readonly compatibility: PineCompatibility;
  readonly version: PineVersion;
  readonly source: string;
  readonly generatedSource: string;
  readonly callSites?: Readonly<Record<number, SourceRange>>;
  readonly variableNames: readonly string[];
  readonly indicatorTitle: string;
  readonly descriptor: ProgramDescriptor;
  readonly requestPlans: readonly CompiledRequestPlan[];
  readonly footprintPlan?: CompiledFootprintPlan;
  readonly runtimeRequirements: PineRuntimeRequirements;
  /** Explicit internal admission; ordinary engine/chart sessions still reject it. */
  readonly historicalFillSchedule?: "lumencharts-v1";
}

export interface CompileResult {
  readonly program?: CompiledProgram;
  readonly descriptor?: ProgramDescriptor;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CompileRequest {
  readonly source: string;
  readonly compatibility: PineCompatibility;
  /** Compile only the bounded Lumen Charts historical fill schedule. */
  readonly historicalFillSchedule?: "lumencharts-v1";
}
