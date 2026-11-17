import type { MarketBar, StrategyConfig, StrategyTrade, SymbolInfo } from "../contracts/index.js";
import { number } from "./values.js";

export function strategyPointValue(symbolInfo: SymbolInfo): number {
  const pointValue = number(symbolInfo.pointvalue ?? 1);
  return Number.isFinite(pointValue) ? pointValue : 1;
}

export function strategyAdverseFirst(
  bar: MarketBar,
  direction: 1 | -1,
): boolean {
  const openCloserToHigh =
    Math.abs(bar.high - bar.open) <= Math.abs(bar.open - bar.low);
  return direction === 1 ? !openCloserToHigh : openCloserToHigh;
}

export function strategyFillTime(bar: MarketBar, price: number): number {
  const closeTime = bar.closeTime ?? bar.openTime;
  const movement = bar.close - bar.open;
  if (closeTime <= bar.openTime || movement === 0) return bar.openTime;
  const ratio = Math.max(0, Math.min(1, (price - bar.open) / movement));
  return Math.round(bar.openTime + (closeTime - bar.openTime) * ratio);
}

export function strategyLegCommission(options: {
  config: StrategyConfig;
  pointValue: number;
  price: number;
  quantity: number;
  rate?: number;
}): number {
  const value = options.config.commission_value;
  if (value === 0) return 0;
  if (options.config.commission_type === "cash_per_order") return value;
  if (options.config.commission_type === "cash_per_contract") {
    return options.quantity * value;
  }
  return options.quantity * options.price * options.pointValue * (options.rate ?? 1) * value / 100;
}

export function averageStrategyTradePercent(
  trades: readonly StrategyTrade[],
  direction?: 1 | -1,
  strictPointValue?: number,
): number {
  const matching = trades.filter(
    (trade) =>
      direction === undefined || Math.sign(trade.profit ?? 0) === direction,
  );
  if (matching.length === 0) return Number.NaN;
  let total = 0;
  for (const trade of matching) {
    const notional = strictPointValue === undefined ? trade.quantity * trade.entryPrice
      : (trade as StrategyTrade & { entryBasis?: number }).entryBasis ?? trade.quantity * trade.entryPrice * strictPointValue;
    if (strictPointValue !== undefined && (!Number.isFinite(notional) || notional <= 0)) return Number.NaN;
    const profit = trade.profit ?? (strictPointValue === undefined ? 0 : Number.NaN);
    const percent = notional === 0 ? 0 : profit * 100 / notional;
    total += strictPointValue !== undefined && direction === -1 ? -percent : percent;
  }
  return total / matching.length;
}
