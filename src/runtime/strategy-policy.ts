import type { MarketBar } from "../contracts/index.js";
import type { MutableStrategyOrder, MutableStrategyState, MutableStrategyTrade } from "./strategy.js";
import { strategyPercent } from "./strategy-accounting.js";
import { strategyAdverseFirst } from "./strategy-math.js";

type State = Readonly<MutableStrategyState>;
type Order = Readonly<MutableStrategyOrder>;

export function projectedPosition(strategy: State, order: Order): number {
  if (order.command === "entry" && strategy.positionSize !== 0 && Math.sign(strategy.positionSize) !== order.direction) return order.direction * order.quantity;
  return strategy.positionSize + order.direction * order.quantity;
}

export function strategyOrderBlocked(strategy: State, order: Order): boolean {
  if (strategy.riskHalted) return true;
  const allowed = strategy.riskRules.allowEntryIn;
  if (allowed === "long" && order.direction === -1) return true;
  if (allowed === "short" && order.direction === 1) return true;
  if (strategy.riskRules.maxIntradayFilledOrders !== undefined && strategy.intradayFills >= strategy.riskRules.maxIntradayFilledOrders) return true;
  return strategy.riskRules.maxPositionSize !== undefined && Math.abs(projectedPosition(strategy, order)) > strategy.riskRules.maxPositionSize;
}

/** Strict-profile entry controls are evaluated at the fill, using current exposure. */
export function strategyRiskOrderDecision(strategy: State, order: Order): { blocked: boolean; quantity: number; closeOnly: boolean } {
  if (strategy.riskHalted || strategy.intradayRiskHalted) return { blocked: true, quantity: 0, closeOnly: false };
  if (order.command !== "entry") return { blocked: false, quantity: order.quantity, closeOnly: false };
  const allowed = strategy.riskRules.allowEntryIn;
  if (allowed === "none" || (allowed === "long" && order.direction === -1) || (allowed === "short" && order.direction === 1)) {
    const closeOnly = strategy.positionSize !== 0 && Math.sign(strategy.positionSize) !== order.direction;
    return { blocked: !closeOnly, quantity: closeOnly ? Math.abs(strategy.positionSize) : 0, closeOnly };
  }
  const maximum = strategy.riskRules.maxPositionSize;
  if (maximum === undefined) return { blocked: false, quantity: order.quantity, closeOnly: false };
  const sameDirection = Math.sign(strategy.positionSize) === order.direction;
  const available = sameDirection ? maximum - Math.abs(strategy.positionSize) : maximum;
  const quantity = Math.min(order.quantity, Math.max(0, available));
  return { blocked: quantity <= 0, quantity, closeOnly: false };
}

