import { PINE_COMPATIBILITY } from "./compatibility.js";

/**
 * Identity of this engine build, shared by the engine, the chart's worker and
 * the page. Lives in its own side-effect-free module so page code can read it
 * without bundling the compiler or runtime.
 */
export const PINE_RUNTIME_IDENTITY = Object.freeze({
  executorVersion: "lumen-script-0.9.0",
  compatibilityProfile: PINE_COMPATIBILITY.strict,
  workerProtocolVersion: 11,
  mainTimeframeAlignmentVersion: 1,
  visualContractVersion: 1,
} as const);
export const LUMEN_SCRIPT_EXECUTOR_VERSION = PINE_RUNTIME_IDENTITY.executorVersion;
