import * as policy from "./strategy-policy.js";
import { PINE_CERTIFIED_STRATEGY_TRADE_FIELDS, type FxRateSelectionResult, isStrictPineCompatibility, PINE_COMPATIBILITY } from "../contracts/index.js";
import type { PineCompatibility, MarketBar, MarketExecutionPoint, PineValue, StrategyConfig, StrategyOrder, StrategyResult, StrategyStateSnapshot, StrategyTrade, SymbolInfo } from "../contracts/index.js";
import {
  averageStrategyTradePercent,
  strategyAdverseFirst,
  strategyFillTime,
  strategyLegCommission,
  strategyPointValue,
} from "./strategy-math.js";
import {
  createStrategyState,
  strategyBuyAndHold,
  strategyCagr,
  strategyPercent,
  strategyRiskAdjusted,
} from "./strategy-accounting.js";
import { dateParts } from "./time.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { integer, number, pineString } from "./values.js";

export interface MutableStrategyOrder {
  id: string;
  command: "entry" | "order" | "exit" | "close" | "close_all" | "margin_call";
  direction: 1 | -1;
  quantity: number;
  type: "market" | "limit" | "stop" | "stop-limit";
  limit?: number;
  stop?: number;
  stopTriggered?: boolean;
  createdBarIndex: number;
  createdTime: number;
  status: "pending" | "filled" | "cancelled";
  fillPrice?: number;
  fillBarIndex?: number;
  fillTime?: number;
  ocaName?: string;
  ocaType?: "none" | "cancel" | "reduce";
  comment?: string;
  commentProfit?: string;
  commentLoss?: string;
  commentTrailing?: string;
  alertMessage?: string;
  alertProfit?: string;
  alertLoss?: string;
  alertTrailing?: string;
  disableAlert?: boolean;
  targetEntryId?: string;
  targetTradeId?: string;
  quantityPercent?: number;
  /** Public strategy.exit claim on one concrete trade; distinct from synthetic reservations. */
  publicExitReservedQuantity?: number;
  /** First allocated size, retained across unrelated cancellation and shrinking trades. */
  publicExitAllocationCeiling?: number;
  /** Remaining explicit cross-family OCA size for a public exit instance. */
  publicExitOcaCap?: number;
  /** The position closed after this order was placed; keep same-bar history visible. */
  publicExitRetired?: boolean;
  /** Internal synthetic fill reservation; never inferred from a public order. */
  reservedQuantity?: number;
  /** Trade size at synthetic reservation time, used to retain qty_percent. */
  reservationBasisQuantity?: number;
  /** Internal identity of the source execution that first reserved this exit. */
  reservationOriginBarIndex?: number;
  reservationOriginTime?: number;
  /** Internal identity of the concrete execution that issued this order instance. */
  reservationIssuedBarIndex?: number;
  reservationIssuedTime?: number;
  immediately?: boolean;
  intendedTradeIds?: readonly string[];
  profitTicks?: number;
  lossTicks?: number;
  trailPrice?: number;
  trailPoints?: number;
  trailOffset?: number;
  trailPeak?: number;
  trailArmed?: boolean;
}

export interface MutableStrategyTrade {
  id: string;
  entryId: string;
  direction: 1 | -1;
  quantity: number;
  /** Original filled size for public strategy.exit percent sizing. */
  originalQuantity?: number;
  /** Creation bar of the entry command that produced this trade. */
  entryOrderCreatedBarIndex?: number;
  entryPrice: number;
  entryBarIndex: number;
  entryTime: number;
  exitPrice?: number;
  exitBarIndex?: number;
  exitTime?: number;
  profit?: number;
  entryCommission: number;
  /** Remaining account-valued entry notional, frozen at the entry-bar rate. */
  entryBasis?: number;
  commission?: number;
  entryComment?: string;
  exitId?: string;
  /** Pine exit label when it differs from the broker order ID. */
  pineExitId?: string;
  exitComment?: string;
  maxDrawdown: number;
  maxRunup: number;
  status: "open" | "closed";
}

export interface MutableStrategyState {
  readonly config: StrategyConfig;
  readonly orders: MutableStrategyOrder[];
  /** Versioned public exit calls retained for same-bar entries and omitted from_entry persistence. */
  readonly publicExitIntents?: MutablePublicExitIntent[];
  readonly openTrades: MutableStrategyTrade[];
  readonly closedTrades: MutableStrategyTrade[];
  /** Lifetime number of closed trades; retained rows may start later. */
  closedTradeCount: number;
  /** Absolute index represented by closedTrades[0]. */
  closedTradeFirstIndex: number;
  closedTradeProfitTotal: number;
  closedTradePercentTotal: number;
  winningTradePercentTotal: number;
  losingTradePercentTotal: number;
  readonly timeline: StrategyStateSnapshot[];
  nextTradeId: number;
  positionSize: number;
  positionAveragePrice: number;
  openProfit: number;
  netProfit: number;
  equity: number;
  grossProfit: number;
  grossLoss: number;
  winningTrades: number;
  losingTrades: number;
  evenTrades: number;
  winningProfit: number;
  losingLoss: number;
  maxContractsHeld: number;
  maxContractsHeldLong: number;
  maxContractsHeldShort: number;
  equityPeak: number;
  equityTrough: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxRunup: number;
  maxRunupPercent: number;
  firstEntryPrice: number;
  firstEntryRate?: number;
  firstEntryPointValue?: number;
  lastFxRate?: number;
  readonly monthlyEquity: number[];
  lastMonthKey: number | undefined;
  readonly riskRules: {
    allowEntryIn?: "long" | "short" | "all" | "none";
    maxPositionSize?: number;
    maxDrawdown?: { readonly value: number; readonly type: "cash" | "percent_of_equity"; readonly alertMessage?: string };
    maxDrawdownPercentRule?: { readonly value: number; readonly type: "percent_of_equity"; readonly alertMessage?: string };
    maxIntradayLoss?: { readonly value: number; readonly type: "cash" | "percent_of_equity"; readonly alertMessage?: string };
    maxIntradayLossPercentRule?: { readonly value: number; readonly type: "percent_of_equity"; readonly alertMessage?: string };
    maxIntradayFilledOrders?: number;
    maxIntradayFilledOrdersAlertMessage?: string;
    maxConsecutiveLossDays?: number;
    maxConsecutiveLossDaysAlertMessage?: string;
  };
  riskHalted: boolean;
  /** Peak cumulative profit from closed trades for the drawdown rule. */
  riskClosedProfitPeak?: number;
  /** Intraday rules reset at the next admitted local risk period. */
  intradayRiskHalted: boolean;
  intradayFillLimitHalted?: boolean;
  intradayKey: string;
  intradayStartEquity: number;
  intradayPeakEquity: number;
  intradayFills: number;
  currentDayRealizedProfit: number;
  consecutiveLossDays: number;
}

export interface MutablePublicExitIntent {
  readonly version: 1;
  readonly id: string;
  readonly targetEntryId: string;
  readonly createdBarIndex: number;
  readonly order: MutableStrategyOrder;
  readonly completedTradeIds: string[];
  readonly ocaCapsByTrade: Record<string, number>;
}

const publicExitContractFields: readonly (keyof MutableStrategyOrder)[] = [
  "quantity", "quantityPercent", "profitTicks", "limit", "lossTicks", "stop", "trailPrice", "trailPoints",
  "trailOffset", "ocaName", "comment", "commentProfit", "commentLoss", "commentTrailing", "alertMessage",
  "alertProfit", "alertLoss", "alertTrailing", "disableAlert",
];

export interface StrategyRuntimeHost {
  readonly barIndex: () => number;
  readonly bars: () => readonly MarketBar[];
  readonly data: (name: string) => PineValue;
  readonly symbolInfo: () => SymbolInfo;
  readonly timezone: () => string;
  /** Host-owned active-session trading day or high-timeframe bar identity. */
  readonly riskPeriodKey?: (openTime: number, barIndex: number) => string | undefined;
  readonly executionBars: () => readonly MarketBar[];
  readonly executionPoints: () => readonly MarketExecutionPoint[];
}

const certifiedOpenTradeIndexNames = new Set(PINE_CERTIFIED_STRATEGY_TRADE_FIELDS.opentrades);
const certifiedClosedTradeIndexNames = new Set(PINE_CERTIFIED_STRATEGY_TRADE_FIELDS.closedtrades);
const zeroDefaultTradeFields = new Set([
  "commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit", "profit_percent", "size",
]);
const MAX_RETAINED_CLOSED_TRADES = 9_000;

export function validatePublicExitSnapshot(strategy: MutableStrategyState): void {
  if (!Array.isArray(strategy.publicExitIntents)) throw new Error("Invalid public strategy.exit intent snapshot");
  if (!Number.isSafeInteger(strategy.closedTradeCount) || !Number.isSafeInteger(strategy.closedTradeFirstIndex)
    || strategy.closedTradeCount < 0 || strategy.closedTradeFirstIndex < 0
    || !Number.isFinite(strategy.closedTradeProfitTotal)
    || typeof strategy.closedTradePercentTotal !== "number"
    || typeof strategy.winningTradePercentTotal !== "number"
    || typeof strategy.losingTradePercentTotal !== "number"
    || strategy.closedTrades.length > MAX_RETAINED_CLOSED_TRADES
    || strategy.closedTradeFirstIndex + strategy.closedTrades.length !== strategy.closedTradeCount) {
    throw new Error("Invalid retained closed-trade snapshot");
  }
  const open = new Map(strategy.openTrades.map((trade) => [trade.id, trade]));
  const closed = new Map(strategy.closedTrades.map((trade) => [trade.id, trade]));
  const claims = new Map<string, number>();
  let totalClaims = 0;
  const intentKeys = new Set<string>();
  const orderKeys = new Set<string>();
  for (const trade of strategy.openTrades) {
    if (!Number.isFinite(trade.originalQuantity) || trade.originalQuantity! < trade.quantity
      || !Number.isInteger(trade.entryOrderCreatedBarIndex)) throw new Error("Invalid public strategy.exit trade basis snapshot");
  }
  for (const intent of strategy.publicExitIntents) {
    if (intent.version !== 1 || intent.order.command !== "exit" || intent.id !== intent.order.id
      || intent.targetEntryId !== intent.order.targetEntryId || !Array.isArray(intent.completedTradeIds)
      || intent.ocaCapsByTrade === null || typeof intent.ocaCapsByTrade !== "object"
      || Array.isArray(intent.ocaCapsByTrade)) {
      throw new Error("Invalid public strategy.exit intent snapshot");
    }
    const key = JSON.stringify([intent.id, intent.targetEntryId]);
    if (intentKeys.has(key) || new Set(intent.completedTradeIds).size !== intent.completedTradeIds.length
      || Object.values(intent.ocaCapsByTrade).some((cap) => !Number.isFinite(cap) || cap < 0)) {
      throw new Error("Invalid public strategy.exit intent snapshot");
    }
    intentKeys.add(key);
  }
  for (const order of strategy.orders) {
    if (order.status !== "pending" || order.command !== "exit") continue;
    if (order.publicExitReservedQuantity === undefined) {
      if (!strategy.config.calc_on_order_fills) throw new Error("Missing public strategy.exit reservation snapshot");
      continue;
    }
    const trade = open.get(order.targetTradeId ?? "");
    const intent = strategy.publicExitIntents.find((candidate) => candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId);
    if (order.publicExitRetired === true) {
      if (order.publicExitReservedQuantity !== 0 || order.quantity !== 0
        || order.targetTradeId === undefined || open.has(order.targetTradeId)) {
        throw new Error("Invalid retired public strategy.exit snapshot");
      }
      continue;
    }
    const source = closed.get(order.targetTradeId ?? "");
    const sourceBasis = source?.originalQuantity ?? source?.quantity;
    const requested = intent === undefined || sourceBasis === undefined ? Number.NaN
      : intent.order.quantity > 0 ? intent.order.quantity
        : intent.order.quantityPercent === undefined ? sourceBasis
          : sourceBasis * Math.max(0, Math.min(100, intent.order.quantityPercent)) / 100;
    const orphan = trade === undefined && strategy.config.close_entries_rule === "FIFO"
      && source !== undefined && source.status === "closed"
      && (order.targetEntryId === "" || source.entryId === order.targetEntryId)
      && source.entryOrderCreatedBarIndex !== undefined && intent !== undefined
      && source.entryOrderCreatedBarIndex <= intent.createdBarIndex
      && source.exitBarIndex !== undefined && source.exitBarIndex >= intent.createdBarIndex
      && source.direction === -order.direction
      && strategy.openTrades.some((candidate) => candidate.direction === source.direction)
      && Number.isFinite(requested) && order.publicExitReservedQuantity <= requested
      && order.publicExitAllocationCeiling !== undefined && order.publicExitAllocationCeiling <= requested;
    if ((trade === undefined && !orphan) || intent === undefined || order.publicExitReservedQuantity < 0
      || order.quantity !== order.publicExitReservedQuantity
      || (order.targetTradeId !== undefined && intent.completedTradeIds.includes(order.targetTradeId))) {
      throw new Error("Invalid public strategy.exit reservation snapshot");
    }
    if (order.publicExitOcaCap !== undefined && (!Number.isFinite(order.publicExitOcaCap)
      || order.publicExitOcaCap < order.publicExitReservedQuantity)) {
      throw new Error("Invalid public strategy.exit OCA snapshot");
    }
    if (order.publicExitAllocationCeiling === undefined || !Number.isFinite(order.publicExitAllocationCeiling)
      || order.publicExitAllocationCeiling < order.publicExitReservedQuantity) {
      throw new Error("Invalid public strategy.exit allocation snapshot");
    }
    const orderKey = JSON.stringify([order.id, order.targetEntryId, order.targetTradeId]);
    if (orderKeys.has(orderKey)) throw new Error("Duplicate public strategy.exit reservation snapshot");
    orderKeys.add(orderKey);
    if (order.targetTradeId !== undefined) claims.set(order.targetTradeId,
      (claims.get(order.targetTradeId) ?? 0) + order.publicExitReservedQuantity);
    totalClaims += order.publicExitReservedQuantity;
  }
  for (const [tradeId, total] of claims) {
    const source = open.get(tradeId) ?? closed.get(tradeId);
    const capacity = open.has(tradeId) ? source?.quantity : source?.originalQuantity ?? source?.quantity;
    if (capacity === undefined || total > capacity + 1e-9) throw new Error("Overclaimed public strategy.exit reservation snapshot");
  }
  if (totalClaims > Math.abs(strategy.positionSize) + 1e-9) throw new Error("Overclaimed public strategy.exit reservation snapshot");
}

/** New account-valued bases are mandatory only for a restored cross-currency ledger. */
export function validateStrategyFxSnapshot(strategy: MutableStrategyState | undefined, required: boolean, evaluated = false,
  selectionIdentity?: string): void {
  if (!required || strategy === undefined) return;
  const money = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (strategy.firstEntryRate !== undefined && (!Number.isFinite(strategy.firstEntryRate) || strategy.firstEntryRate <= 0)) {
    throw new Error("Invalid FX strategy first-entry rate snapshot");
  }
  if (strategy.firstEntryPointValue !== undefined && (!Number.isFinite(strategy.firstEntryPointValue) || strategy.firstEntryPointValue <= 0)) {
    throw new Error("Invalid FX strategy first-entry point value snapshot");
  }
  if (Number.isFinite(strategy.firstEntryPrice) && (strategy.firstEntryRate === undefined || strategy.firstEntryPointValue === undefined)) {
    throw new Error("Missing FX strategy benchmark basis snapshot");
  }
  if (evaluated && strategy.lastFxRate === undefined) throw new Error("Missing FX strategy selected rate snapshot");
  if (strategy.lastFxRate !== undefined && !Number.isNaN(strategy.lastFxRate)
    && (!Number.isFinite(strategy.lastFxRate) || strategy.lastFxRate <= 0)) {
    throw new Error("Invalid FX strategy selected rate snapshot");
  }
  if (evaluated) {
    let selection: unknown;
    try { selection = JSON.parse(selectionIdentity ?? "") as unknown; }
    catch { throw new Error("Invalid FX strategy selected rate identity snapshot"); }
    const selected: unknown = Array.isArray(selection) ? (selection as unknown[])[1] : selection;
    if (selected === null || typeof selected !== "object" || !("kind" in selected)) {
      throw new Error("Invalid FX strategy selected rate identity snapshot");
    }
    const result = selected as Record<string, unknown>;
    if (!["rate", "identity", "unavailable", "missing-pair", "missing-currency"].includes(String(result.kind))) {
      throw new Error("Invalid FX strategy selected rate identity snapshot");
    }
    const expectedRate = result.kind === "rate" || result.kind === "identity" ? result.rate : Number.NaN;
    if (typeof expectedRate !== "number" || !Object.is(strategy.lastFxRate, expectedRate)) {
      throw new Error("FX strategy selected rate does not match selection identity");
    }
  }
  for (const trade of [...strategy.openTrades, ...strategy.closedTrades]) {
    if (!money(trade.entryBasis) || !money(trade.entryCommission)
      || (trade.commission !== undefined && !money(trade.commission))) {
      throw new Error("Invalid FX strategy trade monetary basis snapshot");
    }
  }
}