export function strategyRiskDecision(strategy: State): { permanent: boolean; intraday: boolean; filledOrders: boolean; drawdown: boolean; lossDays: boolean; alertMessage?: string } {
  const exceeds = (loss: number, rule: { readonly value: number; readonly type: "cash" | "percent_of_equity" } | undefined, basis: number): boolean => {
    if (rule === undefined) return false;
    if (rule.type === "cash") return loss >= rule.value;
    return basis > 0 ? loss * 100 / basis >= rule.value : loss > 0;
  };
  const peakClosedProfit = strategy.riskClosedProfitPeak ?? 0;
  const closedEquityPeak = strategy.config.initial_capital + peakClosedProfit;
  const closedEquity = strategy.config.initial_capital + strategy.closedTradeProfitTotal;
  const drawdown = Math.max(0, peakClosedProfit - strategy.closedTradeProfitTotal);
  const intradayLoss = Math.max(0, strategy.intradayStartEquity - strategy.equity);
  const drawdownRule = strategy.riskRules.maxDrawdown;
  const percentDrawdownRule = strategy.riskRules.maxDrawdownPercentRule;
  // The risk rule measures the decline in cumulative closed-trade profit.
  const drawdownCashHit = exceeds(drawdown, drawdownRule, closedEquityPeak);
  const drawdownPercentHit = percentDrawdownRule !== undefined
    && (closedEquity <= 0 || exceeds(drawdown, percentDrawdownRule, closedEquityPeak));
  const drawdownHit = drawdownCashHit || drawdownPercentHit;
  const lossDaysHit = strategy.riskRules.maxConsecutiveLossDays !== undefined
    && strategy.consecutiveLossDays >= strategy.riskRules.maxConsecutiveLossDays;
  const lossCashHit = exceeds(intradayLoss, strategy.riskRules.maxIntradayLoss, strategy.intradayStartEquity);
  const lossPercentHit = exceeds(intradayLoss, strategy.riskRules.maxIntradayLossPercentRule, strategy.intradayStartEquity);
  const exhaustedPercentEquity = strategy.riskRules.maxIntradayLossPercentRule !== undefined && strategy.equity <= 0;
  const lossHit = lossCashHit || lossPercentHit;
  const fillsHit = strategy.riskRules.maxIntradayFilledOrders !== undefined
    && strategy.intradayFills >= strategy.riskRules.maxIntradayFilledOrders;
  const alertMessage = drawdownHit ? (drawdownCashHit ? drawdownRule?.alertMessage : percentDrawdownRule?.alertMessage)
    : lossDaysHit ? strategy.riskRules.maxConsecutiveLossDaysAlertMessage
      : lossHit ? (lossCashHit ? strategy.riskRules.maxIntradayLoss?.alertMessage : strategy.riskRules.maxIntradayLossPercentRule?.alertMessage)
        : fillsHit ? strategy.riskRules.maxIntradayFilledOrdersAlertMessage : undefined;
  return { permanent: drawdownHit || lossDaysHit || exhaustedPercentEquity, intraday: lossHit, filledOrders: fillsHit,
    drawdown: drawdownHit, lossDays: lossDaysHit, ...(alertMessage === undefined ? {} : { alertMessage }) };
}

export function strategyRiskHaltRequired(strategy: State): boolean {
  const thresholdExceeded = (loss: number, rule: { readonly value: number; readonly type: "cash" | "percent_of_equity" } | undefined, basis: number): boolean => {
    if (rule === undefined) return false;
    return rule.type === "percent_of_equity" ? strategyPercent(loss, basis) >= rule.value : loss >= rule.value;
  };
  const intradayLoss = Math.max(0, strategy.intradayStartEquity - strategy.equity);
  return thresholdExceeded(strategy.maxDrawdown, strategy.riskRules.maxDrawdown, strategy.equityPeak)
    || thresholdExceeded(intradayLoss, strategy.riskRules.maxIntradayLoss, strategy.intradayStartEquity)
    || (strategy.riskRules.maxIntradayFilledOrders !== undefined && strategy.intradayFills >= strategy.riskRules.maxIntradayFilledOrders)
    || (strategy.riskRules.maxConsecutiveLossDays !== undefined && strategy.consecutiveLossDays >= strategy.riskRules.maxConsecutiveLossDays);
}

export function strategyEquityAtPrice(strategy: State, price: number, pointValue: number): number {
  const openProfit = strategy.openTrades.reduce((sum, trade) => sum + (price - trade.entryPrice) * trade.direction * trade.quantity * pointValue, 0);
  return strategy.config.initial_capital + strategy.netProfit + openProfit;
}

export function strategyHasMarginForOrder(strategy: State, order: Order, fillPrice: number, pointValue: number): boolean {
  const projected = projectedPosition(strategy, order);
  const marginPercent = projected >= 0 ? strategy.config.margin_long : strategy.config.margin_short;
  const requiredMargin = Math.abs(projected) * fillPrice * pointValue * marginPercent / 100;
  return strategyEquityAtPrice(strategy, fillPrice, pointValue) >= requiredMargin;
}

