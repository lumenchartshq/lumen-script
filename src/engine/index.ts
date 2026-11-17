import { DynamicRequestDiscovery, RequestDatasetDemand } from "./dynamic-request-discovery.js";
import { admitProgramInputs } from "./inputs.js";
import { alignRequestValues, alignLowerRequestArrays, alignSameContextRequestValues, wrapLowerRequestValues } from "./request-alignment.js";
import { requestSelectorValue, normalizeEngineTimeframe, requestTimeframeRank, sessionTimezone, requestContextIdentity, normalizeChildSymbolInfo } from "./request-context-policy.js";
import { requestStartupCount } from "./request-startup-count.js";
import { admitBars, appendBarDataset, replaceBarTail } from "./dataset.js";
import { RequestContextBudget } from "./request-context-budget.js";
import { RequestContexts } from "./request-contexts.js";
import { structurallyEqual } from "./value-equality.js";
import { sceneDelta } from "./scene-delta.js";
import { compile, type CompileRequest, type CompileResult, type CompiledProgram, type CompiledRequestPlan } from "../compiler/index.js";
import { SessionOperations } from "./session-operations.js";
import { PineLogAttempt, PineLogJournal } from "./log-journal.js";
import { checkpointEvaluationStart, SessionCheckpoints, type StoredCheckpoint, type StoredReplaySnapshot } from "./session-checkpoints.js";
import { decodeLumenChartsTickerIdentity, lumenChartsTickerBaseSymbol, lumenChartsTickerParts, type ExecutionDelta, type ExecutionProgress, type ExecutionResult, type MarketBar, type MarketDataset, type PineLogEventV1, type PineLogJournalV1, type PineSessionSchedule, type PineValue, type SessionCheckpoint, type SessionOptions, type SymbolInfo, type LumenChartsTickerIdentityV1, isStrictPineCompatibility } from "../contracts/index.js";
import { admitSessionChartContext } from "./chart-context.js";
import { PineRuntimeError, createExecutor, createRuntime, resolveSessionSchedule, type BarExecutor, type RuntimeContext, type RuntimeTailSnapshot } from "../runtime/index.js";
import { SessionFootprints } from "./session-footprints.js";
import { applyLumenChartsTickerIdentity } from "./synthetic-ticker-bars.js";
import { admitSessionSymbolInfo } from "./symbol-info.js";

const MAX_REQUEST_CONTEXTS = 40;

interface ReplaySnapshot {
  readonly nextIndex: number;
  readonly runtime: RuntimeTailSnapshot;
}

export interface EngineSessionOptions extends SessionOptions {
  /** Omit to return all variables; chart hosts can request only consumed outputs. */
  readonly resultVariables?: readonly string[];
  /**
   * trusted-dynamic uses Function to instantiate compiler-owned output.
   * precompiled requires executorFactory and is compatible with strict script-src CSP.
   */
  readonly codeGeneration?: "trusted-dynamic" | "precompiled";
  readonly executorFactory?: (program: CompiledProgram) => BarExecutor;
  /** Engine-internal bridge for committed child-request logs. */
  readonly onCommittedLogs?: (events: readonly PineLogEventV1[]) => void;
}

export interface ExecutionProgressOptions {
  /** Completed historical batches can replay later instead of retaining rollback state. */
  readonly retainTailSnapshot?: boolean;
  readonly onProgress?: (progress: ExecutionProgress) => void;
  /** A tail correction starts a new epoch; a real tick retains prior tick logs. */
  readonly logCause?: "realtime-tick" | "historical-correction";
}

interface EvaluationPolicy {
  readonly reset: boolean;
  readonly fromIndex: number;
  readonly realtimeUpdateOpenTime?: number;
}
interface EvaluationOutcome {
  readonly requestChangeIndex?: number;
  readonly result: ExecutionResult;
}

export class PineEngine {
  public createSession(program: CompiledProgram, options: EngineSessionOptions = {}): EngineSession {
    return new EngineSession(program, options);
  }
}

export class EngineSession {
  private readonly executor: (runtime: RuntimeContext) => void;
  private readonly runtime: RuntimeContext;
  private readonly effectiveSessionSchedule: PineSessionSchedule;
  private readonly abortController = new AbortController();
  private readonly signal: AbortSignal;
  private readonly requests: RequestContexts<EngineSession>;
  private dynamicAdmissions = new Map<string, CompiledRequestPlan>();
  private readonly checkpoints: SessionCheckpoints;
  private readonly logJournal = new PineLogJournal();
  private activeChildLogs: PineLogAttempt | undefined;
  private bars: readonly MarketBar[] = [];
  private suppliedBars: readonly MarketBar[] = [];
  private firstEvaluatedBar = 0;
  private inputs: Readonly<Record<string, PineValue>>;
  private lastResult: ExecutionResult | undefined;
  private committedDynamicRequestSeries: Readonly<Record<string, readonly PineValue[]>> | undefined;
  private committedRequestSeries: Readonly<Record<string, readonly PineValue[]>> | undefined;
  private tailSnapshot: ReplaySnapshot | undefined;
  private requiresFullReplay = false;
  private currentEvaluationNow = Number.NaN;
  private closed = false;
  private failed = false;
  private readonly operations = new SessionOperations();
  private readonly options: EngineSessionOptions;
  private readonly resultVariables: ReadonlySet<string> | undefined;
  private readonly fxAccountCurrency: string | undefined;
  private readonly footprints: SessionFootprints;

