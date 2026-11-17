import { admitInputs } from "./inputs.js";
import { deserializePineLogJournal, serializePineLogJournal } from "./log-journal.js";
import type { CompiledProgram } from "../compiler/index.js";
import { LUMEN_SCRIPT_EXECUTOR_VERSION, type PineCheckpointLimits, type MarketBar, type PineLogJournalV1, type PineValue, type SessionCheckpoint, isStrictPineCompatibility } from "../contracts/index.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot, validatePublicExitSnapshot, validateStrategyFxSnapshot, type RuntimeSnapshot } from "../runtime/index.js";

export interface StoredReplaySnapshot {
  readonly nextIndex: number;
  readonly runtime: RuntimeSnapshot;
}

export interface StoredCheckpoint {
  readonly runtime: RuntimeSnapshot | undefined;
  readonly tail: StoredReplaySnapshot | undefined;
  readonly journal: PineLogJournalV1;
}

export function checkpointEvaluationStart(checkpoint: SessionCheckpoint): number {
  const start = checkpoint.firstEvaluatedBar === undefined ? 0 : checkpoint.firstEvaluatedBar;
  if (!Number.isSafeInteger(start) || start < 0 || (start > 0 && (checkpoint.version !== 2 || start >= checkpoint.bars.length))) {
    throw new Error("Invalid checkpoint evaluation window");
  }
  return start;
}

/** Owns checkpoint identity and decoding; admission never mutates an engine session. */
export class SessionCheckpoints {
  private readonly states = new WeakMap<SessionCheckpoint, StoredCheckpoint>();
  private readonly fingerprint: string;

  public constructor(private readonly program: CompiledProgram, private readonly limits?: PineCheckpointLimits,
    private readonly fxContextIdentity?: string, private readonly crossCurrencyFx = false) {
    this.fingerprint = fingerprintProgram(program);
  }

  public capture(bars: readonly MarketBar[], inputs: Readonly<Record<string, PineValue>>, stored: Omit<StoredCheckpoint, "journal"> | undefined, journal: PineLogJournalV1, footprintStoreIdentity?: string, firstEvaluatedBar = 0): SessionCheckpoint {
    const checkpoint: SessionCheckpoint = Object.freeze({
      version: 2 as const,
      executorVersion: LUMEN_SCRIPT_EXECUTOR_VERSION,
      programFingerprint: this.fingerprint,
      ...(this.fxContextIdentity === undefined ? {} : { fxContextIdentity: this.fxContextIdentity }),
      ...(stored?.runtime?.fxSelectionIdentity === undefined ? {} : { fxSelectionIdentity: stored.runtime.fxSelectionIdentity }),
      ...(stored?.runtime?.footprintStoreKey === undefined || footprintStoreIdentity === undefined ? {} : { footprintStoreIdentity }),
      bars: Object.freeze([...bars]),
      ...(firstEvaluatedBar === 0 ? {} : { firstEvaluatedBar }),
      inputs: admitInputs(inputs),
      logState: serializePineLogJournal(journal),
      ...(stored?.runtime === undefined ? {} : { runtimeState: serializeRuntimeSnapshot(stored.runtime, this.limits) }),
      ...(stored?.tail === undefined ? {} : {
        tailState: Object.freeze({ nextIndex: stored.tail.nextIndex, runtimeState: serializeRuntimeSnapshot(stored.tail.runtime, this.limits) }),
      }),
    });
    this.states.set(checkpoint, { runtime: stored?.runtime, tail: stored?.tail, journal });
    return checkpoint;
  }

