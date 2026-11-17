import type { CompiledFootprintArgument, CompiledFootprintPlan, CompiledProgram } from "../compiler/index.js";
import {
  LUMEN_SCRIPT_EXECUTOR_VERSION,
  PineFootprintError,
  admitPineFootprintDataset,
  extendPineFootprintStore,
  type AdmittedPineFootprintStoreV1,
  type MarketBar,
  type PineFootprintRequestV1,
  type PineValue,
  type SessionOptions,
} from "../contracts/index.js";
import { FootprintRuntimeStore, PineRuntimeError, admitFootprintArguments, type FootprintArguments, type RuntimeContext } from "../runtime/index.js";
import { evaluateStartupNumber, type StartupFailure } from "./evaluate-startup-program.js";

/** Everything needed to undo a failed restore without recomputing footprints. */
export interface SessionFootprintsState {
  readonly admitted: AdmittedPineFootprintStoreV1 | undefined;
  readonly store: FootprintRuntimeStore | undefined;
  readonly dirtyFrom: number;
}

interface FootprintSource {
  readonly symbol: string;
  readonly timeframe: string;
  readonly mintick: number;
  readonly ticksPerRow: number;
}

const ARGUMENT_FAILURE: StartupFailure = {
  message: "Footprint argument must resolve to a finite simple number",
  operation: "request.footprint",
};

/**
 * Owns one session's footprint data: argument resolution, provider loads,
 * stale-response rejection, tail extension, and the runtime store bound into
 * the RuntimeContext. Only bars from `dirtyFrom` onward are requested again;
 * unchanged bars keep their admitted rows and computed footprints.
 */
export class SessionFootprints {
  #admitted: AdmittedPineFootprintStoreV1 | undefined;
  #store: FootprintRuntimeStore | undefined;
  #dirtyFrom = 0;
  #generation = 0;
  #closed = false;

  public constructor(
    private readonly program: CompiledProgram,
    private readonly runtime: RuntimeContext,
    private readonly options: SessionOptions,
    private readonly signal: AbortSignal,
    private readonly throwIfAborted: () => void,
  ) {}

  public get enabled(): boolean { return this.program.footprintPlan !== undefined; }

  /** Exact admitted content the runtime currently reads; checkpoints bind to it. */
  public get identity(): string | undefined { return this.#store?.identity; }

  /** Marks bars from `index` onward as changed so the next prepare reloads them. */
  public invalidateFrom(index: number): void { this.#dirtyFrom = Math.min(this.#dirtyFrom, index); }

  public reset(): void {
    this.#commit(undefined, undefined);
    this.#dirtyFrom = 0;
  }

  public close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#commit(undefined, undefined);
  }

  public snapshot(): SessionFootprintsState {
    return { admitted: this.#admitted, store: this.#store, dirtyFrom: this.#dirtyFrom };
  }

  public rollback(state: SessionFootprintsState): void {
    this.#admitted = state.admitted;
    this.#store = state.store;
    this.#dirtyFrom = state.dirtyFrom;
    this.runtime.setFootprintStore(state.store);
  }

  /**
   * Brings footprint data up to date with `bars` before evaluation.
   * @returns true when existing footprint handles became invalid and evaluation must replay from the first bar.
   */
  public async prepare(bars: readonly MarketBar[], inputs: Readonly<Record<string, PineValue>>): Promise<boolean> {
    const plan = this.program.footprintPlan;
    if (plan === undefined) return false;
    const previousKey = this.#store?.key;
    const args = this.#arguments(plan, inputs);
    if (args === undefined || bars.length === 0) {
      this.#commit(undefined, undefined);
      this.#dirtyFrom = bars.length;
      return previousKey !== undefined;
    }
    const source = this.#source(args.ticksPerRow);
    const reusable = this.#admitted !== undefined && sameSource(this.#admitted, source);
    const dirtyFrom = reusable ? Math.min(this.#dirtyFrom, bars.length) : 0;
    const admitted = reusable && dirtyFrom >= bars.length ? this.#admitted! : await this.#load(bars, source, dirtyFrom);
    this.#commit(admitted, args);
    this.#dirtyFrom = bars.length;
    return previousKey !== this.#store!.key;
  }

  #arguments(plan: CompiledFootprintPlan, inputs: Readonly<Record<string, PineValue>>): FootprintArguments | undefined {
    const ticksPerRow = this.#argument(plan.ticksPerRow, inputs);
    const vaPercent = this.#argument(plan.vaPercent, inputs);
    const imbalancePercent = this.#argument(plan.imbalancePercent, inputs);
    try { return admitFootprintArguments(ticksPerRow, vaPercent, imbalancePercent); }
    catch (error) { throw PineRuntimeError.at(error, plan.sourceRange, "request.footprint", true); }
  }

  #argument(argument: CompiledFootprintArgument, inputs: Readonly<Record<string, PineValue>>): number {
    return argument.kind === "constant" ? argument.value : evaluateStartupNumber(argument.program, this.options, inputs, ARGUMENT_FAILURE);
  }

  #source(ticksPerRow: number): FootprintSource {
    const symbol = this.options.symbolInfo?.tickerid ?? this.options.symbolInfo?.ticker ?? "";
    const timeframe = this.options.timeframe ?? "";
    const mintick = Number(this.options.symbolInfo?.mintick);
    if (symbol.length === 0 || timeframe.length === 0 || !Number.isFinite(mintick) || mintick <= 0) {
      throw new PineFootprintError("SCRIPT_FOOTPRINT_INVALID_REQUEST", "Footprint execution requires symbol, timeframe, and positive mintick metadata");
    }
    return { symbol, timeframe, mintick, ticksPerRow };
  }