  public constructor(
    private readonly program: CompiledProgram,
    options: EngineSessionOptions,
    private readonly requestBudget = new RequestContextBudget(isStrictProgram(program) ? MAX_REQUEST_CONTEXTS : Number.POSITIVE_INFINITY),
    requestAccountCurrency?: string,
  ) {
    this.resultVariables = options.resultVariables === undefined ? undefined : new Set(options.resultVariables);
    const symbolInfo = admitSessionSymbolInfo(options.symbolInfo, isStrictProgram(program));
    const admittedOptions = admitSessionChartContext(
      symbolInfo === undefined || symbolInfo === options.symbolInfo ? options : { ...options, symbolInfo },
      isStrictProgram(program),
    );
    if (options.codeGeneration === "precompiled" && options.executorFactory === undefined) {
      throw new Error("Precompiled execution requires an executorFactory; use emitExecutorModule() during the build step");
    }
    this.effectiveSessionSchedule = resolveSessionSchedule(admittedOptions);
    this.inputs = admitProgramInputs(program.descriptor, isStrictProgram(program), admittedOptions.inputs ?? {}, admittedOptions.sourceSeries);
    this.runtime = createRuntime(program, { ...admittedOptions, inputs: this.inputs, sessionSchedule: this.effectiveSessionSchedule }, requestAccountCurrency);
    const fxContext = this.runtime.admittedFxContext();
    this.fxAccountCurrency = fxContext.accountCurrency;
    this.options = fxContext.book === undefined ? admittedOptions : { ...admittedOptions, fxRateBook: fxContext.book };
    this.checkpoints = new SessionCheckpoints(program, this.options.checkpointLimits, fxContext.identity,
      fxContext.book !== undefined && fxContext.symbolCurrency !== fxContext.accountCurrency);
    this.requests = new RequestContexts(this.requestBudget, isStrictProgram(program));
    this.executor = this.options.executorFactory?.(program) ?? createExecutor(program);
    this.signal = this.options.signal === undefined
      ? this.abortController.signal
      : AbortSignal.any([this.abortController.signal, this.options.signal]);
    this.footprints = new SessionFootprints(program, this.runtime, this.options, this.signal, () => this.throwIfAborted());
  }

  public async runBatch(bars: readonly MarketBar[], options: ExecutionProgressOptions = {}): Promise<ExecutionResult> {
    return this.withOperation("runBatch", async () => {
      this.assertOpen();
      const admitted = this.admitBars(bars);
      this.installDataset(admitted, this.rootHistoryStart(admitted));
      this.footprints.invalidateFrom(0);
      if (this.program.requestPlans.some((plan) => plan.dynamic)) await this.closeRequestContexts();
      return this.executeFull(options, { reset: true, fromIndex: 0 });
    });
  }

  public async appendBars(bars: readonly MarketBar[], options: ExecutionProgressOptions = {}): Promise<ExecutionDelta> {
    return this.withOperation("appendBars", () => { this.assertReady(); return this.appendPage(bars, options); });
  }

  public async *runPaginated(bars: readonly MarketBar[], pageSize: number): AsyncGenerator<ExecutionDelta> {
    this.assertOpen();
    const finish = this.operations.begin("runPaginated");
    try {
      this.assertReady();
      if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error("pageSize must be a positive integer");
      const admitted = this.admitBars(bars);
      if (this.program.requestPlans.some((plan) => plan.dynamic)) await this.closeRequestContexts();
      const first = this.rootHistoryStart(admitted);
      this.installDataset(first === 0 ? [] : Object.freeze(admitted.slice(0, first)), first);
      this.footprints.reset();
      this.lastResult = undefined;
      this.tailSnapshot = undefined;
      this.requiresFullReplay = false;
      for (let index = first; index < admitted.length; index += pageSize) {
        yield await this.appendPage(admitted.slice(index, index + pageSize), {});
      }
    } finally { finish(); }
  }

  public async replaceTail(bars: readonly MarketBar[], options: ExecutionProgressOptions = {}): Promise<ExecutionDelta> {
    return this.withOperation("replaceTail", async () => {
      this.assertReady();
      if (bars.length === 0) {
        const previous = this.lastResult;
        const fromIndex = this.requiresFullReplay ? 0 : this.bars.length;
        const result = await this.executeFull(options, { reset: true, fromIndex: 0 });
        return { ...result, fromIndex, sceneDelta: sceneDelta(previous, result) };
      }
      const replacement = replaceBarTail(this.suppliedBars, bars, this.options.limits?.maxBars ?? 20_000);
      const previous = this.lastResult;
      const previousTail = this.bars.at(-1);
      const sameTail = previousTail !== undefined && bars.length === 1 && bars[0]?.openTime === previousTail.openTime;
      const realtimeUpdate = isStrictProgram(this.program) && previous !== undefined && sameTail
        && (options.logCause === "realtime-tick" || (options.logCause === undefined
          && (previousTail.closeTime ?? previousTail.openTime) > this.currentEvaluationNow));
      const rebase = replacement.fromIndex < this.firstEvaluatedBar;
      const first = rebase ? this.rootHistoryStart(replacement.bars) : this.firstEvaluatedBar;
      this.installDataset(replacement.bars, first);
      if (rebase) this.requiresFullReplay = true;
      const spliceIndex = this.requiresFullReplay ? 0 : replacement.fromIndex - first;
      this.footprints.invalidateFrom(spliceIndex);
      const realTick = options.logCause === "realtime-tick" || realtimeUpdate;
      const execution = await this.executeIncremental(spliceIndex, replacement.tailChanged, options, {
        reset: !realTick,
        fromIndex: realTick ? spliceIndex : 0,
        ...(realtimeUpdate ? { realtimeUpdateOpenTime: previousTail.openTime } : {}),
      });
      const fromIndex = Math.min(spliceIndex, execution.requestChangeIndex ?? spliceIndex);
      return { ...execution.result, fromIndex, sceneDelta: sceneDelta(previous, execution.result) };
    });
  }