  public read(checkpoint: SessionCheckpoint, expectedSelectionIdentity?: string, expectedFootprintStoreIdentity?: string): StoredCheckpoint | undefined {
    const evaluatedBars = checkpoint.bars.length - checkpointEvaluationStart(checkpoint);
    if (checkpoint.fxContextIdentity !== this.fxContextIdentity) throw new Error("FX checkpoint context does not match this session");
    if (checkpoint.fxSelectionIdentity !== expectedSelectionIdentity) throw new Error("FX checkpoint selected rate does not match this evaluation clock");
    // Legacy bars/inputs-only checkpoints are replay instructions, not runtime state.
    const legacy = checkpoint.version === undefined && checkpoint.executorVersion === undefined
      && checkpoint.programFingerprint === undefined && checkpoint.runtimeState === undefined && checkpoint.tailState === undefined && checkpoint.logState === undefined;
    if (legacy) return undefined;
    const current = checkpoint.version === 2 && checkpoint.executorVersion === LUMEN_SCRIPT_EXECUTOR_VERSION
      && checkpoint.programFingerprint === this.fingerprint;
    if (!current) {
      throw new Error("Checkpoint does not belong to this compiled script");
    }
    // Replay-only checkpoints contain no footprint handles to bind to a dataset.
    if ((checkpoint.runtimeState !== undefined || checkpoint.footprintStoreIdentity !== undefined)
      && checkpoint.footprintStoreIdentity !== expectedFootprintStoreIdentity) {
      throw new Error("Footprint checkpoint store does not match this session");
    }
    if (checkpoint.logState === undefined) throw new Error("Invalid checkpoint log state");
    if (checkpoint.tailState !== undefined && (
      checkpoint.runtimeState === undefined || !Number.isInteger(checkpoint.tailState.nextIndex)
      || checkpoint.tailState.nextIndex < 0 || checkpoint.tailState.nextIndex !== evaluatedBars - 1
    )) throw new Error("Invalid checkpoint tail position");
    const stored = this.states.get(checkpoint);
    if (stored !== undefined) {
      this.assertFxState(stored.runtime);
      this.assertFxState(stored.tail?.runtime);
      if (stored.runtime?.fxSelectionIdentity !== checkpoint.fxSelectionIdentity) throw new Error("FX checkpoint selected rate does not match runtime state");
      assertFootprintState(stored.runtime, checkpoint);
      return stored;
    }
    const journal = deserializePineLogJournal(checkpoint.logState);
    if (checkpoint.runtimeState === undefined) return { runtime: undefined, tail: undefined, journal };
    const decoded = {
      runtime: deserializeRuntimeSnapshot(checkpoint.runtimeState, this.limits, isStrictPineCompatibility(this.program.compatibility)),
      tail: checkpoint.tailState === undefined ? undefined : {
        nextIndex: checkpoint.tailState.nextIndex,
        runtime: deserializeRuntimeSnapshot(checkpoint.tailState.runtimeState, this.limits, isStrictPineCompatibility(this.program.compatibility)),
      },
      journal,
    };
    this.assertPosition(decoded.runtime, evaluatedBars - 1, evaluatedBars);
    if (decoded.tail !== undefined) this.assertPosition(decoded.tail.runtime, decoded.tail.nextIndex - 1, decoded.tail.nextIndex);
    this.assertFxState(decoded.runtime);
    this.assertFxState(decoded.tail?.runtime);
    if (decoded.runtime.fxSelectionIdentity !== checkpoint.fxSelectionIdentity) throw new Error("FX checkpoint selected rate does not match runtime state");
    assertFootprintState(decoded.runtime, checkpoint);
    return decoded;
  }

  private assertFxState(runtime: RuntimeSnapshot | undefined): void {
    if (runtime === undefined) return;
    if (runtime.fxContextIdentity !== this.fxContextIdentity) throw new Error("FX checkpoint runtime context does not match this session");
    validateStrategyFxSnapshot(runtime.strategy, this.crossCurrencyFx, runtime.barIndex >= 0,
      runtime.fxSelectionIdentity);
  }

  private assertPosition(runtime: RuntimeSnapshot, expectedIndex: number, evaluatedBars: number): void {
    if (runtime.barIndex !== expectedIndex || runtime.variables.length !== this.program.variableNames.length
      || runtime.variableHistory.length !== this.program.variableNames.length
      || runtime.variables.some((series) => series.length > evaluatedBars)
      || runtime.variableHistory.some((window) => window.last > expectedIndex)
      || [...runtime.argumentSeries.values(), ...runtime.historySeries.values(), ...[...runtime.localState.values()].map((state) => state.values)]
        .some((window) => window.last > expectedIndex)) {
      throw new Error("Invalid checkpoint program or dataset position");
    }
    if ((runtime.strategy !== undefined) !== (this.program.descriptor.kind === "strategy")) {
      throw new Error("Invalid checkpoint strategy state for program");
    }
    if (isStrictPineCompatibility(this.program.compatibility) && runtime.strategy !== undefined) {
      validatePublicExitSnapshot(runtime.strategy);
    }
    if (isStrictPineCompatibility(this.program.compatibility) && runtime.strategy?.config.calc_on_order_fills === true) {
      throw new Error("strategy() calc_on_order_fills is unsupported because Lumen Script does not recalculate after fills");
    }
  }
}


function fingerprintProgram(program: CompiledProgram, executorVersion: string = LUMEN_SCRIPT_EXECUTOR_VERSION): string {
  let hash = 0xcbf29ce484222325n;
  // The root executor contains request IDs, not their child expressions/selectors.
  // Original source also covers declaration options that live outside generated JS.
  const source = JSON.stringify([executorVersion, program.compatibility, program.source, program.descriptor, program.variableNames, program.runtimeRequirements, program.generatedSource]);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Runtime state carries footprint handles exactly when the checkpoint names the dataset content they read. */
function assertFootprintState(runtime: RuntimeSnapshot | undefined, checkpoint: SessionCheckpoint): void {
  if ((runtime?.footprintStoreKey === undefined) !== (checkpoint.footprintStoreIdentity === undefined)) {
    throw new Error("Footprint checkpoint store does not match runtime state");
  }
}