export class StrategyRuntime {
  private historicalRiskClosePending = false;
  public strategy: MutableStrategyState | undefined;
  private fxSelection: FxRateSelectionResult = { kind: "identity", rate: 1 };

  public constructor(
    enabled: boolean,
    config: StrategyConfig | undefined,
    private readonly host: StrategyRuntimeHost,
    private readonly resolveCurrencyNone = false,
    private readonly compatibility: PineCompatibility = PINE_COMPATIBILITY.legacy,
    private readonly version: 5 | 6 = 5,
    private readonly requestConversionEnabled = false,
  ) {
    this.strategy = enabled ? createStrategyState(config, this.defaultStrategyCurrency(), isStrictPineCompatibility(compatibility)) : undefined;
  }

  public reset(enabled: boolean, config: StrategyConfig | undefined, resolveCurrencyNone = this.resolveCurrencyNone): void {
    this.strategy = enabled ? createStrategyState(config, resolveCurrencyNone ? this.symbolInfo.currency : undefined,
      isStrictPineCompatibility(this.compatibility)) : undefined;
    this.fxSelection = { kind: "identity", rate: 1 };
  }

  public setFxSelection(selection: FxRateSelectionResult): void {
    this.fxSelection = selection;
    if (this.strategy !== undefined) this.strategy.lastFxRate = selection.kind === "rate" || selection.kind === "identity" ? selection.rate : Number.NaN;
  }

  public restoreFxSelection(): void {
    const rate = this.strategy?.lastFxRate;
    this.fxSelection = rate === undefined ? { kind: "identity", rate: 1 }
      : Number.isFinite(rate) && rate > 0 ? { kind: "rate", rate, date: "", observedAt: 0 }
        : { kind: "unavailable", reason: "explicit-unavailable" };
  }

  /** Adds the lifetime trade aggregates introduced with bounded trade retention to older checkpoints. */
  public migrateTradeSnapshot(strategy: MutableStrategyState): void {
    const snapshot = strategy as Partial<MutableStrategyState>;
    if (snapshot.closedTradeCount !== undefined) return;
    if (snapshot.closedTradeFirstIndex !== undefined || snapshot.closedTradeProfitTotal !== undefined
      || snapshot.closedTradePercentTotal !== undefined || snapshot.winningTradePercentTotal !== undefined
      || snapshot.losingTradePercentTotal !== undefined) return;

    const count = strategy.closedTrades.length;
    const pointValue = strategyPointValue(this.symbolInfo);
    strategy.closedTradeCount = count;
    strategy.closedTradeFirstIndex = 0;
    strategy.closedTradeProfitTotal = strategy.winningProfit - strategy.losingLoss;
    strategy.closedTradePercentTotal = count === 0 ? 0
      : averageStrategyTradePercent(strategy.closedTrades, undefined, pointValue) * count;
    strategy.winningTradePercentTotal = strategy.winningTrades === 0 ? 0
      : averageStrategyTradePercent(strategy.closedTrades, 1, pointValue) * strategy.winningTrades;
    strategy.losingTradePercentTotal = strategy.losingTrades === 0 ? 0
      : averageStrategyTradePercent(strategy.closedTrades, -1, pointValue) * strategy.losingTrades;
    if (isStrictPineCompatibility(this.compatibility) && count > MAX_RETAINED_CLOSED_TRADES) {
      strategy.closedTradeFirstIndex = count - MAX_RETAINED_CLOSED_TRADES;
      strategy.closedTrades.splice(0, strategy.closedTradeFirstIndex);
    }
  }

  private fxRate(operation: string): number {
    if (!isStrictPineCompatibility(this.compatibility)) return 1;
    if (this.fxSelection.kind === "rate" || this.fxSelection.kind === "identity") return this.fxSelection.rate;
    throw new PineRuntimeError("FX rate is unavailable for strategy monetary work", operation);
  }

  private finiteAccountMoney(value: number, operation: string): number {
    if (isStrictPineCompatibility(this.compatibility) && !Number.isFinite(value)) {
      throw new PineRuntimeError("Strategy account amount exceeds finite range", operation);
    }
    return value;
  }

  private get barIndex(): number { return this.host.barIndex(); }
  private get bars(): readonly MarketBar[] { return this.host.bars(); }
  private get symbolInfo(): SymbolInfo { return this.host.symbolInfo(); }
  private get timezone(): string { return this.host.timezone(); }
  private data(name: string): PineValue { return this.host.data(name); }

  private defaultStrategyCurrency(): PineValue | undefined {
    return this.resolveCurrencyNone ? this.symbolInfo.currency : undefined;
  }

  public strategyValue(name: string): PineValue {
    if (name === "long") return "long";
    if (name === "short") return "short";
    if (name === "fixed") return "fixed";
    if (name === "cash") return "cash";
    if (name === "percent_of_equity") return "percent_of_equity";
    if (name === "direction.long") return "long";
    if (name === "direction.short") return "short";
    if (name === "direction.all") return "all";
    if (name === "oca.none") return "none";
    if (name === "oca.cancel") return "cancel";
    if (name === "oca.reduce") return "reduce";
    if (name === "commission.percent") return "percent";
    if (name === "commission.cash_per_order") return "cash_per_order";
    if (name === "commission.cash_per_contract") return "cash_per_contract";
    const strategy = this.strategy;
    if (strategy === undefined) return Number.NaN;
    const strict = isStrictPineCompatibility(this.compatibility);
    if (name === "position_size") return strategy.positionSize;
    if (name === "position_avg_price") return strategy.positionAveragePrice;
    if (name === "position_entry_name") return strategy.openTrades.at(-1)?.entryId ?? "";
    if (name === "opentrades") return strategy.openTrades.length;
    if (name === "closedtrades") return strict ? strategy.closedTradeCount : strategy.closedTrades.length;
    if (name === "openprofit") return strategy.openProfit;
    if (name === "netprofit") return strategy.netProfit;
    if (name === "openprofit_percent") {
      const basis = strict ? strategy.config.initial_capital + strategy.netProfit : strategy.config.initial_capital;
      return this.accountPercent(strategy.openProfit, basis);
    }
    if (name === "netprofit_percent") return this.accountPercent(strategy.netProfit, strategy.config.initial_capital);
    if (name === "grossprofit") return strategy.grossProfit;
    if (name === "grossprofit_percent") return this.accountPercent(strategy.grossProfit, strategy.config.initial_capital);
    if (name === "grossloss") return strategy.grossLoss;
    if (name === "grossloss_percent") return this.accountPercent(strategy.grossLoss, strategy.config.initial_capital);
    if (name === "wintrades") return strategy.winningTrades;
    if (name === "losstrades") return strategy.losingTrades;
    if (name === "eventrades") return strategy.evenTrades;
    if (name === "avg_trade") return (strict ? strategy.closedTradeCount : strategy.closedTrades.length) === 0
      ? Number.NaN
      : (strict ? strategy.closedTradeProfitTotal : strategy.closedTrades.reduce((sum, trade) => sum + (trade.profit ?? 0), 0))
        / (strict ? strategy.closedTradeCount : strategy.closedTrades.length);
    if (name === "avg_trade_percent") return this.averageStrategyTradePercent();
    if (name === "avg_winning_trade") return strategy.winningTrades === 0 ? Number.NaN : strategy.winningProfit / strategy.winningTrades;
    if (name === "avg_winning_trade_percent") return this.averageStrategyTradePercent(1);
    if (name === "avg_losing_trade") return strategy.losingTrades === 0 ? Number.NaN : strategy.losingLoss / strategy.losingTrades;
    if (name === "avg_losing_trade_percent") return this.averageStrategyTradePercent(-1);
    if (name === "max_contracts_held_all") return strategy.maxContractsHeld;
    if (name === "max_contracts_held_long") return strategy.maxContractsHeldLong;
    if (name === "max_contracts_held_short") return strategy.maxContractsHeldShort;
    if (name === "max_drawdown") return strategy.maxDrawdown;
    if (name === "max_drawdown_percent") return strategy.maxDrawdownPercent;
    if (name === "max_runup") return strategy.maxRunup;
    if (name === "max_runup_percent") return strategy.maxRunupPercent;
    if (name === "margin_liquidation_price") return this.strategyMarginLiquidationPrice();
    if (name === "equity") return strategy.equity;
    if (name === "initial_capital") return strategy.config.initial_capital;
    if (name === "account_currency") return strategy.config.currency;
    return Number.NaN;
  }