export function strategyMarginLiquidationPrice(strategy: State, pointValue: number, tickValue: number, strict: boolean, fxRate = 1): number {
  if (strategy.positionSize === 0 || !Number.isFinite(strategy.positionAveragePrice)) return Number.NaN;
  const direction = Math.sign(strategy.positionSize);
  const marginPercent = direction === 1 ? strategy.config.margin_long : strategy.config.margin_short;
  if (strict && (marginPercent <= 0 || (direction === 1 && marginPercent === 100)
    || !Number.isFinite(pointValue) || pointValue <= 0
    || !Number.isFinite(tickValue) || tickValue <= 0 || !Number.isFinite(fxRate) || fxRate <= 0)) return Number.NaN;
  if (!strict && marginPercent >= 100) return Number.NaN;
  const raw = ((strategy.config.initial_capital + strategy.netProfit) / (pointValue * fxRate * Math.abs(strategy.positionSize)) - direction * strategy.positionAveragePrice)
    / (marginPercent / 100 - direction);
  const tick = strict ? tickValue : Number.isFinite(tickValue) && tickValue > 0 ? tickValue : 0.01;
  if (!strict) return direction === 1 ? Math.floor(raw / tick) * tick : Math.ceil(raw / tick) * tick;
  if (!Number.isFinite(raw)) return Number.NaN;
  const exactBoundary = exactMarginBoundary(strategy, pointValue, fxRate, tick, marginPercent, direction);
  if (exactBoundary !== undefined) return exactBoundary;
  return direction === 1 ? Math.floor(raw / tick) * tick : Math.ceil(raw / tick) * tick;
}

interface Fraction { numerator: bigint; denominator: bigint }

function decimalFraction(value: number): Fraction | undefined {
  if (!Number.isFinite(value)) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value.toString());
  if (match === null) return undefined;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0) - fraction.length;
  if (Math.abs(exponent) > 32) return undefined;
  const coefficient = BigInt(`${match[1]}${match[2]}${fraction}`);
  return exponent >= 0
    ? { numerator: coefficient * 10n ** BigInt(exponent), denominator: 1n }
    : { numerator: coefficient, denominator: 10n ** BigInt(-exponent) };
}

function addFraction(left: Fraction, right: Fraction): Fraction {
  return { numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator };
}