  public async updateInputs(values: Readonly<Record<string, PineValue>>): Promise<void> {
    return this.withOperation("updateInputs", async () => {
      this.assertOpen();
      this.inputs = admitProgramInputs(this.program.descriptor, isStrictProgram(this.program), values, this.options.sourceSeries);
      const first = this.rootHistoryStart(this.suppliedBars);
      if (first !== this.firstEvaluatedBar) this.footprints.invalidateFrom(0);
      this.installDataset(this.suppliedBars, first);
      this.requiresFullReplay = true;
      await this.closeRequestContexts();
    });
  }

  public checkpoint(): SessionCheckpoint {
    this.assertReady();
    this.operations.assertIdle();
    if (this.lastResult !== undefined && this.requiresFullReplay) throw new Error("Checkpoint requires evaluation of pending input changes");
    const runtime = this.lastResult === undefined ? undefined : this.runtime.snapshot();
    let storedTail: StoredReplaySnapshot | undefined;
    if (runtime !== undefined && this.tailSnapshot !== undefined) {
      try {
        this.runtime.restoreTail(this.tailSnapshot.runtime, this.bars, this.inputs);
        storedTail = { nextIndex: this.tailSnapshot.nextIndex, runtime: this.runtime.snapshot() };
      } finally {
        this.runtime.restore(runtime, this.bars, this.inputs);
      }
      this.tailSnapshot = { nextIndex: storedTail.nextIndex, runtime: { kind: "full", snapshot: storedTail.runtime } };
    }
    return this.checkpoints.capture(this.suppliedBars, this.inputs, runtime === undefined ? undefined : { runtime, tail: storedTail }, this.logJournal.snapshot(),
      this.footprints.identity, this.firstEvaluatedBar);
  }

  public logs(): PineLogJournalV1 { return this.logJournal.snapshot(); }

  public async restore(checkpoint: SessionCheckpoint): Promise<ExecutionResult> {
    return this.withOperation("restore", async () => {
      this.assertOpen();
      const suppliedBars = this.admitBars(checkpoint.bars);
      const inputs = admitProgramInputs(this.program.descriptor, isStrictProgram(this.program), checkpoint.inputs, this.options.sourceSeries);
      const first = checkpoint.version === undefined ? this.rootHistoryStart(suppliedBars, inputs) : checkpointEvaluationStart(checkpoint);
      const bars = first === 0 ? suppliedBars : Object.freeze(suppliedBars.slice(first));
      const inputsChanged = !structurallyEqual(inputs, this.inputs);
      const restoreNow = this.options.fxRateBook === undefined ? Number.NaN : this.options.now?.() ?? Date.now();
      const footprintState = this.footprints.snapshot();
      let stored: StoredCheckpoint | undefined;
      try {
        if (this.footprints.enabled) {
          // Restore binds to freshly loaded provider content, never to the live cache.
          this.footprints.invalidateFrom(0);
          await this.footprints.prepare(bars, inputs);
        }
        const expectedSelection = this.runtime.expectedFxSelectionIdentity(bars, bars.length - 1, restoreNow);
        stored = this.checkpoints.read(checkpoint, expectedSelection, this.footprints.identity);
        if (stored?.tail !== undefined && stored.tail.runtime.fxSelectionIdentity !== this.runtime.expectedFxSelectionIdentity(
          bars, stored.tail.runtime.barIndex, restoreNow)) {
          throw new Error("FX checkpoint tail selected rate does not match this evaluation clock");
        }
      } catch (error) {
        this.footprints.rollback(footprintState);
        throw error;
      }
      if (inputsChanged) await this.closeRequestContexts();
      this.throwIfAborted();
      this.installDataset(suppliedBars, first);
      this.inputs = inputs;
      if (stored?.runtime === undefined || this.program.requestPlans.some((plan) => plan.dynamic)) {
        if (this.program.requestPlans.some((plan) => plan.dynamic)) await this.closeRequestContexts();
        const result = await this.executeFull({}, { reset: true, fromIndex: 0 });
        if (stored !== undefined) this.logJournal.restore(stored.journal);
        return result;
      }
      const started = performance.now();
      try {
        this.runtime.restore(stored.runtime, this.bars, this.inputs);
        this.tailSnapshot = stored.tail === undefined ? undefined : {
          nextIndex: stored.tail.nextIndex,
          runtime: { kind: "full", snapshot: stored.tail.runtime },
        };
        this.requiresFullReplay = false;
        this.committedDynamicRequestSeries = undefined;
        this.committedRequestSeries = undefined;
        const result = this.runtime.result(this.program.variableNames, performance.now() - started, 0, this.resultVariables);
        this.lastResult = result;
        this.currentEvaluationNow = Number.NaN;
        this.logJournal.restore(stored.journal);
        this.failed = false;
        return result;
      } catch (error) {
        this.failed = true;
        this.lastResult = undefined;
        this.tailSnapshot = undefined;
        throw error;
      }
    });
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (!this.abortController.signal.aborted) this.abortController.abort(new DOMException("Engine session closed", "AbortError"));
    await this.closeRequestContexts();
    this.installDataset([], 0);
    this.footprints.close();
    this.lastResult = undefined;
    this.committedDynamicRequestSeries = undefined;
    this.committedRequestSeries = undefined;
    this.tailSnapshot = undefined;
  }


  private async appendPage(bars: readonly MarketBar[], options: ExecutionProgressOptions): Promise<ExecutionDelta> {
    this.assertOpen();
    const fromIndex = this.requiresFullReplay ? 0 : this.bars.length;
    const supplied = appendBarDataset(this.suppliedBars, bars, this.options.limits?.maxBars ?? 20_000);
    const first = this.suppliedBars.length === 0 ? this.rootHistoryStart(supplied) : this.firstEvaluatedBar;
    this.installDataset(supplied, first);
    this.footprints.invalidateFrom(fromIndex);
    const previous = this.lastResult;
    const execution = await this.executeIncremental(fromIndex, bars.length > 0, options,
      { reset: this.lastResult === undefined, fromIndex });
    const changedFromIndex = Math.min(fromIndex, execution.requestChangeIndex ?? fromIndex);
    return { ...execution.result, fromIndex: changedFromIndex, sceneDelta: sceneDelta(previous, execution.result) };
  }