  public queueStrategyOrder(command: "entry" | "order", args: readonly PineValue[]): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) throw new Error("strategy order called outside a strategy declaration");
    const id = pineString(args[0] ?? "");
    if (command === "order" && isStrictPineCompatibility(this.compatibility)
      && args[1] !== "long" && args[1] !== "short") {
      throw new PineRuntimeError("strategy.order direction must be strategy.long or strategy.short", "strategy.order");
    }
    const direction: 1 | -1 = args[1] === "short" || number(args[1]) < 0 ? -1 : 1;
    const specifiedQuantity = number(args[2]);
    const quantity = this.calculateStrategyQuantity(Number.isFinite(specifiedQuantity) ? specifiedQuantity : undefined, number(this.data("close")));
    if (quantity === 0 || (isStrictPineCompatibility(this.compatibility) && !Number.isFinite(quantity))) return null;
    if (isStrictPineCompatibility(this.compatibility)) this.fxRate(`strategy.${command}`);
    if (command === "entry" && this.entryExceedsPyramiding(direction)) return null;
    const limit = number(args[3]);
    const stop = number(args[4]);
    const ocaName = pineString(args[5] ?? "");
    const ocaValue = pineString(args[6] ?? "none");
    if (command === "order" && isStrictPineCompatibility(this.compatibility)
      && ocaValue !== "none" && ocaValue !== "cancel" && ocaValue !== "reduce") {
      throw new PineRuntimeError("strategy.order oca_type must be strategy.oca.none, strategy.oca.cancel, or strategy.oca.reduce", "strategy.order");
    }
    const ocaType = ocaValue === "cancel" || ocaValue === "reduce" ? ocaValue : "none";
    const comment = pineString(args[7] ?? id);
    const alertMessage = pineString(args[8] ?? "");
    const type = Number.isFinite(limit) && Number.isFinite(stop) ? "stop-limit" : Number.isFinite(limit) ? "limit" : Number.isFinite(stop) ? "stop" : "market";
    const nextOrder: MutableStrategyOrder = {
      id,
      command,
      direction,
      quantity,
      type,
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(stop) ? { stop } : {}),
      createdBarIndex: this.barIndex,
      createdTime: this.bars[this.barIndex]?.openTime ?? Number.NaN,
      status: "pending",
      ...(ocaName === "" ? {} : { ocaName, ocaType }),
      comment,
      ...(alertMessage === "" ? {} : { alertMessage }),
      ...(args[9] === true ? { disableAlert: true } : {}),
    };
    if (isStrictPineCompatibility(this.compatibility)) {
      if (strategy.intradayFillLimitHalted === true) {
        nextOrder.status = "cancelled";
        strategy.orders.push(nextOrder);
        return null;
      }
      // Re-sending a pending entry or order id modifies that order rather than adding another.
      const existingIndex = strategy.orders.findIndex((order) => order.command === command && order.id === id && order.status === "pending");
      if (existingIndex >= 0) {
        const previous = strategy.orders[existingIndex]!;
        // A repeated unchanged stop-limit retains its activation; revised
        // direction or trigger prices start a new activation sequence.
        if (previous.type === "stop-limit" && nextOrder.type === "stop-limit"
          && previous.direction === nextOrder.direction && previous.stop === nextOrder.stop
          && previous.limit === nextOrder.limit && previous.stopTriggered === true) {
          nextOrder.stopTriggered = true;
        }
        // Replacing the record also drops stale optional prices and controls.
        strategy.orders[existingIndex] = nextOrder;
        return null;
      }
    }
    strategy.orders.push(nextOrder);
    return null;
  }

  /** True when another same-direction entry would exceed `strategy(pyramiding)`. */
  private entryExceedsPyramiding(direction: 1 | -1): boolean {
    const strategy = this.strategy!;
    if (strategy.positionSize === 0 || Math.sign(strategy.positionSize) !== direction) return false;
    return strategy.openTrades.filter((trade) => trade.direction === direction).length >= strategy.config.pyramiding;
  }

  private marketEntryExceedsPyramiding(order: MutableStrategyOrder): boolean {
    // Price entries already passed admission. Orders placed together can each
    // fill if triggered, even when another fill has since reached the limit.
    return order.command === "entry" && order.type === "market" && this.entryExceedsPyramiding(order.direction);
  }

  public convertStrategyCurrency(value: PineValue | undefined, target: "account" | "symbol"): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined && !this.requestConversionEnabled) return Number.NaN;
    const numericValue = number(value);
    if (!Number.isFinite(numericValue)) return Number.NaN;
    if (!isStrictPineCompatibility(this.compatibility)) {
      const symbolCurrency = this.symbolInfo.currency;
      return typeof symbolCurrency === "string" && symbolCurrency !== strategy?.config.currency ? Number.NaN : numericValue;
    }
    const selection = this.fxSelection;
    if (selection.kind !== "rate" && selection.kind !== "identity") return Number.NaN;
    const converted = target === "account" ? numericValue * selection.rate : numericValue / selection.rate;
    return Number.isFinite(converted) ? converted : Number.NaN;
  }

  public defaultStrategyEntryQuantity(fillPriceValue: PineValue | undefined): PineValue {
    if (this.strategy === undefined) return Number.NaN;
    const fillPrice = number(fillPriceValue);
    return Number.isFinite(fillPrice) && fillPrice > 0 ? this.calculateStrategyQuantity(undefined, fillPrice) : Number.NaN;
  }

  public calculateStrategyQuantity(specifiedQuantity: number | undefined, fillPrice: number): number {
    const strategy = this.strategy!;
    let quantity = specifiedQuantity === undefined ? strategy.config.default_qty_value : Math.abs(specifiedQuantity);
    const unitCost = isStrictPineCompatibility(this.compatibility) && specifiedQuantity === undefined
      && strategy.config.default_qty_type !== "fixed"
      ? fillPrice * strategyPointValue(this.symbolInfo) * this.fxRate("strategy.default_entry_qty")
      : isStrictPineCompatibility(this.compatibility) ? fillPrice * strategyPointValue(this.symbolInfo) : fillPrice;
    if (isStrictPineCompatibility(this.compatibility) && specifiedQuantity === undefined
      && strategy.config.default_qty_type !== "fixed" && (!Number.isFinite(unitCost) || unitCost <= 0)) return Number.NaN;
    if (specifiedQuantity === undefined && strategy.config.default_qty_type === "cash") quantity /= unitCost;
    else if (specifiedQuantity === undefined && strategy.config.default_qty_type === "percent_of_equity") quantity = strategy.equity * quantity / 100 / unitCost;
    if (isStrictPineCompatibility(this.compatibility) && !Number.isFinite(quantity)) return Number.NaN;
    if (isStrictPineCompatibility(this.compatibility) && quantity < 0) return 0;
    if (!isStrictPineCompatibility(this.compatibility)) return Math.floor(Math.max(0, quantity) * 1_000_000) / 1_000_000;
    return floorStrategyQuantity(quantity, this.symbolInfo.mincontract);
  }

  public closedStrategyTradeValue(name: string, indexValue: PineValue | undefined): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) return Number.NaN;
    if (name === "first_index") return isStrictPineCompatibility(this.compatibility) ? strategy.closedTradeFirstIndex : 0;
    const strictIndex = isStrictPineCompatibility(this.compatibility) && certifiedClosedTradeIndexNames.has(name);
    const index = strategyTradeIndex(indexValue, strictIndex);
    const retainedIndex = index === undefined ? undefined : isStrictPineCompatibility(this.compatibility)
      ? index - strategy.closedTradeFirstIndex
      : index;
    const trade = retainedIndex === undefined ? undefined : strategy.closedTrades[retainedIndex];
    if (trade === undefined) return ["entry_id", "entry_comment", "exit_id", "exit_comment"].includes(name) ? "" : absentTradeNumber(name, strictIndex);
    const pointValue = strategyPointValue(this.symbolInfo);
    const notional = trade.quantity * trade.entryPrice * pointValue;
    const costBasis = isStrictPineCompatibility(this.compatibility)
      ? (trade.entryBasis ?? notional) + trade.entryCommission
      : notional + (trade.commission ?? 0) / 2;
    const values: Readonly<Record<string, PineValue>> = {
      profit: trade.profit ?? Number.NaN,
      profit_percent: costBasis > 0 ? (trade.profit ?? 0) * 100 / costBasis : Number.NaN,
      size: trade.direction * trade.quantity,
      commission: trade.commission ?? Number.NaN,
      entry_price: trade.entryPrice,
      entry_bar_index: trade.entryBarIndex,
      entry_id: trade.entryId,
      entry_comment: trade.entryComment ?? trade.entryId,
      entry_time: trade.entryTime,
      exit_price: trade.exitPrice ?? Number.NaN,
      exit_bar_index: trade.exitBarIndex ?? Number.NaN,
      exit_id: trade.pineExitId ?? trade.exitId ?? "",
      exit_comment: trade.exitComment ?? trade.exitId ?? "",
      exit_time: trade.exitTime ?? Number.NaN,
      max_drawdown: trade.maxDrawdown,
      max_drawdown_percent: strategyTradeExcursionPercent(trade.maxDrawdown, costBasis, this.compatibility),
      max_runup: trade.maxRunup,
      max_runup_percent: strategyTradeExcursionPercent(trade.maxRunup, costBasis, this.compatibility),
    };
    return values[name] ?? Number.NaN;
  }

  public openStrategyTradeValue(name: string, indexValue: PineValue | undefined): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) return Number.NaN;
    if (name === "capital_held") {
      if (!isStrictPineCompatibility(this.compatibility) && (strategy.openTrades.length === 0 || (strategy.config.margin_long === 100 && strategy.config.margin_short === 100))) return Number.NaN;
      const pointValue = isStrictPineCompatibility(this.compatibility) ? strategyPointValue(this.symbolInfo) : 1;
      return strategy.openTrades.reduce((sum, trade) => sum + (trade.entryBasis ?? trade.quantity * trade.entryPrice * pointValue) * (trade.direction === 1 ? strategy.config.margin_long : strategy.config.margin_short) / 100, 0);
    }
    const strictIndex = isStrictPineCompatibility(this.compatibility) && certifiedOpenTradeIndexNames.has(name);
    const index = strategyTradeIndex(indexValue, strictIndex);
    const trade = index === undefined ? undefined : strategy.openTrades[index];
    if (trade === undefined) return ["entry_id", "entry_comment"].includes(name) ? "" : absentTradeNumber(name, strictIndex);
    const close = number(this.data("close"));
    const pointValue = strategyPointValue(this.symbolInfo);
    const exitCommission = this.strategyLegCommission(trade.quantity, close);
    const profit = (close - trade.entryPrice) * trade.direction * trade.quantity * pointValue * this.fxRate("strategy.opentrades") - trade.entryCommission - exitCommission;
    const notional = trade.quantity * trade.entryPrice * pointValue;
    const costBasis = (isStrictPineCompatibility(this.compatibility) ? trade.entryBasis ?? notional : notional)
      + trade.entryCommission;
    const values: Readonly<Record<string, PineValue>> = {
      profit,
      profit_percent: costBasis > 0 ? profit * 100 / costBasis : Number.NaN,
      size: trade.direction * trade.quantity,
      commission: trade.entryCommission,
      entry_price: trade.entryPrice,
      entry_bar_index: trade.entryBarIndex,
      entry_id: trade.entryId,
      entry_comment: trade.entryComment ?? trade.entryId,
      entry_time: trade.entryTime,
      max_drawdown: trade.maxDrawdown,
      max_drawdown_percent: strategyTradeExcursionPercent(trade.maxDrawdown, costBasis, this.compatibility),
      max_runup: trade.maxRunup,
      max_runup_percent: strategyTradeExcursionPercent(trade.maxRunup, costBasis, this.compatibility),
    };
    return values[name] ?? Number.NaN;
  }

  public queueStrategyExit(args: readonly PineValue[]): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) throw new Error("strategy exit called outside a strategy declaration");
    if (isStrictPineCompatibility(this.compatibility) && strategy.intradayFillLimitHalted === true) return null;
    const id = pineString(args[0] ?? "exit");
    const targetEntryId = pineString(args[1] ?? "");
    const quantity = number(args[2]);
    const quantityPercent = number(args[3]);
    const profitTicks = number(args[4]);
    const limit = number(args[5]);
    const lossTicks = number(args[6]);
    const stop = number(args[7]);
    const trailPrice = number(args[8]);
    const trailPoints = number(args[9]);
    const trailOffset = number(args[10]);
    if (isStrictPineCompatibility(this.compatibility)) {
      if (Number.isFinite(quantity) && quantity <= 0) {
        throw new PineRuntimeError("strategy.exit qty must be positive", "strategy.exit");
      }
      if (!Number.isFinite(quantity) && Number.isFinite(quantityPercent) && quantityPercent <= 0) {
        throw new PineRuntimeError("strategy.exit qty_percent must be positive", "strategy.exit");
      }
      if (Number.isFinite(trailOffset) && trailOffset < 0) {
        throw new PineRuntimeError("strategy.exit trail_offset must not be negative", "strategy.exit");
      }
      const hasFixedLevel = [profitTicks, limit, lossTicks, stop].some(Number.isFinite);
      const hasTrailingActivation = Number.isFinite(trailPrice) || Number.isFinite(trailPoints);
      const hasTrailingOffset = Number.isFinite(trailOffset);
      if (!hasFixedLevel && !(hasTrailingActivation && hasTrailingOffset)) {
        throw new PineRuntimeError("strategy.exit requires a profit, loss, limit, stop, or complete trailing stop", "strategy.exit");
      }
      if (hasTrailingActivation !== hasTrailingOffset) {
        throw new PineRuntimeError("strategy.exit trailing stop requires trail_offset and trail_price or trail_points", "strategy.exit");
      }
      if (Number.isFinite(quantity) && floorStrategyQuantity(quantity, this.symbolInfo.mincontract) === 0) return null;
    }
    const ocaName = pineString(args[11] ?? "");
    const comment = pineString(args[12] ?? id);
    const order: MutableStrategyOrder = {
      id,
      command: "exit",
      direction: strategy.positionSize < 0 ? 1 : -1,
      quantity: Number.isFinite(quantity) ? (isStrictPineCompatibility(this.compatibility) ? floorStrategyQuantity(Math.abs(quantity), this.symbolInfo.mincontract) : Math.abs(quantity)) : 0,
      type: "market",
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(stop) ? { stop } : {}),
      createdBarIndex: this.barIndex,
      createdTime: this.bars[this.barIndex]?.openTime ?? Number.NaN,
      status: "pending",
      targetEntryId,
      ...(Number.isFinite(quantityPercent) ? { quantityPercent } : {}),
      ...(Number.isFinite(profitTicks) ? { profitTicks } : {}),
      ...(Number.isFinite(lossTicks) ? { lossTicks } : {}),
      ...(Number.isFinite(trailPrice) ? { trailPrice } : {}),
      ...(Number.isFinite(trailPoints) ? { trailPoints } : {}),
      ...(Number.isFinite(trailOffset) ? { trailOffset } : {}),
      ...(ocaName === "" ? {} : { ocaName, ocaType: "reduce" as const }),
      comment,
      commentProfit: pineString(args[13] ?? comment),
      commentLoss: pineString(args[14] ?? comment),
      commentTrailing: pineString(args[15] ?? comment),
      alertMessage: pineString(args[16] ?? ""),
      alertProfit: pineString(args[17] ?? args[16] ?? ""),
      alertLoss: pineString(args[18] ?? args[16] ?? ""),
      alertTrailing: pineString(args[19] ?? args[16] ?? ""),
      ...(args[20] === true ? { disableAlert: true } : {}),
    };
    if (isStrictPineCompatibility(this.compatibility) && !strategy.config.calc_on_order_fills) {
      this.queuePublicStrategyExit(order);
      return null;
    }
    let priorTrail: MutableStrategyOrder | undefined;
    for (const existing of strategy.orders) {
      if (existing.command === "exit" && existing.status === "pending" && existing.id === id && existing.targetEntryId === targetEntryId) {
        priorTrail = existing;
        existing.status = "cancelled";
      }
    }
    if (priorTrail?.trailArmed === true) {
      order.trailArmed = true;
      if (priorTrail.trailPeak !== undefined) order.trailPeak = priorTrail.trailPeak;
    }
    strategy.orders.push(order);
    return null;
  }

  private queuePublicStrategyExit(order: MutableStrategyOrder): void {
    const strategy = this.strategy!;
    const keyMatches = (intent: MutablePublicExitIntent) => intent.id === order.id && intent.targetEntryId === order.targetEntryId;
    const existing = strategy.publicExitIntents!.find(keyMatches);
    if (existing === undefined) {
      const matchesOpen = strategy.openTrades.some((trade) => order.targetEntryId === "" || trade.entryId === order.targetEntryId);
      const matchesPending = strategy.orders.some((pending) => pending.status === "pending"
        && (pending.command === "entry" || pending.command === "order")
        && (order.targetEntryId === "" || pending.id === order.targetEntryId));
      if (!matchesOpen && !matchesPending) return;
      strategy.publicExitIntents!.push({
        version: 1, id: order.id, targetEntryId: order.targetEntryId ?? "",
        createdBarIndex: this.barIndex, order, completedTradeIds: [], ocaCapsByTrade: {},
      });
    } else {
      const old = existing.order;
      const changed = publicExitContractFields.some((field) => old[field] !== order[field]);
      if (changed) {
        const current = strategy.orders.filter((pending) => pending.command === "exit" && pending.status === "pending"
          && pending.id === order.id && pending.targetEntryId === order.targetEntryId
          && pending.publicExitReservedQuantity !== undefined);
        for (const pending of current) {
          if (pending.targetTradeId !== undefined && pending.publicExitOcaCap !== undefined) {
            existing.ocaCapsByTrade[pending.targetTradeId] = pending.publicExitOcaCap;
          }
          const retainedTrail = old.trailPrice === order.trailPrice && old.trailPoints === order.trailPoints
            && old.trailOffset === order.trailOffset && pending.trailArmed === true;
          const replacement: MutableStrategyOrder = {
            ...order,
            targetTradeId: pending.targetTradeId!,
            publicExitReservedQuantity: pending.publicExitReservedQuantity!,
            ...(pending.publicExitAllocationCeiling === undefined ? {} : { publicExitAllocationCeiling: pending.publicExitAllocationCeiling }),
            ...(pending.publicExitOcaCap === undefined ? {} : { publicExitOcaCap: pending.publicExitOcaCap }),
            ...(retainedTrail ? { trailArmed: true, ...(pending.trailPeak === undefined ? {} : { trailPeak: pending.trailPeak }) } : {}),
          };
          const index = strategy.orders.indexOf(pending);
          strategy.orders.splice(index, 1, { ...pending, status: "cancelled" }, replacement);
        }
      }
      // A re-sent exit also covers same-id entries placed since it was first sent.
      Object.assign(existing, { order, createdBarIndex: this.barIndex });
      this.rebuildPublicExitReservations(existing);
      return;
    }
    this.rebuildPublicExitReservations();
  }

  private rebuildPublicExitReservations(reallocateIntent?: MutablePublicExitIntent): void {
    if (!isStrictPineCompatibility(this.compatibility)) return;
    const strategy = this.strategy!;
    // Internal synthetic fill transitions can carry legacy exit orders without
    // the public reservation ledger. Ordinary strict sessions always own it.
    if (strategy.publicExitIntents === undefined || strategy.config.calc_on_order_fills) return;
    const openTradeById = new Map(strategy.openTrades.map((trade) => [trade.id, trade]));
    const closedTradeById = new Map(strategy.closedTrades.map((trade) => [trade.id, trade]));
    for (const order of strategy.orders) {
      if (order.command !== "exit" || order.status !== "pending" || order.publicExitReservedQuantity === undefined
        || order.targetTradeId === undefined || openTradeById.has(order.targetTradeId)) continue;
      // FIFO changes trade attribution, not the already reserved exit's
      // quantity or price basis. Its source entry can be fully attributed to
      // an earlier close while the exit still owns a claim on the position.
      if (strategy.config.close_entries_rule === "FIFO" && strategy.openTrades.some((trade) => trade.direction === -order.direction)) continue;
      order.publicExitRetired = true;
      order.publicExitReservedQuantity = 0;
      order.quantity = 0;
    }
    const claimed = new Map<string, number>();
    for (const intent of strategy.publicExitIntents!) {
      for (const trade of strategy.openTrades) {
        if (intent.targetEntryId !== "" && trade.entryId !== intent.targetEntryId) continue;
        if (intent.targetEntryId !== "" && (trade.entryOrderCreatedBarIndex ?? trade.entryBarIndex) > intent.createdBarIndex) continue;
        if (intent.completedTradeIds.includes(trade.id)) continue;
        const existing = strategy.orders.find((candidate) => candidate.command === "exit" && candidate.status === "pending"
          && candidate.publicExitReservedQuantity !== undefined && candidate.id === intent.id
          && candidate.targetEntryId === intent.targetEntryId && candidate.targetTradeId === trade.id);
        const basis = trade.originalQuantity ?? trade.quantity;
        const requested = Number.isFinite(intent.order.quantity) && intent.order.quantity > 0
          ? intent.order.quantity
          : intent.order.quantityPercent === undefined ? basis : basis * Math.max(0, Math.min(100, intent.order.quantityPercent)) / 100;
        const available = Math.max(0, trade.quantity - (claimed.get(trade.id) ?? 0));
        const ocaCap = existing?.publicExitOcaCap ?? intent.ocaCapsByTrade[trade.id] ?? Number.POSITIVE_INFINITY;
        const allocationCeiling = reallocateIntent === intent ? Number.POSITIVE_INFINITY
          : existing?.publicExitAllocationCeiling ?? Number.POSITIVE_INFINITY;
        const allocated = Math.min(requested, available, ocaCap, allocationCeiling);
        claimed.set(trade.id, (claimed.get(trade.id) ?? 0) + allocated);
        if (existing !== undefined) {
          existing.quantity = allocated;
          existing.publicExitReservedQuantity = allocated;
          if (reallocateIntent === intent) existing.publicExitAllocationCeiling = allocated;
          continue;
        }
        strategy.orders.push({
          ...intent.order,
          direction: trade.direction === 1 ? -1 : 1,
          quantity: allocated,
          targetTradeId: trade.id,
          publicExitReservedQuantity: allocated,
          publicExitAllocationCeiling: allocated,
          ...(Number.isFinite(ocaCap) ? { publicExitOcaCap: ocaCap } : {}),
        });
      }
    }
    let unclaimedPosition = Math.abs(strategy.positionSize);
    const unclaimedSource = new Map<string, number>();
    for (const order of strategy.orders) {
      if (order.command !== "exit" || order.status !== "pending" || order.publicExitReservedQuantity === undefined
        || order.publicExitRetired === true) continue;
      const sourceId = order.targetTradeId;
      const sourceTrade = openTradeById.get(sourceId ?? "");
      const closedSource = sourceTrade === undefined ? closedTradeById.get(sourceId ?? "") : undefined;
      const sourceCapacity = sourceTrade?.quantity ?? closedSource?.originalQuantity ?? closedSource?.quantity ?? 0;
      const sourceAvailable = sourceId === undefined ? 0 : unclaimedSource.get(sourceId) ?? sourceCapacity;
      const quantity = Math.min(order.publicExitReservedQuantity, unclaimedPosition, sourceAvailable);
      if (quantity < order.publicExitReservedQuantity) {
        order.quantity = quantity;
        order.publicExitReservedQuantity = quantity;
        order.publicExitAllocationCeiling = Math.min(order.publicExitAllocationCeiling ?? quantity, quantity);
      }
      // Exact decimal arithmetic keeps percent-of-equity sizes from leaving
      // a sub-step remainder that the quantity floor would turn into dust.
      if (sourceId !== undefined) unclaimedSource.set(sourceId, decimalQuantitySum(sourceAvailable, -quantity));
      unclaimedPosition = decimalQuantitySum(unclaimedPosition, -quantity);
    }
  }

  private finishPublicExit(order: MutableStrategyOrder): void {
    if (order.publicExitReservedQuantity === undefined || order.targetTradeId === undefined) return;
    const intent = this.strategy!.publicExitIntents!.find((candidate) => candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId);
    if (intent !== undefined && !intent.completedTradeIds.includes(order.targetTradeId)) intent.completedTradeIds.push(order.targetTradeId);
    this.rebuildPublicExitReservations();
  }

  public queueStrategyClose(all: boolean, args: readonly PineValue[]): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) throw new Error("strategy close called outside a strategy declaration");
    if (isStrictPineCompatibility(this.compatibility) && strategy.intradayFillLimitHalted === true) return null;
    const targetEntryId = all ? undefined : pineString(args[0] ?? "");
    const matching = strategy.openTrades.filter((trade) => targetEntryId === undefined || trade.entryId === targetEntryId);
    if (matching.length === 0) return null;
    const quantity = all ? 0 : number(args[2]);
    const quantityPercent = all ? Number.NaN : number(args[3]);
    if (!all && isStrictPineCompatibility(this.compatibility) && Number.isFinite(quantity) && quantity !== 0
      && floorStrategyQuantity(Math.abs(quantity), this.symbolInfo.mincontract) === 0) return null;
    const immediately = (all ? args[2] : args[5]) === true;
    const orderId = all ? "close_all" : `close_${targetEntryId ?? ""}`;
    const pineExitId = all ? "Close position order" : `Close entry(s) order ${targetEntryId ?? ""}`;
    const defaultComment = isStrictPineCompatibility(this.compatibility) ? pineExitId : orderId;
    const comment = pineString((all ? args[0] : args[1]) ?? defaultComment);
    const alertMessage = pineString(all ? args[1] ?? "" : args[4] ?? "");
    strategy.orders.push({
      id: orderId,
      command: all ? "close_all" : "close",
      direction: strategy.positionSize < 0 ? 1 : -1,
      quantity: Number.isFinite(quantity) ? (isStrictPineCompatibility(this.compatibility) ? floorStrategyQuantity(Math.abs(quantity), this.symbolInfo.mincontract) : Math.abs(quantity)) : 0,
      type: "market",
      createdBarIndex: this.barIndex,
      createdTime: this.bars[this.barIndex]?.openTime ?? Number.NaN,
      status: "pending",
      ...(targetEntryId === undefined ? {} : { targetEntryId }),
      ...(Number.isFinite(quantityPercent) ? { quantityPercent } : {}),
      ...(immediately ? { immediately: true } : {}),
      comment,
      ...(alertMessage === "" ? {} : { alertMessage }),
      ...((all ? args[3] : args[6]) === true ? { disableAlert: true } : {}),
      intendedTradeIds: Object.freeze(matching.map((trade) => trade.id)),
    });
    return null;
  }

  public cancelStrategyOrders(id?: string): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) throw new Error("strategy cancellation called outside a strategy declaration");
    for (const order of strategy.orders) {
      const matches = id === undefined
        ? isStrictPineCompatibility(this.compatibility) || order.command === "entry" || order.command === "order"
        : order.id === id;
      if (order.status === "pending" && matches) order.status = "cancelled";
    }
    if (isStrictPineCompatibility(this.compatibility)) {
      for (let index = strategy.publicExitIntents!.length - 1; index >= 0; index -= 1) {
        if (id === undefined || strategy.publicExitIntents![index]!.id === id) strategy.publicExitIntents!.splice(index, 1);
      }
      this.rebuildPublicExitReservations();
    }
    return null;
  }

  public setStrategyRiskRule(name: string, args: readonly PineValue[]): PineValue {
    const strategy = this.strategy;
    if (strategy === undefined) return null;
    if (isStrictPineCompatibility(this.compatibility)) {
      const numeric = (value: PineValue | undefined, integerOnly = false): number => {
        const parsed = number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || (integerOnly && !Number.isSafeInteger(parsed))) {
          throw new PineRuntimeError(`strategy.risk.${name} requires a nonnegative ${integerOnly ? "integer" : "finite number"}`, `strategy.risk.${name}`);
        }
        return parsed;
      };
      const message = args[name === "max_drawdown" || name === "max_intraday_loss" ? 2 : 1];
      if (message !== undefined && name !== "allow_entry_in" && name !== "max_position_size" && typeof message !== "string") {
        throw new PineRuntimeError(`strategy.risk.${name} alert_message must be a string`, `strategy.risk.${name}`);
      }
      if (name === "allow_entry_in") {
        if (args[0] !== "long" && args[0] !== "short" && args[0] !== "all") throw new PineRuntimeError("strategy.risk.allow_entry_in requires a strategy.direction value", "strategy.risk.allow_entry_in");
        const previous = strategy.riskRules.allowEntryIn;
        strategy.riskRules.allowEntryIn = previous === undefined || previous === "all" ? args[0]
          : args[0] === "all" || previous === args[0] ? previous : "none";
      } else if (name === "max_position_size") strategy.riskRules.maxPositionSize = Math.min(strategy.riskRules.maxPositionSize ?? Number.POSITIVE_INFINITY, numeric(args[0]));
      else if (name === "max_intraday_filled_orders") {
        this.requireStrategyRiskPeriod(name);
        const value = numeric(args[0], true);
        if (value === 0) {
          throw new PineRuntimeError("Invalid value of the 'count' argument (0) in the 'strategy.risk.max_intraday_filled_orders' function. It must be > 0.", "strategy.risk.max_intraday_filled_orders");
        }
        if (value < (strategy.riskRules.maxIntradayFilledOrders ?? Number.POSITIVE_INFINITY)) {
          strategy.riskRules.maxIntradayFilledOrders = value;
          if (message === undefined) delete strategy.riskRules.maxIntradayFilledOrdersAlertMessage;
          else strategy.riskRules.maxIntradayFilledOrdersAlertMessage = message as string;
        }
      } else if (name === "max_cons_loss_days") {
        this.requireStrategyRiskPeriod(name);
        const value = numeric(args[0], true);
        if (value < (strategy.riskRules.maxConsecutiveLossDays ?? Number.POSITIVE_INFINITY)) {
          strategy.riskRules.maxConsecutiveLossDays = value;
          if (message === undefined) delete strategy.riskRules.maxConsecutiveLossDaysAlertMessage;
          else strategy.riskRules.maxConsecutiveLossDaysAlertMessage = message as string;
        }
      } else if (name === "max_drawdown" || name === "max_intraday_loss") {
        if (name === "max_intraday_loss") this.requireStrategyRiskPeriod(name);
        const value = numeric(args[0]);
        if (args[1] !== "cash" && args[1] !== "percent_of_equity") throw new PineRuntimeError(`strategy.risk.${name} requires strategy.cash or strategy.percent_of_equity`, `strategy.risk.${name}`);
        if (args[1] === "percent_of_equity" && value > 100) throw new PineRuntimeError(`strategy.risk.${name} percent value must not exceed 100`, `strategy.risk.${name}`);
        const rule = { value, type: args[1] as "cash" | "percent_of_equity", ...(message === undefined ? {} : { alertMessage: message as string }) };
        if (name === "max_drawdown" && rule.type === "percent_of_equity") {
          if (value < (strategy.riskRules.maxDrawdownPercentRule?.value ?? Number.POSITIVE_INFINITY)) strategy.riskRules.maxDrawdownPercentRule = { ...rule, type: "percent_of_equity" };
        } else if (name === "max_intraday_loss" && rule.type === "percent_of_equity") {
          if (value < (strategy.riskRules.maxIntradayLossPercentRule?.value ?? Number.POSITIVE_INFINITY)) strategy.riskRules.maxIntradayLossPercentRule = { ...rule, type: "percent_of_equity" };
        } else if (name === "max_drawdown") {
          if (value < (strategy.riskRules.maxDrawdown?.value ?? Number.POSITIVE_INFINITY)) strategy.riskRules.maxDrawdown = rule;
        } else if (value < (strategy.riskRules.maxIntradayLoss?.value ?? Number.POSITIVE_INFINITY)) strategy.riskRules.maxIntradayLoss = rule;
      }
      return null;
    }
    if (name === "allow_entry_in") {
      const value = pineString(args[0] ?? "all");
      strategy.riskRules.allowEntryIn = value === "long" || value === "short" ? value : "all";
    } else if (name === "max_position_size") strategy.riskRules.maxPositionSize = Math.max(0, number(args[0] ?? 0));
    else if (name === "max_intraday_filled_orders") strategy.riskRules.maxIntradayFilledOrders = Math.max(0, integer(args[0] ?? 0));
    else if (name === "max_cons_loss_days") strategy.riskRules.maxConsecutiveLossDays = Math.max(0, integer(args[0] ?? 0));
    else if (name === "max_drawdown" || name === "max_intraday_loss") {
      const value = Math.max(0, number(args[0] ?? 0));
      const type = args[1] === "percent_of_equity" ? "percent_of_equity" : "cash";
      if (name === "max_drawdown") strategy.riskRules.maxDrawdown = { value, type };
      else strategy.riskRules.maxIntradayLoss = { value, type };
    }
    return null;
  }

  public processStrategyOrders(): void {
    this.historicalRiskClosePending = false;
    const strategy = this.strategy;
    const parentBar = this.bars[this.barIndex];
    if (strategy === undefined || parentBar === undefined) return;
    const providedPoints = strategy.config.use_bar_magnifier
      ? this.host.executionPoints()
      : [];
    const magnifiedBars = strategy.config.use_bar_magnifier
      ? this.host.executionBars()
      : [];
    const magnifiedPoints = providedPoints.length > 0
      ? providedPoints
      : magnifiedBars.flatMap((bar, index) => {
          const next = magnifiedBars[index + 1];
          const previous = magnifiedBars[index - 1];
          return legacyIntrabarPoints(bar, {
            parentTime: parentBar.openTime,
            intervalEnd:
              bar.closeTime ??
              next?.openTime ??
              parentBar.closeTime ??
              bar.openTime + 1,
            startsGap: Boolean(previous && previous.close !== bar.open),
          });
        });
    if (magnifiedPoints.length === 0) {
      if (isStrictPineCompatibility(this.compatibility) && !strategy.config.calc_on_order_fills
        && (strategy.riskRules.maxIntradayFilledOrders !== undefined || strategy.riskRules.maxIntradayLoss !== undefined
          || strategy.riskRules.maxIntradayLossPercentRule !== undefined)) {
        const path = strategyExcursionPath(parentBar, false);
        let open = parentBar.open;
        this.historicalRiskClosePending = true;
        for (const [index, close] of path.entries()) {
          // Each historical broker tick receives the whole preceding price move.
          let phase: "open" | "extreme" | "close" = "extreme";
          if (index === 0) phase = "open";
          else if (index === path.length - 1) phase = "close";
          this.processStrategyOrdersForBar({ ...parentBar, open, high: Math.max(open, close), low: Math.min(open, close), close }, true, phase);
          open = close;
        }
        return;
      }
      this.processStrategyOrdersForBar(parentBar);
      return;
    }

    let previous: MarketExecutionPoint | undefined;
    for (const point of magnifiedPoints) {
      const beginsSegment = previous !== undefined && point.kind !== "open";
      const open = beginsSegment ? previous!.price : point.price;
      this.processStrategyOrdersForBar({
        open,
        high: Math.max(open, point.price),
        low: Math.min(open, point.price),
        close: point.price,
        openTime: beginsSegment ? previous!.timestamp : point.timestamp,
        closeTime: point.timestamp,
        volume: 0,
      }, true);
      previous = point;
    }
  }

  private processStrategyOrdersForBar(bar: MarketBar, orderedPath = false, historicalRiskTick?: "open" | "extreme" | "close"): void {
    const strategy = this.strategy!;
    const strict = isStrictPineCompatibility(this.compatibility);
    const excursionPath = strict ? strategyExcursionPath(bar, orderedPath) : undefined;
    let excursionOffset = 0;
    const beforeFill = (price: number): void => {
      if (excursionPath === undefined) return;
      const fillOffset = strategyExcursionFillOffset(excursionPath, excursionOffset, price);
      const exposed = strategyExcursionSegment(bar, excursionPath, excursionOffset, fillOffset);
      if (fillOffset === excursionOffset) this.updateStrategyTradeExcursions(exposed);
      else this.updateStrategyEquityExcursions(exposed);
      excursionOffset = fillOffset;
    };
    if (isStrictPineCompatibility(this.compatibility)) {
      let dailyRule: string | undefined;
      if (strategy.riskRules.maxIntradayFilledOrders !== undefined) dailyRule = "max_intraday_filled_orders";
      else if (strategy.riskRules.maxIntradayLoss !== undefined || strategy.riskRules.maxIntradayLossPercentRule !== undefined) dailyRule = "max_intraday_loss";
      else if (strategy.riskRules.maxConsecutiveLossDays !== undefined) dailyRule = "max_cons_loss_days";
      if (dailyRule !== undefined) this.requireStrategyRiskPeriod(dailyRule, bar.openTime);
    }
    // A next-open fill changes which quantity owns the current candle's range.
    // The sealed lane retains its historical pre-fill excursion accounting.
    if (!isStrictPineCompatibility(this.compatibility)) this.updateStrategyTradeExcursions(bar);
    this.markStrategyToMarket(bar.open);
    if (historicalRiskTick === undefined || historicalRiskTick === "open") {
      this.beginStrategyDayAt(bar.openTime);
      this.evaluateStrategyRiskHalts(historicalRiskTick === undefined);
      this.processStrategyRiskHalt(bar.open, bar.openTime, beforeFill, historicalRiskTick === undefined);
    }
    if (historicalRiskTick === undefined) this.processStrategyMarginCall(bar, "open", beforeFill);
    this.rebuildPublicExitReservations();
    let adverseMarginProcessed = false;
    for (const order of strategy.orders) {
      if (order.status !== "pending" || order.createdBarIndex >= this.barIndex) continue;
      if (order.command === "exit") {
        if (order.publicExitRetired === true) {
          order.status = "cancelled";
          continue;
        }
        if (order.publicExitReservedQuantity === 0) continue;
        this.expandStrategyExitOrder(order);
        const exitDirection = strategy.positionSize === 0 ? 1 : Math.sign(strategy.positionSize) as 1 | -1;
        const adverseFirst = orderedPath
          ? strategyOrderedSegmentIsAdverse(bar, exitDirection)
          : this.strategyAdverseFirst(bar, exitDirection);
        if (historicalRiskTick === undefined && !adverseMarginProcessed && strategy.positionSize !== 0 && adverseFirst) {
          this.processStrategyMarginCall(bar, "extreme", beforeFill);
          adverseMarginProcessed = true;
          if (order.status !== "pending") continue;
        }
        const openOnlyBar: MarketBar = { ...bar, high: bar.open, low: bar.open, close: bar.open };
        const openTrigger = this.strategyExitTrigger(order, openOnlyBar, orderedPath);
        const trigger = openTrigger === undefined
          ? this.strategyExitTrigger(order, bar, orderedPath)
          : { ...openTrigger, price: bar.open };
        if (trigger === undefined) continue;
        beforeFill(trigger.price);
        const positionBeforeFill = strategy.positionSize;
        order.direction = trigger.direction;
        order.status = "filled";
        const fillPrice = this.strategyExitFillPrice(trigger.price, trigger.direction, trigger.kind);
        order.fillPrice = fillPrice;
        order.fillBarIndex = this.barIndex;
        const fillTime = historicalRiskTick ? bar.openTime : this.strategyFillTime(bar, trigger.price);
        order.fillTime = fillTime;
        const filledQuantity = this.executeStrategyExit(order, fillPrice, fillTime, trigger.kind);
        const alertMessage = trigger.kind === "profit" ? order.alertProfit : trigger.kind === "loss" ? order.alertLoss : order.alertTrailing;
        if (alertMessage !== undefined) order.alertMessage = alertMessage;
        this.applyStrategyOcaFill(order, filledQuantity);
        if (isStrictPineCompatibility(this.compatibility)) this.finishStrategyRiskFill(fillPrice, fillTime, positionBeforeFill, beforeFill);
        else {
          strategy.intradayFills += 1;
          this.markStrategyToMarket(bar.close);
        }
        continue;
      }
      let fillPrice: number | undefined;
      const tickValue = number(this.symbolInfo.mintick ?? 0.01);
      const tick = Number.isFinite(tickValue) ? tickValue : 0;
      const limitVerification = strategy.config.backtest_fill_limits_assumption * tick;
      if (order.type === "market") fillPrice = bar.open;
      else if (order.type === "limit" && order.limit !== undefined) {
        const verificationPrice = order.limit - order.direction * limitVerification;
        if (order.direction === 1 ? bar.open <= verificationPrice : bar.open >= verificationPrice) fillPrice = bar.open;
        else if (order.direction === 1 ? bar.low <= verificationPrice : bar.high >= verificationPrice) fillPrice = order.limit;
      }
      else if (order.type === "stop" && order.stop !== undefined) {
        if (order.direction === 1 ? bar.open >= order.stop : bar.open <= order.stop) fillPrice = bar.open;
        else if (order.direction === 1 ? bar.high >= order.stop : bar.low <= order.stop) fillPrice = order.stop;
      }
      else if (order.type === "stop-limit" && order.stop !== undefined && order.limit !== undefined) {
        const verificationPrice = order.limit - order.direction * limitVerification;
        if (excursionPath !== undefined) {
          fillPrice = strictStopLimitFill(order, order.stop, order.limit, verificationPrice, excursionPath);
        } else {
          const previouslyTriggered = order.stopTriggered === true;
          const stopTriggeredAtOpen = !previouslyTriggered
            && (order.direction === 1 ? bar.open >= order.stop : bar.open <= order.stop);
          if (stopTriggeredAtOpen) order.stopTriggered = true;
          if (order.stopTriggered !== true && (order.direction === 1 ? bar.high >= order.stop : bar.low <= order.stop)) order.stopTriggered = true;
          if ((previouslyTriggered || stopTriggeredAtOpen) && (order.direction === 1 ? bar.open <= verificationPrice : bar.open >= verificationPrice)) fillPrice = bar.open;
          else if (!stopTriggeredAtOpen && order.stopTriggered === true) {
            if (orderedPath && !previouslyTriggered) {
              if (order.direction === 1 ? order.stop <= verificationPrice : order.stop >= verificationPrice) fillPrice = order.stop;
              else if (order.direction === 1 ? bar.close <= verificationPrice : bar.close >= verificationPrice) fillPrice = order.limit;
            } else if (order.direction === 1 ? bar.low <= verificationPrice : bar.high >= verificationPrice) {
              fillPrice = order.limit;
            }
          }
        }
      }
      if (fillPrice === undefined) continue;
      if (strict && this.marketEntryExceedsPyramiding(order)) {
        order.status = "cancelled";
        continue;
      }
      const riskEntry = order.command === "entry" || order.command === "order" ? this.prepareStrategyRiskOrder(order) : { closeOnly: false };
      if (riskEntry === undefined) {
        order.status = "cancelled";
        continue;
      }
      if ((order.command === "entry" || order.command === "order") && !riskEntry.closeOnly && !this.strategyHasMarginForOrder(order, fillPrice)) {
        order.status = "cancelled";
        continue;
      }
      beforeFill(fillPrice);
      const positionBeforeFill = strategy.positionSize;
      fillPrice += order.direction * strategy.config.slippage * tick;
      order.status = "filled";
      order.fillPrice = fillPrice;
      order.fillBarIndex = this.barIndex;
      const fillTime = historicalRiskTick ? bar.openTime : this.strategyFillTime(bar, fillPrice);
      order.fillTime = fillTime;
      if (order.command === "close" || order.command === "close_all") {
        this.executeStrategyClose(order, fillPrice, fillTime);
        if (isStrictPineCompatibility(this.compatibility) && order.status === "filled") this.finishStrategyRiskFill(fillPrice, fillTime, positionBeforeFill, beforeFill);
        else this.markStrategyToMarket(bar.close);
        continue;
      }
      if (order.command === "entry") {
        this.executeStrategyEntry(order, fillPrice, fillTime, riskEntry.closeOnly);
      } else {
        this.executeStrategyOrder(order, fillPrice, fillTime);
      }
      this.applyStrategyOcaFill(order);
      if (isStrictPineCompatibility(this.compatibility)) this.finishStrategyRiskFill(fillPrice, fillTime, positionBeforeFill, beforeFill);
      else {
        strategy.intradayFills += 1;
        this.evaluateStrategyRiskHalts();
        this.markStrategyToMarket(fillPrice);
      }
    }
    if (historicalRiskTick === undefined && !adverseMarginProcessed) this.processStrategyMarginCall(bar, "extreme", beforeFill);
    this.markStrategyToMarket(bar.close);
    this.updateStrategyEquityExcursions(excursionPath === undefined
      ? bar
      : strategyExcursionSegment(bar, excursionPath, excursionOffset, excursionPath.length - 1));
    if (excursionPath !== undefined) excursionOffset = excursionPath.length - 1;
    if (historicalRiskTick !== undefined) {
      // Pine evaluates the bar before the broker handles risk on the final close.
      if (historicalRiskTick !== "close") this.processHistoricalRiskTick(bar, historicalRiskTick, beforeFill);
      return;
    }
    this.processStrategyMarginCall(bar, "close", beforeFill);
    this.markStrategyToMarket(bar.close);
    this.evaluateStrategyRiskHalts();
    this.processStrategyRiskHalt(bar.close, bar.openTime, beforeFill);
    this.markStrategyToMarket(bar.close);
  }

  private processHistoricalRiskTick(bar: MarketBar, checkpoint: "open" | "extreme" | "close", beforeFill?: (price: number) => void): void {
    this.evaluateStrategyRiskHalts();
    this.processStrategyRiskHalt(bar.close, bar.openTime, beforeFill);
    // The risk check precedes margin. A margin fill contributes to the next tick's count.
    const atPrice = { ...bar, open: bar.close, high: bar.close, low: bar.close };
    this.processStrategyMarginCall(atPrice, checkpoint, beforeFill, true);
  }

  public beginStrategyDayAt(openTime: number): void {
    const strategy = this.strategy!;
    // Keep the frozen profile's UTC accounting boundary intact. The current
    // The production profile resets intraday risk at the exchange-local date.
    const intradayKey = isStrictPineCompatibility(this.compatibility)
      ? this.host.riskPeriodKey?.(openTime, this.barIndex) ?? strategyDayKey(openTime, this.timezone)
      : this.resolveCurrencyNone
      ? strategyDayKey(openTime, this.timezone)
      : new Date(openTime).toISOString().slice(0, 10);
    if (strategy.intradayKey !== intradayKey) {
      if (strategy.intradayKey !== "") {
        strategy.consecutiveLossDays = strategy.currentDayRealizedProfit < 0 ? strategy.consecutiveLossDays + 1 : 0;
      }
      strategy.intradayKey = intradayKey;
      strategy.intradayStartEquity = strategy.equity;
      strategy.intradayPeakEquity = strategy.equity;
      strategy.intradayFills = 0;
      strategy.currentDayRealizedProfit = 0;
      if (isStrictPineCompatibility(this.compatibility)) {
        strategy.intradayRiskHalted = false;
        delete strategy.intradayFillLimitHalted;
      }
    }
  }

  private requireStrategyRiskPeriod(name: string, time = this.bars[this.barIndex]?.openTime): void {
    if (time !== undefined && this.host.riskPeriodKey !== undefined
      && this.host.riskPeriodKey(time, this.barIndex) === undefined) {
      throw new PineRuntimeError(`strategy.risk.${name} requires a bar inside the active session`, `strategy.risk.${name}`);
    }
  }

  public strategyOrderBlocked(order: MutableStrategyOrder): boolean {
    return policy.strategyOrderBlocked(this.strategy!, order);
  }

  private prepareStrategyRiskOrder(order: MutableStrategyOrder): { closeOnly: boolean } | undefined {
    if (!isStrictPineCompatibility(this.compatibility) || this.strategy!.config.calc_on_order_fills) {
      return this.strategyOrderBlocked(order) ? undefined : { closeOnly: false };
    }
    const decision = policy.strategyRiskOrderDecision(this.strategy!, order);
    if (decision.blocked) return undefined;
    order.quantity = floorCalculatedStrategyQuantity(decision.quantity, this.symbolInfo.mincontract);
    if (order.quantity <= 0) return undefined;
    return { closeOnly: decision.closeOnly };
  }

  private finishStrategyRiskFill(price: number, time: number, positionBeforeFill: number, beforeFill?: (price: number) => void): void {
    const strategy = this.strategy!;
    strategy.intradayFills += 1;
    const partialExit = Math.sign(strategy.positionSize) === Math.sign(positionBeforeFill)
      && Math.abs(strategy.positionSize) < Math.abs(positionBeforeFill);
    this.recordStrategyFillEquityExcursion(price, partialExit);
    this.evaluateStrategyRiskHalts(false);
    if (isStrictPineCompatibility(this.compatibility)) this.processStrategyRiskHalt(price, time, beforeFill, false);
  }

  private recordStrategyFillEquityExcursion(price: number, partialExit = false): void {
    const strategy = this.strategy!;
    const priorRunupTrough = strategy.equityTrough;
    this.markStrategyToMarket(price);
    if (strategy.openTrades.length === 0 && priorRunupTrough < 0 && strategy.equity < 0) {
      // A full exit into negative equity exposes a signed closed-equity event.
      // The amount getter still retains its independent favorable excursion.
      const signedExitPercent = this.finiteAccountMoney(
        (strategy.equity - priorRunupTrough) * 100 / priorRunupTrough, "strategy.max_runup_percent");
      strategy.maxRunupPercent = Math.max(strategy.maxRunupPercent, signedExitPercent);
    }
    // A discretionary partial exit counts any remaining unrealized gain in the
    // fill's run-up base. An unrealized loss on the residual does not lower it.
    const runupBase = partialExit
      ? strategy.equity - Math.min(0, strategy.openProfit)
      : strategy.equity;
    strategy.equityTrough = Math.min(strategy.equityTrough, runupBase);
  }

  public applyStrategyOcaFill(filledOrder: MutableStrategyOrder, filledQuantity = filledOrder.quantity): void {
    const strategy = this.strategy!;
    if (filledOrder.ocaName === undefined || filledOrder.ocaType === undefined || filledOrder.ocaType === "none") return;
    for (const sibling of strategy.orders) {
      if (sibling === filledOrder || sibling.status !== "pending" || sibling.ocaName !== filledOrder.ocaName
        || (isStrictPineCompatibility(this.compatibility) && sibling.ocaType !== filledOrder.ocaType)) continue;
      if (filledOrder.ocaType === "cancel") {
        sibling.status = "cancelled";
        continue;
      }
      if (isStrictPineCompatibility(this.compatibility) && sibling.publicExitReservedQuantity !== undefined) {
        const remaining = Math.max(0, (sibling.publicExitOcaCap ?? sibling.publicExitReservedQuantity) - filledQuantity);
        sibling.publicExitOcaCap = remaining;
        sibling.quantity = remaining;
        sibling.publicExitReservedQuantity = remaining;
        if (remaining === 0) {
          sibling.status = "cancelled";
          const intent = strategy.publicExitIntents!.find((candidate) => candidate.id === sibling.id
            && candidate.targetEntryId === sibling.targetEntryId);
          if (intent !== undefined && sibling.targetTradeId !== undefined) intent.completedTradeIds.push(sibling.targetTradeId);
        }
        continue;
      }
      sibling.quantity = Math.max(0, sibling.quantity - filledQuantity);
      if (sibling.quantity === 0) sibling.status = "cancelled";
    }
  }

  public evaluateStrategyRiskHalts(atBrokerTick = true): void {
    const strategy = this.strategy!;
    if (!isStrictPineCompatibility(this.compatibility)) {
      if (policy.strategyRiskHaltRequired(strategy)) strategy.riskHalted = true;
      return;
    }
    strategy.riskClosedProfitPeak = Math.max(
      strategy.riskClosedProfitPeak ?? strategy.equityPeak - strategy.config.initial_capital,
      strategy.closedTradeProfitTotal,
    );
    const decision = policy.strategyRiskDecision(strategy);
    const checkIntraday = atBrokerTick || strategy.config.calc_on_order_fills;
    if (decision.permanent && (checkIntraday || decision.drawdown || decision.lossDays)) strategy.riskHalted = true;
    if ((checkIntraday && decision.intraday) || (strategy.config.calc_on_order_fills && decision.filledOrders)) strategy.intradayRiskHalted = true;
  }

  public processStrategyRiskHalt(fillPrice: number, fillTime: number, beforeFill?: (price: number) => void, atBrokerTick = true): void {
    const strategy = this.strategy!;
    const strict = isStrictPineCompatibility(this.compatibility);
    const decision = strict ? policy.strategyRiskDecision(strategy) : undefined;
    const halt = strategy.riskHalted || (strict && strategy.intradayRiskHalted);
    const fillLimit = atBrokerTick && !strategy.config.calc_on_order_fills
      && decision?.filledOrders === true && strategy.intradayFillLimitHalted !== true;
    if (fillLimit) strategy.intradayFillLimitHalted = true;
    if (!halt && !fillLimit) return;
    // A fill-limit close blocks new submissions but leaves resting orders eligible.
    if (halt) {
      for (const order of strategy.orders) if (order.status === "pending") order.status = "cancelled";
    }
    if (strategy.openTrades.length === 0) return;
    beforeFill?.(fillPrice);
    const quantity = Math.abs(strategy.positionSize);
    let pineExitId: string | undefined;
    if (decision?.drawdown === true) pineExitId = "Close Position (Max Drawdown)";
    else if (decision?.lossDays === true) pineExitId = "Close Position (Max consecutive loss days)";
    else if (decision?.intraday === true) pineExitId = "Close Position (Max intraday Loss)";
    else if (fillLimit) pineExitId = "Close Position (Max number of filled orders in one day)";
    const order: MutableStrategyOrder = {
      id: `Risk rule-${String(this.barIndex)}`,
      command: "close_all",
      direction: strategy.positionSize > 0 ? -1 : 1,
      quantity,
      type: "market",
      createdBarIndex: this.barIndex,
      createdTime: fillTime,
      status: "filled",
      fillPrice,
      fillBarIndex: this.barIndex,
      fillTime,
      comment: pineExitId ?? "Risk rule",
      ...(decision?.alertMessage === undefined ? {} : { alertMessage: decision.alertMessage }),
    };
    strategy.orders.push(order);
    this.closeStrategyTrades(fillPrice, fillTime, order.id, order.comment, pineExitId);
    if (strict) this.recordStrategyFillEquityExcursion(fillPrice);
  }

  public strategyHasMarginForOrder(order: MutableStrategyOrder, fillPrice: number): boolean {
    return policy.strategyHasMarginForOrder(this.strategy!, order, fillPrice, strategyPointValue(this.symbolInfo) * this.fxRate("strategy.margin"));
  }

  public strategyEquityAtPrice(price: number): number {
    return policy.strategyEquityAtPrice(this.strategy!, price, strategyPointValue(this.symbolInfo) * this.fxRate("strategy.equity"));
  }

  public strategyMarginLiquidationPrice(): number {
    if (this.strategy!.positionSize === 0) return Number.NaN;
    return policy.strategyMarginLiquidationPrice(this.strategy!, strategyPointValue(this.symbolInfo),
      number(this.symbolInfo.mintick ?? 0.01), isStrictPineCompatibility(this.compatibility),
      this.fxRate("strategy.margin_liquidation_price"));
  }

  public processStrategyMarginCall(bar: MarketBar, checkpoint: "open" | "extreme" | "close" = "extreme",
    beforeFill?: (price: number) => void, deferRisk = false): void {
    const strategy = this.strategy!;
    if (strategy.positionSize === 0) return;
    const decision = policy.strategyMarginCallDecision(strategy, bar, strategyPointValue(this.symbolInfo) * this.fxRate("strategy.margin"), checkpoint);
    if (decision === undefined) return;
    const strict = isStrictPineCompatibility(this.compatibility);
    const positionQuantity = Math.abs(strategy.positionSize);
    let quantity = decision.legacyQuantity;
    if (strict && decision.coverQuantity < positionQuantity) {
      // Pine truncates the amount needed to cover the deficit before multiplying it.
      const step = strategyQuantityStep(this.symbolInfo.mincontract);
      const covered = floorCalculatedStrategyQuantity(decision.coverQuantity, step);
      const liquidationQuantity = covered > 0 ? floorCalculatedStrategyQuantity(covered * 4, step) : step;
      quantity = Math.min(positionQuantity, liquidationQuantity);
    }
    if (quantity <= 0) return;
    const adversePrice = decision.price;
    beforeFill?.(adversePrice);
    const order: MutableStrategyOrder = {
      id: checkpoint === "extreme" ? `Margin call-${String(this.barIndex)}` : `Margin call-${checkpoint}-${String(this.barIndex)}`,
      command: "margin_call",
      direction: decision.direction,
      quantity,
      type: "market",
      createdBarIndex: this.barIndex,
      createdTime: bar.openTime,
      status: "filled",
      fillPrice: adversePrice,
      fillBarIndex: this.barIndex,
      fillTime: bar.openTime,
    };
    strategy.orders.push(order);
    let remaining = quantity;
    for (const trade of [...strategy.openTrades]) {
      if (remaining <= 0) break;
      const closedQuantity = Math.min(remaining, trade.quantity);
      this.closeStrategyTradeQuantity(trade, closedQuantity, adversePrice, bar.openTime, order.id, "Margin call",
        strict ? { pineExitId: "Close position order" } : undefined);
      remaining = strict ? decimalQuantitySum(remaining, -closedQuantity) : remaining - closedQuantity;
    }
    strategy.intradayFills += 1;
    this.recalculateStrategyPosition();
    if (strict) {
      this.recordStrategyFillEquityExcursion(adversePrice);
      if (!deferRisk) {
        this.evaluateStrategyRiskHalts();
        this.processStrategyRiskHalt(adversePrice, bar.openTime, beforeFill, false);
      }
    }
  }

  public strategyExitTrigger(order: MutableStrategyOrder, bar: MarketBar, orderedPath = false): { readonly price: number; readonly direction: 1 | -1; readonly kind: "profit" | "loss" | "trailing" } | undefined {
    const strategy = this.strategy!;
    const matching = strategy.openTrades.filter((trade) => (order.targetEntryId === "" || trade.entryId === order.targetEntryId) && (order.targetTradeId === undefined || trade.id === order.targetTradeId));
    const trade = matching[0] ?? (isStrictPineCompatibility(this.compatibility)
      && strategy.config.close_entries_rule === "FIFO" && order.publicExitReservedQuantity !== undefined
      && order.targetTradeId !== undefined && strategy.openTrades.some((candidate) => candidate.direction === -order.direction)
      ? strategy.closedTrades.find((candidate) => candidate.id === order.targetTradeId)
      : undefined);
    if (trade === undefined) return undefined;
    const tick = number(this.symbolInfo.mintick ?? 0.01);
    const trailingPrice = this.strategyTrailingTrigger(order, trade, bar, tick, orderedPath);
    return policy.strategyExitDecision(order, trade, bar, tick, trailingPrice,
      isStrictPineCompatibility(this.compatibility) && this.version === 6);
  }

  public expandStrategyExitOrder(order: MutableStrategyOrder): void {
    if (order.publicExitReservedQuantity !== undefined) return;
    if (order.targetTradeId !== undefined) return;
    const matching = this.strategy!.openTrades.filter((trade) => order.targetEntryId === "" || trade.entryId === order.targetEntryId);
    if (matching.length === 0) return;
    order.targetTradeId = matching[0]!.id;
    for (const trade of matching.slice(1)) this.strategy!.orders.push({
      ...order,
      targetTradeId: trade.id,
    });
  }

  public strategyAdverseFirst(bar: MarketBar, direction: 1 | -1): boolean {
    return strategyAdverseFirst(bar, direction);
  }

  public strategyTrailingTrigger(order: MutableStrategyOrder, trade: MutableStrategyTrade, bar: MarketBar, tick: number, orderedPath = false): number | undefined {
    if (order.trailOffset === undefined || (order.trailPrice === undefined && order.trailPoints === undefined)) return undefined;
    const relativeActivation = order.trailPoints === undefined ? undefined : trade.entryPrice + trade.direction * order.trailPoints * tick;
    const activation = isStrictPineCompatibility(this.compatibility) && this.version === 6
      ? policy.firstFavorableLevel(order.trailPrice, relativeActivation, trade.direction)!
      : order.trailPrice ?? relativeActivation!;
    if (orderedPath) {
      return this.strategyOrderedTrailingTrigger(order, trade, bar, activation, tick);
    }
    if (order.trailArmed !== true) {
      const activated = trade.direction === 1 ? bar.high >= activation : bar.low <= activation;
      if (!activated) return undefined;
      order.trailArmed = true;
      order.trailPeak = trade.direction === 1 ? bar.high : bar.low;
    } else {
      order.trailPeak = trade.direction === 1
        ? Math.max(order.trailPeak ?? bar.high, bar.high)
        : Math.min(order.trailPeak ?? bar.low, bar.low);
    }
    const trigger = order.trailPeak! - trade.direction * order.trailOffset * tick;
    return trade.direction === 1 ? (bar.low <= trigger ? trigger : undefined) : (bar.high >= trigger ? trigger : undefined);
  }

  private strategyOrderedTrailingTrigger(
    order: MutableStrategyOrder,
    trade: MutableStrategyTrade,
    bar: MarketBar,
    activation: number,
    tick: number,
  ): number | undefined {
    const start = bar.open;
    const end = bar.close;
    if (order.trailArmed !== true) {
      const activated = trade.direction === 1
        ? Math.max(start, end) >= activation
        : Math.min(start, end) <= activation;
      if (!activated) return undefined;
      order.trailArmed = true;
      order.trailPeak = trade.direction === 1
        ? Math.max(activation, start, end)
        : Math.min(activation, start, end);
      return undefined;
    }

    const previousPeak = order.trailPeak ?? start;
    if (trade.direction === 1) {
      order.trailPeak = Math.max(previousPeak, start, end);
      if (end >= start) return undefined;
      const trigger = order.trailPeak - order.trailOffset! * tick;
      return end <= trigger ? trigger : undefined;
    }

    order.trailPeak = Math.min(previousPeak, start, end);
    if (end <= start) return undefined;
    const trigger = order.trailPeak + order.trailOffset! * tick;
    return end >= trigger ? trigger : undefined;
  }

  private strategyFillTime(bar: MarketBar, price: number): number {
    return strategyFillTime(bar, price);
  }

  public strategyExitFillPrice(price: number, direction: 1 | -1, kind: "profit" | "loss" | "trailing"): number {
    if (kind !== "loss" || !isStrictPineCompatibility(this.compatibility)) return price;
    const tick = number(this.symbolInfo.mintick ?? 0.01);
    return Number.isFinite(tick) ? price + direction * this.strategy!.config.slippage * tick : price;
  }

  public executeStrategyExit(order: MutableStrategyOrder, fillPrice: number, fillTime: number, kind: "profit" | "loss" | "trailing", quantityCap?: number): number {
    const strategy = this.strategy!;
    const matching = strategy.openTrades.filter((trade) => (order.targetEntryId === "" || trade.entryId === order.targetEntryId) && (order.targetTradeId === undefined || trade.id === order.targetTradeId));
    const total = matching.reduce((sum, trade) => isStrictPineCompatibility(this.compatibility) ? decimalQuantitySum(sum, trade.quantity) : sum + trade.quantity, 0);
    let remaining = order.quantity > 0
      ? Math.min(order.quantity, total)
      : order.quantityPercent !== undefined
        ? total * Math.max(0, Math.min(100, order.quantityPercent)) / 100
        : total;
    // The synthetic event owner fixes the effective size when the order first
    // reserves units. Do not recompute qty_percent from a later, smaller trade.
    if (order.publicExitReservedQuantity !== undefined) remaining = Math.min(order.publicExitReservedQuantity,
      isStrictPineCompatibility(this.compatibility) && strategy.config.close_entries_rule === "FIFO"
        ? Math.abs(strategy.positionSize) : total);
    else if (quantityCap !== undefined) remaining = Math.min(quantityCap, total);
    if (isStrictPineCompatibility(this.compatibility)) remaining = floorStrategyQuantity(remaining, this.symbolInfo.mincontract);
    const requestedQuantity = remaining;
    const attributed = isStrictPineCompatibility(this.compatibility) && strategy.config.close_entries_rule === "FIFO"
      && order.publicExitReservedQuantity !== undefined
      ? strategy.openTrades.filter((trade) => trade.direction === -order.direction)
      : matching;
    for (const trade of [...attributed]) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, trade.quantity);
      const exitComment = kind === "profit" ? order.commentProfit : kind === "loss" ? order.commentLoss : order.commentTrailing;
      this.closeStrategyTradeQuantity(trade, quantity, fillPrice, fillTime, order.id, exitComment ?? order.comment);
      remaining = isStrictPineCompatibility(this.compatibility) ? decimalQuantitySum(remaining, -quantity) : remaining - quantity;
    }
    const filledQuantity = requestedQuantity - remaining;
    if (requestedQuantity === 0) order.status = "cancelled";
    this.recalculateStrategyPosition();
    this.finishPublicExit(order);
    return filledQuantity;
  }

  public processStrategyOrdersOnClose(): void {
    const strategy = this.strategy!;
    const bar = this.bars[this.barIndex];
    if (bar === undefined) return;
    const processAll = strategy.config.process_orders_on_close;
    if (!this.historicalRiskClosePending && !processAll && (!isStrictPineCompatibility(this.compatibility) || !strategy.orders.some((order) =>
      order.status === "pending" && order.createdBarIndex === this.barIndex && isImmediateCloseOrder(order)))) return;
    for (const order of strategy.orders) {
      if (order.status !== "pending" || order.createdBarIndex !== this.barIndex) continue;
      if (!processAll && !isImmediateCloseOrder(order)) continue;
      if (order.command === "exit" && (order.publicExitRetired === true || order.publicExitReservedQuantity === 0)) continue;
      const closeOnlyBar: MarketBar = { ...bar, open: bar.close, high: bar.close, low: bar.close };
      let fillPrice: number | undefined;
      let exitKind: "profit" | "loss" | "trailing" | undefined;
      if (order.command === "exit") {
        const trigger = this.strategyExitTrigger(order, closeOnlyBar);
        fillPrice = trigger?.price;
        exitKind = trigger?.kind;
        if (trigger !== undefined) order.direction = trigger.direction;
      } else if (order.type === "market") fillPrice = bar.close;
      else if (order.type === "limit" && order.limit !== undefined && (order.direction === 1 ? bar.close <= order.limit : bar.close >= order.limit)) fillPrice = order.limit;
      else if (order.type === "stop" && order.stop !== undefined && (order.direction === 1 ? bar.close >= order.stop : bar.close <= order.stop)) fillPrice = order.stop;
      else if (order.type === "stop-limit" && order.stop !== undefined && order.limit !== undefined) {
        if (order.direction === 1 ? bar.close >= order.stop : bar.close <= order.stop) order.stopTriggered = true;
        if (order.stopTriggered === true && (order.direction === 1 ? bar.close <= order.limit : bar.close >= order.limit)) fillPrice = order.limit;
      }
      if (fillPrice === undefined) continue;
      if (isStrictPineCompatibility(this.compatibility) && this.marketEntryExceedsPyramiding(order)) {
        order.status = "cancelled";
        continue;
      }
      const riskEntry = order.command === "entry" || order.command === "order" ? this.prepareStrategyRiskOrder(order) : { closeOnly: false };
      if (riskEntry === undefined || ((order.command === "entry" || order.command === "order") && !riskEntry.closeOnly && !this.strategyHasMarginForOrder(order, fillPrice))) {
        order.status = "cancelled";
        continue;
      }
      const tickValue = number(this.symbolInfo.mintick ?? 0.01);
      const tick = Number.isFinite(tickValue) ? tickValue : 0;
      fillPrice += order.direction * strategy.config.slippage * tick;
      order.status = "filled";
      order.fillPrice = fillPrice;
      order.fillBarIndex = this.barIndex;
      order.fillTime = bar.openTime;
      const positionBeforeFill = strategy.positionSize;
      if (order.command === "exit" && exitKind !== undefined) {
        this.executeStrategyExit(order, fillPrice, bar.openTime, exitKind);
        const alertMessage = exitKind === "profit" ? order.alertProfit : exitKind === "loss" ? order.alertLoss : order.alertTrailing;
        if (alertMessage !== undefined) order.alertMessage = alertMessage;
      }
      else if (order.command === "close" || order.command === "close_all") this.executeStrategyClose(order, fillPrice, bar.openTime);
      else if (order.command === "entry") {
        this.executeStrategyEntry(order, fillPrice, bar.openTime, riskEntry.closeOnly);
      } else if (order.command === "order") this.executeStrategyOrder(order, fillPrice, bar.openTime);
      this.applyStrategyOcaFill(order);
      if (isStrictPineCompatibility(this.compatibility)) this.finishStrategyRiskFill(fillPrice, bar.openTime, positionBeforeFill);
      else {
        strategy.intradayFills += 1;
        this.markStrategyToMarket(fillPrice);
      }
    }
    if (this.historicalRiskClosePending) {
      this.markStrategyToMarket(bar.close);
      this.processHistoricalRiskTick(bar, "close");
      this.historicalRiskClosePending = false;
    } else {
      this.evaluateStrategyRiskHalts();
      this.processStrategyRiskHalt(bar.close, bar.openTime);
    }
  }

  public executeStrategyClose(order: MutableStrategyOrder, fillPrice: number, fillTime: number): void {
    const strategy = this.strategy!;
    const strict = isStrictPineCompatibility(this.compatibility);
    const intended = new Set(order.intendedTradeIds ?? []);
    const matching = strategy.openTrades.filter((trade) => intended.has(trade.id) && (order.targetEntryId === undefined || trade.entryId === order.targetEntryId));
    const total = matching.reduce((sum, trade) => strict ? decimalQuantitySum(sum, trade.quantity) : sum + trade.quantity, 0);
    let remaining = order.quantity > 0
      ? Math.min(order.quantity, total)
      : order.quantityPercent !== undefined
        ? total * Math.max(0, Math.min(100, order.quantityPercent)) / 100
        : total;
    if (strict) remaining = floorStrategyQuantity(remaining, this.symbolInfo.mincontract);
    const attributed = strict && !strategy.config.calc_on_order_fills
      && strategy.config.close_entries_rule === "FIFO"
      ? strategy.openTrades.filter((trade) => trade.direction === -order.direction)
      : matching;
    let pineExitId: string | undefined;
    if (strict) {
      if (order.command === "close") pineExitId = `Close entry(s) order ${order.targetEntryId ?? ""}`;
      if (order.command === "close_all") pineExitId = "Close position order";
    }
    const fillQuantity = remaining;
    const closeFee = strict && fillQuantity > 0 && strategy.config.commission_type === "cash_per_order"
      ? this.strategyLegCommission(fillQuantity, fillPrice)
      : undefined;
    for (const trade of [...attributed]) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, trade.quantity);
      const commission = closeFee === undefined ? undefined : closeFee * (quantity / fillQuantity);
      this.closeStrategyTradeQuantity(trade, quantity, fillPrice, fillTime, order.id, order.comment,
        commission === undefined ? { pineExitId } : { pineExitId, commission });
      remaining = strict ? decimalQuantitySum(remaining, -quantity) : remaining - quantity;
    }
    if (total === 0) order.status = "cancelled";
    this.recalculateStrategyPosition();
    this.rebuildPublicExitReservations();
  }

  public executeStrategyEntry(order: MutableStrategyOrder, fillPrice: number, fillTime: number, closeOnly = false, entryOrderCreatedBarIndex = order.createdBarIndex): void {
    const strategy = this.strategy!;
    const reverses = strategy.positionSize !== 0 && Math.sign(strategy.positionSize) !== order.direction;
    let entryCommission: number | undefined;
    if (reverses && isStrictPineCompatibility(this.compatibility) && strategy.config.commission_type === "cash_per_order") {
      const totalQuantity = Math.abs(strategy.positionSize) + (closeOnly ? 0 : order.quantity);
      const commissionPerUnit = strategy.config.commission_value / totalQuantity;
      for (const trade of [...strategy.openTrades]) {
        this.closeStrategyTradeQuantity(trade, trade.quantity, fillPrice, fillTime, order.id, order.comment, {
          commission: commissionPerUnit * trade.quantity,
        });
      }
      this.recalculateStrategyPosition();
      this.rebuildPublicExitReservations();
      entryCommission = commissionPerUnit * order.quantity;
    } else if (reverses) {
      this.closeStrategyTrades(fillPrice, fillTime, order.id, order.comment);
    }
    if (!closeOnly) {
      this.openStrategyTrade(order.id, order.direction, order.quantity, fillPrice, fillTime, order.comment, entryOrderCreatedBarIndex, entryCommission);
    }
  }

  public openStrategyTrade(entryId: string, direction: 1 | -1, quantity: number, fillPrice: number, fillTime: number, entryComment = entryId, entryOrderCreatedBarIndex = this.barIndex, entryCommission = this.strategyLegCommission(quantity, fillPrice)): void {
    const strategy = this.strategy!;
    const pointValue = strategyPointValue(this.symbolInfo);
    const rate = this.fxRate("strategy.entry");
    const entryBasis = quantity * fillPrice * pointValue * rate;
    if (!Number.isFinite(entryBasis) || (this.fxSelection.kind === "rate" && entryBasis < 0)) {
      throw new PineRuntimeError("Strategy entry basis is outside finite account value", "strategy.entry");
    }
    this.finiteAccountMoney(strategy.netProfit - entryCommission, "strategy.entry");
    if (!Number.isFinite(strategy.firstEntryPrice)) {
      strategy.firstEntryPrice = fillPrice;
      if (isStrictPineCompatibility(this.compatibility)) {
        strategy.firstEntryRate = rate;
        strategy.firstEntryPointValue = pointValue;
      }
    }
    strategy.openTrades.push({
      id: `trade-${String(strategy.nextTradeId++)}`,
      entryId,
      direction,
      quantity,
      ...(isStrictPineCompatibility(this.compatibility) ? { originalQuantity: quantity, entryOrderCreatedBarIndex } : {}),
      entryPrice: fillPrice,
      entryBarIndex: this.barIndex,
      entryTime: fillTime,
      entryCommission,
      ...(isStrictPineCompatibility(this.compatibility) ? { entryBasis } : {}),
      entryComment,
      maxDrawdown: entryCommission,
      maxRunup: 0,
      status: "open",
    });
    strategy.netProfit -= entryCommission;
    if (!isStrictPineCompatibility(this.compatibility)) strategy.grossLoss += entryCommission;
    this.recalculateStrategyPosition();
    this.rebuildPublicExitReservations();
  }

  public executeStrategyOrder(order: MutableStrategyOrder, fillPrice: number, fillTime: number): void {
    const strategy = this.strategy!;
    let remaining = order.quantity;
    if (strategy.positionSize !== 0 && Math.sign(strategy.positionSize) !== order.direction) {
      for (const trade of [...strategy.openTrades]) {
        if (remaining <= 0 || trade.direction === order.direction) continue;
        const closedQuantity = Math.min(remaining, trade.quantity);
        this.closeStrategyTradeQuantity(trade, closedQuantity, fillPrice, fillTime, order.id, order.comment);
        remaining = isStrictPineCompatibility(this.compatibility) ? decimalQuantitySum(remaining, -closedQuantity) : remaining - closedQuantity;
      }
    }
    if (remaining > 0) this.openStrategyTrade(order.id, order.direction, remaining, fillPrice, fillTime, order.comment, order.createdBarIndex);
    else this.recalculateStrategyPosition();
    this.rebuildPublicExitReservations();
  }

  public closeStrategyTradeQuantity(trade: MutableStrategyTrade, quantity: number, fillPrice: number, fillTime: number, exitId = "", exitComment = exitId, options: { commission?: number; pineExitId?: string | undefined } = {}): void {
    const strategy = this.strategy!;
    const pointValue = strategyPointValue(this.symbolInfo);
    const gross = this.finiteAccountMoney((fillPrice - trade.entryPrice) * trade.direction * quantity * pointValue * this.fxRate("strategy.close"), "strategy.close");
    const entryCommission = trade.entryCommission * quantity / trade.quantity;
    const exitCommission = options.commission ?? this.strategyLegCommission(quantity, fillPrice);
    const profit = this.finiteAccountMoney(gross - entryCommission - exitCommission, "strategy.close");
    this.finiteAccountMoney(strategy.netProfit + gross - exitCommission, "strategy.close");
    this.finiteAccountMoney(strategy.currentDayRealizedProfit + profit, "strategy.close");
    this.finiteAccountMoney(strategy.grossProfit + Math.max(0, profit), "strategy.close");
    this.finiteAccountMoney(strategy.grossLoss + Math.max(0, -profit), "strategy.close");
    this.finiteAccountMoney(strategy.winningProfit + Math.max(0, profit), "strategy.close");
    this.finiteAccountMoney(strategy.losingLoss + Math.max(0, -profit), "strategy.close");
    const closeFraction = quantity / trade.quantity;
    const entryBasis = (trade.entryBasis ?? trade.quantity * trade.entryPrice * pointValue) * closeFraction;
    const closed: MutableStrategyTrade = {
      ...trade,
      id: quantity === trade.quantity ? trade.id : `${trade.id}-partial-${String(strategy.closedTradeCount)}`,
      quantity,
      exitPrice: fillPrice,
      exitBarIndex: this.barIndex,
      exitTime: fillTime,
      profit,
      entryCommission,
      ...(isStrictPineCompatibility(this.compatibility) ? { entryBasis } : {}),
      commission: this.finiteAccountMoney(entryCommission + exitCommission, "strategy.close"),
      ...(isStrictPineCompatibility(this.compatibility) ? {
        maxDrawdown: trade.maxDrawdown * closeFraction,
        maxRunup: trade.maxRunup * closeFraction,
      } : {}),
      exitId,
      ...(options.pineExitId === undefined ? {} : { pineExitId: options.pineExitId }),
      exitComment,
      status: "closed",
    };
    trade.entryCommission -= entryCommission;
    if (trade.entryBasis !== undefined) trade.entryBasis -= entryBasis;
    trade.quantity = isStrictPineCompatibility(this.compatibility) ? decimalQuantitySum(trade.quantity, -quantity) : trade.quantity - quantity;
    if (isStrictPineCompatibility(this.compatibility)) {
      trade.maxDrawdown *= 1 - closeFraction;
      trade.maxRunup *= 1 - closeFraction;
    }
    if (trade.quantity === 0) strategy.openTrades.splice(strategy.openTrades.indexOf(trade), 1);
    if (isStrictPineCompatibility(this.compatibility) && strategy.publicExitIntents !== undefined
      && strategy.openTrades.length === 0) {
      strategy.publicExitIntents.length = 0;
      for (const pending of strategy.orders) {
        if (pending.command !== "exit" || pending.status !== "pending" || pending.publicExitReservedQuantity === undefined) continue;
        pending.publicExitRetired = true;
        pending.publicExitReservedQuantity = 0;
        pending.quantity = 0;
      }
    }
    strategy.closedTrades.push(closed);
    strategy.closedTradeCount += 1;
    strategy.closedTradeProfitTotal += profit;
    if (isStrictPineCompatibility(this.compatibility) && strategy.closedTrades.length > MAX_RETAINED_CLOSED_TRADES) {
      const trimmed = strategy.closedTrades.length - MAX_RETAINED_CLOSED_TRADES;
      strategy.closedTrades.splice(0, trimmed);
      strategy.closedTradeFirstIndex += trimmed;
    }
    const percent = entryBasis > 0 ? profit * 100 / entryBasis : Number.NaN;
    strategy.closedTradePercentTotal += percent;
    if (profit > 0) strategy.winningTradePercentTotal += percent;
    else if (profit < 0) strategy.losingTradePercentTotal += -percent;
    strategy.currentDayRealizedProfit += profit;
    strategy.netProfit += gross - exitCommission;
    if (!isStrictPineCompatibility(this.compatibility)) strategy.grossLoss -= entryCommission;
    if (profit > 0) {
      strategy.grossProfit += profit;
      strategy.winningTrades += 1;
      strategy.winningProfit += profit;
    } else if (profit < 0) {
      strategy.grossLoss += Math.abs(profit);
      strategy.losingTrades += 1;
      strategy.losingLoss += Math.abs(profit);
    } else {
      strategy.evenTrades += 1;
    }
  }

  public closeStrategyTrades(fillPrice: number, fillTime: number, exitId = "", exitComment = exitId, pineExitId?: string): void {
    const strategy = this.strategy!;
    for (const trade of [...strategy.openTrades]) {
      this.closeStrategyTradeQuantity(trade, trade.quantity, fillPrice, fillTime, exitId, exitComment, { pineExitId });
    }
    this.recalculateStrategyPosition();
    this.rebuildPublicExitReservations();
  }

  public recalculateStrategyPosition(): void {
    const strategy = this.strategy!;
    strategy.positionSize = strategy.openTrades.reduce((sum, trade) => isStrictPineCompatibility(this.compatibility)
      ? decimalQuantitySum(sum, trade.direction * trade.quantity) : sum + trade.direction * trade.quantity, 0);
    const totalQuantity = strategy.openTrades.reduce((sum, trade) => isStrictPineCompatibility(this.compatibility)
      ? decimalQuantitySum(sum, trade.quantity) : sum + trade.quantity, 0);
    strategy.positionAveragePrice = totalQuantity === 0
      ? Number.NaN
      : strategy.openTrades.reduce((sum, trade) => sum + trade.entryPrice * trade.quantity, 0) / totalQuantity;
    const absolute = Math.abs(strategy.positionSize);
    strategy.maxContractsHeld = Math.max(strategy.maxContractsHeld, absolute);
    if (strategy.positionSize > 0) strategy.maxContractsHeldLong = Math.max(strategy.maxContractsHeldLong, strategy.positionSize);
    if (strategy.positionSize < 0) strategy.maxContractsHeldShort = Math.max(strategy.maxContractsHeldShort, -strategy.positionSize);
  }

  public markStrategyToMarket(price: number): void {
    const strategy = this.strategy;
    if (strategy === undefined) return;
    const pointValue = strategyPointValue(this.symbolInfo);
    const rate = strategy.openTrades.length > 0 ? this.fxRate("strategy.openprofit") : 1;
    const openProfit = this.finiteAccountMoney(strategy.openTrades.reduce((sum, trade) => sum + (price - trade.entryPrice) * trade.direction * trade.quantity * pointValue * rate, 0), "strategy.openprofit");
    const equity = this.finiteAccountMoney(strategy.config.initial_capital + strategy.netProfit + openProfit, "strategy.equity");
    strategy.openProfit = openProfit;
    strategy.equity = equity;
    if (isStrictPineCompatibility(this.compatibility) && strategy.intradayKey !== "") {
      strategy.intradayPeakEquity = Math.max(strategy.intradayPeakEquity, strategy.equity);
    }
  }

  public updateStrategyEquityExcursions(barOverride?: MarketBar): void {
    const strategy = this.strategy;
    const bar = barOverride ?? this.bars[this.barIndex];
    if (strategy === undefined || bar === undefined) return;
    const pointValue = this.finiteAccountMoney(strategyPointValue(this.symbolInfo)
      * (strategy.openTrades.length > 0 ? this.fxRate("strategy.equity") : 1), "strategy.equity");
    const realizedEquity = this.finiteAccountMoney(strategy.config.initial_capital + strategy.netProfit, "strategy.equity");
    const openCommission = this.finiteAccountMoney(strategy.openTrades.reduce((sum, trade) => sum + trade.entryCommission, 0), "strategy.equity");
    strategy.equityPeak = Math.max(strategy.equityPeak, this.finiteAccountMoney(realizedEquity + openCommission, "strategy.equity"));
    if (!isStrictPineCompatibility(this.compatibility)) {
      strategy.equityTrough = Math.min(strategy.equityTrough, realizedEquity);
    }
    this.updateStrategyTradeExcursions(bar);
    let worstExcursion = 0;
    let bestExcursion = 0;
    if (strategy.positionSize !== 0 && Number.isFinite(strategy.positionAveragePrice)) {
      const worstPrice = strategy.positionSize > 0 ? bar.low : bar.high;
      const bestPrice = strategy.positionSize > 0 ? bar.high : bar.low;
      worstExcursion = this.finiteAccountMoney(strategy.positionSize * (strategy.positionAveragePrice - worstPrice) * pointValue, "strategy.max_drawdown");
      bestExcursion = this.finiteAccountMoney(strategy.positionSize * (bestPrice - strategy.positionAveragePrice) * pointValue, "strategy.max_runup");
    }
    const drawdown = Math.max(0, this.finiteAccountMoney(strategy.equityPeak - realizedEquity + worstExcursion, "strategy.max_drawdown"));
    if (drawdown > strategy.maxDrawdown) strategy.maxDrawdown = drawdown;
    if (strategy.equityPeak > 0) strategy.maxDrawdownPercent = Math.max(strategy.maxDrawdownPercent,
      this.finiteAccountMoney(drawdown * 100 / strategy.equityPeak, "strategy.max_drawdown_percent"));
    const runup = Math.max(0, this.finiteAccountMoney(realizedEquity - strategy.equityTrough + bestExcursion, "strategy.max_runup"));
    if (runup > strategy.maxRunup) strategy.maxRunup = runup;
    const runupPrices = isStrictPineCompatibility(this.compatibility)
      ? [bar.open, bar.high, bar.low, bar.close]
      : [strategy.positionSize > 0 ? bar.high : bar.low];
    for (const price of runupPrices) {
      const excursion = strategy.positionSize === 0 ? 0 : this.finiteAccountMoney(
        strategy.positionSize * (price - strategy.positionAveragePrice) * pointValue, "strategy.max_runup_percent");
      const eventEquity = this.finiteAccountMoney(realizedEquity + excursion, "strategy.max_runup_percent");
      if (eventEquity <= 0) continue;
      const eventRunup = Math.max(0, this.finiteAccountMoney(
        realizedEquity - strategy.equityTrough + excursion, "strategy.max_runup_percent"));
      strategy.maxRunupPercent = Math.max(strategy.maxRunupPercent,
        this.finiteAccountMoney(eventRunup * 100 / eventEquity, "strategy.max_runup_percent"));
    }
  }

  /** A close-time fill can expose only the close after the bar's earlier path was sampled. */
  public finalizeStrategyEquityExcursions(): void {
    const bar = this.bars[this.barIndex];
    if (bar === undefined) return;
    this.updateStrategyEquityExcursions(isStrictPineCompatibility(this.compatibility)
      ? { ...bar, open: bar.close, high: bar.close, low: bar.close }
      : bar);
  }

  public updateStrategyTradeExcursions(barOverride?: MarketBar): void {
    const strategy = this.strategy;
    const bar = barOverride ?? this.bars[this.barIndex];
    if (strategy === undefined || bar === undefined) return;
    const pointValue = this.finiteAccountMoney(strategyPointValue(this.symbolInfo)
      * (strategy.openTrades.length > 0 ? this.fxRate("strategy.excursion") : 1), "strategy.excursion");
    for (const trade of strategy.openTrades) {
      const adversePrice = trade.direction === 1 ? bar.low : bar.high;
      const favorablePrice = trade.direction === 1 ? bar.high : bar.low;
      const adverse = this.finiteAccountMoney(Math.max(0, (trade.entryPrice - adversePrice) * trade.direction * trade.quantity * pointValue)
        + trade.entryCommission, "strategy.max_drawdown");
      const favorable = this.finiteAccountMoney(Math.max(0, (favorablePrice - trade.entryPrice) * trade.direction * trade.quantity * pointValue
        - trade.entryCommission), "strategy.max_runup");
      trade.maxDrawdown = Math.max(trade.maxDrawdown, adverse);
      trade.maxRunup = Math.max(trade.maxRunup, favorable);
    }
  }

  public strategyLegCommission(quantity: number, price: number): number {
    const commission = strategyLegCommission({
      config: this.strategy!.config,
      pointValue: strategyPointValue(this.symbolInfo),
      price,
      quantity,
      rate: this.strategy!.config.commission_type === "percent" ? this.fxRate("strategy.commission") : 1,
    });
    if (isStrictPineCompatibility(this.compatibility) && !Number.isFinite(commission)) {
      throw new PineRuntimeError("Strategy commission exceeds finite account value", "strategy.commission");
    }
    return commission;
  }

  public averageStrategyTradePercent(direction?: 1 | -1): number {
    if (isStrictPineCompatibility(this.compatibility)) {
      const strategy = this.strategy!;
      if (direction === 1) return strategy.winningTrades === 0 ? Number.NaN : strategy.winningTradePercentTotal / strategy.winningTrades;
      if (direction === -1) return strategy.losingTrades === 0 ? Number.NaN : strategy.losingTradePercentTotal / strategy.losingTrades;
      return strategy.closedTradeCount === 0 ? Number.NaN : strategy.closedTradePercentTotal / strategy.closedTradeCount;
    }
    return averageStrategyTradePercent(
      this.strategy!.closedTrades,
      direction,
      isStrictPineCompatibility(this.compatibility) ? strategyPointValue(this.symbolInfo) : undefined,
    );
  }

  private accountPercent(amount: number, basis: number): number {
    if (isStrictPineCompatibility(this.compatibility) && basis === 0) return Number.NaN;
    return strategyPercent(amount, basis);
  }

  public strategySnapshot(): StrategyStateSnapshot {
    const strategy = this.strategy!;
    return {
      barIndex: this.barIndex,
      time: this.bars[this.barIndex]?.openTime ?? Number.NaN,
      positionSize: strategy.positionSize,
      positionAveragePrice: strategy.positionAveragePrice,
      openProfit: strategy.openProfit,
      netProfit: strategy.netProfit,
      equity: strategy.equity,
      openTrades: strategy.openTrades.length,
      closedTrades: isStrictPineCompatibility(this.compatibility) ? strategy.closedTradeCount : strategy.closedTrades.length,
      pendingOrders: strategy.orders.filter((order) => order.status === "pending").length,
      filledOrders: strategy.orders.filter((order) => order.status === "filled").length,
      cancelledOrders: strategy.orders.filter((order) => order.status === "cancelled").length,
      grossProfit: strategy.grossProfit,
      grossLoss: strategy.grossLoss,
      maxDrawdown: strategy.maxDrawdown,
      maxRunup: strategy.maxRunup,
    };
  }

  public strategyResult(): StrategyResult {
    const strategy = this.strategy!;
    const cagr = strategyCagr(strategy, this.bars);
    const buyAndHold = strategyBuyAndHold(strategy, this.bars);
    const riskAdjusted = strategyRiskAdjusted(strategy);
    const finalSnapshot = strategy.timeline.at(-1) ?? Object.freeze(this.strategySnapshot());
    const orders: StrategyOrder[] = strategy.orders.map((order) => Object.freeze({
      id: order.id, command: order.command, direction: order.direction, quantity: order.quantity, type: order.type,
      ...(order.limit === undefined ? {} : { limit: order.limit }),
      ...(order.stop === undefined ? {} : { stop: order.stop }),
      createdBarIndex: order.createdBarIndex, createdTime: order.createdTime, status: order.status,
      ...(order.fillPrice === undefined ? {} : { fillPrice: order.fillPrice }),
      ...(order.fillBarIndex === undefined ? {} : { fillBarIndex: order.fillBarIndex }),
      ...(order.fillTime === undefined ? {} : { fillTime: order.fillTime }),
      ...(order.ocaName === undefined ? {} : { ocaName: order.ocaName }),
      ...(order.ocaType === undefined ? {} : { ocaType: order.ocaType }),
      ...(order.comment === undefined ? {} : { comment: order.comment }),
      ...(order.alertMessage === undefined || order.alertMessage === "" ? {} : { alertMessage: order.alertMessage }),
      ...(order.disableAlert === undefined ? {} : { disableAlert: order.disableAlert }),
      ...(order.targetEntryId === undefined ? {} : { targetEntryId: order.targetEntryId }),
      ...(order.quantityPercent === undefined ? {} : { quantityPercent: order.quantityPercent }),
      ...(order.profitTicks === undefined ? {} : { profitTicks: order.profitTicks }),
      ...(order.lossTicks === undefined ? {} : { lossTicks: order.lossTicks }),
      ...(order.trailPrice === undefined ? {} : { trailPrice: order.trailPrice }),
      ...(order.trailPoints === undefined ? {} : { trailPoints: order.trailPoints }),
      ...(order.trailOffset === undefined ? {} : { trailOffset: order.trailOffset }),
      ...(order.trailPeak === undefined ? {} : { trailPeak: order.trailPeak }),
      ...(order.trailArmed === undefined ? {} : { trailArmed: order.trailArmed }),
      ...(order.stopTriggered === undefined ? {} : { stopTriggered: order.stopTriggered }),
    }));
    const tradeRecord = (trade: MutableStrategyTrade): StrategyTrade => Object.freeze({
      id: trade.id,
      entryId: trade.entryId,
      direction: trade.direction,
      quantity: trade.quantity,
      entryPrice: trade.entryPrice,
      entryBarIndex: trade.entryBarIndex,
      entryTime: trade.entryTime,
      ...(trade.exitPrice === undefined ? {} : { exitPrice: trade.exitPrice }),
      ...(trade.exitBarIndex === undefined ? {} : { exitBarIndex: trade.exitBarIndex }),
      ...(trade.exitTime === undefined ? {} : { exitTime: trade.exitTime }),
      ...(trade.profit === undefined ? {} : { profit: trade.profit }),
      commission: trade.commission ?? trade.entryCommission,
      ...(trade.entryComment === undefined ? {} : { entryComment: trade.entryComment }),
      ...(trade.exitId === undefined ? {} : { exitId: trade.exitId }),
      ...(trade.exitComment === undefined ? {} : { exitComment: trade.exitComment }),
      maxDrawdown: trade.maxDrawdown,
      maxRunup: trade.maxRunup,
      status: trade.status,
    });
    return Object.freeze({
      ...finalSnapshot,
      config: strategy.config,
      orders: Object.freeze(orders),
      openTradeRecords: Object.freeze(strategy.openTrades.map(tradeRecord)),
      closedTradeRecords: Object.freeze(strategy.closedTrades.map(tradeRecord)),
      timeline: Object.freeze([...strategy.timeline]),
      grossProfit: strategy.grossProfit,
      grossLoss: strategy.grossLoss,
      winningTrades: strategy.winningTrades,
      losingTrades: strategy.losingTrades,
      evenTrades: strategy.evenTrades,
      maxContractsHeld: strategy.maxContractsHeld,
      maxContractsHeldLong: strategy.maxContractsHeldLong,
      maxContractsHeldShort: strategy.maxContractsHeldShort,
      maxDrawdown: strategy.maxDrawdown,
      maxDrawdownPercent: strategy.maxDrawdownPercent,
      maxRunup: strategy.maxRunup,
      maxRunupPercent: strategy.maxRunupPercent,
      cagr,
      buyAndHoldProfit: buyAndHold.profit,
      buyAndHoldPercent: buyAndHold.percent,
      strategyOutperformance: strategy.netProfit - buyAndHold.profit,
      sharpeRatio: riskAdjusted.sharpe,
      sortinoRatio: riskAdjusted.sortino,
    });
  }


  public recordStrategyMonthlyEquity(): void {
    const strategy = this.strategy;
    const bar = this.bars[this.barIndex];
    if (strategy === undefined || bar === undefined || !Number.isFinite(bar.openTime)) return;
    const date = new Date(bar.openTime);
    const monthKey = date.getUTCFullYear() * 12 + date.getUTCMonth();
    if (strategy.lastMonthKey === monthKey && strategy.monthlyEquity.length > 0) strategy.monthlyEquity[strategy.monthlyEquity.length - 1] = strategy.equity;
    else {
      strategy.monthlyEquity.push(strategy.equity);
      strategy.lastMonthKey = monthKey;
    }
  }

}