function multiplyFraction(left: Fraction, right: Fraction): Fraction {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

/** Compare the boundary with decimal host inputs before binary division can move an exact tick. */
function exactMarginBoundary(strategy: State, pointValue: number, fxRate: number, tick: number, marginPercent: number, direction: number): number | undefined {
  const parts = [strategy.config.initial_capital, strategy.netProfit, Math.abs(strategy.positionSize),
    pointValue, fxRate, strategy.positionAveragePrice, marginPercent, tick].map(decimalFraction);
  if (parts.some((part) => part === undefined)) return undefined;
  const [capital, profit, size, point, rate, average, margin, tickFraction] = parts as Fraction[];
  const accountPoint = multiplyFraction(point!, rate!);
  const signedAverage = multiplyFraction(multiplyFraction(size!, accountPoint), average!);
  const funds = addFraction(capital!, profit!);
  const numerator = addFraction(funds, multiplyFraction({ numerator: BigInt(-direction), denominator: 1n }, signedAverage));
  const marginFraction = multiplyFraction(margin!, { numerator: 1n, denominator: 100n });
  const denominator = multiplyFraction(multiplyFraction(size!, accountPoint),
    addFraction(marginFraction, { numerator: BigInt(-direction), denominator: 1n }));
  if (denominator.numerator === 0n || tickFraction!.numerator === 0n) return undefined;
  const signedNumerator = numerator.numerator * denominator.denominator * tickFraction!.denominator;
  const signedDenominator = numerator.denominator * denominator.numerator * tickFraction!.numerator;
  const positiveNumerator = signedDenominator < 0n ? -signedNumerator : signedNumerator;
  const positiveDenominator = signedDenominator < 0n ? -signedDenominator : signedDenominator;
  const quotient = positiveNumerator / positiveDenominator;
  const remainder = positiveNumerator % positiveDenominator;
  const rounded = direction === 1
    ? quotient - (remainder < 0n ? 1n : 0n)
    : quotient + (remainder > 0n ? 1n : 0n);
  const ticks = Number(rounded);
  if (!Number.isSafeInteger(ticks)) return undefined;
  const price = Number(rounded * tickFraction!.numerator) / Number(tickFraction!.denominator);
  return Number.isFinite(price) ? price : undefined;
}

export function strategyMarginCallDecision(strategy: State, bar: MarketBar, pointValue: number, checkpoint: "open" | "extreme" | "close"): { coverQuantity: number; legacyQuantity: number; price: number; direction: 1 | -1 } | undefined {
  if (strategy.positionSize === 0) return undefined;
  const direction = strategy.positionSize > 0 ? 1 : -1;
  let price = direction === 1 ? bar.low : bar.high;
  if (checkpoint === "open") price = bar.open;
  else if (checkpoint === "close") price = bar.close;
  const marginPercent = direction === 1 ? strategy.config.margin_long : strategy.config.margin_short;
  const marginFraction = marginPercent / 100;
  if (marginFraction <= 0) return undefined;
  const totalQuantity = Math.abs(strategy.positionSize);
  const requiredMargin = totalQuantity * price * pointValue * marginFraction;
  const equity = strategyEquityAtPrice(strategy, price, pointValue);
  if (equity >= requiredMargin) return undefined;
  const deficit = requiredMargin - equity;
  const unitMargin = price * pointValue * marginFraction;
  const coverQuantity = deficit / unitMargin;
  const legacyQuantity = Math.min(totalQuantity, 4 * deficit / unitMargin);
  if (!(legacyQuantity > 0)) return undefined;
  return { coverQuantity, legacyQuantity, price, direction: direction === 1 ? -1 : 1 };
}

export function firstFavorableLevel(absolute: number | undefined, relative: number | undefined, direction: 1 | -1): number | undefined {
  if (absolute === undefined) return relative;
  if (relative === undefined) return absolute;
  return direction === 1 ? Math.min(absolute, relative) : Math.max(absolute, relative);
}

export function strategyExitDecision(order: Order, trade: Readonly<MutableStrategyTrade>, bar: MarketBar, tick: number, trailingPrice: number | undefined, earliestPair = false): { price: number; direction: 1 | -1; kind: "profit" | "loss" | "trailing" } | undefined {
  const relativeProfit = order.profitTicks === undefined ? undefined : trade.entryPrice + trade.direction * order.profitTicks * tick;
  const relativeLoss = order.lossTicks === undefined ? undefined : trade.entryPrice - trade.direction * order.lossTicks * tick;
  const profitPrice = earliestPair ? firstFavorableLevel(order.limit, relativeProfit, trade.direction) : order.limit ?? relativeProfit;
  const lossPrice = earliestPair ? firstFavorableLevel(order.stop, relativeLoss, trade.direction === 1 ? -1 : 1) : order.stop ?? relativeLoss;
  const profitHit = profitPrice !== undefined && (trade.direction === 1 ? bar.high >= profitPrice : bar.low <= profitPrice);
  const lossHit = lossPrice !== undefined && (trade.direction === 1 ? bar.low <= lossPrice : bar.high >= lossPrice);
  if (!profitHit && !lossHit && trailingPrice === undefined) return undefined;
  const direction = trade.direction === 1 ? -1 : 1;
  if (trailingPrice !== undefined) return { price: trailingPrice, direction, kind: "trailing" };
  const lossFirst = lossHit && (!profitHit || strategyAdverseFirst(bar, trade.direction));
  return { price: lossFirst ? lossPrice! : profitPrice!, direction, kind: lossFirst ? "loss" : "profit" };
}
