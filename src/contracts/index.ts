import type { FxRateBookV1 } from "./fx-rate-book.js";
import type { PineFootprintGateway, PineFootprintLimits } from "./footprint.js";

export { PINE_CHART_FIELD_REQUIREMENTS, pineChartFieldRequirement } from "./runtime-requirements.js";
export { FX_RATE_BOOK_LIMITS, normalizeFxRateBook, selectFxRate } from "./fx-rate-book.js";
export type { FxRateBookV1, FxRatePairV1, FxRateSelection, FxRateSelectionResult, FxRateSlotV1, NormalizedFxRateBookV1 } from "./fx-rate-book.js";
export {
  PINE_FOOTPRINT_DEFAULTS,
  PINE_FOOTPRINT_ERROR_CODES,
  PINE_FOOTPRINT_LIMITS,
  PineFootprintError,
  admitPineFootprintDataset,
  decodePineFootprintDatasetV1,
  decodePineFootprintRequestV1,
  extendPineFootprintStore,
} from "./footprint.js";
export type {
  AdmittedPineFootprintStoreV1,
  PineFootprintAdmissionContext,
  PineFootprintBarV1,
  PineFootprintDatasetV1,
  PineFootprintErrorCode,
  PineFootprintErrorOptions,
  PineFootprintGateway,
  PineFootprintLimits,
  PineFootprintRequestV1,
  PineFootprintRowV1,
} from "./footprint.js";
export { PINE_CERTIFIED_STRATEGY_TRADE_CALLS, PINE_CERTIFIED_STRATEGY_TRADE_FIELDS } from "./strategy-trade-fields.js";
export type { PineChartFieldRequirement, PineRuntimeRequirements } from "./runtime-requirements.js";
export type PineVersion = 5 | 6;
export type PineQualifier = "const" | "input" | "simple" | "series";
export type PineTypeKind =
  | "unknown" | "void" | "na"
  | "bool" | "int" | "float" | "string" | "color"
  | "enum" | "tuple" | "udt"
  | "array" | "map" | "matrix"
  | "reference" | "plot" | "hline";

export interface PineQualifiedType {
  readonly kind: PineTypeKind;
  readonly qualifier: PineQualifier;
  readonly name?: string;
  readonly arguments?: readonly PineQualifiedType[];
}
export { isPineShadowingNamespaceConstant, PINE_CONSTANT_NAMES, PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES } from "./constant-names.js";
export {
  PINE_BACKFILLABLE_CALLS,
  PINE_BUILTIN_CATALOG,
  PINE_BUILTIN_CATALOGS,
  PINE_CALLABLE_METADATA,
  PINE_CALLABLE_METADATA_BY_PROFILE,
  PINE_BUILTIN_REGISTRY,
  PINE_BUILTIN_REGISTRIES,
  PINE_DISPLAY_MASKS,
  PINE_MARKET_FIELDS,
  PINE_NAMESPACE_CALL_ROOTS,
  PINE_PRODUCTION_BUILTIN_CATALOG,
  PINE_PRODUCTION_BUILTIN_REGISTRY,
  PINE_PRODUCTION_NAMESPACE_CALL_ROOTS,
  PINE_PRODUCTION_CALLABLE_METADATA,
  PINE_PRODUCTION_RUNTIME_FIELDS,
  PINE_RUNTIME_FIELDS,
  PINE_TIME_COMPONENT_FIELDS,
  PINE_ZERO_ARGUMENT_CALLS,
  pineBuiltinCatalog,
  pineBuiltinRegistry,
  pineCallableMetadata,
  pineNamespaceCallRoots,
  pineRuntimeFields,
} from "./builtins.js";
export { PINE_DRAWING_CALL_SIGNATURES, PINE_FILL_CALL_SIGNATURES, PINE_PLOT_CALL_SIGNATURES, PINE_STRATEGY_CALL_SIGNATURES, PINE_V5_STRATEGY_CALL_SIGNATURES } from "./builtin-signatures.js";
export type { PineBuiltinCatalog, PineBuiltinSpec } from "./builtins.js";
export type { PineCallableDefinition, PineCallableOverloadDefinition, PineCallableParameterDefinition } from "./callable-metadata.js";
export {
  LUMEN_CHARTS_TICKER_IDENTITY_PREFIX,
  decodeLumenChartsTickerIdentity,
  encodeLumenChartsTickerIdentity,
  normalizeLumenChartsTickerNumber,
  normalizeLumenChartsTickerSource,
  normalizeLumenChartsTickerStyle,
  lumenChartsTickerBaseSymbol,
  lumenChartsTickerParts,
} from "./ticker-identity.js";
export type { LumenChartsTickerIdentityV1, LumenChartsTickerTransform } from "./ticker-identity.js";
export { PINE_COMPATIBILITY, isStrictPineCompatibility, type PineCompatibility } from "./compatibility.js";
export { PINE_RUNTIME_IDENTITY, LUMEN_SCRIPT_EXECUTOR_VERSION } from "./runtime-identity.js";
export type PineValue = number | string | boolean | null | readonly PineValue[] | { readonly [key: string]: PineValue };
export type PineDisplayMask = number;
export type PineFormat = "inherit" | "price" | "percent" | "volume";
export type PineScale = "left" | "right" | "none";