function strategyTradeIndex(value: PineValue | undefined, strict: boolean): number | undefined {
  if (!strict) return integer(value ?? -1);
  if (typeof value === "number" && Number.isNaN(value)) return 0;
  const index = number(value);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function absentTradeNumber(name: string, strict: boolean): number {
  return strict && zeroDefaultTradeFields.has(name) ? 0 : Number.NaN;
}

interface DecimalFraction { readonly numerator: bigint; readonly denominator: bigint }

/** Correct floating-point noise in internally calculated sizes before flooring. */
function floorCalculatedStrategyQuantity(quantity: number, suppliedStep: number | undefined): number {
  const step = strategyQuantityStep(suppliedStep);
  const units = quantity / step;
  const nearest = Math.round(units);
  if (Number.isSafeInteger(nearest) && Math.abs(units - nearest) <= Number.EPSILON * Math.max(1, Math.abs(units)) * 4) {
    const fraction = decimalQuantityFraction(step);
    if (fraction !== undefined) return Number(BigInt(nearest) * fraction.numerator) / Number(fraction.denominator);
    return nearest * step;
  }
  return floorStrategyQuantity(quantity, step);
}

/** Preserve exact decimal steps when combining already-normalized position quantities. */
function decimalQuantitySum(left: number, right: number): number {
  const a = decimalQuantityFraction(Math.abs(left));
  const b = decimalQuantityFraction(Math.abs(right));
  if (a === undefined || b === undefined) return left + right;
  const numerator = BigInt(Math.sign(left)) * a.numerator * b.denominator
    + BigInt(Math.sign(right)) * b.numerator * a.denominator;
  const result = Number(numerator) / Number(a.denominator * b.denominator);
  return Number.isFinite(result) ? result : left + right;
}

function decimalQuantityFraction(value: number): DecimalFraction | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/u.exec(value.toString());
  if (match === null) return undefined;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 32) return undefined;
  const coefficient = BigInt(`${match[1]}${fraction}`);
  return exponent >= 0
    ? { numerator: coefficient * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: coefficient, denominator: 10n ** BigInt(-exponent) };
}

