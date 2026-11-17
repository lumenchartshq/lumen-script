import { refreshPineArrayValue } from "./array-views.js";
import { calendarComponent, type CalendarComponentName } from "./calendar-components.js";
import type { CompiledProgram } from "../compiler/index.js";
import { PINE_DISPLAY_MASKS,
  PINE_MARKET_FIELDS,
  PINE_TIME_COMPONENT_FIELDS,
  PINE_ZERO_ARGUMENT_CALLS,
  PINE_V5_STRATEGY_CALL_SIGNATURES,
  decodeLumenChartsTickerIdentity,
  encodeLumenChartsTickerIdentity,
  normalizeLumenChartsTickerNumber,
  normalizeLumenChartsTickerSource,
  normalizeLumenChartsTickerStyle,
  lumenChartsTickerBaseSymbol,
  lumenChartsTickerParts,
  type LumenChartsTickerIdentityV1,
  type LumenChartsTickerTransform,
  isStrictPineCompatibility,
} from "../contracts/index.js";
import { pineMapIteration, arrayCall, isPineMap, isPineMatrix, mapCall, matrixCall } from "./collections.js";
import { DrawingRuntime, drawingCast, isChartPoint, isPineBox, isPineLabel, isPineLine, isPineLinefill, isPinePolyline, isPineTable, type MutablePineTable } from "./drawings.js";
import {
  assignHistoryWindow,
  captureMutableState,
  captureHistoryWindow,
  captureHistoryWindowMap,
  cloneRuntimeGraph,
  createHistoryWindow,
  migrateExecutionHistory,
  mutablePineValue,
  readHistoryWindow,
  replaceArray,
  replaceArrays,
  replaceMap,
  replaceSet,
  writeHistoryWindow,
  writeHistoryWindowExecution,
  type RuntimeHistoryWindow,
  type RuntimeLocalState,
  type RuntimePlotBuffer,
  type RuntimeSnapshot,
  type RuntimeTailSnapshot,
} from "./runtime-snapshot.js";
import { colorComponent, colorGradient, colorNew, colorRgb, formatBoundedLogMessage, mathCall, stringCall } from "./scalar-builtins.js";
import { StrategyRuntime, validatePublicExitSnapshot, validateStrategyFxSnapshot, type MutableStrategyState } from "./strategy.js";
import { invalidFootprintHandle, isPineFootprintHandle, isPineVolumeRowHandle, type FootprintRuntimeStore } from "./footprint.js";
import { admitStrategyFxContext, selectStrategyFxBar, type StrategyFxContext } from "./strategy-fx-context.js";
import { admitSyntheticHistoricalFillFeed, type HistoricalFillEventV1, type SyntheticHistoricalFillFeedV1 } from "./strategy-fill-event-schedule.js";
import { TechnicalAnalysisRuntime, type StateId } from "./technical-analysis.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { validateStrictStrategyRiskSnapshot } from "./snapshot-domain-validation.js";
import { alignToTimeframe, calendarSessionBarAt, compileSessionCorrections, correctedSessionTradingDayKey, dateParts, isValidTimezone, isInSession, isInSessionSpec, normalizeTimeframe, offsetSessionBar, offsetTimeframe, parseSessionSpec, pineTimestamp, sessionBarAt, timeframeEnd, timeframeFromSeconds, timeframeProperty, timeframeSeconds, type CompiledSessionCorrections, type SessionSpec } from "./time.js";
import { compare, integer, isNa, normalize, number, pineString, taValue } from "./values.js";
import type {
  ExecutionResult,
  AlertEvent,
  Drawing,
  MarketBar,
  PineLogDraft,
  PineValue,
  PineSessionSchedule,
  PlotResult,
  SessionOptions,
  SymbolInfo,
  TableSnapshot,
} from "../contracts/index.js";

export type BarExecutor = (runtime: RuntimeContext) => void;
export { admitSyntheticHistoricalFillFeed } from "./strategy-fill-event-schedule.js";
export { admitStrategyFxContext } from "./strategy-fx-context.js";
export { FootprintRuntimeStore, admitFootprintArguments, isPineFootprintHandle, isPineVolumeRowHandle } from "./footprint.js";
export type { FootprintArguments, FootprintCalculation, FootprintWorkCounter, PineFootprintHandle, PineVolumeRowHandle } from "./footprint.js";
export type { HistoricalOrderCandidateV1, SyntheticHistoricalFillFeedV1 } from "./strategy-fill-event-schedule.js";
export { prepareSyntheticHistoricalFillRecalculation } from "./strategy-fill-event-rollback.js";
export { syntheticHistoricalFillCursorComplete, transitionSyntheticHistoricalFillPoint } from "./strategy-fill-event-transition.js";
export type { SyntheticHistoricalFillCursorV1 } from "./strategy-fill-event-transition.js";
export type { MutableStrategyState, StrategyRuntimeHost } from "./strategy.js";
const timeComponentNames = new Set<string>(PINE_TIME_COMPONENT_FIELDS);
const zeroArgumentCallNames = new Set<string>(PINE_ZERO_ARGUMENT_CALLS);
const BUILTIN_SAMPLE_PREFIX = "builtin:";
const builtinSampleId = (name: string): string => `${BUILTIN_SAMPLE_PREFIX}${name}`;
const BAR_HISTORY_PREFIX = "bar:";
const barHistoryId = (id: StateId): string => `${BAR_HISTORY_PREFIX}${String(id)}`;
/** History windows indexed by chart bar rather than by execution. */
const isBarIndexedHistory = (id: StateId): boolean => typeof id === "string"
  && (id.startsWith(BUILTIN_SAMPLE_PREFIX) || id.startsWith(BAR_HISTORY_PREFIX));
const marketSourceNames = new Set<string>(PINE_MARKET_FIELDS.filter((name) => name !== "time" && name !== "time_close"));
const numericSymbolInfoNames = new Set([
  "employees", "mincontract", "minmove", "mintick", "pointvalue", "pricescale", "shareholders",
]);
const MAX_TA_HISTORY_ARGUMENT = 5_000;
const taLengthArgumentIndexes: Readonly<Record<string, readonly number[]>> = {
  "ta.change": [1],
  "ta.mom": [1],
  "ta.roc": [1],
  "ta.rising": [1],
  "ta.falling": [1],
  "ta.highest": [1],
  "ta.lowest": [1],
  "ta.highestbars": [1],
  "ta.lowestbars": [1],
  "ta.range": [1],
  "ta.sma": [1],
  "ta.ema": [1],
  "ta.rma": [1],
  "ta.wma": [1],
  "ta.hma": [1],
  "ta.alma": [1],
  "ta.vwma": [1],
  "ta.linreg": [1],
  "ta.variance": [1],
  "ta.stdev": [1],
  "ta.dev": [1],
  "ta.atr": [0],
  "ta.rsi": [1],
  "ta.cci": [1],
  "ta.cmo": [1],
  "ta.cog": [1],
  "ta.stoch": [3],
  "ta.wpr": [0],
  "ta.tsi": [1, 2],
  "ta.macd": [1, 2, 3],
  "ta.dmi": [0, 1],
  "ta.bb": [1],
  "ta.bbw": [1],
  "ta.kc": [1],
  "ta.kcw": [1],
  "ta.correlation": [2],
  "ta.median": [1],
  "ta.mode": [1],
  "ta.percentile_linear_interpolation": [1],
  "ta.percentile_nearest_rank": [1],
  "ta.percentrank": [1],
  "ta.mfi": [1],
};
const MAX_TA_OFFSET_ARGUMENT = 5_000;

/** `color.green` and `color.red`. */
const PLOTARROW_DEFAULT_UP_COLOR = "#00FF00";
const PLOTARROW_DEFAULT_DOWN_COLOR = "#FF0000";

export interface SeriesReference {
  get(offset?: number): PineValue;
}

interface MutableSeriesReference extends SeriesReference {
  set(value: PineValue): PineValue;
}

interface StrictRandomState {
  seed: number;
  value: number;
}

interface FixnanState {
  hasValue: boolean;
  value: PineValue;
}

interface DecimalParts {
  coefficient: bigint;
  exponent: number;
}