/** Host-owned input IDs are deliberately invalid Pine identifiers. */
export const PINE_MAIN_TIMEFRAME_INPUT_ID = "$pine.main.timeframe";
export const PINE_MAIN_TIMEFRAME_GAPS_INPUT_ID = "$pine.main.timeframe_gaps";

export interface InputDefinition {
  readonly id: string;
  readonly type: "bool" | "color" | "enum" | "float" | "int" | "price" | "session" | "source" | "string" | "symbol" | "text_area" | "time" | "timeframe";
  readonly title: string;
  readonly defaultValue: PineValue;
  readonly tooltip?: string;
  readonly inline?: string;
  readonly group?: string;
  readonly confirm?: boolean;
  /** Canonical bitmask from `PINE_DISPLAY_MASKS`; combinations are supported. */
  readonly display?: PineDisplayMask;
  readonly active?: boolean;
  readonly options?: readonly PineValue[];
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly step?: number;
}

export interface PlotDefinition {
  readonly id: string;
  readonly title: string;
}

export interface AlertDefinition {
  readonly id: string;
  readonly title: string;
  readonly message: string;
}

export interface ProgramDescriptor {
  readonly version: PineVersion;
  readonly kind: "indicator" | "strategy";
  readonly title: string;
  /** Non-empty declaration `shorttitle`, used in compact chart surfaces. */
  readonly shortTitle?: string;
  readonly overlay: boolean;
  /** Host-rendering metadata from the indicator()/strategy() declaration. */
  readonly format: PineFormat;
  readonly precision: number;
  /**
   * True when `precision` was supplied. An omitted precision keeps the
   * descriptor default but hosts should format values like the parent series.
   */
  readonly precisionSpecified?: boolean;
  readonly scale: PineScale;
  /**
   * Distinguishes an omitted `scale` argument from Pine's descriptor default.
   * An omitted scale uses the occupied pane's existing scale; an explicit
   * left/right scale requires an independent study scale when overlaid.
   */
  readonly scaleExplicit?: boolean;
  readonly behindChart: boolean;
  readonly explicitPlotZOrder: boolean;
  /**
   * Declared indicator main timeframe. `undefined` means the source did not
   * override the chart timeframe; a non-empty value requires host resampling.
   */
  readonly timeframe?: string;
  /** True when `timeframe` was syntactically supplied, including `timeframe=""`. */
  readonly timeframeSpecified?: boolean;
  /** Host default is true when a declaration timeframe is present. */
  readonly timeframeGaps?: boolean;
  /** True when `timeframe_gaps` was syntactically supplied. */
  readonly timeframeGapsSpecified?: boolean;
  /** Preserved declaration setting; Pine-core series are not buffer-capped. */
  readonly maxBarsBack?: number;
  /** Preserved declaration setting; request plans remain statically compiled. */
  readonly dynamicRequests: boolean;
  readonly drawingLimits: {
    readonly lines: number;
    readonly boxes: number;
    readonly labels: number;
    readonly polylines: number;
  };
  readonly inputs: readonly InputDefinition[];
  readonly plots: readonly PlotDefinition[];
  readonly alerts: readonly AlertDefinition[];
  readonly strategy?: StrategyConfig;
}