  private installDataset(supplied: readonly MarketBar[], first: number): void {
    this.suppliedBars = supplied;
    this.firstEvaluatedBar = first;
    this.bars = first === 0 ? supplied : Object.freeze(supplied.slice(first));
    this.runtime.setSourceBarOffset(first);
  }

  private rootHistoryStart(bars: readonly MarketBar[], inputs = this.inputs): number {
    if (!isStrictProgram(this.program) || bars.length === 0) return 0;
    const chartTicker = this.options.symbolInfo?.ticker ?? "";
    const chartSymbol = this.options.symbolInfo?.tickerid ?? chartTicker;
    const chartTimeframe = this.options.timeframe ?? "";
    const normalizedTimeframe = normalizeEngineTimeframe(chartTimeframe);
    // Written order determines whether the root context starts unbounded.
    // Positive counts can widen a bounded start, and later omissions leave it intact.
    let count: number | undefined;
    for (const plan of this.program.requestPlans) {
      if (plan.dynamic) continue;
      const symbol = requestSelectorValue(plan.symbol, plan.symbolInputId, plan.symbolInputTitle, inputs) || chartSymbol;
      const timeframe = requestSelectorValue(plan.timeframe, plan.timeframeInputId, plan.timeframeInputTitle, inputs) || chartTimeframe;
      if (!isRootRequestContext(symbol, normalizeEngineTimeframe(timeframe), chartSymbol, chartTicker, normalizedTimeframe)) continue;
      let requested: number | undefined;
      try {
        requested = requestStartupCount(plan, this.options, inputs);
      } catch {
        // Request preparation owns diagnostics for invalid startup expressions.
        return 0;
      }
      if (count === undefined && requested === undefined) return 0;
      if (requested !== undefined) count = Math.max(count ?? 0, requested);
    }
    if (count === undefined) return 0;
    const now = this.options.now?.() ?? Date.now();
    const firstFuture = bars.findIndex(({ openTime }) => openTime > now);
    return Math.max(0, (firstFuture === -1 ? bars.length : firstFuture) - count);
  }

  private async executeIncremental(
    changeIndex: number,
    datasetTailChanged: boolean,
    options: ExecutionProgressOptions,
    policy: EvaluationPolicy,
  ): Promise<EvaluationOutcome> {
    const snapshot = this.tailSnapshot;
    if (
      !this.requiresFullReplay
      && !(this.program.runtimeRequirements.usesDatasetTail && datasetTailChanged)
      && !this.program.runtimeRequirements.usesExecutionClock
      && this.lastResult !== undefined
      && snapshot !== undefined
      && snapshot.nextIndex <= changeIndex
      && !(policy.reset && this.logJournal.logsCount > 0)
    ) {
      return this.executeFrom(snapshot.nextIndex, snapshot.runtime, options, policy);
    }
    const reset = policy.reset || this.requiresFullReplay;
    return this.executeFrom(0, undefined, options, { ...policy, reset, fromIndex: reset ? 0 : policy.fromIndex });
  }

  private async executeFull(options: ExecutionProgressOptions = {}, policy: EvaluationPolicy = { reset: true, fromIndex: 0 }): Promise<ExecutionResult> {
    return (await this.executeFrom(0, undefined, options, policy)).result;
  }

  private async executeFrom(startIndex: number, snapshot?: RuntimeTailSnapshot, options: ExecutionProgressOptions = {}, policy: EvaluationPolicy = { reset: true, fromIndex: 0 }): Promise<EvaluationOutcome> {
    try {
      const result = await this.evaluateFrom(startIndex, snapshot, options, policy);
      this.failed = false;
      return result;
    } catch (error) {
      this.failed = true;
      this.lastResult = undefined;
      this.committedDynamicRequestSeries = undefined;
      this.committedRequestSeries = undefined;
      this.tailSnapshot = undefined;
      this.requiresFullReplay = true;
      await this.closeRequestContexts();
      throw error;
    }
  }