function decimalParts(value: number): DecimalParts | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value.toString());
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[1] ?? ""}${match[2]}${fraction}`);
  return {
    coefficient,
    exponent: Number(match[4] ?? 0) - fraction.length,
  };
}

function decimalRatioAtOrAboveHalf(value: number, tick: number, lower: number, fallback: boolean): boolean {
  if (!Number.isSafeInteger(lower)) return fallback;
  const valueParts = decimalParts(value);
  const tickParts = decimalParts(tick);
  if (valueParts === undefined || tickParts === undefined) return fallback;

  let numerator = valueParts.coefficient;
  let denominator = tickParts.coefficient;
  const exponentDifference = valueParts.exponent - tickParts.exponent;
  if (exponentDifference >= 0) numerator *= 10n ** BigInt(exponentDifference);
  else denominator *= 10n ** BigInt(-exponentDifference);

  const remainder = numerator - BigInt(lower) * denominator;
  if (remainder < 0n || remainder > denominator) return fallback;
  return remainder * 2n >= denominator;
}

type SessionScheduleField = "activeSession" | "regularSession" | "extendedSession" | "premarketSession" | "postmarketSession";
type RuntimeSessionMatcher =
  | { readonly ok: true; readonly spec: SessionSpec; readonly corrections: CompiledSessionCorrections }
  | { readonly ok: false; readonly reason: string; readonly source: "session" | "correction" };
type RuntimeSessionMatchers = Readonly<Partial<Record<SessionScheduleField, RuntimeSessionMatcher>>>;

export class RuntimeContext extends TechnicalAnalysisRuntime {
  public barIndex = -1;
  private sourceBarOffset = 0;
  private bars: readonly MarketBar[] = [];
  private readonly variables: PineValue[][];
  private readonly variableHistory: RuntimeHistoryWindow[];
  private readonly globalPersistence: Array<"var" | "varip" | undefined> = [];
  private readonly plots = new Map<string, RuntimePlotBuffer>();
  private readonly lastSourceCallBar = new Map<StateId, number>();
  private readonly mapIterables = new WeakSet();
  private readonly argumentSeries = new Map<string, RuntimeHistoryWindow>();
  private readonly localState = new Map<string, RuntimeLocalState>();
  private readonly historySeries = new Map<StateId, RuntimeHistoryWindow>();
  private readonly historyDepthBySource = new Map<string, number>();
  private readonly alerts: AlertEvent[] = [];
  private readonly firedAlerts = new Set<string>();
  private readonly drawings: DrawingRuntime;
  private requestResolver: ((id: string, symbol: PineValue, timeframe: PineValue, realtime: boolean, index: number) => PineValue) | undefined;
  private logSink: ((event: PineLogDraft) => void) | undefined;
  private requestSeries: Readonly<Record<string, readonly PineValue[]>> = {};
  private footprintStore: FootprintRuntimeStore | undefined;
  private readonly strategies: StrategyRuntime;
  private fxSelectionIdentity: string | undefined;
  private syntheticHistoricalFillEvent: { readonly barIndex: number; readonly event: HistoricalFillEventV1 } | undefined;
  private operations = 0;
  private randomState: number;
  private evaluationNow: number;
  private realtimeUpdateOpenTime: number | undefined;
  private readonly sessionMatchers: RuntimeSessionMatchers;

  public constructor(
    variableCount: number,
    private inputs: Readonly<Record<string, PineValue>>,
    private readonly sourceSeries: Readonly<Record<string, readonly PineValue[]>>,
    private readonly maxOperationsPerBar: number,
    private readonly maxTableCells: number,
    private readonly program: CompiledProgram,
    private readonly timeframe: string,
    private readonly mainTimeframe: string,
    private readonly timezone: string,
    private readonly symbolInfo: SymbolInfo,
    private readonly randomSeed: number,
    private readonly alertMode: "realtime" | "realtime-update" | "off" | "all",
    private readonly chartType: NonNullable<SessionOptions["chartType"]>,
    private readonly chartColors: NonNullable<SessionOptions["chartColors"]>,
    private readonly visibleRange: SessionOptions["visibleRange"],
    private readonly now: () => number,
    private readonly sessionSchedule: PineSessionSchedule,
    private readonly intrabarBars: SessionOptions["intrabarBars"],
    private readonly intrabarPoints: SessionOptions["intrabarPoints"],
    private readonly allowSyntheticHistoricalFillSchedule = false,
    private readonly fxContext?: StrategyFxContext,
    private readonly requestAccountCurrency?: string,
  ) {
    super();
    this.drawings = new DrawingRuntime(program, () => ({ time: this.data("time"), index: this.barIndex }), this.maxTableCells);
    this.strategies = new StrategyRuntime(program.descriptor.kind === "strategy", program.descriptor.strategy, {
      barIndex: () => this.barIndex,
      bars: () => this.bars,
      data: (name) => this.data(name),
      symbolInfo: () => this.symbolInfo,
      timezone: () => this.timezone,
      riskPeriodKey: (openTime, barIndex) => {
        if (timeframeSeconds(this.timeframe) > 86_400) return `bar:${barIndex}`;
        const matcher = this.sessionMatchers.activeSession
          ?? (this.sessionSchedule.activeSubsessionId === "extended"
            ? this.sessionMatchers.extendedSession : this.sessionMatchers.regularSession);
        if (matcher === undefined || !matcher.ok) return undefined;
        return correctedSessionTradingDayKey(openTime, matcher.spec, matcher.corrections,
          this.sessionSchedule.timezone ?? this.timezone);
      },
      executionBars: () => {
        const parent = this.bars[this.barIndex];
        if (parent === undefined) return [];
        return this.intrabarBars?.[String(parent.openTime)] ?? [];
      },
      executionPoints: () => {
        const parent = this.bars[this.barIndex];
        if (parent === undefined) return [];
        return this.intrabarPoints?.[String(parent.openTime)] ?? [];
      },
    }, this.isStrictProgram(), program.compatibility, program.version, requestAccountCurrency !== undefined);
    this.variables = Array.from({ length: variableCount }, () => []);
    this.variableHistory = Array.from({ length: variableCount }, createHistoryWindow);
    this.randomState = randomSeed >>> 0;
    this.evaluationNow = Number.NaN;
    this.sessionMatchers = compileRuntimeSessionMatchers(sessionSchedule);
  }

  public beginEvaluation(evaluationNow: number, realtimeUpdateOpenTime?: number): void {
    this.evaluationNow = evaluationNow;
    this.realtimeUpdateOpenTime = realtimeUpdateOpenTime;
  }

  public admittedFxContext(): StrategyFxContext { return this.fxContext!; }

  public setSourceBarOffset(offset: number): void {
    this.sourceBarOffset = offset;
  }

  public reset(bars: readonly MarketBar[], inputs = this.inputs): void {
    this.barIndex = -1;
    this.syntheticHistoricalFillEvent = undefined;
    this.bars = bars;
    this.inputs = inputs;
    this.evaluationNow = Number.NaN;
    this.realtimeUpdateOpenTime = undefined;
    this.fxSelectionIdentity = undefined;
    for (const series of this.variables) series.length = 0;
    for (const window of this.variableHistory) assignHistoryWindow(window, createHistoryWindow());
    this.globalPersistence.length = 0;
    this.plots.clear();
    this.callState.clear();
    this.lastSourceCallBar.clear();
    this.argumentSeries.clear();
    this.localState.clear();
    this.historySeries.clear();
    this.alerts.length = 0;
    this.firedAlerts.clear();
    this.drawings.reset();
    this.randomState = this.randomSeed >>> 0;
    this.strategies.reset(this.program.descriptor.kind === "strategy", this.program.descriptor.strategy, this.isStrictProgram());
  }

  public snapshot(): RuntimeSnapshot {
    return cloneRuntimeGraph({
      ...(this.fxContext?.identity === undefined ? {} : { fxContextIdentity: this.fxContext.identity }),
      ...(this.fxSelectionIdentity === undefined ? {} : { fxSelectionIdentity: this.fxSelectionIdentity }),
      ...(this.footprintStore === undefined ? {} : { footprintStoreKey: this.footprintStore.key }),
      barIndex: this.barIndex,
      variables: this.variables,
      variableHistory: this.variableHistory,
      globalPersistence: this.globalPersistence,
      plots: this.plots,
      callState: this.callState,
      lastSourceCallBar: this.lastSourceCallBar,
      argumentSeries: this.argumentSeries,
      localState: this.localState,
      historySeries: this.historySeries,
      historyDepthBySource: this.historyDepthBySource,
      alerts: this.alerts,
      firedAlerts: this.firedAlerts,
      lines: this.drawings.lines,
      nextVisualOrder: this.drawings.nextVisualOrder,
      nextLineId: this.drawings.nextLineId,
      boxes: this.drawings.boxes,
      nextBoxId: this.drawings.nextBoxId,
      labels: this.drawings.labels,
      nextLabelId: this.drawings.nextLabelId,
      polylines: this.drawings.polylines,
      nextPolylineId: this.drawings.nextPolylineId,
      linefills: this.drawings.linefills,
      nextLinefillId: this.drawings.nextLinefillId,
      tables: this.drawings.tables,
      nextTableId: this.drawings.nextTableId,
      requestSeries: this.requestSeries,
      strategy: this.strategies.strategy,
      operations: this.operations,
      randomState: this.randomState,
    } satisfies RuntimeSnapshot);
  }

  /** Captures the state before a realtime tail bar with a compact rollback when safe. */
  public tailSnapshot(): RuntimeTailSnapshot {
    if (this.strategies.strategy !== undefined || this.variables.some((series) => mutablePineValue(series.at(-1)))
      || [...this.localState.values()].some((state) => mutablePineValue(state.persistentValue))) {
      return { kind: "full", snapshot: this.snapshot() };
    }
    const variableLengths = this.variables.map((series) => series.length);
    const restoreVariableHistory = this.variableHistory.map((window) => captureHistoryWindow(window, this.barIndex + 1));
    const plotKeys = new Set(this.plots.keys());
    const plotState = [...this.plots.entries()].map(([key, plot]) => ({ key, plot, pointsLength: plot.points.length, options: plot.options }));
    const restoreCallState = captureMutableState(this.callState, false);
    const restoreLocalState = captureMutableState(this.localState, false);
    const restoreLastSource = captureMutableState(this.lastSourceCallBar, false);
    const restoreArguments = captureHistoryWindowMap(this.argumentSeries, this.barIndex + 1);
    const restoreHistory = captureHistoryWindowMap(this.historySeries, this.barIndex + 1);
    const restoreLocalHistory = [...this.localState.values()].map((local) => captureHistoryWindow(local.values, this.barIndex + 1));
    const historyDepthBySource = new Map(this.historyDepthBySource);
    const alertsLength = this.alerts.length;
    const firedAlerts = [...this.firedAlerts];
    const lines = structuredClone(this.drawings.lines);
    const boxes = structuredClone(this.drawings.boxes);
    const labels = structuredClone(this.drawings.labels);
    const polylines = structuredClone(this.drawings.polylines);
    const linefills = structuredClone(this.drawings.linefills);
    const tables = structuredClone(this.drawings.tables);
    const state = {
      barIndex: this.barIndex,
      nextVisualOrder: this.drawings.nextVisualOrder,
      nextLineId: this.drawings.nextLineId,
      nextBoxId: this.drawings.nextBoxId,
      nextLabelId: this.drawings.nextLabelId,
      nextPolylineId: this.drawings.nextPolylineId,
      nextLinefillId: this.drawings.nextLinefillId,
      nextTableId: this.drawings.nextTableId,
      requestSeries: this.requestSeries,
      operations: this.operations,
      randomState: this.randomState,
    };
    return {
      kind: "rollback",
      restore: () => {
        this.barIndex = state.barIndex;
        this.variables.forEach((series, index) => { series.length = variableLengths[index] ?? 0; });
        restoreVariableHistory.forEach((restore) => restore());
        for (const key of this.plots.keys()) if (!plotKeys.has(key)) this.plots.delete(key);
        for (const entry of plotState) {
          this.plots.set(entry.key, entry.plot);
          entry.plot.points.length = entry.pointsLength;
          entry.plot.options = entry.options;
        }
        restoreCallState();
        restoreLocalState();
        restoreLocalHistory.forEach((restore) => restore());
        restoreLastSource();
        restoreArguments();
        restoreHistory();
        replaceMap(this.historyDepthBySource, historyDepthBySource);
        this.alerts.length = alertsLength;
        this.firedAlerts.clear();
        for (const key of firedAlerts) this.firedAlerts.add(key);
        replaceArray(this.drawings.lines, structuredClone(lines));
        replaceArray(this.drawings.boxes, structuredClone(boxes));
        replaceArray(this.drawings.labels, structuredClone(labels));
        replaceArray(this.drawings.polylines, structuredClone(polylines));
        replaceArray(this.drawings.linefills, structuredClone(linefills));
        replaceArray(this.drawings.tables, structuredClone(tables));
        this.drawings.nextVisualOrder = state.nextVisualOrder;
        this.drawings.nextLineId = state.nextLineId;
        this.drawings.nextBoxId = state.nextBoxId;
        this.drawings.nextLabelId = state.nextLabelId;
        this.drawings.nextPolylineId = state.nextPolylineId;
        this.drawings.nextLinefillId = state.nextLinefillId;
        this.drawings.nextTableId = state.nextTableId;
        this.requestSeries = state.requestSeries;
        this.operations = state.operations;
        this.randomState = state.randomState;
      },
    };
  }

  public restoreTail(snapshot: RuntimeTailSnapshot, bars: readonly MarketBar[], inputs = this.inputs): void {
    const persistent = this.isStrictProgram() ? cloneRuntimeGraph({
      variables: new Map(this.globalPersistence.flatMap((persistence, id) => persistence === "varip"
        ? [[id, this.variables[id] ?? []] as const]
        : [])),
      variableHistory: new Map(this.globalPersistence.flatMap((persistence, id) => persistence === "varip"
        ? [[id, this.variableHistory[id]] as const]
        : [])),
      locals: new Map([...this.localState.entries()].filter(([, state]) => state.persistence === "varip")),
    }) : undefined;
    const intrabarPersistentVariables = persistent?.variables;
    const intrabarPersistentVariableHistory = persistent?.variableHistory;
    const intrabarPersistent = persistent?.locals;
    if (snapshot.kind === "full") this.restore(snapshot.snapshot, bars, inputs);
    else {
      this.syntheticHistoricalFillEvent = undefined;
      snapshot.restore();
      this.bars = bars;
      this.inputs = inputs;
    }
    if (intrabarPersistent !== undefined) {
      for (const [key, state] of intrabarPersistent) this.localState.set(key, state);
    }
    if (intrabarPersistentVariables !== undefined) {
      for (const [id, values] of intrabarPersistentVariables) {
        this.globalPersistence[id] = "varip";
        replaceArray(this.variables[id]!, values);
      }
    }
    if (intrabarPersistentVariableHistory !== undefined) {
      for (const [id, window] of intrabarPersistentVariableHistory) {
        assignHistoryWindow(this.variableHistory[id]!, window!);
      }
    }
  }

  public restore(snapshot: RuntimeSnapshot, bars: readonly MarketBar[], inputs = this.inputs): void {
    if (snapshot.fxContextIdentity !== this.fxContext?.identity) throw new Error("FX checkpoint context does not match this session");
    if (snapshot.footprintStoreKey !== this.footprintStore?.key) throw new Error("Footprint checkpoint store does not match this session");
    const fxClock = this.fxContext?.book !== undefined && this.fxContext.symbolCurrency !== this.fxContext.accountCurrency;
    if (snapshot.fxSelectionIdentity !== this.expectedFxSelectionIdentity(bars, snapshot.barIndex, fxClock ? this.now() : Number.NaN)) {
      throw new Error("FX checkpoint selected rate does not match this evaluation clock");
    }
    const state = cloneRuntimeGraph(snapshot);
    if (state.strategy !== undefined) this.strategies.migrateTradeSnapshot(state.strategy);
    validateStrategyFxSnapshot(state.strategy, this.fxContext?.book !== undefined
      && this.fxContext.symbolCurrency !== this.fxContext.accountCurrency, snapshot.barIndex >= 0,
    snapshot.fxSelectionIdentity);
    if (this.isStrictProgram()) validateStrictStrategyRiskSnapshot(state.strategy);
    if (this.isStrictProgram() && state.strategy?.config.calc_on_order_fills === true
      && !this.allowSyntheticHistoricalFillSchedule) {
      throw new Error("strategy() calc_on_order_fills is unsupported because Lumen Script does not recalculate after fills");
    }
    if (this.isStrictProgram()) {
      if (state.strategy !== undefined) validatePublicExitSnapshot(state.strategy);
      state.argumentSeries.forEach(migrateExecutionHistory);
      for (const local of state.localState.values()) migrateExecutionHistory(local.values);
      for (const [id, window] of state.historySeries) {
        if (!isBarIndexedHistory(id)) migrateExecutionHistory(window);
      }
    }
    this.syntheticHistoricalFillEvent = undefined;
    this.barIndex = state.barIndex;
    this.bars = bars;
    this.inputs = inputs;
    replaceArrays(this.variables, state.variables);
    this.variableHistory.forEach((window, index) => assignHistoryWindow(window, state.variableHistory[index]!));
    replaceArray(this.globalPersistence, state.globalPersistence ?? []);
    replaceMap(this.plots, state.plots);
    replaceMap(this.callState, state.callState);
    replaceMap(this.lastSourceCallBar, state.lastSourceCallBar);
    replaceMap(this.argumentSeries, state.argumentSeries);
    replaceMap(this.localState, state.localState);
    replaceMap(this.historySeries, state.historySeries);
    replaceMap(this.historyDepthBySource, state.historyDepthBySource);
    replaceArray(this.alerts, state.alerts);
    replaceSet(this.firedAlerts, state.firedAlerts);
    replaceArray(this.drawings.lines, state.lines);
    this.drawings.nextVisualOrder = state.nextVisualOrder;
    this.drawings.nextLineId = state.nextLineId;
    replaceArray(this.drawings.boxes, state.boxes);
    this.drawings.nextBoxId = state.nextBoxId;
    replaceArray(this.drawings.labels, state.labels);
    this.drawings.nextLabelId = state.nextLabelId;
    replaceArray(this.drawings.polylines, state.polylines);
    this.drawings.nextPolylineId = state.nextPolylineId;
    replaceArray(this.drawings.linefills, state.linefills);
    this.drawings.nextLinefillId = state.nextLinefillId;
    replaceArray(this.drawings.tables, state.tables);
    this.drawings.nextTableId = state.nextTableId;
    this.requestSeries = state.requestSeries;
    this.strategies.strategy = state.strategy;
    this.strategies.restoreFxSelection();
    this.fxSelectionIdentity = state.fxSelectionIdentity;
    this.operations = state.operations;
    this.randomState = state.randomState;
  }

  public beginBar(index: number): void {
    this.syntheticHistoricalFillEvent = undefined;
    this.barIndex = index;
    this.operations = 0;
    if (this.program.descriptor.kind === "strategy" || this.requestAccountCurrency !== undefined) {
      const bar = this.bars[index];
      if (bar === undefined) throw new Error("Missing strategy bar");
      const fxClock = this.fxContext?.book !== undefined && this.fxContext.symbolCurrency !== this.fxContext.accountCurrency;
      const selected = selectStrategyFxBar(this.fxContext!, bar, this.timeframe, this.timezone,
        fxClock ? this.operationNow() : Number.NaN, fxClock && this.isCurrentBarRealtime());
      this.fxSelectionIdentity = selected.identity;
      this.strategies.setFxSelection(selected.result);
    }
    this.strategies.processStrategyOrders();
  }

  public expectedFxSelectionIdentity(bars: readonly MarketBar[], index: number, evaluatedAt: number): string | undefined {
    if (this.fxContext?.identity === undefined || index < 0
      || (this.program.descriptor.kind !== "strategy" && this.requestAccountCurrency === undefined)) return undefined;
    const bar = bars[index];
    if (bar === undefined) throw new Error("Invalid FX checkpoint bar position");
    const realtime = index === bars.length - 1 && (bar.closeTime ?? bar.openTime) > evaluatedAt;
    return selectStrategyFxBar(this.fxContext, bar, this.timeframe, this.timezone, evaluatedAt, realtime).identity;
  }

  /** Only unavailable monetary bars need a pre-bar rollback snapshot. */
  public needsFxBarTransaction(index: number): boolean {
    if (this.strategies.strategy === undefined || this.fxContext?.book === undefined
      || this.fxContext.symbolCurrency === this.fxContext.accountCurrency) return false;
    const bar = this.bars[index];
    if (bar === undefined) return false;
    const realtime = index === this.bars.length - 1 && (bar.closeTime ?? bar.openTime) > this.operationNow();
    const result = selectStrategyFxBar(this.fxContext, bar, this.timeframe, this.timezone, this.operationNow(), realtime).result;
    return result.kind !== "rate" && result.kind !== "identity";
  }

  public endBar(): void {
    this.syntheticHistoricalFillEvent = undefined;
    if (this.strategies.strategy === undefined) return;
    this.strategies.processStrategyOrdersOnClose();
    this.strategies.markStrategyToMarket(number(this.data("close")));
    this.strategies.finalizeStrategyEquityExcursions();
    this.strategies.recordStrategyMonthlyEquity();
    this.strategies.strategy.timeline.push(Object.freeze(this.strategies.strategySnapshot()));
  }

  public data(name: string, offset = 0): PineValue {
    this.tick();
    const index = this.barIndex - integer(offset);
    if (index < 0) return Number.NaN;
    const eventView = this.syntheticHistoricalFillEvent?.barIndex === index
      ? this.syntheticHistoricalFillEvent.event.asOfBar
      : undefined;
    if (this.syntheticHistoricalFillEvent !== undefined && this.hasSyntheticHistoricalFillSourceConflict()) {
      throw new Error("Synthetic historical fill data view source series changed");
    }
    const hostSeries = this.syntheticHistoricalFillEvent === undefined ? this.sourceSeries[name] : undefined;
    if (hostSeries !== undefined) return hostSeries[this.sourceBarOffset + index] ?? Number.NaN;
    const bar = eventView ?? this.bars[index];
    if (bar === undefined) return Number.NaN;
    switch (name) {
      case "open": return bar.open;
      case "high": return bar.high;
      case "low": return bar.low;
      case "close": return bar.close;
      case "volume": return bar.volume;
      case "time": return bar.openTime;
      case "time_close": return bar.closeTime ?? bar.openTime;
      case "time_tradingday": {
        const parts = dateParts(bar.closeTime ?? bar.openTime, this.timezone);
        return Date.UTC(parts.year, parts.month - 1, parts.day);
      }
      case "hl2": return (bar.high + bar.low) / 2;
      case "hlc3": return (bar.high + bar.low + bar.close) / 3;
      case "ohlc4": return (bar.open + bar.high + bar.low + bar.close) / 4;
      case "hlcc4": return (bar.high + bar.low + bar.close * 2) / 4;
      default: return Number.NaN;
    }
  }

  /**
   * Internal synthetic point read port. It changes only current-bar market
   * fields; the engine must still own strategy fills, rollback and execution.
   * No production scheduler calls this method while post-fill recalculation is
   * guarded. Restore/begin/end clear the view so it cannot leak across bars.
   */
  public setSyntheticHistoricalFillDataView(feed: SyntheticHistoricalFillFeedV1, pointIndex: number): HistoricalFillEventV1 {
    if (this.program.descriptor.kind !== "strategy" || !this.isStrictProgram()
      || this.program.requestPlans.length > 0 || this.hasSyntheticHistoricalFillSourceConflict()) {
      throw new Error("Synthetic historical fill data view does not admit this program or source series");
    }
    if (!Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex > 3) {
      throw new Error("Synthetic historical fill data point is invalid");
    }
    const parent = this.bars[this.barIndex];
    if (parent === undefined) throw new Error("Synthetic historical fill data parent is unavailable");
    const event = admitSyntheticHistoricalFillFeed(parent, feed)[pointIndex]!;
    this.syntheticHistoricalFillEvent = { barIndex: this.barIndex, event };
    return event;
  }

  public clearSyntheticHistoricalFillDataView(): void {
    this.syntheticHistoricalFillEvent = undefined;
  }

  /** Internal event entry; unlike beginBar, this never sweeps the parent bar. */
  public beginSyntheticHistoricalFillBar(index: number, feed: SyntheticHistoricalFillFeedV1): void {
    const strategy = this.strategies.strategy;
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.bars.length
      || this.barIndex !== index - 1 || strategy === undefined || strategy.timeline.length !== index) {
      throw new Error("Synthetic historical fill bar boundary is invalid");
    }
    if (this.program.descriptor.kind !== "strategy" || !this.isStrictProgram()
      || this.program.requestPlans.length > 0 || this.hasSyntheticHistoricalFillSourceConflict()) {
      throw new Error("Synthetic historical fill bar does not admit this program or source series");
    }
    const first = admitSyntheticHistoricalFillFeed(this.bars[index]!, feed)[0]!;
    this.barIndex = index;
    this.operations = 0;
    this.syntheticHistoricalFillEvent = { barIndex: index, event: first };
  }

  /** Commit only a separately validated one-point strategy transition. */
  public replaceSyntheticHistoricalFillStrategyState(state: MutableStrategyState): void {
    if (this.syntheticHistoricalFillEvent?.barIndex !== this.barIndex
      || this.strategies.strategy === undefined || state.timeline.length !== this.barIndex) {
      throw new Error("Synthetic historical fill strategy state is not active");
    }
    this.strategies.strategy = structuredClone(state) as MutableStrategyState;
  }

  /** Stamp orders queued by this exact execution before the next point. */
  public stampSyntheticHistoricalFillOrders(startIndex: number): readonly number[] {
    const active = this.syntheticHistoricalFillEvent;
    const orders = this.strategies.strategy?.orders;
    if (active?.barIndex !== this.barIndex || orders === undefined
      || !Number.isSafeInteger(startIndex) || startIndex < 0 || startIndex > orders.length) {
      throw new Error("Synthetic historical fill order stamp is invalid");
    }
    const created: number[] = [];
    for (let index = startIndex; index < orders.length; index += 1) {
      const order = orders[index]!;
      if (order.createdBarIndex !== this.barIndex) throw new Error("Synthetic historical fill order has a stale bar");
      created.push(index);
    }
    for (const index of created) {
      const order = orders[index]!;
      order.createdTime = active.event.point.timestamp;
      if (order.reservationOriginBarIndex !== undefined || order.reservationOriginTime !== undefined) {
        order.reservationIssuedBarIndex = order.createdBarIndex;
        order.reservationIssuedTime = order.createdTime;
      }
    }
    return Object.freeze(created);
  }

  /** Finalize one bar without normal endBar's whole-bar close-order sweep. */
  public finalizeSyntheticHistoricalFillBar(): void {
    const active = this.syntheticHistoricalFillEvent;
    const strategy = this.strategies.strategy;
    if (active?.barIndex !== this.barIndex || !active.event.confirmed
      || strategy === undefined || strategy.timeline.length !== this.barIndex
      || strategy.config.process_orders_on_close) {
      throw new Error("Synthetic historical fill finalization is invalid");
    }
    this.strategies.markStrategyToMarket(number(this.data("close")));
    this.strategies.finalizeStrategyEquityExcursions();
    this.strategies.recordStrategyMonthlyEquity();
    strategy.timeline.push(Object.freeze(this.strategies.strategySnapshot()));
    this.syntheticHistoricalFillEvent = undefined;
  }

  private hasSyntheticHistoricalFillSourceConflict(): boolean {
    const prototype: unknown = Object.getPrototypeOf(this.sourceSeries);
    return (prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(this.sourceSeries).length > 0;
  }

  public get(id: number, offset = 0): PineValue {
    this.tick();
    const window = this.variableHistory[id];
    const value = window === undefined ? undefined : readHistoryWindow(window, this.barIndex - integer(offset));
    const current = window === undefined ? undefined : readHistoryWindow(window, this.barIndex);
    return refreshPineArrayValue(value ?? this.missingHistoryValue(current));
  }

  public set(id: number, value: PineValue): PineValue {
    this.tick();
    const series = this.variables[id];
    if (series === undefined) throw new Error(`Unknown runtime variable ${id}`);
    const normalized = normalize(value);
    series[this.barIndex] = normalized;
    writeHistoryWindow(this.variableHistory[id]!, this.barIndex, normalized);
    return value;
  }

  public setPersistent(id: number, initializer: () => PineValue, persistence: "var" | "varip" = "var"): PineValue {
    this.globalPersistence[id] = persistence;
    const window = this.variableHistory[id];
    const current = window === undefined ? undefined : readHistoryWindow(window, this.barIndex);
    const previous = window === undefined ? undefined : readHistoryWindow(window, this.barIndex - 1);
    const value = persistence === "varip" && current !== undefined
      ? current
      : this.barIndex === 0 || previous === undefined
        ? initializer()
        : previous;
    return this.set(id, value);
  }

  public input(id: string, title: string, defaultValue: PineValue, type: string): PineValue {
    this.tick();
    const override = Object.hasOwn(this.inputs, id) ? this.inputs[id] : this.inputs[title];
    if (override === undefined) return defaultValue;
    if (type !== "source" || typeof override !== "string") return override;
    if (!marketSourceNames.has(override) && !Object.hasOwn(this.sourceSeries, override)) return defaultValue;
    return this.data(override);
  }

  public setRequestSeries(series: Readonly<Record<string, readonly PineValue[]>>): void {
    this.requestSeries = series;
  }

  public setFootprintStore(store: FootprintRuntimeStore | undefined): void { this.footprintStore = store; }

  public setRequestResolver(resolve: typeof this.requestResolver): void { this.requestResolver = resolve; }

  public setLogSink(sink: typeof this.logSink): void { this.logSink = sink; }

  public dynamicRequest(id: string, symbol: PineValue, timeframe: PineValue): PineValue {
    this.tick();
    if (this.requestResolver === undefined) throw new Error("Dynamic request resolver is unavailable");
    return this.requestResolver(id, symbol, timeframe, this.isCurrentBarRealtime(), this.barIndex);
  }

  public request(id: string): PineValue {
    this.tick();
    return this.requestSeries[id]?.[this.barIndex] ?? Number.NaN;
  }

  public valueRef(value: PineValue): SeriesReference {
    return { get: (offset = 0) => integer(offset) === 0 ? value : this.missingHistoryValue(value) };
  }

  public dataRef(name: string): SeriesReference {
    return { get: (offset = 0) => this.data(name, offset) };
  }

  public variableRef(id: number): SeriesReference {
    return { get: (offset = 0) => this.get(id, offset) };
  }

  public argumentRef(id: StateId, argumentIndex: number, value: PineValue): SeriesReference {
    const key = `${String(id)}:${String(argumentIndex)}`;
    let series = this.argumentSeries.get(key);
    if (series === undefined) {
      series = createHistoryWindow();
      this.argumentSeries.set(key, series);
    }
    const index = this.writeExecutableHistory(series, value);
    const window = series;
    return { get: (offset = 0) => readHistoryWindow(window, index - integer(offset)) ?? this.missingHistoryValue(value) };
  }

  public scope(parent: StateId, child: number): StateId {
    return `${String(parent)}.${String(child)}`;
  }

  public integer(value: PineValue): number {
    return integer(value);
  }

  public integerSigned(value: PineValue): number {
    const numeric = number(value);
    return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
  }

  public rangeBound(value: PineValue): number {
    const numeric = number(value);
    return Number.isFinite(numeric) ? numeric : Number.NaN;
  }

  /**
   * Production programs sample the builtin variables they read through
   * history, and every zero-argument TA variable, once at the start of each
   * bar. Builtins exist on every bar, so a read inside a branch that skipped
   * earlier bars still sees their values, and TA state advances every bar.
   */
  public sampleBuiltins(names: readonly string[]): void {
    for (const name of names) {
      const id = builtinSampleId(name);
      const value = zeroArgumentCallNames.has(name) ? this.call(id, name, []) : this.constant(name);
      let series = this.historySeries.get(id);
      if (series === undefined) {
        series = createHistoryWindow();
        this.historySeries.set(id, series);
      }
      writeHistoryWindow(series, this.barIndex, value);
    }
  }

  /** Records a call-free operand at its source evaluation point. */
  public recordHistory(id: StateId, value: PineValue, byBar = false): void {
    const series = this.getOrCreateHistory(byBar ? barHistoryId(id) : id);
    if (byBar) writeHistoryWindow(series, this.barIndex, value);
    else this.writeExecutableHistory(series, value);
  }

  public readRecordedHistory(id: StateId, offset: number, byBar = false): PineValue {
    const series = this.historySeries.get(byBar ? barHistoryId(id) : id);
    if (series === undefined) return this.missingHistoryValue(undefined);
    const index = byBar ? this.barIndex : series.last;
    return readHistoryWindow(series, index - offset) ?? this.missingHistoryValue(readHistoryWindow(series, index));
  }

  /** Reads a builtin sampled by `sampleBuiltins`. */
  public builtin(name: string, offset: number): PineValue {
    const series = this.historySeries.get(builtinSampleId(name));
    if (series === undefined) throw new Error(`Builtin ${name} was not sampled`);
    return readHistoryWindow(series, this.barIndex - offset) ?? this.missingHistoryValue(readHistoryWindow(series, this.barIndex));
  }

  /** `bar_index[offset]`: na before the first bar. */
  public barIndexAt(offset: number): number {
    const index = this.barIndex - offset;
    return index < 0 ? Number.NaN : index;
  }

  public rangeStep(from: number, to: number, value: PineValue): number {
    const step = number(value);
    if (!Number.isFinite(step) || step <= 0) throw new PineRuntimeError("'step' in loop must be greater than zero");
    return from > to ? -step : step;
  }

  public loop(): void {
    this.tick();
  }

  public tupleGet(value: PineValue, index: number): PineValue {
    const tuple = Array.isArray(value) ? value as readonly PineValue[] : undefined;
    return tuple?.[index] ?? Number.NaN;
  }

  public iterable(value: PineValue, liveMapValues = false): readonly PineValue[] {
    refreshPineArrayValue(value);
    if (isPineMap(value)) {
      const entries = this.isStrictProgram() ? pineMapIteration(value, liveMapValues) : value.entries.map(([key, entry]) => [key, entry] as PineValue[]);
      this.mapIterables.add(entries);
      return entries;
    }
    if (this.isStrictProgram() && isPineMatrix(value)) {
      // A matrix loop reads its current rows, copying each primitive row while
      // retaining references to UDT/drawing elements inside that row.
      return new Proxy<PineValue[]>([], {
        get: (target, property, receiver) => {
          if (property === "length") return value.data.length;
          if (typeof property === "string" && /^(0|[1-9][0-9]*)$/u.test(property)) return [...(value.data[Number(property)] ?? [])];
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    }
    if (!Array.isArray(value)) throw new Error("Expected an iterable array or map");
    return value as readonly PineValue[];
  }

  public iterationKey(collection: readonly PineValue[], index: number): PineValue {
    return this.mapIterables.has(collection as object) ? (collection[index] as readonly PineValue[] | undefined)?.[0] ?? Number.NaN : index;
  }

  public iterationValue(collection: readonly PineValue[], index: number): PineValue {
    return this.mapIterables.has(collection as object) ? (collection[index] as readonly PineValue[] | undefined)?.[1] ?? Number.NaN : collection[index] ?? Number.NaN;
  }

  public historyOffset(callId: number, value: PineValue, maxDepth: number, sourceId?: string, targetedMinimum = 0): number {
    // The reference platform treats an na offset as zero, but rejects future references.
    if (isNa(value)) return 0;
    const offset = number(value);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new PineRuntimeError("History offset must be a non-negative integer", "[]", this.program.callSites?.[callId]);
    }
    if (offset > maxDepth) {
      throw new PineRuntimeError(`History offset exceeds ${String(maxDepth)} bars for this series`, "[]", this.program.callSites?.[callId]);
    }
    if (sourceId !== undefined && this.isStrictProgram()) {
      const inferred = this.historyDepthBySource.get(sourceId) ?? 0;
      if (this.isCurrentBarRealtime()) {
        const available = Math.max(inferred, targetedMinimum, this.program.descriptor.maxBarsBack ?? 0);
        if (offset > available) {
          throw new PineRuntimeError(`History offset exceeds inferred buffer of ${String(available)} bars for this series`, "[]", this.program.callSites?.[callId]);
        }
      } else if (offset > inferred) this.historyDepthBySource.set(sourceId, offset);
    }
    return offset;
  }

  public history(id: StateId, value: PineValue, offset: PineValue): PineValue {
    const series = this.getOrCreateHistory(id);
    const index = this.writeExecutableHistory(series, value);
    return readHistoryWindow(series, index - integer(offset)) ?? this.missingHistoryValue(value);
  }

  private getOrCreateHistory(id: StateId): RuntimeHistoryWindow {
    let series = this.historySeries.get(id);
    if (series === undefined) {
      series = createHistoryWindow();
      this.historySeries.set(id, series);
    }
    return series;
  }

  private writeExecutableHistory(window: RuntimeHistoryWindow, value: PineValue): number {
    if (this.isStrictProgram()) return writeHistoryWindowExecution(window, this.barIndex, value);
    writeHistoryWindow(window, this.barIndex, value);
    return this.barIndex;
  }

  public localRef(scope: StateId, localId: number, initializer: () => PineValue, persistence: "bar" | "var" | "varip"): MutableSeriesReference {
    const key = `${String(scope)}:${String(localId)}`;
    let state = this.localState.get(key);
    if (state === undefined) {
      state = { values: createHistoryWindow(), persistence, initialized: false, persistentValue: Number.NaN };
      this.localState.set(key, state);
    }
    const initial = persistence === "bar" || !state.initialized ? initializer() : state.persistentValue;
    const local = state;
    const index = this.writeExecutableHistory(local.values, initial);
    local.initialized = true;
    local.persistentValue = initial;
    return {
      get: (offset = 0) => readHistoryWindow(local.values, index - integer(offset))
        ?? this.missingHistoryValue(readHistoryWindow(local.values, index)),
      set: (value) => {
        writeHistoryWindow(local.values, index, value);
        local.persistentValue = value;
        return value;
      },
    };
  }

  /** Pine v6 `once`: test a call-path-local latch without committing it. */
  public once(scope: StateId, condition: () => PineValue): boolean {
    const latch = this.localRef(scope, -1, () => false, "var");
    return !this.truthy(latch.get(0)) && this.truthy(condition());
  }

  /** Commit a successfully completed Pine v6 `once` body. */
  public commitOnce(scope: StateId): void {
    this.localRef(scope, -1, () => false, "var").set(true);
  }

  public assignRef(reference: MutableSeriesReference, value: PineValue): PineValue {
    return reference.set(value);
  }

  public plot(id: string, value: PineValue, title: string, options: Readonly<Record<string, PineValue>> = {}): PineValue {
    this.tick();
    const resolvedOptions = { color: "#2962ff", ...options };
    let plot = this.plots.get(id);
    if (plot === undefined) {
      plot = { id, title, points: [], options: resolvedOptions };
      this.plots.set(id, plot);
    }
    const point = { time: number(this.data("time")), value: normalize(value) };
    plot.points[this.barIndex] = { ...point, options: resolvedOptions };
    return id;
  }

  public hline(id: string, price: PineValue, title: string, options: Readonly<Record<string, PineValue>>): PineValue {
    if (this.isStrictProgram()) {
      const style = options.linestyle;
      if (style !== undefined && (typeof style !== "string" || !["solid", "dotted", "dashed"].includes(style))) {
        throw new PineRuntimeError("hline() requires an hline linestyle", "hline");
      }
      const width = options.linewidth;
      if (width !== undefined && (typeof width !== "number" || !Number.isSafeInteger(width) || width < 1)) {
        throw new PineRuntimeError("hline() requires a positive linewidth", "hline");
      }
    }
    this.visual(id, "hline", price, title, { color: "#787b86", ...options },
      { color: options.color === undefined ? "#787b86" : options.color });
    return id;
  }

  public fill(
    id: string,
    plot1: PineValue,
    plot2: PineValue,
    title: string,
    options: Readonly<Record<string, PineValue>>,
  ): PineValue {
    this.tick();
    if (this.isStrictProgram()) {
      const first = typeof plot1 === "string" ? this.plots.get(plot1) : undefined;
      const second = typeof plot2 === "string" ? this.plots.get(plot2) : undefined;
      if (first === undefined || second === undefined ||
        (first.options.style === "hline") !== (second.options.style === "hline")) {
        throw new PineRuntimeError("fill() requires two plot or two hline handles", "fill");
      }
    }
    let plot = this.plots.get(id);
    if (plot === undefined) {
      plot = { id, title, points: [], options: { plot1, plot2, ...options, style: "fill" } };
      this.plots.set(id, plot);
    }
    const gradient = ["top_value", "bottom_value", "top_color", "bottom_color"].some((key) => options[key] !== undefined);
    if (gradient) plot.options = { ...plot.options, gradient: true };
    const pointOptions = gradient
      ? Object.fromEntries(["top_value", "bottom_value", "top_color", "bottom_color"].filter((key) => options[key] !== undefined).map((key) => [key, options[key]!]))
      : options.color === undefined ? {} : { color: options.color };
    plot.points[this.barIndex] = { time: number(this.data("time")), value: null, options: pointOptions };
    return id;
  }

  public visual(
    id: string,
    style: "background" | "bar" | "barcolor" | "candle" | "char" | "hline" | "shape",
    value: PineValue,
    title: string,
    options: Readonly<Record<string, PineValue>>,
    pointOptions: Readonly<Record<string, PineValue>>,
  ): void {
    this.tick();
    let plot = this.plots.get(id);
    if (plot === undefined) {
      plot = { id, title, points: [], options: { ...options, style } };
      this.plots.set(id, plot);
    }
    plot.points[this.barIndex] = {
      time: number(this.data("time")),
      value: normalize(value),
      options: pointOptions,
    };
  }

  public arrow(id: string, value: PineValue, title: string, options: Readonly<Record<string, PineValue>>): void {
    const numeric = number(value);
    const pointOptions: Record<string, PineValue> = {};
    if (Number.isFinite(numeric) && numeric !== 0) {
      // Without colorup/colordown the production profile draws green up and red down arrows.
      const strict = this.isStrictProgram();
      pointOptions.color = numeric > 0
        ? options.colorup ?? (strict ? PLOTARROW_DEFAULT_UP_COLOR : Number.NaN)
        : options.colordown ?? (strict ? PLOTARROW_DEFAULT_DOWN_COLOR : Number.NaN);
      pointOptions.offset = options.offset ?? 0;
      pointOptions.shape = numeric > 0 ? "shape_arrow_up" : "shape_arrow_down";
      pointOptions.location = numeric > 0 ? "BelowBar" : "AboveBar";
      pointOptions.height = options.maxheight ?? Number.NaN;
    }
    this.visual(id, "shape", value, title, options, pointOptions);
  }

  public alert(id: string, message: PineValue, frequency: PineValue | undefined): PineValue {
    this.tick();
    if (this.isStrictProgram() && frequency !== undefined && frequency !== "alert.freq_all"
      && frequency !== "alert.freq_once_per_bar" && frequency !== "alert.freq_once_per_bar_close") {
      throw new PineRuntimeError("alert() frequency must be alert.freq_all, alert.freq_once_per_bar, or alert.freq_once_per_bar_close", "alert");
    }
    const resolvedFrequency = frequency === "alert.freq_all" || frequency === "alert.freq_once_per_bar_close"
      ? frequency : "alert.freq_once_per_bar";
    if (!this.shouldEmitAlert(id, resolvedFrequency)) return null;
    this.alerts.push(Object.freeze({
      type: "alert",
      id,
      message: pineString(message),
      frequency: resolvedFrequency,
      barIndex: this.barIndex,
      time: number(this.data("time")),
      ...(this.isStrictProgram() ? { confirmed: this.isCurrentBarConfirmed() } : {}),
    }));
    return null;
  }

  public alertCondition(id: string, condition: PineValue, title: PineValue, message: PineValue): PineValue {
    this.tick();
    if (!this.truthy(condition) || !this.shouldEmitAlert(id, "alert.freq_once_per_bar")) return null;
    this.alerts.push(Object.freeze({
      type: "alertcondition",
      id,
      title: pineString(title),
      message: pineString(message),
      barIndex: this.barIndex,
      time: number(this.data("time")),
      ...(this.isStrictProgram() ? { confirmed: this.isCurrentBarConfirmed() } : {}),
    }));
    return null;
  }

  private shouldEmitAlert(id: string, frequency: "alert.freq_all" | "alert.freq_once_per_bar" | "alert.freq_once_per_bar_close"): boolean {
    if (this.alertMode === "off") return false;
    if (this.alertMode === "realtime-update" && this.barIndex !== this.bars.length - 1) return false;
    if (this.alertMode === "realtime" && (this.isStrictProgram() ? !this.isCurrentBarRealtime() : this.barIndex !== this.bars.length - 1)) return false;
    if (frequency === "alert.freq_once_per_bar_close" && this.syntheticHistoricalFillEvent?.barIndex === this.barIndex
      && !this.syntheticHistoricalFillEvent.event.confirmed) return false;
    if (this.isStrictProgram() && frequency === "alert.freq_once_per_bar_close" && !this.isCurrentBarConfirmed()) return false;
    if (frequency === "alert.freq_all") return true;
    const key = `${id}:${String(this.barIndex)}`;
    if (this.firedAlerts.has(key)) return false;
    this.firedAlerts.add(key);
    return true;
  }

  public unary(operator: string, value: PineValue): PineValue {
    this.tick();
    if (operator === "not") return !this.truthy(value);
    const numeric = number(value);
    return operator === "-" ? -numeric : numeric;
  }

  public binary(operator: string, left: PineValue, right: PineValue): PineValue {
    this.tick();
    if (operator === "and") return this.truthy(left) && this.truthy(right);
    if (operator === "or") return this.truthy(left) || this.truthy(right);
    const comparison = ["==", "!=", "<", "<=", ">", ">="].includes(operator);
    if (isNa(left) || isNa(right)) {
      return comparison && this.program.version === 6 && this.isStrictProgram() ? false : Number.NaN;
    }
    if (typeof left === "number" && typeof right === "number" && comparison) {
      const equal = Math.abs(left - right) < 1e-10;
      if (operator === "==") return equal;
      if (operator === "!=") return !equal;
      if (operator === "<") return !equal && left < right;
      if (operator === ">") return !equal && left > right;
      if (operator === "<=") return equal || left < right;
      return equal || left > right;
    }
    switch (operator) {
      case "+": return typeof left === "string" || typeof right === "string" ? pineString(left) + pineString(right) : number(left) + number(right);
      case "-": return number(left) - number(right);
      case "*": return number(left) * number(right);
      case "/": return number(left) / number(right);
      case "__idiv": return Math.trunc(number(left) / number(right));
      case "%": return number(left) % number(right);
      case "==": return left === right;
      case "!=": return left !== right;
      case "<": return compare(left, right) < 0;
      case "<=": return compare(left, right) <= 0;
      case ">": return compare(left, right) > 0;
      case ">=": return compare(left, right) >= 0;
      default: throw new Error(`Unsupported binary operator ${operator}`);
    }
  }

  public truthy(value: PineValue): boolean {
    return !isNa(value) && Boolean(value);
  }

  public constant(name: string): PineValue {
    this.tick();
    if (this.isStrictProgram() && (name.startsWith("dividends.future_") || name.startsWith("earnings.future_"))) {
      return this.symbolInfo[name.replace(".", "_")] ?? Number.NaN;
    }
    if (this.syntheticHistoricalFillEvent?.barIndex === this.barIndex
      && ["barstate.islast", "barstate.islastconfirmedhistory", "last_bar_index", "last_bar_time", "timenow"].includes(name)) {
      throw new Error("Synthetic historical fill dataset-tail or execution-clock value is not admitted");
    }
    if (name === "barstate.isfirst") return this.barIndex === 0;
    if (name === "barstate.islast") return this.barIndex === this.bars.length - 1;
    if (name === "barstate.ishistory") return this.isStrictProgram() ? !this.isCurrentRealtimeEvaluation() : this.barIndex < this.bars.length - 1;
    if (name === "barstate.isrealtime") return this.isStrictProgram() ? this.isCurrentRealtimeEvaluation() : this.barIndex === this.bars.length - 1;
    if (name === "barstate.isnew") return !this.isRealtimeUpdate(this.barIndex);
    if (name === "barstate.isconfirmed") return this.isCurrentBarConfirmed();
    if (name === "barstate.islastconfirmedhistory") {
      if (this.barIndex === this.bars.length - 1) return this.isCurrentBarConfirmed() && !this.isRealtimeUpdate(this.barIndex);
      const next = this.barIndex + 1;
      return next === this.bars.length - 1 && (!this.isBarConfirmed(next) || this.isRealtimeUpdate(next));
    }
    if (name.startsWith("strategy.")) return this.strategies.strategyValue(name.slice("strategy.".length));
    if (name === "last_bar_index") return this.isStrictProgram() ? this.bars.length - 1 : this.barIndex;
    if (name === "last_bar_time") return this.bars.at(-1)?.openTime ?? Number.NaN;
    if (name === "timenow" && this.isStrictProgram()) return this.operationNow();
    if (name.startsWith("session.") && this.isStrictProgram()) return this.sessionValue(name);
    if (name === "time_tradingday" && this.isStrictProgram()) return this.tradingDayAt(0);
    if (name === "time_tradingday") {
      const closeTime = number(this.data("time_close"));
      if (Number.isNaN(closeTime)) return Number.NaN;
      const parts = dateParts(closeTime, this.timezone);
      return Date.UTC(parts.year, parts.month - 1, parts.day);
    }
    if (name === "chart.left_visible_bar_time") return this.visibleRange?.left ?? this.bars[0]?.openTime ?? Number.NaN;
    if (name === "chart.right_visible_bar_time") return this.visibleRange?.right ?? this.bars.at(-1)?.openTime ?? Number.NaN;
    if (name === "chart.is_standard") return this.chartType === "standard";
    if (["chart.is_heikinashi", "chart.is_kagi", "chart.is_linebreak", "chart.is_pnf", "chart.is_range", "chart.is_renko"].includes(name)) {
      return this.chartType === name.slice("chart.is_".length);
    }
    if (name === "chart.bg_color") return this.chartColors.background;
    if (name === "chart.fg_color") return this.chartColors.foreground;
    if (name.startsWith("timeframe.")) return timeframeProperty(
      name.slice(10),
      this.isStrictProgram()
        ? (name === "timeframe.main_period" ? this.mainTimeframe : this.timeframe)
        : legacyNormalizeTimeframe(this.timeframe),
      this.isStrictProgram() && this.program.version === 6,
    );
    if (name.startsWith("syminfo.")) {
      const field = name.slice("syminfo.".length);
      const value = this.symbolInfo[field];
      if (value !== undefined) return value;
      if (field === "mincontract" && !this.isStrictProgram()) return 1;
      return numericSymbolInfoNames.has(field) ? Number.NaN : "";
    }
    if (name === "line.all") return this.drawings.lines.filter((line) => !line.deleted);
    if (name === "box.all") return this.drawings.boxes.filter((box) => !box.deleted);
    if (name === "label.all") return this.drawings.labels.filter((label) => !label.deleted);
    if (name === "polyline.all") return this.drawings.polylines.filter((polyline) => !polyline.deleted);
    if (name === "linefill.all") return this.drawings.linefills.filter((linefill) => !linefill.deleted);
    if (name === "table.all") return this.drawings.tables.filter((table) => !table.deleted);
    if (name.startsWith("currency.")) return name.slice("currency.".length);
    const constants: Readonly<Record<string, PineValue>> = {
      "math.e": Math.E,
      "math.phi": (1 + Math.sqrt(5)) / 2,
      "math.pi": Math.PI,
      "math.rphi": 2 / (1 + Math.sqrt(5)),
      "color.aqua": "#00BCD4",
      "color.black": "#363A45",
      "color.blue": this.isStrictProgram() ? "#2962FF" : "#2196F3",
      "color.fuchsia": "#E040FB",
      "color.gray": "#787B86",
      "color.green": "#4CAF50",
      "color.lime": "#00E676",
      "color.maroon": "#880E4F",
      "color.navy": "#311B92",
      "color.olive": "#808000",
      "color.orange": "#FF9800",
      "color.purple": "#9C27B0",
      "color.red": "#F23645",
      "color.silver": "#B2B5BE",
      "color.teal": "#089981",
      "color.white": "#FFFFFF",
      "color.yellow": "#FDD835",
      "plot.style_area": "style_area",
      "plot.style_areabr": "style_areabr",
      "plot.style_circles": "style_circles",
      "plot.style_columns": "style_columns",
      "plot.style_cross": "style_cross",
      "plot.style_histogram": "style_histogram",
      "plot.style_line": "style_line",
      "plot.style_linebr": "style_linebr",
      "plot.style_stepline": "style_stepline",
      "plot.style_stepline_diamond": "style_stepline_diamond",
      "plot.style_steplinebr": "style_steplinebr",
      "plot.linestyle_solid": "linestyle_solid",
      "plot.linestyle_dotted": "linestyle_dotted",
      "plot.linestyle_dashed": "linestyle_dashed",
      "location.abovebar": "AboveBar",
      "location.belowbar": "BelowBar",
      "location.absolute": "Absolute",
      "location.bottom": "Bottom",
      "location.top": "Top",
      "shape.flag": "shape_flag",
      "shape.arrowdown": "shape_arrow_down",
      "shape.arrowup": "shape_arrow_up",
      "shape.circle": "shape_circle",
      "shape.cross": "shape_cross",
      "shape.diamond": "shape_diamond",
      "shape.labeldown": "shape_label_down",
      "shape.labelup": "shape_label_up",
      "shape.square": "shape_square",
      "shape.triangledown": "shape_triangle_down",
      "shape.triangleup": "shape_triangle_up",
      "shape.xcross": "shape_xcross",
      "size.auto": "auto",
      "size.tiny": "tiny",
      "size.small": "small",
      "size.normal": "normal",
      "size.large": "large",
      "size.huge": "huge",
      "format.inherit": "inherit",
      "format.mintick": "mintick",
      "format.percent": "percent",
      "format.price": "price",
      "format.volume": "volume",
      "text.align_left": "left",
      "text.align_center": "center",
      "text.align_right": "right",
      "text.align_top": "top",
      "text.align_bottom": "bottom",
      "text.format_none": "format_none",
      "text.format_bold": "format_bold",
      "text.format_italic": "format_italic",
      "text.wrap_auto": "auto",
      "text.wrap_none": "none",
      "font.family_default": "default",
      "font.family_monospace": "monospace",
      "adjustment.none": "none",
      "adjustment.splits": "splits",
      "adjustment.dividends": "dividends",
      "backadjustment.inherit": "inherit",
      "backadjustment.off": "off",
      "backadjustment.on": "on",
      "earnings.actual": "earnings_actual",
      "earnings.estimate": "earnings_estimate",
      "earnings.standardized": "earnings_standardized",
      "earnings.future_eps": "earnings_future_eps",
      "earnings.future_period_end_time": "earnings_future_period_end_time",
      "earnings.future_revenue": "earnings_future_revenue",
      "earnings.future_time": "earnings_future_time",
      "dividends.gross": "dividends_gross",
      "dividends.net": "dividends_net",
      "dividends.future_amount": "dividends_future_amount",
      "dividends.future_ex_date": "dividends_future_ex_date",
      "dividends.future_pay_date": "dividends_future_pay_date",
      "splits.denominator": "splits_denominator",
      "splits.numerator": "splits_numerator",
      "dayofweek.sunday": 1,
      "dayofweek.monday": 2,
      "dayofweek.tuesday": 3,
      "dayofweek.wednesday": 4,
      "dayofweek.thursday": 5,
      "dayofweek.friday": 6,
      "dayofweek.saturday": 7,
      "order.ascending": 1,
      "order.descending": 0,
      "display.all": PINE_DISPLAY_MASKS.all,
      "display.data_window": PINE_DISPLAY_MASKS.data_window,
      "display.none": PINE_DISPLAY_MASKS.none,
      "display.pane": PINE_DISPLAY_MASKS.pane,
      "display.price_scale": PINE_DISPLAY_MASKS.price_scale,
      "display.status_line": PINE_DISPLAY_MASKS.status_line,
      "display.pine_screener": PINE_DISPLAY_MASKS.pine_screener,
      "barmerge.gaps_on": "gaps_on",
      "barmerge.gaps_off": "gaps_off",
      "barmerge.lookahead_on": "lookahead_on",
      "barmerge.lookahead_off": "lookahead_off",
      "hline.style_dashed": "dashed",
      "hline.style_dotted": "dotted",
      "hline.style_solid": "solid",
      "alert.freq_all": "alert.freq_all",
      "alert.freq_once_per_bar": "alert.freq_once_per_bar",
      "alert.freq_once_per_bar_close": "alert.freq_once_per_bar_close",
      "xloc.bar_index": "bi",
      "xloc.bar_time": "bt",
      "extend.left": "l",
      "extend.right": "r",
      "extend.both": "b",
      "extend.none": "n",
      "line.style_solid": "style_solid",
      "line.style_dotted": "style_dotted",
      "line.style_dashed": "style_dashed",
      "line.style_arrow_left": "style_arrow_left",
      "line.style_arrow_right": "style_arrow_right",
      "line.style_arrow_both": "style_arrow_both",
      "yloc.price": "pr",
      "yloc.abovebar": "ab",
      "yloc.belowbar": "bl",
      "label.style_label_down": "style_label_down",
      "label.style_label_up": "style_label_up",
      "label.style_label_left": "style_label_left",
      "label.style_label_right": "style_label_right",
      "label.style_label_center": "style_label_center",
      "label.style_label_lower_left": "style_label_lower_left",
      "label.style_label_lower_right": "style_label_lower_right",
      "label.style_label_upper_left": "style_label_upper_left",
      "label.style_label_upper_right": "style_label_upper_right",
      "label.style_circle": "style_circle",
      "label.style_square": "style_square",
      "label.style_diamond": "style_diamond",
      "label.style_arrowdown": "style_arrowdown",
      "label.style_arrowup": "style_arrowup",
      "label.style_cross": "style_cross",
      "label.style_flag": "style_flag",
      "label.style_none": "style_none",
      "label.style_text_outline": "style_text_outline",
      "label.style_triangledown": "style_triangledown",
      "label.style_triangleup": "style_triangleup",
      "label.style_xcross": "style_xcross",
      "scale.left": "left",
      "scale.none": "none",
      "scale.right": "right",
      "settlement_as_close.inherit": "inherit",
      "settlement_as_close.off": "off",
      "settlement_as_close.on": "on",
      "position.top_left": "top_left",
      "position.top_center": "top_center",
      "position.top_right": "top_right",
      "position.middle_left": "middle_left",
      "position.middle_center": "middle_center",
      "position.middle_right": "middle_right",
      "position.bottom_left": "bottom_left",
      "position.bottom_center": "bottom_center",
      "position.bottom_right": "bottom_right",
    };
    return constants[name] ?? name;
  }

  public call(id: StateId, name: string, args: readonly PineValue[]): PineValue {
    try { return this.dispatchCall(id, name, args); }
    catch (error) { throw this.locateCallError(error, id, name); }
  }

  private dispatchCall(id: StateId, name: string, args: readonly PineValue[]): PineValue {
    this.tick();
    if (this.syntheticHistoricalFillEvent?.barIndex === this.barIndex && (name === "time" || name === "time_close")) {
      throw new Error("Synthetic historical fill time() overload is not admitted");
    }
    // Array dispatch owns its own read barrier, including direct arrayCall users.
    if (!name.startsWith("array.")) for (const arg of args) refreshPineArrayValue(arg);
    const strictTaHistory = this.isStrictProgram();
    if (strictTaHistory) this.validateTaArguments(name, args);
    // The reference platform evaluates these windows over the last `length` non-na samples.
    if (strictTaHistory) {
      if (name === "ta.sma") return this.presentWindowStatistic(id, args, "sma");
      if (name === "ta.highest") return taValue(this.presentWindowStatistic(id, args, "highest"));
      if (name === "ta.lowest") return taValue(this.presentWindowStatistic(id, args, "lowest"));
      if (name === "ta.range") return taValue(this.presentWindowStatistic(id, args, "range"));
      if (name === "ta.median") return taValue(this.presentWindowStatistic(id, args, "median"));
      if (name === "ta.highestbars") return taValue(this.presentExtremeOffset(id, args, true));
      if (name === "ta.lowestbars") return taValue(this.presentExtremeOffset(id, args, false));
      if (name === "ta.variance" || name === "ta.stdev") {
        // biased=false divides by n - 1 for the sample estimate.
        const variance = this.presentWindowStatistic(id, args, args[2] === false ? "sampleVariance" : "variance");
        return taValue(name === "ta.stdev" ? Math.sqrt(number(variance)) : variance);
      }
    }
    if (name === "ta.sma") return taValue(this.sma(id, args));
    if (name === "ta.ema") {
      const value = this.ema(id, args, strictTaHistory);
      // The reference platform returns na on a bar whose source is na, then resumes from the held state.
      return strictTaHistory && isNa(args[0]) ? Number.NaN : taValue(value);
    }
    if (name === "ta.rma") {
      const value = this.rma(id, args);
      return strictTaHistory && isNa(args[0]) ? Number.NaN : taValue(value);
    }
    if (name === "ta.wma") return taValue(this.wma(id, args, strictTaHistory));
    if (name === "ta.vwma") return taValue(this.vwma(id, args, strictTaHistory));
    if (name === "ta.alma") return taValue(this.alma(id, args, strictTaHistory));
    if (name === "ta.hma") return taValue(this.hma(id, args, strictTaHistory));
    if (name === "ta.swma") return taValue(this.swma(id, args));
    if (name === "ta.linreg") return taValue(this.linearRegression(id, args));
    if (name === "ta.change") return taValue(this.change(id, args, strictTaHistory));
    if (name === "ta.mom") return taValue(this.change(id, args));
    if (name === "ta.roc") return taValue(this.roc(id, args, strictTaHistory));
    if (name === "ta.highest") return taValue(this.extreme(id, args, Math.max, "high"));
    if (name === "ta.lowest") return taValue(this.extreme(id, args, Math.min, strictTaHistory ? "low" : "high"));
    if (name === "ta.highestbars") return taValue(this.extremeOffset(id, args, true, strictTaHistory));
    if (name === "ta.lowestbars") return taValue(this.extremeOffset(id, args, false, strictTaHistory));
    if (name === "ta.variance" || name === "ta.stdev") {
      const variance = this.variance(id, args);
      return taValue(name === "ta.stdev" ? Math.sqrt(number(variance)) : variance);
    }
    if (name === "ta.dev") return taValue(this.deviation(id, args));
    if (name === "ta.median") return taValue(this.median(id, args));
    if (name === "ta.mode") return taValue(this.mode(id, args, strictTaHistory));
    if (name === "ta.cci") return taValue(this.cci(id, args));
    if (name === "ta.cmo") return taValue(this.cmo(id, args, strictTaHistory));
    if (name === "ta.cog") return taValue(this.cog(id, args));
    if (name === "ta.correlation") {
      const result = this.correlation(id, args, strictTaHistory);
      return strictTaHistory ? result : taValue(result);
    }
    if (name === "ta.rci") return taValue(this.rankCorrelationIndex(id, args, strictTaHistory));
    if (name === "ta.max") return taValue(this.runningExtreme(id, args, true));
    if (name === "ta.min") return taValue(this.runningExtreme(id, args, false));
    if (name === "ta.stoch") return taValue(this.stochastic(id, args, strictTaHistory));
    if (name === "ta.wpr") return taValue(this.williamsPercentRange(id, args));
    if (name === "ta.percentrank") return taValue(this.percentRank(id, args, strictTaHistory));
    if (name === "ta.percentile_linear_interpolation" || name === "ta.percentile_nearest_rank") {
      const interpolate = name === "ta.percentile_linear_interpolation";
      return taValue(strictTaHistory ? this.strictPercentile(id, args, interpolate) : this.percentile(id, args, interpolate));
    }
    if (name === "ta.cross") return this.cross(id, args, "either", strictTaHistory);
    if (name === "ta.valuewhen") return this.valueWhen(id, args);
    if (name === "ta.mfi") return taValue(this.moneyFlowIndex(id, args, strictTaHistory));
    if (name === "ta.pivothigh") return taValue(this.pivot(id, args, true, strictTaHistory));
    if (name === "ta.pivotlow") return taValue(this.pivot(id, args, false, strictTaHistory));
    if (name === "ta.pivot_point_levels") return this.pivotPointLevels(id, args, strictTaHistory);
    if (name === "ta.tsi") return taValue(this.trueStrengthIndex(id, args));
    if (name === "ta.dmi") return this.dmi(id, args);
    if (name === "ta.supertrend") return this.supertrend(id, args, strictTaHistory);
    if (name === "ta.sar") return taValue(this.sar(id, args, strictTaHistory));
    if (name === "ta.vwap") {
      if (!strictTaHistory) return taValue(this.vwap(id, args));
      const tradingDay = args.length >= 2 || this.sessionSchedule.activeSession === undefined
        ? number(this.data("time_tradingday"))
        : number(this.tradingDayAt(0));
      return this.strictVwap(id, args, tradingDay);
    }
    if (name === "ta.crossover") return this.cross(id, args, "over", strictTaHistory);
    if (name === "ta.crossunder") return this.cross(id, args, "under", strictTaHistory);
    if (name === "ta.rsi") return taValue(this.rsi(id, args));
    if (name === "ta.tr") {
      const handleNa = strictTaHistory && args[0] !== undefined ? this.truthy(args[0]) : true;
      return taValue(this.trueRange(handleNa));
    }
    if (name === "ta.atr") return taValue(this.atr(id, args));
    if (name === "ta.macd") return this.macd(id, args, strictTaHistory);
    if (name === "ta.bb") return this.bb(id, args, strictTaHistory);
    if (name === "ta.bbw") return taValue(this.bbw(id, args, strictTaHistory));
    if (name === "ta.kc") return this.kc(id, args, strictTaHistory);
    if (name === "ta.kcw") return taValue(this.kcw(id, args, strictTaHistory));
    if (name === "ta.cum") {
      const result = this.cumulative(id, args, strictTaHistory);
      return strictTaHistory ? result : taValue(result);
    }
    if (name === "ta.sum") return taValue(this.movingSum(id, args));
    if (name === "ta.range") return taValue(this.range(id, args));
    if (name === "ta.rising") return this.directionalWindow(id, args, true, strictTaHistory);
    if (name === "ta.falling") return this.directionalWindow(id, args, false, strictTaHistory);
    if (name === "ta.barssince") return this.barsSince(id, args);
    if (name === "ta.accdist") {
      const result = this.accumulationDistribution(id);
      return strictTaHistory ? result : taValue(result);
    }
    if (name === "ta.obv") return taValue(this.onBalanceVolume(id, strictTaHistory));
    if (name === "ta.pvt") return taValue(this.priceVolumeTrend(id, strictTaHistory));
    if (name === "ta.wad") return taValue(this.williamsAccumulation(id));
    if (name === "ta.wvad") {
      const result = this.williamsVariableAccumulation(strictTaHistory);
      return strictTaHistory ? result : taValue(result);
    }
    if (name === "ta.iii") return taValue(this.intradayIntensity(strictTaHistory));
    if (name === "ta.nvi") return taValue(this.volumeIndex(id, false));
    if (name === "ta.pvi") return taValue(this.volumeIndex(id, true));
    if (strictTaHistory && name === "fixnan") {
      let state = this.callState.get(id) as FixnanState | undefined;
      if (state === undefined) {
        state = { hasValue: false, value: Number.NaN };
        this.callState.set(id, state);
      }
      if (isNa(args[0])) return state.hasValue ? state.value : Number.NaN;
      state.hasValue = true;
      state.value = args[0]!;
      return state.value;
    }
    if (name === "na" || name === "nz") {
      const value = args[0];
      const missing = isNa(value) || (strictTaHistory && typeof value === "number" && !Number.isFinite(value));
      if (name === "na") return missing;
      if (!missing) return value ?? Number.NaN;
      if (args[1] !== undefined) return args[1];
      if (!strictTaHistory) return args[1] ?? 0;
      if (args[2] === "color") return "#00000000";
      if (args[2] === "bool") return false;
      return 0;
    }
    if (name === "int") return isNa(args[0]) ? Number.NaN : Math.trunc(number(args[0]));
    if (name === "float") return isNa(args[0]) ? Number.NaN : number(args[0]);
    if (name === "bool") {
      if (strictTaHistory && this.program.version === 5 && isNa(args[0])) return Number.NaN;
      return this.truthy(args[0] ?? Number.NaN);
    }
    if (name === "string") {
      if (strictTaHistory) return isNa(args[0]) ? "" : pineString(args[0] ?? "");
      return isNa(args[0]) ? "NaN" : pineString(args[0] ?? "");
    }
    if (name === "color") {
      if (strictTaHistory) return typeof args[0] === "string" ? args[0] : Number.NaN;
      return isNa(args[0]) ? Number.NaN : (args[0] ?? Number.NaN);
    }
    if (this.isStrictProgram() && (name === "log.info" || name === "log.warning" || name === "log.error")) {
      const bar = this.bars[this.barIndex];
      const callId = typeof id === "number" ? id : Number(id.split(".").at(-1));
      const range = this.program.callSites?.[callId];
      if (bar === undefined || range === undefined) throw new PineRuntimeError("Log source location is unavailable", name);
      const formatted = formatBoundedLogMessage(args);
      const phase = this.isCurrentRealtimeEvaluation() ? "realtime" : "historical";
      this.logSink?.({
        level: name.slice(4) as PineLogDraft["level"],
        message: formatted.message,
        ...(formatted.truncated ? { truncated: true } : {}),
        barIndex: this.barIndex,
        barOpenTimeMs: bar.openTime,
        emittedAtMs: phase === "realtime" ? this.evaluationNow : bar.openTime,
        phase,
        callSite: { line: range.start.line, column: range.start.column, endLine: range.end.line, endColumn: range.end.column },
      });
      return null;
    }
    if (!this.isStrictProgram() && name.startsWith("log.")) return null;
    if (name === "runtime.error") {
      const message = pineString(args[0] ?? (this.isStrictProgram() ? "" : "Runtime error"));
      throw this.isStrictProgram()
        ? new PineRuntimeError(message, "runtime.error")
        : new Error(message);
    }
    if (name === "request.footprint") return this.currentFootprint();
    if (name.startsWith("footprint.")) return this.footprints(name).footprintCall(name.slice("footprint.".length), args);
    if (name.startsWith("volume_row.")) return this.footprints(name).rowCall(name.slice("volume_row.".length), args);
    if (["box", "label", "line", "linefill", "table"].includes(name)) {
      return drawingCast(name, args[0], this.drawings, this.isStrictProgram());
    }
    if (name === "polyline") return drawingCast(name, args[0]);
    if (name === "color.new") return colorNew(args[0], args[1], this.isStrictProgram());
    if (name === "color.rgb") return colorRgb(args, this.isStrictProgram());
    if (name === "color.from_gradient") return colorGradient(args, this.isStrictProgram());
    if (name === "color.r" || name === "color.g" || name === "color.b" || name === "color.t") {
      return colorComponent(name.slice(6), args[0], this.isStrictProgram());
    }
    if (name.startsWith("str.")) return stringCall(name.slice(4), args, this.timezone, number(this.symbolInfo.mintick ?? 0.01), this.isStrictProgram());
    if (name === "math.sum") {
      if (this.isStrictProgram()) this.validateMathSumLength(args[1], name);
      return taValue(this.movingSum(
        id,
        args,
        this.isStrictProgram() ? MAX_TA_HISTORY_ARGUMENT : undefined,
      ));
    }
    if (name === "math.round_to_mintick") {
      const tick = number(this.symbolInfo.mintick ?? 0.01);
      if (!this.isStrictProgram()) {
        const scaled = number(args[0]) / tick;
        return tick <= 0 ? number(args[0]) : Math.sign(scaled) * Math.round(Math.abs(scaled)) * tick;
      }
      if (!Number.isFinite(tick) || tick <= 0) {
        throw new PineRuntimeError("math.round_to_mintick requires a finite positive host mintick", name);
      }
      const value = number(args[0]);
      if (!Number.isFinite(value)) return value;
      const magnitude = Math.abs(value);
      const scaled = magnitude / tick;
      if (!Number.isFinite(scaled)) return value;
      if (scaled === 0) return 0;
      if (Number.isInteger(scaled)) return value;
      const lower = Math.floor(scaled);
      const fraction = scaled - lower;
      const halfwayRefinementWindow = Math.min(
        0.5,
        Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4,
      );
      const numericRoundsUp = fraction >= 0.5;
      const roundsUp = Math.abs(fraction - 0.5) <= halfwayRefinementWindow
        ? decimalRatioAtOrAboveHalf(magnitude, tick, lower, numericRoundsUp)
        : numericRoundsUp;
      const roundedTicks = roundsUp ? lower + 1 : lower;
      const rounded = Math.sign(value) * roundedTicks * tick;
      if (!Number.isFinite(rounded)) return value;
      return Object.is(rounded, -0) ? 0 : rounded;
    }
    if (name === "math.random") {
      if (this.isStrictProgram()) return this.strictRandom(id, args, name);
      this.randomState = (Math.imul(1_664_525, this.randomState) + 1_013_904_223) >>> 0;
      const unit = this.randomState / 4_294_967_296;
      const minimum = args[0] === undefined ? 0 : number(args[0]);
      const maximum = args[1] === undefined ? 1 : number(args[1]);
      return minimum + unit * (maximum - minimum);
    }
    if (name.startsWith("math.")) return mathCall(name.slice(5), args, this.isStrictProgram());
    if (name.startsWith("array.")) return arrayCall(name.slice(6), args, this.collectionOptions());
    if (name.startsWith("map.")) return mapCall(name.slice(4), args, this.collectionOptions());
    if (name.startsWith("matrix.")) return matrixCall(name.slice(7), args, this.collectionOptions());
    if (name === "syminfo.prefix" || name === "syminfo.ticker") {
      const parts = lumenChartsTickerParts(requiredTickerText(args[0], "symbol"));
      return name === "syminfo.prefix" ? parts.prefix : parts.ticker;
    }
    if (name.startsWith("ticker.")) return tickerCall(name.slice("ticker.".length), args);
    if (name.startsWith("line.")) return this.drawings.lineCall(name.slice(5), args);
    if (name.startsWith("box.")) return this.drawings.boxCall(name.slice(4), args);
    if (name.startsWith("label.")) return this.drawings.labelCall(name.slice(6), args);
    if (name.startsWith("chart.point.")) return this.drawings.chartPointCall(name.slice(12), args);
    if (name.startsWith("polyline.")) return this.drawings.polylineCall(name.slice(9), args);
    if (name.startsWith("linefill.")) return this.drawings.linefillCall(name.slice(9), args);
    if (name.startsWith("table.")) return this.drawings.tableCall(name.slice(6), args);
    if (name.startsWith("timeframe.")) return this.timeframeCall(name.slice(10), args);
    if (name === "time" || name === "time_close") return this.timeCall(name, args);
    if (name === "timestamp") return pineTimestamp(args, this.timezone, this.isStrictProgram());
    if (name === "request.security") return this.sameContextSecurity(args);
    const v5WhenSignature = this.isStrictProgram() && this.program.version === 5
      ? PINE_V5_STRATEGY_CALL_SIGNATURES[name]
      : undefined;
    if (v5WhenSignature?.at(-1) === "when") {
      const condition = args[v5WhenSignature.length - 1];
      if (condition !== undefined && !this.truthy(condition)) return null;
    }
    if (name === "strategy.entry") return this.strategies.queueStrategyOrder("entry", args);
    if (name === "strategy.order") return this.strategies.queueStrategyOrder("order", args);
    if (name === "strategy.exit") return this.strategies.queueStrategyExit(args);
    if (name === "strategy.close") return this.strategies.queueStrategyClose(false, args);
    if (name === "strategy.close_all") return this.strategies.queueStrategyClose(true, args);
    if (name === "strategy.cancel") return this.strategies.cancelStrategyOrders(pineString(args[0] ?? ""));
    if (name === "strategy.cancel_all") return this.strategies.cancelStrategyOrders();
    if (name === "strategy.convert_to_account") return this.strategies.convertStrategyCurrency(args[0], "account");
    if (name === "strategy.convert_to_symbol") return this.strategies.convertStrategyCurrency(args[0], "symbol");
    if (name === "strategy.default_entry_qty") return this.strategies.defaultStrategyEntryQuantity(args[0]);
    if (name.startsWith("strategy.closedtrades.")) return this.strategies.closedStrategyTradeValue(name.slice("strategy.closedtrades.".length), args[0]);
    if (name.startsWith("strategy.opentrades.")) return this.strategies.openStrategyTradeValue(name.slice("strategy.opentrades.".length), args[0]);
    if (name.startsWith("strategy.risk.")) return this.strategies.setStrategyRiskRule(name.slice("strategy.risk.".length), args);
    if (timeComponentNames.has(name)) return this.timeComponent(name, args);
    throw new Error(`Unsupported runtime call ${name}`);
  }

  private validateTaArguments(name: string, args: readonly PineValue[]): void {
    if (name === "ta.pivothigh" || name === "ta.pivotlow") {
      const strengths = args.length === 2 ? args : args.slice(1);
      for (const value of strengths) {
        const numeric = number(value);
        if (!Number.isInteger(numeric) || numeric < 0 || numeric > MAX_TA_HISTORY_ARGUMENT) {
          throw new PineRuntimeError(
            `${name} strength must be an integer from 0 to ${String(MAX_TA_HISTORY_ARGUMENT)}`,
            name,
          );
        }
      }
      return;
    }
    if (name === "ta.sar") {
      const start = number(args[0]);
      const increment = number(args[1]);
      const maximum = number(args[2]);
      if (![start, increment, maximum].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new PineRuntimeError("ta.sar parameters must be finite nonnegative numbers", name);
      }
      if (start > maximum || increment > maximum) {
        throw new PineRuntimeError("ta.sar start and increment must not exceed max", name);
      }
      return;
    }
    if (name === "ta.supertrend") {
      const factor = number(args[0]);
      const period = number(args[1]);
      if ((!Number.isFinite(factor) && !isNa(args[0])) || factor < 0) {
        throw new PineRuntimeError("ta.supertrend factor must be a finite nonnegative number", name);
      }
      if (!Number.isInteger(period) || period < 1 || period > MAX_TA_HISTORY_ARGUMENT) {
        throw new PineRuntimeError(
          `ta.supertrend atrPeriod must be an integer from 1 to ${String(MAX_TA_HISTORY_ARGUMENT)}`,
          name,
        );
      }
      return;
    }
    const lengthIndexes = taLengthArgumentIndexes[name];
    if (lengthIndexes !== undefined) {
      for (const index of lengthIndexes) {
        const implicitLength = ["ta.highest", "ta.lowest", "ta.highestbars", "ta.lowestbars"].includes(name)
          && args.length === 1;
        const value = implicitLength ? args[0] : args[index] ?? (name === "ta.change" ? 1 : undefined);
        const numeric = number(value);
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_TA_HISTORY_ARGUMENT) {
          throw new PineRuntimeError(
            `${name} length must be an integer from 1 to ${String(MAX_TA_HISTORY_ARGUMENT)}`,
            name,
          );
        }
      }
    } else if (name === "ta.valuewhen") {
      const occurrence = number(args[2]);
      if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > MAX_TA_HISTORY_ARGUMENT) {
        throw new PineRuntimeError(
          `${name} occurrence must be an integer from 0 to ${String(MAX_TA_HISTORY_ARGUMENT)}`,
          name,
        );
      }
    } else {
      return;
    }
    if (name === "ta.alma") {
      const offset = number(args[2]);
      const sigma = number(args[3]);
      if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
        throw new PineRuntimeError("ta.alma offset must be a finite number from 0 to 1", name);
      }
      if (!Number.isFinite(sigma) || sigma <= 0) {
        throw new PineRuntimeError("ta.alma sigma must be a finite number greater than 0", name);
      }
      if (args[4] !== undefined && typeof args[4] !== "boolean") {
        throw new PineRuntimeError("ta.alma floor must be a bool", name);
      }
    }
    if (name === "ta.linreg") {
      const offset = number(args[2]);
      if (!Number.isInteger(offset) || Math.abs(offset) > MAX_TA_OFFSET_ARGUMENT) {
        throw new PineRuntimeError(
          `ta.linreg offset must be an integer from -${String(MAX_TA_OFFSET_ARGUMENT)} to ${String(MAX_TA_OFFSET_ARGUMENT)}`,
          name,
        );
      }
    }
    if (name === "ta.bb" || name === "ta.bbw" || name === "ta.kc" || name === "ta.kcw") {
      const multiplier = number(args[2]);
      if (!Number.isFinite(multiplier)) {
        throw new PineRuntimeError(`${name} multiplier must be a finite number`, name);
      }
    }
    if (name === "ta.percentile_linear_interpolation" || name === "ta.percentile_nearest_rank") {
      const percentage = number(args[2]);
      if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        throw new PineRuntimeError(`${name} percentage must be a finite number from 0 to 100`, name);
      }
    }
  }

  private validateMathSumLength(value: PineValue | undefined, name: string): void {
    const length = number(value);
    if (!Number.isInteger(length) || length < 1 || length > MAX_TA_HISTORY_ARGUMENT) {
      throw new PineRuntimeError(
        `${name} length must be an integer from 1 to ${String(MAX_TA_HISTORY_ARGUMENT)}`,
        name,
      );
    }
  }

  private strictRandom(id: StateId, args: readonly PineValue[], name: string): number {
    const minimum = args[0] === undefined ? 0 : number(args[0]);
    const maximum = args[1] === undefined ? 1 : number(args[1]);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
      throw new PineRuntimeError(`${name} bounds must be finite numbers with min not greater than max`, name);
    }
    const explicitSeed = args[2] === undefined ? undefined : number(args[2]);
    if (explicitSeed !== undefined && (!Number.isInteger(explicitSeed) || explicitSeed < 0 || explicitSeed > 0xffff_ffff)) {
      throw new PineRuntimeError(`${name} seed must be an integer from 0 to 4294967295`, name);
    }
    const seed = explicitSeed === undefined ? this.randomSeed >>> 0 : explicitSeed >>> 0;
    let state = this.callState.get(id) as StrictRandomState | undefined;
    if (state === undefined || state.seed !== seed) {
      state = { seed, value: seed };
      this.callState.set(id, state);
    }
    state.value = (Math.imul(1_664_525, state.value) + 1_013_904_223) >>> 0;
    const unit = state.value / 4_294_967_296;
    return minimum + unit * (maximum - minimum);
  }

  public callWithSource(id: StateId, name: string, args: readonly PineValue[], source: SeriesReference): PineValue {
    // The production profile follows the reference platform: a TA call that runs only on
    // some bars sees only those bars' samples, so nothing is replayed. The
    // baseline profile replays the bars this call skipped.
    const previousBar = this.isStrictProgram() ? this.barIndex - 1 : this.lastSourceCallBar.get(id) ?? -1;
    for (let bar = previousBar + 1; bar < this.barIndex; bar += 1) {
      const offset = this.barIndex - bar;
      this.call(id, name, [source.get(offset), ...args.slice(1)]);
    }
    this.lastSourceCallBar.set(id, this.barIndex);
    return this.call(id, name, args);
  }

  public method(id: StateId, receiver: PineValue, name: string, args: readonly PineValue[], receiverType?: "array"): PineValue {
    try { return this.dispatchMethod(receiver, name, args, receiverType); }
    catch (error) { throw this.locateCallError(error, id, name); }
  }

  private locateCallError(error: unknown, id: StateId, name: string): unknown {
    if (!this.isStrictProgram()) return error;
    const callId = typeof id === "number" ? id : Number(id.split(".").at(-1));
    return PineRuntimeError.at(error, this.program.callSites?.[callId], name);
  }

  private dispatchMethod(receiver: PineValue, name: string, args: readonly PineValue[], receiverType?: "array"): PineValue {
    if (isNa(receiver)) {
      return receiverType === "array" && this.isStrictProgram()
        ? arrayCall(name, [receiver, ...args], this.collectionOptions())
        : Number.NaN;
    }
    if (isPineFootprintHandle(receiver)) return this.footprints(`footprint.${name}`).footprintCall(name, [receiver, ...args]);
    if (isPineVolumeRowHandle(receiver)) return this.footprints(`volume_row.${name}`).rowCall(name, [receiver, ...args]);
    if (isPineLine(receiver)) return this.drawings.lineCall(name, [receiver, ...args]);
    if (isPineBox(receiver)) return this.drawings.boxCall(name, [receiver, ...args]);
    if (isPineLabel(receiver)) return this.drawings.labelCall(name, [receiver, ...args]);
    if (isChartPoint(receiver) && name === "copy") return this.drawings.chartPointCall("copy", [receiver]);
    if (isPinePolyline(receiver)) return this.drawings.polylineCall(name, [receiver, ...args]);
    if (isPineLinefill(receiver)) return this.drawings.linefillCall(name, [receiver, ...args]);
    if (isPineTable(receiver)) return this.drawings.tableCall(name, [receiver, ...args]);
    if (isPineMatrix(receiver)) return matrixCall(name, [receiver, ...args], this.collectionOptions());
    if (isPineMap(receiver)) return mapCall(name, [receiver, ...args], this.collectionOptions());
    if (Array.isArray(receiver)) return arrayCall(name, [receiver, ...args], this.collectionOptions());
    if (typeof receiver === "string") return stringCall(name, [receiver, ...args], this.timezone, number(this.symbolInfo.mintick ?? 0.01), this.isStrictProgram());
    if (receiver !== null && typeof receiver === "object" && typeof (receiver as Record<string, PineValue>).__pineType === "string" && name === "copy") {
      return this.copyObject(receiver);
    }
    throw new Error(`Unsupported method ${name}`);
  }

  /** Arguments were admitted before the first bar; the call only selects this bar's data. */
  private currentFootprint(): PineValue {
    const bar = this.bars[this.barIndex];
    if (bar === undefined || this.footprintStore === undefined) return Number.NaN;
    return this.footprintStore.select(bar.openTime) ?? Number.NaN;
  }

  /** Without a store (`ticks_per_row` is `na`/0) no handle can be valid. */
  private footprints(operation: string): FootprintRuntimeStore {
    return this.footprintStore ?? invalidFootprintHandle(operation);
  }

  public property(receiver: PineValue, name: string): PineValue {
    if (receiver === null || typeof receiver !== "object" || Array.isArray(receiver)) return Number.NaN;
    const record = receiver as Readonly<Record<string, PineValue>>;
    return Object.hasOwn(record, name) ? record[name] ?? null : Number.NaN;
  }

  public objectField(id: StateId, receiver: PineValue, type: string, field: string): PineValue {
    if (isNa(receiver)) {
      const member = `${type}.${field}`;
      const error = new PineRuntimeError(`Cannot access the '${member}' field of an undefined object. The object is 'na'.`, member);
      throw this.locateCallError(error, id, member);
    }
    return this.property(receiver, field);
  }

  public object(type: string, fields: Readonly<Record<string, PineValue>>): PineValue {
    return { __pineType: type, ...fields };
  }

  public objectType(receiver: PineValue): string {
    if (receiver === null || typeof receiver !== "object" || Array.isArray(receiver)) return "";
    const type = (receiver as Record<string, PineValue>).__pineType;
    return typeof type === "string" ? type : "";
  }

  public copyObject(receiver: PineValue, expectedType?: string, firstField?: { readonly id: StateId; readonly name: string }): PineValue {
    if (firstField !== undefined && expectedType !== undefined && isNa(receiver)) {
      this.objectField(firstField.id, receiver, expectedType, firstField.name);
    }
    if (receiver === null || typeof receiver !== "object" || Array.isArray(receiver)) return Number.NaN;
    const record = receiver as Record<string, PineValue>;
    if (typeof record.__pineType !== "string" || (expectedType !== undefined && record.__pineType !== expectedType)) return Number.NaN;
    return { ...record };
  }

  public setProperty(receiver: PineValue, name: string, value: PineValue): PineValue {
    if (receiver === null || typeof receiver !== "object" || Array.isArray(receiver)) return Number.NaN;
    const record = receiver as Record<string, PineValue>;
    const chartPointField = isChartPoint(receiver) && ["time", "index", "price"].includes(name);
    const userTypeField = typeof record.__pineType === "string" && Object.hasOwn(record, name);
    if (!chartPointField && !userTypeField) return Number.NaN;
    (receiver as Record<string, PineValue>)[name] = value;
    return value;
  }

  public updateProperty(receiver: PineValue, name: string, operator: string, value: PineValue): PineValue {
    return this.setProperty(receiver, name, this.binary(operator, this.property(receiver, name), value));
  }

  public result(variableNames: readonly string[], elapsedMs: number, processedBars = this.bars.length, selectedVariables?: ReadonlySet<string>): ExecutionResult {
    const returned: Record<string, readonly PineValue[]> = {};
    for (const [id, name] of variableNames.entries()) {
      if (selectedVariables === undefined || selectedVariables.has(name)) returned[name] = Object.freeze([...(this.variables[id] ?? [])]);
    }
    const plots: PlotResult[] = [...this.plots.values()].map((plot) => Object.freeze({ id: plot.id, title: plot.title, options: plot.options, points: Object.freeze([...plot.points]) }));
    const drawings: Drawing[] = this.drawings.lines.filter((line) => !line.deleted).map((line) => Object.freeze({
      kind: "line", id: line.id, ...(this.isStrictProgram() ? { order: line.order } : {}), x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2, xloc: line.xloc,
      extend: line.extend, color: line.color, style: line.style, width: line.width, forceOverlay: line.forceOverlay,
    }));
    drawings.push(...this.drawings.boxes.filter((box) => !box.deleted).map((box) => Object.freeze({
      kind: "box" as const, id: box.id, left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      xloc: box.xloc, extend: box.extend, borderColor: box.borderColor, borderStyle: box.borderStyle,
      borderWidth: box.borderWidth, backgroundColor: box.backgroundColor, text: box.text, textColor: box.textColor,
      textSize: box.textSize, textHorizontalAlign: box.textHorizontalAlign, textVerticalAlign: box.textVerticalAlign,
      textWrap: box.textWrap, textFontFamily: box.textFontFamily, textFormatting: box.textFormatting, forceOverlay: box.forceOverlay,
    })));
    drawings.push(...this.drawings.labels.filter((label) => !label.deleted).map((label) => Object.freeze({
      kind: "label" as const, id: label.id, x: label.x, y: label.y, text: label.text, xloc: label.xloc, yloc: label.yloc,
      color: label.color, style: label.style, textColor: label.textColor, size: label.size, textAlign: label.textAlign,
      tooltip: label.tooltip, textFontFamily: label.textFontFamily, forceOverlay: label.forceOverlay,
      textFormatting: label.textFormatting,
    })));
    drawings.push(...this.drawings.linefills.filter((linefill) => !linefill.deleted
      && (!this.isStrictProgram() || (!linefill.line1.deleted && !linefill.line2.deleted))).map((linefill) => Object.freeze({
      kind: "linefill" as const, id: linefill.id, line1Id: linefill.line1.id, line2Id: linefill.line2.id,
      color: linefill.color, forceOverlay: linefill.line1.forceOverlay || linefill.line2.forceOverlay,
    })));
    drawings.push(...this.drawings.polylines.filter((polyline) => !polyline.deleted
      && (!this.isStrictProgram() || polyline.points.length >= 2)).map((polyline) => Object.freeze({
      kind: "polyline" as const, id: polyline.id, ...(this.isStrictProgram() ? { order: polyline.order } : {}), points: Object.freeze(polyline.points.map((point) => Object.freeze({
        ...(typeof point.time === "number" ? { time: point.time } : {}),
        ...(typeof point.index === "number" ? { index: point.index } : {}),
        price: point.price,
      }))), curved: polyline.curved, closed: polyline.closed, xloc: polyline.xloc, lineColor: polyline.lineColor,
      fillColor: polyline.fillColor, lineStyle: polyline.lineStyle, lineWidth: polyline.lineWidth, forceOverlay: polyline.forceOverlay,
    })));
    const activeTables = this.drawings.tables.filter((table) => !table.deleted);
    const newestTableByPosition = new Map<string, MutablePineTable>();
    for (const table of activeTables) newestTableByPosition.set(table.position, table);
    const visibleTables = this.isStrictProgram()
      ? activeTables.filter((table) => newestTableByPosition.get(table.position) === table)
      : activeTables;
    const tables: TableSnapshot[] = visibleTables.map((table) => Object.freeze({
      id: table.id, position: table.position, columns: table.columns, rows: table.rows, backgroundColor: table.backgroundColor,
      frameColor: table.frameColor, frameWidth: table.frameWidth, borderColor: table.borderColor, borderWidth: table.borderWidth,
      forceOverlay: table.forceOverlay, cells: Object.freeze(table.cells.map((row) => Object.freeze(row.map((cell) => cell === null ? null : Object.freeze({ ...cell }))))),
      merges: Object.freeze(table.merges.map((merge) => Object.freeze({ ...merge }))),
    }));
    return Object.freeze({
      times: Object.freeze(this.bars.map((bar) => bar.openTime)),
      descriptor: this.program.descriptor,
      plots: Object.freeze(plots),
      drawings: Object.freeze(drawings),
      tables: Object.freeze(tables),
      alerts: Object.freeze([...this.alerts]),
      ...(this.strategies.strategy === undefined ? {} : { strategy: this.strategies.strategyResult() }),
      returned: Object.freeze(returned),
      diagnostics: Object.freeze([]),
      stats: Object.freeze({ bars: this.bars.length, processedBars, elapsedMs }),
    });
  }

  private timeframeCall(name: string, args: readonly PineValue[]): PineValue {
    if (name === "in_seconds") {
      const supplied = pineString(args[0] ?? "");
      const requested = supplied.length === 0 ? this.timeframe : supplied;
      return timeframeSeconds(this.isStrictProgram() ? requested : legacyNormalizeTimeframe(requested));
    }
    if (name === "from_seconds") return timeframeFromSeconds(number(args[0]), this.isStrictProgram());
    if (name === "change") {
      if (this.barIndex <= 0) return false;
      const requested = pineString(args[0] ?? "");
      if (requested.length === 0) return false;
      const current = number(this.data("time"));
      const previous = number(this.data("time", 1));
      if (!this.isStrictProgram()) {
        return legacyTimeframeBoundary(current, requested) !== legacyTimeframeBoundary(previous, requested);
      }
      return alignToTimeframe(current, requested, this.timezone) !== alignToTimeframe(previous, requested, this.timezone);
    }
    throw new Error(`Unsupported timeframe call timeframe.${name}`);
  }

  private timeCall(name: "time" | "time_close", args: readonly PineValue[]): PineValue {
    if (this.isStrictProgram()) return this.strictTimeCall(name, args);
    const requested = pineString(args[0] ?? "");
    let session: string | undefined;
    let timezone = this.timezone;
    let barsBack = 0;
    let timeframeBarsBack = 0;
    if (this.isStrictProgram()) {
      if (typeof args[1] === "string") session = args[1];
      if (typeof args[2] === "string") {
        timezone = args[2];
        barsBack = Math.trunc(number(args[3] ?? 0));
        timeframeBarsBack = Math.trunc(number(args[4] ?? 0));
      } else {
        barsBack = Math.trunc(number(args[2] ?? 0));
        timeframeBarsBack = Math.trunc(number(args[3] ?? 0));
      }
    } else if (typeof args[1] === "number") barsBack = integer(args[1]);
    else if (typeof args[1] === "string") {
      session = args[1];
      if (typeof args[2] === "number") barsBack = integer(args[2]);
      else if (typeof args[2] === "string") {
        timezone = args[2];
        barsBack = integer(args[3] ?? 0);
      }
    }
    if (this.isStrictProgram() && typeof args[2] === "string" && !isValidTimezone(timezone)) {
      throw new PineRuntimeError(`Invalid timezone: "${timezone}"`, name);
    }
    const timestamp = number(this.data(name, barsBack));
    if (Number.isNaN(timestamp)) return Number.NaN;
    const strictCompatibility = this.isStrictProgram();
    const sameTimeframe = requested.length === 0 || (strictCompatibility ? normalizeTimeframe(requested) : legacyNormalizeTimeframe(requested))
      === (strictCompatibility ? normalizeTimeframe(this.timeframe) : legacyNormalizeTimeframe(this.timeframe));
    const boundaryTimezone = strictCompatibility ? timezone : "UTC";
    const boundaryTimestamp = strictCompatibility && name === "time_close" && (!sameTimeframe || timeframeBarsBack !== 0)
      ? number(this.data("time", barsBack))
      : timestamp;
    if (Number.isNaN(boundaryTimestamp)) return Number.NaN;
    const alignedOpen = sameTimeframe
      ? boundaryTimestamp
      : strictCompatibility
        ? alignToTimeframe(boundaryTimestamp, requested, boundaryTimezone)
        : legacyTimeframeBoundary(boundaryTimestamp, requested);
    if (session !== undefined && session.length > 0) {
      if (!strictCompatibility) {
        if (!isInSession(alignedOpen, session, timezone)) return Number.NaN;
      } else {
        const parsed = parseSessionSpec(session);
        if (!parsed.ok) throw new PineRuntimeError(`Invalid session specification: "${session}"`, "time");
        if (!isInSessionSpec(alignedOpen, parsed.value, timezone)) return Number.NaN;
      }
    }
    const offsetOpen = strictCompatibility && timeframeBarsBack !== 0
      ? offsetTimeframe(alignedOpen, requested.length === 0 ? this.timeframe : requested, timeframeBarsBack, boundaryTimezone)
      : alignedOpen;
    if (name !== "time_close" || !strictCompatibility) return offsetOpen;
    if (sameTimeframe && timeframeBarsBack === 0) return timestamp;
    return timeframeEnd(offsetOpen, requested.length === 0 ? this.timeframe : requested, boundaryTimezone);
  }

  private strictTimeCall(name: "time" | "time_close", args: readonly PineValue[]): PineValue {
    const requested = args[0];
    if (typeof requested !== "string") throw new PineRuntimeError("Timeframe must be a string", name);
    const timeframe = requested.length === 0 ? this.timeframe : requested;
    const normalized = normalizeTimeframe(timeframe);
    const timeBasedFrame = /^(?:[1-9]\d*|[1-9]\d*[SDWM]|[DWM])$/u.test(normalized)
      && timeframeSeconds(normalized) > 0;
    if (!timeBasedFrame && !/^\d+T$/u.test(normalized)) {
      throw new PineRuntimeError(`Invalid timeframe: "${timeframe}"`, name);
    }
    const session = args[1];
    if (session !== undefined && typeof session !== "string") {
      throw new PineRuntimeError("Session must be a string", name);
    }
    const hasTimezone = typeof args[2] === "string";
    const timezone = hasTimezone ? args[2] as string : this.timezone;
    if (!isValidTimezone(timezone)) throw new PineRuntimeError(`Invalid timezone: "${timezone}"`, name);
    const barsBackValue = args[hasTimezone ? 3 : 2] ?? 0;
    const frameBarsBackValue = args[hasTimezone ? 4 : 3] ?? 0;
    const checkedOffset = (value: PineValue, parameter: string): number => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < -500 || value > 5_000) {
        throw new PineRuntimeError(`${parameter} must be an integer from -500 to 5000`, name);
      }
      return value;
    };
    const barsBack = checkedOffset(barsBackValue, "bars_back");
    const timeframeBarsBack = checkedOffset(frameBarsBackValue, "timeframe_bars_back");
    const nonTimeBased = !timeBasedFrame || !/^(?:[1-9]\d*|[1-9]\d*[SDWM]|[DWM])$/u.test(normalizeTimeframe(this.timeframe))
      || !["standard", "heikinashi"].includes(this.chartType);
    if (nonTimeBased && (barsBack < 0 || timeframeBarsBack < 0)) return Number.NaN;

    const chartOpen = barsBack < 0
      ? offsetTimeframe(number(this.data("time")), this.timeframe, barsBack, this.timezone)
      : number(this.data("time", barsBack));
    if (!Number.isFinite(chartOpen)) return Number.NaN;
    const sameTimeframe = normalized === normalizeTimeframe(this.timeframe);
    if (session !== undefined && session.length > 0) {
      const parsed = parseSessionSpec(session);
      if (!parsed.ok) throw new PineRuntimeError(`Invalid session specification: "${session}"`, name);
      if (nonTimeBased) return Number.NaN;
      const chartClose = barsBack < 0
        ? timeframeEnd(chartOpen, this.timeframe, this.timezone)
        : number(this.data("time_close", barsBack));
      if (!Number.isFinite(chartClose)) return Number.NaN;
      let selected;
      if (/^(?:[1-9]\d*)?[DWM]$/u.test(normalized)) {
        selected = calendarSessionBarAt(chartOpen, chartClose, normalized, timeframeBarsBack, parsed.value, timezone, name);
      } else {
        // A same-frame session requires the chart bar to open inside its window.
        const currentBar = sessionBarAt(chartOpen, chartClose, normalized, parsed.value, timezone, !sameTimeframe);
        selected = currentBar === undefined ? undefined
          : offsetSessionBar(currentBar, normalized, timeframeBarsBack, parsed.value, timezone);
      }
      if (selected === undefined) return Number.NaN;
      return name === "time" ? selected.open : selected.close;
    }
    const frameOpen = sameTimeframe ? chartOpen : alignToTimeframe(chartOpen, normalized, timezone);
    const selectedOpen = timeframeBarsBack === 0 ? frameOpen
      : offsetTimeframe(frameOpen, normalized, timeframeBarsBack, timezone);
    if (name === "time") return selectedOpen;
    if (sameTimeframe && timeframeBarsBack === 0 && barsBack >= 0) {
      const close = number(this.data("time_close", barsBack));
      if (!Number.isFinite(close)) return Number.NaN;
      if (nonTimeBased && barsBack === 0 && this.barIndex === this.bars.length - 1
        && !this.isCurrentBarConfirmed()) return Number.NaN;
      return close;
    }
    if (nonTimeBased) return Number.NaN;
    return timeframeEnd(selectedOpen, normalized, timezone);
  }

  /** Session values are derived on demand, including historical bars skipped by a branch. */
  public sessionHistory(name: string, offset: number): PineValue {
    this.tick();
    if (offset > this.barIndex) return Number.NaN;
    if (name === "time_tradingday") return this.tradingDayAt(offset);
    return this.sessionValue(name, offset);
  }

  private tradingDayAt(offset: number): PineValue {
    const openTime = number(this.data("time", offset));
    const closeTime = number(this.data("time_close", offset));
    if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) return Number.NaN;
    const matcher = this.requireSessionMatcher("activeSession", "time_tradingday");
    const tradingDay = correctedSessionTradingDayKey(openTime, matcher.spec, matcher.corrections,
      this.sessionSchedule.timezone ?? this.timezone);
    return tradingDay === undefined ? Number.NaN : Date.parse(`${tradingDay}T00:00:00Z`);
  }

  private sessionValue(name: string, offset = 0): PineValue {
    if (name === "session.regular") return "regular";
    if (name === "session.extended") return "extended";
    if (name === "session.ismarket") return this.matchesSession("regularSession", name, offset);
    if (name === "session.ispremarket") return this.matchesOptionalSession("premarketSession", name, offset);
    if (name === "session.ispostmarket") return this.matchesOptionalSession("postmarketSession", name, offset);
    if (name === "session.isfirstbar") return this.isSessionBoundary("activeSession", name, offset, -1);
    if (name === "session.islastbar") return this.isSessionBoundary("activeSession", name, offset, 1);
    if (name === "session.isfirstbar_regular") return this.isSessionBoundary("regularSession", name, offset, -1);
    if (name === "session.islastbar_regular") return this.isSessionBoundary("regularSession", name, offset, 1);
    return false;
  }

  private matchesSession(sessionKey: SessionScheduleField, method: string, offset: number): boolean {
    const matcher = this.requireSessionMatcher(sessionKey, method);
    const timestamp = number(this.data("time", offset));
    return !Number.isNaN(timestamp) && correctedSessionTradingDayKey(
      timestamp,
      matcher.spec,
      matcher.corrections,
      this.sessionSchedule.timezone ?? this.timezone,
    ) !== undefined;
  }

  private matchesOptionalSession(sessionKey: "premarketSession" | "postmarketSession", method: string, offset: number): boolean {
    const session = this.sessionSchedule[sessionKey];
    if (session === undefined || session.length === 0) {
      if (this.sessionSchedule.activeSubsessionId === "extended") {
        throw new PineRuntimeError(`Cannot evaluate ${method} without explicit extended-session metadata`, method);
      }
      return false;
    }
    return this.matchesSession(sessionKey, method, offset);
  }

  private isSessionBoundary(sessionKey: "activeSession" | "regularSession", method: string, offset: number, direction: -1 | 1): boolean {
    const matcher = this.requireSessionMatcher(sessionKey, method);
    const timezone = this.sessionSchedule.timezone ?? this.timezone;
    const index = this.barIndex - offset;
    const current = this.bars[index];
    if (current === undefined) return false;
    const currentKey = correctedSessionTradingDayKey(current.openTime, matcher.spec, matcher.corrections, timezone);
    if (currentKey === undefined) return false;
    const adjacent = this.bars[index + direction];
    if (adjacent === undefined) return true;
    return correctedSessionTradingDayKey(adjacent.openTime, matcher.spec, matcher.corrections, timezone) !== currentKey;
  }

  private requireSessionMatcher(sessionKey: SessionScheduleField, method: string): Extract<RuntimeSessionMatcher, { readonly ok: true }> {
    const session = this.sessionSchedule[sessionKey];
    if (session === undefined || session.length === 0) {
      throw new PineRuntimeError(`Cannot evaluate ${method} without an active session schedule`, method);
    }
    const matcher = this.sessionMatchers[sessionKey];
    if (matcher === undefined) throw new PineRuntimeError(`Cannot evaluate ${method} without an active session schedule`, method);
    if (!matcher.ok) {
      const message = matcher.source === "session"
        ? `Invalid host session specification: "${session}"`
        : `Invalid host session correction: ${matcher.reason}`;
      throw new PineRuntimeError(message, method);
    }
    return matcher;
  }

  private timeComponent(name: string, args: readonly PineValue[]): PineValue {
    const timestamp = args[0] === undefined ? number(this.data("time")) : number(args[0]);
    const explicitTimezone = typeof args[1] === "string" ? args[1] : undefined;
    return calendarComponent(
      name as CalendarComponentName,
      timestamp,
      explicitTimezone ?? this.timezone,
      this.isStrictProgram(),
    );
  }

  private sameContextSecurity(args: readonly PineValue[]): PineValue {
    const requestedSymbol = pineString(args[0] ?? "");
    const requestedTimeframe = pineString(args[1] ?? "");
    const ticker = typeof this.symbolInfo.ticker === "string" ? this.symbolInfo.ticker : "";
    const tickerId = typeof this.symbolInfo.tickerid === "string" ? this.symbolInfo.tickerid : ticker;
    const unprefixed = requestedSymbol.includes(":") ? requestedSymbol.slice(requestedSymbol.indexOf(":") + 1) : requestedSymbol;
    const sameSymbol = requestedSymbol.length === 0 || requestedSymbol === tickerId || unprefixed === ticker;
    const sameTimeframe = requestedTimeframe.length === 0 || normalizeTimeframe(requestedTimeframe) === normalizeTimeframe(this.timeframe);
    if (!sameSymbol || !sameTimeframe) throw new Error(`request.security requires host child data for ${requestedSymbol || tickerId}@${requestedTimeframe || this.timeframe}`);
    const value = args[2] ?? Number.NaN;
    return Array.isArray(value) ? [value as readonly PineValue[]] : value;
  }

  private barCloseTime(index: number): number {
    const bar = this.bars[index];
    return bar?.closeTime ?? bar?.openTime ?? Number.POSITIVE_INFINITY;
  }

  private isStrictProgram(): boolean {
    return isStrictPineCompatibility(this.program.compatibility);
  }

  private isBarConfirmed(index: number): boolean {
    return this.barCloseTime(index) <= this.operationNow();
  }

  private operationNow(): number {
    if (!this.isStrictProgram()) return this.now();
    if (Number.isNaN(this.evaluationNow)) this.evaluationNow = this.now();
    return this.evaluationNow;
  }

  private isCurrentBarConfirmed(): boolean {
    return this.isBarConfirmed(this.barIndex);
  }

  private isRealtimeUpdate(index: number): boolean {
    return this.realtimeUpdateOpenTime !== undefined && this.bars[index]?.openTime === this.realtimeUpdateOpenTime;
  }

  private isCurrentRealtimeEvaluation(): boolean {
    if (this.syntheticHistoricalFillEvent?.barIndex === this.barIndex) return false;
    return this.isCurrentBarRealtime() || this.isRealtimeUpdate(this.barIndex);
  }

  private isCurrentBarRealtime(): boolean {
    if (this.syntheticHistoricalFillEvent?.barIndex === this.barIndex) return false;
    return this.barIndex === this.bars.length - 1 && !this.isCurrentBarConfirmed();
  }

  private missingHistoryValue(current: PineValue | undefined): PineValue {
    // Generic function bodies share syntax but have independent argument types
    // at each callsite; their missing value cannot rely on one static AST type.
    return this.isStrictProgram() && this.program.version === 6 && typeof current === "boolean" ? false : Number.NaN;
  }

  private collectionOptions() {
    return {
      strict: this.isStrictProgram(),
      negativeIndices: this.isStrictProgram() && this.program.version === 6,
    } as const;
  }

  private tick(): void {
    this.operations += 1;
    if (this.operations > this.maxOperationsPerBar) {
      const message = `Operation budget exceeded at bar ${this.barIndex}`;
      if (this.isStrictProgram()) throw new PineRuntimeError(message, undefined, undefined, "SCRIPT_LOOP_LIMIT");
      throw new Error(message);
    }
  }

}


export function createExecutor(program: CompiledProgram): BarExecutor {
  const factory = new Function(program.generatedSource) as () => BarExecutor;
  return factory();
}

export function createRuntime(program: CompiledProgram, options: SessionOptions, requestAccountCurrency?: string): RuntimeContext {
  if (
    isStrictPineCompatibility(program.compatibility) &&
    program.descriptor.kind === "strategy" &&
    program.descriptor.strategy?.calc_on_order_fills === true
  ) {
    throw new Error("strategy() calc_on_order_fills is unsupported because Lumen Script does not recalculate after fills");
  }
  return createRuntimeContext(program, options, false, requestAccountCurrency);
}

/** Internal owner for the explicitly compiled Lumen Charts historical fill schedule. */
export function createSyntheticHistoricalFillRuntime(
  program: CompiledProgram, options: SessionOptions,
): RuntimeContext {
  if (program.historicalFillSchedule !== "lumencharts-v1"
    || program.descriptor.kind !== "strategy"
    || program.descriptor.strategy?.calc_on_order_fills !== true) {
    throw new Error("Program is not admitted for the Lumen Charts historical fill schedule");
  }
  if (options.fxRateBook !== undefined) throw new Error("The Lumen Charts historical fill schedule does not admit supplied FX data");
  return createRuntimeContext(program, options, true);
}

function createRuntimeContext(
  program: CompiledProgram, options: SessionOptions, allowSyntheticHistoricalFillSchedule: boolean,
  requestAccountCurrency?: string,
): RuntimeContext {
  const fxContext = admitStrategyFxContext(program.descriptor.kind === "strategy" ? program.descriptor.strategy : undefined,
    options, isStrictPineCompatibility(program.compatibility), requestAccountCurrency);
  return new RuntimeContext(
    program.variableNames.length,
    options.inputs ?? {},
    options.sourceSeries ?? {},
    options.limits?.maxOperationsPerBar ?? 500_000,
    options.limits?.maxTableCells ?? (isStrictPineCompatibility(program.compatibility) ? 2_000 : Number.POSITIVE_INFINITY),
    program,
    options.timeframe ?? "",
    options.mainTimeframe ?? options.timeframe ?? "",
    options.timezone ?? (typeof options.symbolInfo?.timezone === "string" ? options.symbolInfo.timezone : "UTC"),
    options.symbolInfo ?? {},
    options.randomSeed ?? 0x6d2b79f5,
    options.alertMode ?? "realtime",
    options.chartType ?? "standard",
    options.chartColors ?? { background: "#1e293b", foreground: "#d1d4dc" },
    options.visibleRange,
    options.now ?? Date.now,
    resolveSessionSchedule(options),
    options.intrabarBars,
    options.intrabarPoints,
    allowSyntheticHistoricalFillSchedule,
    fxContext,
    requestAccountCurrency,
  );
}

export function resolveSessionSchedule(options: Pick<SessionOptions, "sessionSchedule" | "symbolInfo" | "timezone">): PineSessionSchedule {
  if (options.sessionSchedule !== undefined) {
    const schedule = options.sessionSchedule;
    const activeSubsessionId = optionalScheduleText(schedule.activeSubsessionId, "activeSubsessionId");
    const timezone = requiredScheduleText(schedule.timezone ?? options.timezone ?? options.symbolInfo?.timezone ?? "UTC", "timezone");
    return Object.freeze({
      activeSession: normalizeProviderSession(requiredScheduleText(schedule.activeSession, "activeSession")),
      ...(activeSubsessionId === undefined ? {} : { activeSubsessionId }),
      regularSession: normalizeProviderSession(requiredScheduleText(schedule.regularSession, "regularSession")),
      ...(schedule.extendedSession === undefined ? {} : { extendedSession: normalizeProviderSession(requiredScheduleText(schedule.extendedSession, "extendedSession")) }),
      ...(schedule.premarketSession === undefined ? {} : { premarketSession: normalizeProviderSession(requiredScheduleText(schedule.premarketSession, "premarketSession")) }),
      ...(schedule.postmarketSession === undefined ? {} : { postmarketSession: normalizeProviderSession(requiredScheduleText(schedule.postmarketSession, "postmarketSession")) }),
      ...(schedule.corrections === undefined ? {} : { corrections: freezeSessionCorrections(schedule.corrections) }),
      timezone,
    });
  }
  const symbolInfo = options.symbolInfo;
  const regularSession = normalizeProviderSession(symbolInfo?.session ?? "24x7");
  const activeSubsessionId = symbolInfo?.subsession_id;
  const activeSession = activeSubsessionId === "extended"
    ? ""
    : regularSession;
  return Object.freeze({
    activeSession,
    ...(activeSubsessionId === undefined ? {} : { activeSubsessionId }),
    regularSession,
    timezone: options.timezone ?? symbolInfo?.timezone ?? "UTC",
  });
}

function compileRuntimeSessionMatchers(schedule: PineSessionSchedule): RuntimeSessionMatchers {
  const keys = ["activeSession", "regularSession", "extendedSession", "premarketSession", "postmarketSession"] as const;
  const matchers: Partial<Record<SessionScheduleField, RuntimeSessionMatcher>> = {};
  for (const key of keys) {
    const session = schedule[key];
    if (session === undefined || session.length === 0) continue;
    const parsed = parseSessionSpec(normalizeProviderSession(session));
    if (!parsed.ok) {
      matchers[key] = Object.freeze({ ok: false, reason: parsed.reason, source: "session" });
      continue;
    }
    const corrections = compileSessionCorrections(schedule.corrections?.[key]);
    matchers[key] = corrections.ok
      ? Object.freeze({ ok: true, spec: parsed.value, corrections: corrections.value })
      : Object.freeze({ ok: false, reason: corrections.reason, source: "correction" });
  }
  return Object.freeze(matchers);
}

function freezeSessionCorrections(corrections: NonNullable<PineSessionSchedule["corrections"]>): NonNullable<PineSessionSchedule["corrections"]> {
  const keys = ["activeSession", "regularSession", "extendedSession", "premarketSession", "postmarketSession"] as const;
  return Object.freeze(Object.fromEntries(keys.flatMap((key) => {
    const entries = corrections[key];
    if (entries === undefined) return [];
    if (!Array.isArray(entries)) throw new Error(`Invalid session corrections '${key}': expected an array`);
    const normalized = entries.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Invalid session correction '${key}.${String(index)}': expected an object`);
      }
      const record = entry as Readonly<Record<string, unknown>>;
      return Object.freeze({
        session: requiredScheduleText(record.session, `${key}.${String(index)}.session`),
        tradingDay: requiredScheduleText(record.tradingDay, `${key}.${String(index)}.tradingDay`),
      });
    });
    return [[key, Object.freeze(normalized)]];
  })) as NonNullable<PineSessionSchedule["corrections"]>);
}

