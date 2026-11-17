import type { MarketBar, PineValue, StrategyConfig } from "../contracts/index.js";
import type { MutableStrategyState } from "./strategy.js";

export function createStrategyState(config: StrategyConfig | undefined, defaultCurrency?: PineValue, publicExitReservations = false): MutableStrategyState {
  const declared = config ?? {
    initial_capital: 1_000_000,
    currency: "USD",
    pyramiding: 1,
    default_qty_type: "fixed",
    default_qty_value: 1,
    slippage: 0,
    commission_type: "percent",
    commission_value: 0,
    process_orders_on_close: false,
    margin_long: 100,
    margin_short: 100,
    calc_on_order_fills: false,
    calc_on_every_tick: false,
    backtest_fill_limits_assumption: 0,
    close_entries_rule: "FIFO",
    risk_free_rate: 2,
    use_bar_magnifier: false,
    fill_orders_on_standard_ohlc: false,
  };
  const resolved = declared.currency.toUpperCase() === "NONE" && typeof defaultCurrency === "string" && defaultCurrency.length > 0
    ? { ...declared, currency: defaultCurrency }
    : declared;
  return {
    config: Object.freeze({ ...resolved }),
    orders: [],
    ...(publicExitReservations ? { publicExitIntents: [] } : {}),
    openTrades: [],
    closedTrades: [],
    closedTradeCount: 0,
    closedTradeFirstIndex: 0,
    closedTradeProfitTotal: 0,
    closedTradePercentTotal: 0,
    winningTradePercentTotal: 0,
    losingTradePercentTotal: 0,
    timeline: [],
    nextTradeId: 0,
    positionSize: 0,
    positionAveragePrice: Number.NaN,
    openProfit: 0,
    netProfit: 0,
    equity: resolved.initial_capital,
    grossProfit: 0,
    grossLoss: 0,
    winningTrades: 0,
    losingTrades: 0,
    evenTrades: 0,
    winningProfit: 0,
    losingLoss: 0,
    maxContractsHeld: 0,
    maxContractsHeldLong: 0,
    maxContractsHeldShort: 0,
    equityPeak: resolved.initial_capital,
    equityTrough: resolved.initial_capital,
    maxDrawdown: 0,
    maxDrawdownPercent: 0,
    maxRunup: 0,
    maxRunupPercent: 0,
    firstEntryPrice: Number.NaN,
    monthlyEquity: [],
    lastMonthKey: undefined,
    riskRules: {},
    riskHalted: false,
    intradayRiskHalted: false,
    intradayKey: "",
    intradayStartEquity: resolved.initial_capital,
    intradayPeakEquity: resolved.initial_capital,
    intradayFills: 0,
    currentDayRealizedProfit: 0,
    consecutiveLossDays: 0,
  };
}

export function strategyCagr(strategy: MutableStrategyState, bars: readonly MarketBar[]): number {
  const firstTime = bars[0]?.openTime;
  const lastTime = bars.at(-1)?.openTime;
  if (firstTime === undefined || lastTime === undefined) return Number.NaN;
  const days = (lastTime - firstTime) / 86_400_000;
  const endingCapital = strategy.config.initial_capital + strategy.netProfit;
  if (days < 1 || strategy.config.initial_capital === 0 || !Number.isFinite(endingCapital)) return Number.NaN;
  return 100 * (Math.pow(endingCapital / strategy.config.initial_capital, 365 / days) - 1);
}

export function strategyBuyAndHold(strategy: MutableStrategyState, bars: readonly MarketBar[]): { readonly profit: number; readonly percent: number } {
  const finalPrice = bars.at(-1)?.close;
  if (!Number.isFinite(strategy.firstEntryPrice) || strategy.firstEntryPrice === 0 || finalPrice === undefined || !Number.isFinite(finalPrice)) {
    return { profit: Number.NaN, percent: Number.NaN };
  }
  const ratio = (finalPrice - strategy.firstEntryPrice) / strategy.firstEntryPrice;
  if (strategy.firstEntryRate !== undefined && strategy.firstEntryPointValue !== undefined && strategy.lastFxRate !== undefined) {
    const unitCost = strategy.firstEntryPrice * strategy.firstEntryPointValue * strategy.firstEntryRate;
    if (!Number.isFinite(unitCost) || unitCost === 0 || !Number.isFinite(strategy.lastFxRate)) {
      return { profit: Number.NaN, percent: ratio * 100 };
    }
    const units = strategy.config.initial_capital / unitCost;
    const profit = units * (finalPrice - strategy.firstEntryPrice) * strategy.firstEntryPointValue * strategy.lastFxRate;
    return { profit: Number.isFinite(profit) ? profit : Number.NaN, percent: ratio * 100 };
  }
  return { profit: strategy.config.initial_capital * ratio, percent: ratio * 100 };
}

export function strategyRiskAdjusted(strategy: MutableStrategyState): { readonly sharpe: number; readonly sortino: number } {
  const equities = [strategy.config.initial_capital, ...strategy.monthlyEquity];
  const returns: number[] = [];
  for (let index = 1; index < equities.length; index += 1) {
    const previous = equities[index - 1]!;
    const current = equities[index]!;
    if (previous !== 0 && Number.isFinite(previous) && Number.isFinite(current)) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return { sharpe: 0, sortino: 0 };
  const monthlyRiskFreeRate = strategy.config.risk_free_rate / 100 / 12;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const excess = mean - monthlyRiskFreeRate;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  const downsideVariance = returns.reduce((sum, value) => sum + Math.min(0, value - monthlyRiskFreeRate) ** 2, 0) / returns.length;
  const deviation = Math.sqrt(variance);
  const downsideDeviation = Math.sqrt(downsideVariance);
  return {
    sharpe: deviation > 0 ? excess / deviation : 0,
    sortino: downsideDeviation > 0 ? excess / downsideDeviation : 0,
  };
}

export function strategyPercent(value: number, basis: number): number {
  return basis === 0 ? 0 : value * 100 / basis;
}