  private async evaluateFrom(startIndex: number, snapshot?: RuntimeTailSnapshot, options: ExecutionProgressOptions = {}, policy: EvaluationPolicy = { reset: true, fromIndex: 0 }): Promise<EvaluationOutcome> {
    const started = performance.now();
    const strictCompatibility = isStrictProgram(this.program);
    this.currentEvaluationNow = strictCompatibility ? this.options.now?.() ?? Date.now() : Number.NaN;
    const childLogs = new PineLogAttempt();
    this.activeChildLogs = childLogs;
    try {
      // Scripts without footprints must not gain an await before request dispatch.
      const footprintHandlesChanged = this.footprints.enabled && await this.footprints.prepare(this.bars, this.inputs);
      if (footprintHandlesChanged && snapshot !== undefined) {
        startIndex = 0;
        snapshot = undefined;
        policy = { ...policy, reset: true, fromIndex: 0 };
      }
      const lowerHistoryWindows = strictCompatibility ? new Map<string, number | undefined>() : undefined;
      const requestSeries = await this.prepareRequests(
        strictCompatibility ? this.currentEvaluationNow : undefined, options.logCause, lowerHistoryWindows,
      );
      const staticRequestChangeIndex = strictCompatibility
        ? earliestRequestSeriesChange(this.committedRequestSeries, requestSeries)
        : undefined;
      const admittedDynamicPlans = strictCompatibility
        ? [...this.dynamicAdmissions.values()]
        : [];
      const refreshedDynamicRequestSeries: Readonly<Record<string, readonly PineValue[]>> = admittedDynamicPlans.length === 0
        ? Object.freeze({})
        : await this.prepareRequests(this.currentEvaluationNow, options.logCause, lowerHistoryWindows, admittedDynamicPlans);
      const dynamicRequestChangeIndex = strictCompatibility
        ? earliestRequestSeriesChange(this.committedDynamicRequestSeries, refreshedDynamicRequestSeries)
        : undefined;
      const requestChangeIndex = earliestDefinedIndex(staticRequestChangeIndex, dynamicRequestChangeIndex);
      let widenedRequestChangeIndex = requestChangeIndex !== undefined && requestChangeIndex < startIndex
        ? requestChangeIndex
        : undefined;
      if (widenedRequestChangeIndex !== undefined) {
        startIndex = 0;
        snapshot = undefined;
        policy = { ...policy, reset: true, fromIndex: 0 };
      }
      const dynamic = this.program.requestPlans.some((plan) => plan.dynamic);
      const discovery = new DynamicRequestDiscovery(this.program.requestPlans, this.dynamicAdmissions,
        this.options.symbolInfo?.tickerid ?? this.options.symbolInfo?.ticker ?? "", this.options.timeframe ?? "");
      for (const plan of admittedDynamicPlans) {
        discovery.admit(plan, refreshedDynamicRequestSeries[plan.id] ?? []);
      }
      // Tail restore intentionally preserves varip across real evaluations. A
      // speculative discovery retry must instead start from the same committed
      // runtime, or each missing dataset would advance intrabar state again.
      const retryBaseline = dynamic && snapshot !== undefined ? this.runtime.snapshot() : undefined;
      this.runtime.setRequestResolver(dynamic ? discovery.resolve : undefined);
      try {
        // The first attempt still has the captured state; only a retry has mutated it.
        let retry = false;
        for (;;) {
          try {
            if (retry && retryBaseline !== undefined) this.runtime.restore(retryBaseline, this.bars, this.inputs);
            retry = true;
            const rootLogs = new PineLogAttempt();
            const result = this.evaluateRequestAttempt(startIndex, snapshot, requestSeries, started, dynamic ? {} : options, rootLogs, policy);
            this.throwIfAborted();
            if (dynamic && this.bars.length > 0) options.onProgress?.({ currentBarTime: this.bars.at(-1)!.openTime, processedBars: this.bars.length, totalBars: this.bars.length });
            this.throwIfAborted();
            if (policy.reset) this.logJournal.reset();
            const committedLogs = this.logJournal.commit([childLogs, rootLogs]);
            this.options.onCommittedLogs?.(committedLogs);
            this.dynamicAdmissions = discovery.admitted;
            this.committedDynamicRequestSeries = strictCompatibility
              ? Object.freeze({
                ...(this.committedDynamicRequestSeries ?? {}),
                ...discovery.resolvedSeries(),
              })
              : undefined;
            this.committedRequestSeries = strictCompatibility ? requestSeries : undefined;
            this.lastResult = result;
            return {
              ...(widenedRequestChangeIndex === undefined ? {} : { requestChangeIndex: widenedRequestChangeIndex }),
              result,
            };
          } catch (error) {
            if (!(error instanceof RequestDatasetDemand)) throw error;
            const previouslyAdmitted = discovery.admitted.has(error.plan.id);
            const loaded = await this.prepareRequests(this.currentEvaluationNow, options.logCause, lowerHistoryWindows, [error.plan]);
            this.throwIfAborted();
            const values = loaded[error.plan.id] ?? [];
            if (strictCompatibility && previouslyAdmitted) {
              const dynamicChangeIndex = earliestSeriesValueChange(
                this.committedDynamicRequestSeries?.[error.plan.id],
                values,
              );
              if (dynamicChangeIndex !== undefined && dynamicChangeIndex < startIndex) {
                widenedRequestChangeIndex = widenedRequestChangeIndex === undefined
                  ? dynamicChangeIndex
                  : Math.min(widenedRequestChangeIndex, dynamicChangeIndex);
                startIndex = 0;
                snapshot = undefined;
                policy = { ...policy, reset: true, fromIndex: 0 };
              }
            }
            discovery.admit(error.plan, values);
          }
        }
      } finally { this.runtime.setRequestResolver(undefined); }
    } finally { this.activeChildLogs = undefined; }
  }

  private evaluateRequestAttempt(startIndex: number, snapshot: RuntimeTailSnapshot | undefined, requestSeries: Readonly<Record<string, readonly PineValue[]>>, started: number, options: ExecutionProgressOptions, logs: PineLogAttempt, policy: EvaluationPolicy): ExecutionResult {
    this.throwIfAborted();
    if (snapshot === undefined) this.runtime.reset(this.bars, this.inputs);
    else this.runtime.restoreTail(snapshot, this.bars, this.inputs);
    if (isStrictProgram(this.program)) this.runtime.beginEvaluation(this.currentEvaluationNow, policy.realtimeUpdateOpenTime);
    this.runtime.setRequestSeries(requestSeries);
    this.runtime.setLogSink((draft) => { if (draft.barIndex >= policy.fromIndex) logs.add(draft); });
    let nextTail: ReplaySnapshot | undefined;
    let processedBars = 0;
    try {
      for (let index = startIndex; index < this.bars.length; index += 1) {
        this.throwIfAborted();
        if (options.retainTailSnapshot !== false && index === this.bars.length - 1) nextTail = { nextIndex: index, runtime: this.runtime.tailSnapshot() };
        const fxRollback = this.runtime.needsFxBarTransaction(index) ? this.runtime.snapshot() : undefined;
        try {
          this.runtime.beginBar(index);
          this.executor(this.runtime);
          this.runtime.endBar();
        } catch (error) {
          if (fxRollback !== undefined) this.runtime.restore(fxRollback, this.bars, this.inputs);
          throw error;
        }
        processedBars += 1;
        if (processedBars === 1 || processedBars % 128 === 0 || index === this.bars.length - 1) {
          options.onProgress?.({
            currentBarTime: this.bars[index]?.openTime ?? null,
            processedBars: index + 1,
            totalBars: this.bars.length,
          });
        }
      }
      this.throwIfAborted();
      const result = this.runtime.result(this.program.variableNames, performance.now() - started, processedBars, this.resultVariables);
      this.tailSnapshot = nextTail;
      this.requiresFullReplay = false;
      return result;
    } finally { this.runtime.setLogSink(undefined); }
  }

