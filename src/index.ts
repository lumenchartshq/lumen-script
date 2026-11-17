import type { CompiledProgram, CompileRequest as CoreCompileRequest, CompileResult } from "./compiler/index.js";
import type { EngineSessionOptions } from "./engine/index.js";
import type {
  ExecutionDelta,
  ExecutionProgress,
  ExecutionResult,
  MarketBar,
  PineLogJournalV1,
  PineValue,
  SessionCheckpoint,
} from "./contracts/index.js";
import { PineEngine as CorePineEngine, compile as coreCompile } from "./engine/index.js";
export {
  PINE_MAIN_TIMEFRAME_GAPS_INPUT_ID,
  PINE_MAIN_TIMEFRAME_INPUT_ID,
  PINE_RUNTIME_IDENTITY,
  PINE_PRODUCTION_BUILTIN_CATALOG,
  PINE_PRODUCTION_CALLABLE_METADATA,
  PINE_COMPATIBILITY,
  LUMEN_SCRIPT_EXECUTOR_VERSION,
  PineFootprintError,
  isStrictPineCompatibility,
  pineBuiltinCatalog,
  pineBuiltinRegistry,
  pineCallableMetadata,
} from "./contracts/index.js";
export type { PineBuiltinCatalog, PineBuiltinSpec, PineCallableDefinition, PineCompatibility } from "./contracts/index.js";

export { PINE_COMPILER_DIGEST, PINE_CATALOG_DIGEST, emitExecutorModule } from "./compiler/index.js";
export type { CompiledProgram, CompileResult, PineRuntimeRequirements } from "./compiler/index.js";

/** Source and compatibility profile to compile. */
export type CompileRequest = Omit<CoreCompileRequest, "historicalFillSchedule">;
export { PineRuntimeError } from "./runtime/index.js";
export type { EngineSessionOptions } from "./engine/index.js";
export type {
  ExecutionDelta,
  ExecutionProgress,
  ExecutionResult,
  MarketBar,
  MarketDataGateway,
  PineFootprintDatasetV1,
  PineFootprintErrorCode,
  PineFootprintGateway,
  PineFootprintRequestV1,
  PineValue,
  PineSessionSchedule,
  PineSessionCorrection,
  PineSessionCorrections,
  PineSubsessionInfo,
  ProgramDescriptor,
  SessionOptions,
  StrategyResult,
} from "./contracts/index.js";

export interface EngineSession {
  runBatch(bars: readonly MarketBar[], options?: ExecutionProgressOptions): Promise<ExecutionResult>;
  appendBars(bars: readonly MarketBar[], options?: ExecutionProgressOptions): Promise<ExecutionDelta>;
  runPaginated(bars: readonly MarketBar[], pageSize: number): AsyncGenerator<ExecutionDelta>;
  replaceTail(bars: readonly MarketBar[], options?: ExecutionProgressOptions): Promise<ExecutionDelta>;
  updateInputs(values: Readonly<Record<string, PineValue>>): Promise<void>;
  checkpoint(): SessionCheckpoint;
  restore(checkpoint: SessionCheckpoint): Promise<ExecutionResult>;
  logs(): PineLogJournalV1;
  close(): Promise<void>;
}

export interface ExecutionProgressOptions {
  onProgress?(progress: ExecutionProgress): void;
  logCause?: "realtime-tick" | "historical-correction";
}

export interface PineEngine {
  createSession(program: CompiledProgram, options?: EngineSessionOptions): EngineSession;
}

export const PineEngine: new () => PineEngine = CorePineEngine;

export const compile: (request: CompileRequest) => CompileResult = coreCompile;

export { renamePineReceiverMethods } from "./compiler/index.js";
export { renamePineBindings, pineGlobalBindings } from "./compiler/index.js";
export { stripPineLibraryDemonstration } from "./compiler/index.js";

export { validatePineLibraryExports } from "./compiler/index.js";
export { validatePineLibraryRequestPolicy } from "./compiler/index.js";
