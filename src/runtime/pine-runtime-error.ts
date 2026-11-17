import type { SourceRange } from "../contracts/index.js";

export class PineRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly method?: string,
    public readonly range?: SourceRange,
    public readonly code: "SCRIPT_RUNTIME_ERROR" | "SCRIPT_LOOP_LIMIT" = "SCRIPT_RUNTIME_ERROR",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PineRuntimeError";
  }

  public static at(error: unknown, range: SourceRange | undefined, method: string, replaceRange = false): PineRuntimeError {
    const prior = error instanceof PineRuntimeError ? error : undefined;
    return new PineRuntimeError(error instanceof Error ? error.message : String(error), prior?.method ?? method,
      replaceRange ? range : prior?.range ?? range, prior?.code ?? "SCRIPT_RUNTIME_ERROR", error);
  }
}