  private async prepareRequests(
    evaluationNow: number | undefined,
    logCause: ExecutionProgressOptions["logCause"],
    lowerHistoryWindows: Map<string, number | undefined> | undefined,
    dynamicPlans?: readonly CompiledRequestPlan[],
  ): Promise<Readonly<Record<string, readonly PineValue[]>>> {
    const plans = dynamicPlans ?? this.program.requestPlans.filter((plan) => !plan.dynamic);
    if (plans.length === 0) return {};
    const result: Record<string, readonly PineValue[]> = {};
    const chartTicker = typeof this.options.symbolInfo?.ticker === "string" ? this.options.symbolInfo.ticker : "";
    const chartTickerId = typeof this.options.symbolInfo?.tickerid === "string" ? this.options.symbolInfo.tickerid : chartTicker;
    const chartTickerIdentity = decodeLumenChartsTickerIdentity(chartTickerId);
    const chartTimeframe = this.options.timeframe ?? "";
    const strictCompatibility = isStrictProgram(this.program);
    const parentTimezone = this.effectiveSessionSchedule.timezone ?? sessionTimezone(this.options.timezone, this.options.symbolInfo);
    const datasetLoads = new Map<string, Promise<MarketDataset>>();
    const symbolInfoLoads = new Map<string, Promise<SymbolInfo>>();
    const chartRank = requestTimeframeRank(chartTimeframe, strictCompatibility);
    const normalizedChartTimeframe = normalizeEngineTimeframe(chartTimeframe);
    const selections = plans.map((plan) => {
      try {
        const count = requestStartupCount(plan, this.options, this.inputs);
        const symbol = requestSelectorValue(plan.symbol, plan.symbolInputId, plan.symbolInputTitle, this.inputs) || chartTickerId;
        const tickerIdentity = decodeLumenChartsTickerIdentity(symbol);
        const providerSymbol = tickerIdentity?.symbol ?? lumenChartsTickerBaseSymbol(symbol);
        const timeframe = requestSelectorValue(plan.timeframe, plan.timeframeInputId, plan.timeframeInputTitle, this.inputs) || chartTimeframe;
        const normalizedTimeframe = normalizeEngineTimeframe(timeframe);
        const unprefixed = providerSymbol.includes(":") ? providerSymbol.slice(providerSymbol.indexOf(":") + 1) : providerSymbol;
        const sameProviderSymbol = providerSymbol === chartTickerId || unprefixed === chartTicker;
        const sameSymbol = symbol === chartTickerId || (chartTickerIdentity === undefined && sameProviderSymbol);
        const requestRank = requestTimeframeRank(timeframe, strictCompatibility);
        const invalidTimeframe = requestRank < 0 || chartRank < 0 || (plan.kind === "security_lower_tf" && requestRank > chartRank);
        const contextKey = JSON.stringify([sameSymbol ? chartTickerId : symbol, normalizedTimeframe]);
        return { plan, selection: { count, symbol, tickerIdentity, providerSymbol, timeframe, normalizedTimeframe, sameSymbol, requestRank, invalidTimeframe, contextKey } };
      } catch (error) {
        return { plan, error };
      }
    });
    if (lowerHistoryWindows !== undefined) {
      // Static requests establish the widest window before dynamic discovery.
      // Otherwise, the first historical dynamic request fixes the window for
      // its context. Refreshes visit admitted requests in discovery order.
      for (const { selection } of selections) {
        if (selection === undefined || selection.invalidTimeframe || selection.requestRank >= chartRank) continue;
        const { contextKey, count } = selection;
        if (!lowerHistoryWindows.has(contextKey)) {
          lowerHistoryWindows.set(contextKey, count);
        } else if (dynamicPlans === undefined) {
          const previous = lowerHistoryWindows.get(contextKey);
          lowerHistoryWindows.set(contextKey, previous === undefined || count === undefined ? undefined : Math.max(previous, count));
        }
      }
    }
    for (const entry of selections) {
      const { plan } = entry;
      this.throwIfAborted();
      try {
        if (entry.selection === undefined) throw entry.error;
        const { count, symbol, tickerIdentity, providerSymbol, timeframe, normalizedTimeframe, sameSymbol, requestRank, invalidTimeframe, contextKey } = entry.selection;
        const calcBarsCount = lowerHistoryWindows?.has(contextKey) ? lowerHistoryWindows.get(contextKey) : count;
        const sameTimeframe = normalizedTimeframe === normalizedChartTimeframe;
        const reusesCurrentDataset = sameSymbol && sameTimeframe;
        const identityAlreadyApplied = tickerIdentity !== undefined && symbol === chartTickerId && reusesCurrentDataset;
        if (invalidTimeframe) {
          if (plan.kind === "security_lower_tf" && plan.ignoreInvalidTimeframe) {
            result[plan.id] = Object.freeze(this.bars.map(() => Number.NaN));
            continue;
          }
          throw new Error(plan.kind === "security_lower_tf" && requestRank > chartRank
            ? `Timeframe ${timeframe} is not lower than or equal to chart timeframe ${chartTimeframe}`
            : "Invalid timeframe");
        }
        let childBars: readonly MarketBar[];
        let childSymbolInfo = sameSymbol ? this.options.symbolInfo : undefined;
        let childSessionSchedule = sameSymbol ? this.effectiveSessionSchedule : undefined;
        if (reusesCurrentDataset) childBars = this.bars;
        else {
          const gateway = this.options.marketDataGateway;
          if (gateway === undefined) throw new Error(`request.security requires a marketDataGateway for ${symbol}@${timeframe}`);
          const providerCalcBarsCount = providerTickerCalcBarsCount(
            calcBarsCount,
            tickerIdentity,
            this.options.limits?.maxBars ?? 20_000,
          );
          const datasetKey = `${providerSymbol}\u0000${normalizedTimeframe}\u0000${String(providerCalcBarsCount ?? "")}`;
          let datasetLoad = datasetLoads.get(datasetKey);
          if (datasetLoad === undefined) {
            datasetLoad = gateway.load({ symbol: providerSymbol, timeframe, ...(providerCalcBarsCount === undefined ? {} : { calcBarsCount: providerCalcBarsCount }) }, this.signal)
              .then((dataset) => ({ ...dataset, bars: this.admitBars(dataset.bars) }));
            datasetLoads.set(datasetKey, datasetLoad);
          }
          const dataset = await datasetLoad;
          this.throwIfAborted();
          childBars = dataset.bars;
          if (dataset.sessionSchedule !== undefined) childSessionSchedule = dataset.sessionSchedule;
          if (dataset.symbolInfo !== undefined) childSymbolInfo = dataset.symbolInfo;
          else if (gateway.getSymbolInfo !== undefined) {
            let symbolInfoLoad = symbolInfoLoads.get(providerSymbol);
            if (symbolInfoLoad === undefined) {
              symbolInfoLoad = gateway.getSymbolInfo(providerSymbol, this.signal);
              symbolInfoLoads.set(providerSymbol, symbolInfoLoad);
            }
            childSymbolInfo = await symbolInfoLoad;
            this.throwIfAborted();
          }
        }
        childSymbolInfo = normalizeChildSymbolInfo(childSymbolInfo);
        let effectiveChildSessionSchedule = resolveSessionSchedule({
          ...(childSessionSchedule === undefined ? {} : { sessionSchedule: childSessionSchedule }),
          ...(childSymbolInfo === undefined ? {} : { symbolInfo: childSymbolInfo }),
        });
        if (tickerIdentity !== undefined && !identityAlreadyApplied) {
          const applied = applyLumenChartsTickerIdentity(childBars, tickerIdentity, effectiveChildSessionSchedule);
          childBars = applied.bars;
          effectiveChildSessionSchedule = applied.sessionSchedule;
          childSymbolInfo = syntheticTickerSymbolInfo(childSymbolInfo, symbol, tickerIdentity);
        }
        if (strictCompatibility && evaluationNow !== undefined) {
          const firstFuture = childBars.findIndex((bar) => bar.openTime > evaluationNow);
          if (firstFuture >= 0) childBars = Object.freeze(childBars.slice(0, firstFuture));
        }
        const sharesRoot = strictCompatibility && reusesCurrentDataset
          && isRootRequestContext(symbol, normalizedTimeframe, chartTickerId, chartTicker, normalizedChartTimeframe)
          && this.program.requestPlans.some((original) => original.id === plan.id && !original.dynamic);
        if (strictCompatibility && !sharesRoot && calcBarsCount !== undefined && childBars.length > calcBarsCount) {
          childBars = Object.freeze(childBars.slice(-calcBarsCount));
        }
        const childResult = await this.executeRequestContext(
          plan.id,
          JSON.stringify([symbol, normalizeEngineTimeframe(timeframe)]),
          requestContextIdentity(symbol, timeframe, childSymbolInfo, effectiveChildSessionSchedule),
          plan.program,
          childBars,
          timeframe,
          childSymbolInfo,
          effectiveChildSessionSchedule,
          logCause,
        );
        const values = childResult.returned.__request ?? [];
        if (childResult.times.length < childBars.length) childBars = childBars.slice(childBars.length - childResult.times.length);
        const identicalDataset = tickerIdentity === undefined && sameSymbol && sameTimeframe && childBars.length === this.bars.length;
        const childTimezone = effectiveChildSessionSchedule.timezone ?? sessionTimezone(undefined, childSymbolInfo, parentTimezone);
        if (strictCompatibility && tickerIdentity === undefined && reusesCurrentDataset) {
          result[plan.id] = alignSameContextRequestValues(
            this.bars, childBars, values, plan.kind === "security_lower_tf" ? plan.tupleArity : undefined, evaluationNow ?? 0,
          );
          continue;
        }
        if (plan.kind === "security_lower_tf") {
          result[plan.id] = identicalDataset
            ? wrapLowerRequestValues(values, plan.tupleArity)
            : alignLowerRequestArrays(this.bars, chartTimeframe, childBars, values, timeframe, plan.tupleArity, parentTimezone, childTimezone, strictCompatibility, evaluationNow);
        } else {
          result[plan.id] = identicalDataset ? Object.freeze([...values]) : alignRequestValues(
            this.bars,
            chartTimeframe,
            childBars,
            values,
            timeframe,
            plan.lookahead,
            plan.gaps,
            strictCompatibility,
            evaluationNow ?? 0,
            parentTimezone,
            childTimezone,
          );
        }
      } catch (error) {
        this.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof PineRuntimeError && error.range === (plan.startupProgram?.range ?? plan.startupCount?.range)) throw error;
        if (plan.sourceRange !== undefined) throw PineRuntimeError.at(error, plan.sourceRange, `request.${plan.kind}`, true);
        throw error;
      }
    }
    return result;
  }

  private async executeRequestContext(
    id: string,
    selection: string,
    key: string,
    program: CompiledProgram,
    bars: readonly MarketBar[],
    timeframe: string,
    symbolInfo: SymbolInfo | undefined,
    sessionSchedule: PineSessionSchedule | undefined,
    logCause: ExecutionProgressOptions["logCause"],
  ): Promise<ExecutionResult> {
    return this.requests.execute(id, key, bars, program.runtimeRequirements.usesExecutionClock, () => new EngineSession(program, {
        inputs: this.inputs,
        ...(this.resultVariables === undefined ? {} : { resultVariables: ["__request"] }),
        timeframe,
        mainTimeframe: this.options.mainTimeframe ?? this.options.timeframe ?? timeframe,
        ...(symbolInfo === undefined ? {} : { symbolInfo }),
        ...(this.options.fxRateBook === undefined ? {} : { fxRateBook: this.options.fxRateBook }),
        ...(sessionSchedule === undefined ? {} : { sessionSchedule }),
        ...(sessionSchedule?.timezone === undefined ? {} : { timezone: sessionSchedule.timezone }),
        signal: this.signal,
        ...(this.options.limits === undefined ? {} : { limits: this.options.limits }),
        ...(this.options.marketDataGateway === undefined ? {} : { marketDataGateway: this.options.marketDataGateway }),
        ...(this.options.randomSeed === undefined ? {} : { randomSeed: this.options.randomSeed }),
        ...(this.options.alertMode === undefined ? {} : { alertMode: this.options.alertMode }),
        ...(this.options.chartColors === undefined ? {} : { chartColors: this.options.chartColors }),
        ...(isStrictProgram(this.program)
          ? { now: () => this.currentEvaluationNow }
          : this.options.now === undefined ? {} : { now: this.options.now }),
        ...(this.options.visibleRange === undefined ? {} : { visibleRange: this.options.visibleRange }),
        ...(this.options.codeGeneration === undefined ? {} : { codeGeneration: this.options.codeGeneration }),
        ...(this.options.executorFactory === undefined ? {} : { executorFactory: this.options.executorFactory }),
        onCommittedLogs: (events) => {
          for (const event of events) this.activeChildLogs?.addChild(event, event.context.kind === "request"
            ? `${id}/${event.context.requestId ?? ""}` : id);
        },
      }, this.requestBudget, this.fxAccountCurrency), selection, logCause);
  }

  private async closeRequestContexts(): Promise<void> {
    this.dynamicAdmissions.clear();
    this.committedDynamicRequestSeries = undefined;
    this.committedRequestSeries = undefined;
    await this.requests.close();
  }

  private async withOperation<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const finish = this.operations.begin(name);
    try { return await action(); }
    finally { finish(); }
  }

  private assertReady(): void {
    this.assertOpen();
    if (this.failed) throw new Error("Engine session requires runBatch() or restore() after a failed evaluation");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Engine session is closed");
    this.throwIfAborted();
  }

  private throwIfAborted(): void {
    if (this.signal.aborted) throw this.signal.reason ?? new DOMException("Execution aborted", "AbortError");
  }

  private admitBars(bars: readonly MarketBar[]): readonly MarketBar[] {
    return admitBars(bars, this.options.limits?.maxBars ?? 20_000);
  }

}