export interface StrategyConfig {
  readonly initial_capital: number;
  /**
   * The declaration's account currency. In the strict profile, `"NONE"`
   * preserves Pine's `currency.NONE` choice; runtime public results resolve it
   * to the chart symbol's currency. Explicit cross-currency strategies require
   * a matching host-supplied FX book in the strict profile.
   */
  readonly currency: string;
  readonly pyramiding: number;
  readonly default_qty_type: "fixed" | "cash" | "percent_of_equity";
  readonly default_qty_value: number;
  readonly slippage: number;
  readonly commission_type: "percent" | "cash_per_order" | "cash_per_contract";
  readonly commission_value: number;
  readonly process_orders_on_close: boolean;
  readonly margin_long: number;
  readonly margin_short: number;
  readonly calc_on_order_fills: boolean;
  readonly calc_on_every_tick: boolean;
  readonly backtest_fill_limits_assumption: number;
  readonly close_entries_rule: "FIFO" | "ANY";
  readonly risk_free_rate: number;
  readonly use_bar_magnifier: boolean;
  readonly fill_orders_on_standard_ohlc: boolean;
}

export interface StrategyOrder {
  readonly id: string;
  readonly command: "entry" | "order" | "exit" | "close" | "close_all" | "margin_call";
  readonly direction: 1 | -1;
  readonly quantity: number;
  readonly type: "market" | "limit" | "stop" | "stop-limit";
  readonly limit?: number;
  readonly stop?: number;
  readonly createdBarIndex: number;
  readonly createdTime: number;
  readonly status: "pending" | "filled" | "cancelled";
  readonly fillPrice?: number;
  readonly fillBarIndex?: number;
  readonly fillTime?: number;
  readonly ocaName?: string;
  readonly ocaType?: "none" | "cancel" | "reduce";
  readonly comment?: string;
  readonly alertMessage?: string;
  readonly disableAlert?: boolean;
  readonly targetEntryId?: string;
  readonly quantityPercent?: number;
  readonly profitTicks?: number;
  readonly lossTicks?: number;
  readonly trailPrice?: number;
  readonly trailPoints?: number;
  readonly trailOffset?: number;
  readonly trailPeak?: number;
  readonly trailArmed?: boolean;
  readonly stopTriggered?: boolean;
}

export interface StrategyTrade {
  readonly id: string;
  readonly entryId: string;
  readonly direction: 1 | -1;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly entryBarIndex: number;
  readonly entryTime: number;
  readonly exitPrice?: number;
  readonly exitBarIndex?: number;
  readonly exitTime?: number;
  readonly profit?: number;
  readonly commission?: number;
  readonly entryComment?: string;
  readonly exitId?: string;
  readonly exitComment?: string;
  readonly maxDrawdown: number;
  readonly maxRunup: number;
  readonly status: "open" | "closed";
}

export interface StrategyStateSnapshot {
  readonly barIndex: number;
  readonly time: number;
  readonly positionSize: number;
  readonly positionAveragePrice: number;
  readonly openProfit: number;
  readonly netProfit: number;
  readonly equity: number;
  readonly openTrades: number;
  readonly closedTrades: number;
  readonly pendingOrders: number;
  readonly filledOrders: number;
  readonly cancelledOrders: number;
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly maxDrawdown: number;
  readonly maxRunup: number;
}

export interface StrategyResult extends StrategyStateSnapshot {
  readonly config: StrategyConfig;
  readonly orders: readonly StrategyOrder[];
  readonly openTradeRecords: readonly StrategyTrade[];
  readonly closedTradeRecords: readonly StrategyTrade[];
  readonly timeline: readonly StrategyStateSnapshot[];
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly evenTrades: number;
  readonly maxContractsHeld: number;
  readonly maxContractsHeldLong: number;
  readonly maxContractsHeldShort: number;
  readonly maxDrawdownPercent: number;
  readonly maxRunupPercent: number;
  readonly cagr: number;
  readonly buyAndHoldProfit: number;
  readonly buyAndHoldPercent: number;
  readonly strategyOutperformance: number;
  readonly sharpeRatio: number;
  readonly sortinoRatio: number;
}

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface Diagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly range?: SourceRange;
}