function strategyQuantityStep(suppliedStep: number | undefined): number {
  return typeof suppliedStep === "number" && Number.isFinite(suppliedStep) && suppliedStep > 0
    ? suppliedStep
    : 0.000001;
}

/** Floors to the provider quantity step using decimal integer arithmetic. */
function floorStrategyQuantity(quantity: number, suppliedStep: number | undefined): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const step = strategyQuantityStep(suppliedStep);
  const valueFraction = decimalQuantityFraction(quantity);
  const stepFraction = decimalQuantityFraction(step);
  if (valueFraction === undefined || stepFraction === undefined || stepFraction.numerator === 0n) {
    const ratio = quantity / step;
    if (!Number.isFinite(ratio)) return quantity;
    const units = Math.floor(ratio + Number.EPSILON * Math.max(1, Math.abs(ratio)) * 4);
    return units * step;
  }
  const units = valueFraction.numerator * stepFraction.denominator
    / (valueFraction.denominator * stepFraction.numerator);
  const numerator = Number(units * stepFraction.numerator);
  const denominator = Number(stepFraction.denominator);
  return Number.isFinite(numerator) && Number.isFinite(denominator) ? numerator / denominator : quantity;
}

function strategyTradeExcursionPercent(value: number, basis: number, compatibility: PineCompatibility): number {
  if (basis > 0) return value * 100 / basis;
  return isStrictPineCompatibility(compatibility) ? Number.NaN : 0;
}