function isRootRequestContext(symbol: string, timeframe: string, chartSymbol: string, chartTicker: string, chartTimeframe: string): boolean {
  return timeframe === chartTimeframe && (symbol === chartSymbol
    || (chartTicker !== "" && symbol === chartTicker && decodeLumenChartsTickerIdentity(chartSymbol) === undefined));
}

function isStrictProgram(program: CompiledProgram): boolean {
  return isStrictPineCompatibility(program.compatibility);
}

function providerTickerCalcBarsCount(
  requested: number | undefined,
  identity: LumenChartsTickerIdentityV1 | undefined,
  maximum: number,
): number | undefined {
  if (requested === undefined || identity === undefined) return requested;
  // Session filters and event-derived chart types can consume an arbitrary
  // number of source bars before producing the requested output count. Load
  // an explicit full provider window bounded by maxBars, transform, and only
  // then apply calc_bars_count. Omitting the count is provider-dependent and
  // can silently fall back to the shorter primary-chart window.
  return maximum;
}

function syntheticTickerSymbolInfo(
  source: SymbolInfo | undefined,
  tickerId: string,
  identity: LumenChartsTickerIdentityV1,
): SymbolInfo {
  const parts = lumenChartsTickerParts(identity.symbol);
  return Object.freeze({
    ...(source ?? {}),
    ticker: parts.ticker,
    tickerid: tickerId,
    prefix: parts.prefix,
    session: identity.session ?? source?.session ?? "",
  });
}