function requiredScheduleText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid session schedule '${field}': expected a string`);
  return value;
}

function optionalScheduleText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requiredScheduleText(value, field);
}

function normalizeProviderSession(session: string): string {
  const normalized = session.trim().toLowerCase();
  if (normalized === "24x7") return "24x7";
  if (normalized === "24x5") return "0000-0000:23456";
  return session.trim();
}

export { PineRuntimeError } from "./pine-runtime-error.js";
export { pineRound } from "./scalar-builtins.js";

export { alignToTimeframe, compileSessionCorrections, correctedSessionTradingDayKey, isInSession, parseSessionSpec, timeframeEnd } from "./time.js";

function tickerCall(name: string, args: readonly PineValue[]): string {
  if (name === "standard") return lumenChartsTickerBaseSymbol(requiredTickerText(args[0], "symbol"));
  if (name === "new") {
    const prefix = requiredTickerText(args[0], "prefix");
    const ticker = requiredTickerText(args[1], "ticker");
    const symbol = prefix.length === 0 ? ticker : ticker.length === 0 ? prefix : `${prefix}:${ticker}`;
    return encodeLumenChartsTickerIdentity(withTickerModifiers({ version: 1, symbol }, args, 2));
  }
  if (name === "modify") {
    const input = requiredTickerText(args[0], "tickerid");
    const identity = decodeLumenChartsTickerIdentity(input) ?? { version: 1, symbol: lumenChartsTickerBaseSymbol(input) };
    return encodeLumenChartsTickerIdentity(withTickerModifiers(identity, args, 1));
  }
  if (name === "inherit") {
    const source = requiredTickerText(args[0], "from_tickerid");
    const target = requiredTickerText(args[1], "symbol");
    const inherited = decodeLumenChartsTickerIdentity(source);
    if (inherited === undefined) return lumenChartsTickerBaseSymbol(target);
    return encodeLumenChartsTickerIdentity({ ...inherited, symbol: lumenChartsTickerBaseSymbol(target) });
  }
  const symbol = requiredTickerText(args[0], "symbol");
  if (name === "heikinashi") return withTickerTransform(symbol, { kind: "heikinashi" });
  if (name === "kagi") return withTickerTransform(symbol, {
    kind: "kagi",
    reversal: normalizeLumenChartsTickerNumber(args[1], "Kagi reversal"),
  });
  if (name === "linebreak") return withTickerTransform(symbol, {
    kind: "linebreak",
    lines: normalizeLumenChartsTickerNumber(args[1], "Line Break lines", true, 1_000),
  });
  if (name === "renko") {
    const style = normalizeLumenChartsTickerStyle(args[1]);
    return withTickerTransform(symbol, {
      kind: "renko",
      style,
      param: normalizeLumenChartsTickerNumber(args[2], "Renko param", style === "atr", style === "atr" ? 10_000 : 1_000_000),
      requestWicks: args[3] === undefined ? false : Boolean(args[3]),
      source: normalizeLumenChartsTickerSource(args[4] ?? "Close", "renko") as "close" | "ohlc",
    });
  }
  if (name === "pointfigure") {
    const style = normalizeLumenChartsTickerStyle(args[2]);
    return withTickerTransform(symbol, {
      kind: "pointfigure",
      source: normalizeLumenChartsTickerSource(args[1], "pointfigure") as "close" | "hl",
      style,
      param: normalizeLumenChartsTickerNumber(args[3], "Point & Figure param", style === "atr", style === "atr" ? 10_000 : 1_000_000),
      reversal: normalizeLumenChartsTickerNumber(args[4], "Point & Figure reversal", true, 1_000),
    });
  }
  throw new Error(`Unsupported ticker call ticker.${name}`);
}

function withTickerModifiers(identity: LumenChartsTickerIdentityV1, args: readonly PineValue[], offset: number): LumenChartsTickerIdentityV1 {
  return {
    ...identity,
    ...(args[offset] === undefined ? {} : { session: requiredTickerText(args[offset], "session") }),
    ...(args[offset + 1] === undefined ? {} : { adjustment: tickerEnum(args[offset + 1], ["none", "splits", "dividends"], "adjustment") }),
    ...(args[offset + 2] === undefined ? {} : { backadjustment: tickerEnum(args[offset + 2], ["inherit", "off", "on"], "backadjustment") }),
    ...(args[offset + 3] === undefined ? {} : { settlementAsClose: tickerEnum(args[offset + 3], ["inherit", "off", "on"], "settlement_as_close") }),
  };
}

function withTickerTransform(symbol: string, transform: LumenChartsTickerTransform): string {
  const decoded = decodeLumenChartsTickerIdentity(symbol);
  const identity = decoded ?? { version: 1, symbol: lumenChartsTickerBaseSymbol(symbol) };
  if (identity.transform !== undefined && identity.transform.kind !== transform.kind) {
    throw new Error(`Nested synthetic ticker transforms are unsupported (${identity.transform.kind} -> ${transform.kind})`);
  }
  return encodeLumenChartsTickerIdentity({ ...identity, transform });
}

function requiredTickerText(value: PineValue | undefined, field: string): string {
  if (typeof value !== "string") throw new Error(`Ticker ${field} must be a string`);
  return value;
}

function tickerEnum<const T extends string>(value: PineValue | undefined, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value.toLowerCase() as T)) throw new Error(`Invalid ticker ${field}`);
  return value.toLowerCase() as T;
}

function legacyTimeframeBoundary(timestamp: number, timeframe: string): number {
  const normalized = legacyNormalizeTimeframe(timeframe);
  if (normalized === "M") {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  if (normalized === "W") {
    const date = new Date(timestamp);
    const daysToMonday = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysToMonday);
  }
  const seconds = timeframeSeconds(normalized);
  const duration = seconds * 1000;
  const dayStart = Math.floor(timestamp / 86_400_000) * 86_400_000;
  if (normalized === "D" || seconds >= 86_400) return dayStart;
  return duration <= 0 ? timestamp : dayStart + Math.floor((timestamp - dayStart) / duration) * duration;
}

function legacyNormalizeTimeframe(value: string): string {
  if (/^\d+$/.test(value)) return value;
  const direct: Readonly<Record<string, string>> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "45m": "45",
    "1h": "60", "2h": "120", "3h": "180", "4h": "240", "1d": "D", "1w": "W", "1M": "M",
  };
  if (direct[value] !== undefined) return direct[value];
  const mapped = direct[value.toLowerCase()];
  if (mapped !== undefined) return mapped;
  const normalized = value.trim().toUpperCase();
  return normalized === "1D" || normalized === "1W" || normalized === "1M" ? normalized.slice(1) : normalized;
}

export {
  deserializeRuntimeSnapshot,
  serializeRuntimeSnapshot,
  type RuntimeSnapshot,
  type RuntimeTailSnapshot,
} from "./runtime-snapshot.js";

export { cloneRuntimeGraph } from "./runtime-value-graph.js";
export { validatePublicExitSnapshot, validateStrategyFxSnapshot } from "./strategy.js";