export interface MarketBar {
  readonly openTime: number;
  readonly closeTime?: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface PineSubsessionInfo {
  readonly [key: string]: PineValue | undefined;
  readonly id: string;
  readonly session: string;
  readonly correction?: string;
}

export interface PineSessionCorrection {
  /** Trading day in the provider's YYYYMMDD format. */
  readonly tradingDay: string;
  /** Replacement session for that trading day, including optional F-day offsets. */
  readonly session: string;
}

export interface PineSessionCorrections {
  readonly activeSession?: readonly PineSessionCorrection[];
  readonly regularSession?: readonly PineSessionCorrection[];
  readonly extendedSession?: readonly PineSessionCorrection[];
  readonly premarketSession?: readonly PineSessionCorrection[];
  readonly postmarketSession?: readonly PineSessionCorrection[];
}

/** Host-normalized exchange schedule used by the Pine `session` namespace. */
export interface PineSessionSchedule {
  readonly activeSession: string;
  readonly activeSubsessionId?: string;
  readonly regularSession: string;
  readonly extendedSession?: string;
  readonly premarketSession?: string;
  readonly postmarketSession?: string;
  readonly timezone?: string;
  readonly corrections?: PineSessionCorrections;
}

export interface SymbolInfo {
  readonly [key: string]: PineValue | undefined;
  /** Optional, session-stable future-event values supplied by the host. Dates are Unix milliseconds. */
  readonly dividends_future_amount?: number;
  readonly dividends_future_ex_date?: number;
  readonly dividends_future_pay_date?: number;
  readonly earnings_future_eps?: number;
  readonly earnings_future_period_end_time?: number;
  readonly earnings_future_revenue?: number;
  readonly earnings_future_time?: number;
  readonly ticker?: string;
  readonly tickerid?: string;
  readonly main_tickerid?: string;
  readonly prefix?: string;
  readonly root?: string;
  readonly description?: string;
  readonly type?: string;
  readonly currency?: string;
  readonly basecurrency?: string;
  readonly country?: string;
  readonly current_contract?: string;
  readonly employees?: number;
  readonly industry?: string;
  readonly isin?: string;
  readonly timezone?: string;
  readonly session?: string;
  readonly subsession_id?: string;
  readonly volumetype?: string;
  readonly mincontract?: number;
  readonly minmove?: number;
  readonly mintick?: number;
  readonly pointvalue?: number;
  readonly pricescale?: number;
  readonly sector?: string;
  readonly shareholders?: number;
}

export interface DataRequest {
  readonly symbol: string;
  readonly timeframe: string;
  readonly calcBarsCount?: number;
}

export interface MarketDataset {
  readonly bars: readonly MarketBar[];
  readonly symbolInfo?: SymbolInfo;
  /** Normalized exchange schedule for the active dataset and session namespace. */
  readonly sessionSchedule?: PineSessionSchedule;
}

export interface MarketDataGateway {
  load(request: DataRequest, signal: AbortSignal): Promise<MarketDataset>;
  getSymbolInfo?(symbol: string, signal: AbortSignal): Promise<SymbolInfo>;
}

export interface PlotPoint {
  readonly time: number;
  readonly value: PineValue;
  readonly options?: Readonly<Record<string, PineValue>>;
}

export interface PlotResult {
  readonly id: string;
  readonly title: string;
  readonly options?: Readonly<Record<string, PineValue>>;
  readonly points: readonly PlotPoint[];
}

export interface LineDrawing {
  readonly kind: "line";
  readonly id: number;
  readonly order?: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly xloc: string;
  readonly extend: string;
  readonly color: PineValue;
  readonly style: string;
  readonly width: number;
  readonly forceOverlay: boolean;
}

export interface BoxDrawing {
  readonly kind: "box";
  readonly id: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly xloc: string;
  readonly extend: string;
  readonly borderColor: PineValue;
  readonly borderStyle: string;
  readonly borderWidth: number;
  readonly backgroundColor: PineValue;
  readonly text: string;
  readonly textColor: PineValue;
  readonly textSize: string;
  readonly textHorizontalAlign: string;
  readonly textVerticalAlign: string;
  readonly textWrap: string;
  readonly textFontFamily: string;
  readonly textFormatting: string;
  readonly forceOverlay: boolean;
}

export interface LabelDrawing {
  readonly kind: "label";
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly xloc: string;
  readonly yloc: string;
  readonly color: PineValue;
  readonly style: string;
  readonly textColor: PineValue;
  readonly size: string;
  readonly textAlign: string;
  readonly tooltip: string;
  readonly textFontFamily: string;
  readonly textFormatting: string;
  readonly forceOverlay: boolean;
}

export interface DrawingPoint {
  readonly time?: number;
  readonly index?: number;
  readonly price: number;
}

export interface PolylineDrawing {
  readonly kind: "polyline";
  readonly id: number;
  readonly order?: number;
  readonly points: readonly DrawingPoint[];
  readonly curved: boolean;
  readonly closed: boolean;
  readonly xloc: string;
  readonly lineColor: PineValue;
  readonly fillColor: PineValue;
  readonly lineStyle: string;
  readonly lineWidth: number;
  readonly forceOverlay: boolean;
}

export interface LinefillDrawing {
  readonly kind: "linefill";
  readonly id: number;
  readonly line1Id: number;
  readonly line2Id: number;
  readonly color: PineValue;
  readonly forceOverlay: boolean;
}

export type Drawing = LineDrawing | BoxDrawing | LabelDrawing | LinefillDrawing | PolylineDrawing;

export interface TableCell {
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly textColor: PineValue;
  readonly textHorizontalAlign: string;
  readonly textVerticalAlign: string;
  readonly textSize: PineValue;
  readonly backgroundColor: PineValue;
  readonly tooltip: string;
  readonly textFontFamily: string;
  readonly textFormatting: string;
  readonly merged: boolean;
  readonly mergeParent: readonly [number, number] | null;
}

export interface TableMerge {
  readonly startColumn: number;
  readonly startRow: number;
  readonly endColumn: number;
  readonly endRow: number;
}

export interface TableSnapshot {
  readonly id: number;
  readonly position: string;
  readonly columns: number;
  readonly rows: number;
  readonly backgroundColor: PineValue;
  readonly frameColor: PineValue;
  readonly frameWidth: number;
  readonly borderColor: PineValue;
  readonly borderWidth: number;
  readonly forceOverlay: boolean;
  readonly cells: readonly (readonly (TableCell | null)[])[];
  readonly merges: readonly TableMerge[];
}

export interface ExecutionStats {
  readonly bars: number;
  /** Bars evaluated by this session to produce this result. Child request sessions are excluded. */
  readonly processedBars: number;
  readonly elapsedMs: number;
}

export interface AlertEvent {
  readonly type: "alert" | "alertcondition";
  readonly id: string;
  readonly message: string;
  readonly title?: string;
  readonly frequency?: "alert.freq_all" | "alert.freq_once_per_bar" | "alert.freq_once_per_bar_close";
  readonly barIndex: number;
  readonly time: number;
  /** Confirmation at the exact evaluation that emitted this event. */
  readonly confirmed?: boolean;
}

export interface PineLogDraft {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly truncated?: boolean;
  readonly barIndex: number;
  readonly barOpenTimeMs: number;
  readonly emittedAtMs: number;
  readonly phase: "historical" | "realtime";
  readonly callSite: { readonly line: number; readonly column: number; readonly endLine: number; readonly endColumn: number };
}

export interface PineLogEventV1 extends PineLogDraft {
  readonly version: 1;
  readonly sequence: number;
  readonly logEpoch: string;
  readonly context: { readonly kind: "root" | "request"; readonly requestId?: string };
}

export interface PineLogJournalV1 {
  readonly version: 1;
  readonly logEpoch: string;
  readonly firstRetainedSequence: number;
  readonly nextSequence: number;
  readonly droppedCount: number;
  readonly historyUnavailable: boolean;
  readonly events: readonly PineLogEventV1[];
}

export interface ExecutionResult {
  readonly descriptor: ProgramDescriptor;
  readonly times: readonly number[];
  readonly plots: readonly PlotResult[];
  readonly drawings: readonly Drawing[];
  readonly tables: readonly TableSnapshot[];
  readonly alerts: readonly AlertEvent[];
  readonly strategy?: StrategyResult;
  readonly returned: Readonly<Record<string, readonly PineValue[]>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: ExecutionStats;
}

export interface DrawingRef {
  readonly kind: Drawing["kind"];
  readonly id: number;
}

export interface SceneDelta {
  readonly drawings: {
    readonly added: readonly Drawing[];
    readonly updated: readonly Drawing[];
    readonly deleted: readonly DrawingRef[];
  };
  readonly tables: {
    readonly added: readonly TableSnapshot[];
    readonly updated: readonly TableSnapshot[];
    readonly deleted: readonly number[];
  };
}

export interface ExecutionDelta extends ExecutionResult {
  readonly fromIndex: number;
  readonly sceneDelta: SceneDelta;
}

export interface SessionCheckpoint {
  readonly bars: readonly MarketBar[];
  /** Offset of the anchored script window within the supplied chart bars. */
  readonly firstEvaluatedBar?: number;
  /** Runtime implementation identity; portable state cannot cross executor semantics. */
  readonly executorVersion?: string;
  readonly inputs: Readonly<Record<string, PineValue>>;
  /** Portable checkpoint schema. Absent on legacy checkpoints. */
  readonly version?: 1 | 2;
  /** Identifies the compiled program that produced the runtime state. */
  readonly programFingerprint?: string;
  /** Exact normalized FX content and owning selection context. */
  readonly fxContextIdentity?: string;
  /** Exact selected final-bar context under the captured evaluation clock. */
  readonly fxSelectionIdentity?: string;
  /** Exact admitted footprint content required to restore compact handles. */
  readonly footprintStoreIdentity?: string;
  /** Opaque, JSON-safe runtime state used after process or worker boundaries. */
  readonly runtimeState?: string;
  /** Bounded session log journal; present on version 2 checkpoints. */
  readonly logState?: string;
  /** State immediately before the final evaluated bar, used for tail replacement. */
  readonly tailState?: {
    readonly nextIndex: number;
    readonly runtimeState: string;
  };
}

export interface ExecutionProgress {
  readonly currentBarTime: number | null;
  readonly processedBars: number;
  readonly totalBars: number;
}

export interface MarketExecutionPoint {
  readonly parentTime: number;
  readonly childTime: number;
  readonly timestamp: number;
  readonly sequence: number;
  readonly price: number;
  readonly kind: "open" | "high" | "low" | "close";
  readonly source: "default" | "high";
  readonly startsGap: boolean;
}

export interface PineCheckpointLimits {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxEntries?: number;
}

export interface SessionOptions {
  /** Portable graph budgets; omitted fields use runtime defaults. */
  readonly checkpointLimits?: PineCheckpointLimits;
  /** Host-resolved chart price construction exposed through chart.is_* variables. */
  readonly chartType?: "standard" | "heikinashi" | "kagi" | "linebreak" | "pnf" | "range" | "renko";
  /** Host-resolved chart colors exposed through chart.bg_color/chart.fg_color. */
  readonly chartColors?: {
    readonly background: string;
    readonly foreground: string;
  };
  readonly inputs?: Readonly<Record<string, PineValue>>;
  readonly sourceSeries?: Readonly<Record<string, readonly PineValue[]>>;
  readonly timeframe?: string;
  /** Indicator declaration context, preserved inside child request contexts. */
  readonly mainTimeframe?: string;
  readonly timezone?: string;
  readonly symbolInfo?: SymbolInfo;
  /** Normalized exchange schedule for the active dataset and session namespace. */
  readonly sessionSchedule?: PineSessionSchedule;
  /** Raw host-supplied FX v1 book; a session owner must normalize and validate it before use. */
  readonly fxRateBook?: FxRateBookV1;
  readonly randomSeed?: number;
  readonly alertMode?: "realtime" | "realtime-update" | "off" | "all";
  /** Host clock used for realtime bar-state evaluation. Defaults to Date.now. */
  readonly now?: () => number;
  readonly visibleRange?: {
    readonly left: number;
    readonly right: number;
  };
  readonly marketDataGateway?: MarketDataGateway;
  /** Provider-neutral, separately entitled volume-footprint source. */
  readonly footprintGateway?: PineFootprintGateway;
  /** Footprint admission budgets; omitted fields use the public conservative defaults. */
  readonly footprintLimits?: PineFootprintLimits;
  /** Lower-timeframe bars keyed by the parent bar's open time. */
  readonly intrabarBars?: Readonly<Record<string, readonly MarketBar[]>>;
  /** Ordered lower-timeframe price points keyed by parent bar open time. */
  readonly intrabarPoints?: Readonly<
    Record<string, readonly MarketExecutionPoint[]>
  >;
  readonly signal?: AbortSignal;
  readonly limits?: {
    readonly maxBars?: number;
    readonly maxOperationsPerBar?: number;
    readonly maxTableCells?: number;
  };
}

export { parsePineDateString, timezoneOffsetMinutes } from "./pine-date-string.js";