/** Checks the limit only at the activation price and on later parts of the bar path. */
function strictStopLimitFill(
  order: MutableStrategyOrder,
  stop: number,
  limit: number,
  verificationPrice: number,
  path: readonly number[],
): number | undefined {
  const stopReached = (price: number): boolean => order.direction * (price - stop) >= 0;
  const limitReached = (price: number): boolean => order.direction * (price - verificationPrice) <= 0;
  const open = path[0]!;
  if (stopReached(open)) order.stopTriggered = true;
  if (order.stopTriggered === true && limitReached(open)) return open;

  for (const price of path.slice(1)) {
    if (order.stopTriggered !== true) {
      if (!stopReached(price)) continue;
      order.stopTriggered = true;
      if (limitReached(stop)) return stop;
    }
    if (limitReached(price)) return limit;
  }
  return undefined;
}

function strategyExcursionPath(bar: MarketBar, orderedPath: boolean): readonly number[] {
  if (orderedPath) return [bar.open, bar.close];
  const highFirst = Math.abs(bar.high - bar.open) <= Math.abs(bar.open - bar.low);
  return highFirst
    ? [bar.open, bar.high, bar.low, bar.close]
    : [bar.open, bar.low, bar.high, bar.close];
}

function strategyExcursionPrice(path: readonly number[], offset: number): number {
  const segment = Math.min(Math.floor(offset), path.length - 2);
  return path[segment]! + (path[segment + 1]! - path[segment]!) * (offset - segment);
}