function earliestRequestSeriesChange(
  previous: Readonly<Record<string, readonly PineValue[]>> | undefined,
  current: Readonly<Record<string, readonly PineValue[]>>,
): number | undefined {
  const currentIds = Object.keys(current);
  if (previous === undefined) return currentIds.length === 0 ? undefined : 0;
  const previousIds = Object.keys(previous);
  if (previousIds.length !== currentIds.length) return 0;

  let earliest: number | undefined;
  for (const id of currentIds) {
    const previousValues = previous[id];
    const currentValues = current[id]!;
    if (previousValues === undefined) return 0;
    const changeIndex = earliestSeriesValueChange(previousValues, currentValues);
    if (changeIndex !== undefined) earliest = earliest === undefined ? changeIndex : Math.min(earliest, changeIndex);
  }
  return earliest;
}

function earliestDefinedIndex(...indices: readonly (number | undefined)[]): number | undefined {
  let earliest: number | undefined;
  for (const index of indices) {
    if (index !== undefined) earliest = earliest === undefined ? index : Math.min(earliest, index);
  }
  return earliest;
}

function earliestSeriesValueChange(
  previous: readonly PineValue[] | undefined,
  current: readonly PineValue[],
): number | undefined {
  if (previous === undefined) return 0;
  const sharedLength = Math.min(previous.length, current.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (!structurallyEqual(previous[index], current[index])) return index;
  }
  return previous.length === current.length ? undefined : sharedLength;
}


export { compile };
export type { CompileRequest, CompileResult, CompiledProgram };
export type * from "../contracts/index.js";