  async #load(bars: readonly MarketBar[], source: FootprintSource, fromIndex: number): Promise<AdmittedPineFootprintStoreV1> {
    if (this.options.footprintGateway === undefined) {
      throw new PineFootprintError("SCRIPT_FOOTPRINT_PROVIDER_UNAVAILABLE", "Footprint gateway is not configured");
    }
    const generation = ++this.#generation;
    const slice = await this.#fetch(bars, fromIndex, source, generation);
    const previous = this.#admitted;
    if (fromIndex === 0 || previous === undefined) return slice;
    // A new provider revision may have changed retained bars too.
    if (slice.datasetKey !== previous.datasetKey) return this.#fetch(bars, 0, source, generation);
    return extendPineFootprintStore(previous, slice, {
      parentOpenTimes: bars.map((bar) => bar.openTime),
      ...(this.options.footprintLimits === undefined ? {} : { limits: this.options.footprintLimits }),
    });
  }

  async #fetch(bars: readonly MarketBar[], fromIndex: number, source: FootprintSource, generation: number): Promise<AdmittedPineFootprintStoreV1> {
    const parentOpenTimes = bars.slice(fromIndex).map((bar) => bar.openTime);
    const request: PineFootprintRequestV1 = Object.freeze({
      schemaVersion: 1,
      symbol: source.symbol,
      timeframe: source.timeframe,
      ticksPerRow: source.ticksPerRow,
      fromOpenTime: parentOpenTimes[0]!,
      toOpenTime: parentOpenTimes.at(-1)!,
    });
    let dataset: unknown;
    try { dataset = await this.options.footprintGateway!.load(request, this.signal); }
    catch (error) {
      this.throwIfAborted();
      if (error instanceof PineFootprintError) throw error;
      throw new PineFootprintError("SCRIPT_FOOTPRINT_PROVIDER_FAILURE", "Footprint provider request failed", { cause: error });
    }
    this.throwIfAborted();
    if (generation !== this.#generation || this.#closed) {
      throw new PineFootprintError("SCRIPT_FOOTPRINT_STALE_RESPONSE", "Stale footprint response discarded");
    }
    return admitPineFootprintDataset(request, dataset, {
      mintick: source.mintick,
      parentOpenTimes,
      compatibility: this.program.compatibility,
      executorVersion: LUMEN_SCRIPT_EXECUTOR_VERSION,
      ...(this.options.footprintLimits === undefined ? {} : { limits: this.options.footprintLimits }),
    });
  }

  #commit(admitted: AdmittedPineFootprintStoreV1 | undefined, args: FootprintArguments | undefined): void {
    let store: FootprintRuntimeStore | undefined;
    if (admitted !== undefined && args !== undefined) {
      store = this.#store?.reusableFor(admitted, args) === true
        ? this.#store
        : new FootprintRuntimeStore(admitted, args, this.#store === undefined ? {} : { previous: this.#store });
    }
    this.#admitted = store === undefined ? undefined : admitted;
    this.#store = store;
    this.runtime.setFootprintStore(store);
  }
}

function sameSource(admitted: AdmittedPineFootprintStoreV1, source: FootprintSource): boolean {
  return admitted.request.symbol === source.symbol
    && admitted.request.timeframe === source.timeframe
    && admitted.request.ticksPerRow === source.ticksPerRow
    && admitted.mintick === source.mintick;
}