function strategyExcursionFillOffset(path: readonly number[], from: number, price: number): number {
  for (let segment = Math.floor(from); segment < path.length - 1; segment += 1) {
    const startOffset = segment === Math.floor(from) ? from : segment;
    const start = strategyExcursionPrice(path, startOffset);
    const end = path[segment + 1]!;
    if (price < Math.min(start, end) || price > Math.max(start, end)) continue;
    if (start === end) return startOffset;
    return startOffset + (price - start) / (end - start) * (segment + 1 - startOffset);
  }
  // The order engine selects fills in source order. If a later selected fill
  // crossed earlier on this path, value the prior position through the
  // remaining path and assign this fill a terminal exposure boundary. The
  // order's actual fill price and ledger are unchanged.
  return path.length - 1;
}

function strategyExcursionSegment(bar: MarketBar, path: readonly number[], from: number, to: number): MarketBar {
  const prices = [strategyExcursionPrice(path, from)];
  for (let index = Math.floor(from) + 1; index <= Math.floor(to); index += 1) {
    if (index < to) prices.push(path[index]!);
  }
  prices.push(strategyExcursionPrice(path, to));
  return {
    ...bar,
    open: prices[0]!,
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices.at(-1)!,
  };
}

function legacyIntrabarPoints(
  bar: MarketBar,
  options: {
    parentTime: number;
    intervalEnd: number;
    startsGap: boolean;
  },
): MarketExecutionPoint[] {
  const highFirst = Math.abs(bar.high - bar.open) <= Math.abs(bar.open - bar.low);
  const middle = highFirst
    ? [
        { kind: "high" as const, price: bar.high },
        { kind: "low" as const, price: bar.low },
      ]
    : [
        { kind: "low" as const, price: bar.low },
        { kind: "high" as const, price: bar.high },
      ];
  const values = [
    { kind: "open" as const, price: bar.open },
    ...middle,
    { kind: "close" as const, price: bar.close },
  ];
  const duration = Math.max(3, options.intervalEnd - bar.openTime);
  return values.map((point, sequence) => ({
    parentTime: options.parentTime,
    childTime: bar.openTime,
    timestamp:
      sequence === 3
        ? options.intervalEnd - 1
        : bar.openTime + Math.floor((duration * sequence) / 3),
    sequence,
    price: point.price,
    kind: point.kind,
    source: "high",
    startsGap: options.startsGap && sequence === 0,
  }));
}

function strategyOrderedSegmentIsAdverse(
  bar: MarketBar,
  direction: 1 | -1,
): boolean {
  return direction === 1 ? bar.close < bar.open : bar.close > bar.open;
}

function strategyDayKey(timestamp: number, timezone: string): string {
  const parts = dateParts(timestamp, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** `strategy.close(immediately=true)` and `strategy.close_all(immediately=true)` fill at this bar's close. */
function isImmediateCloseOrder(order: MutableStrategyOrder): boolean {
  return (order.command === "close" || order.command === "close_all") && order.immediately === true;
}
