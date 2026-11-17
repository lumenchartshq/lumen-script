import type { MarketBar } from "../contracts/index.js";
import {
  admitSyntheticHistoricalFillFeed,
  eligibleHistoricalOrders,
  type HistoricalFillEventV1,
  type HistoricalOrderCandidateV1,
  type SyntheticHistoricalFillFeedV1,
} from "./strategy-fill-event-schedule.js";
import {
  StrategyRuntime,
  type MutableStrategyOrder,
  type MutableStrategyState,
  type MutableStrategyTrade,
  type StrategyRuntimeHost,
} from "./strategy.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

export interface SyntheticHistoricalFillCursorV1 {
  readonly version: 1;
  readonly phase: "active" | "complete";
  readonly sourceId: string;
  readonly revision: string;
  readonly barIndex: number;
  readonly pointIndex: number;
  readonly fillOrdinal: number;
  readonly fillCount: number;
}

export interface SyntheticHistoricalFillTransitionV1 {
  readonly state: MutableStrategyState;
  readonly cursor: SyntheticHistoricalFillCursorV1;
  readonly event: HistoricalFillEventV1;
  readonly filledOrderIndex?: number;
  readonly fillPrice?: number;
  readonly cancelledOrderIndices: readonly number[];
  readonly expandedOrderOrigins: readonly { readonly orderIndex: number; readonly sourceOrderIndex: number }[];
}

/** A completed cursor is valid but cannot be advanced through another point. */
export function syntheticHistoricalFillCursorComplete(
  cursor: SyntheticHistoricalFillCursorV1,
  feed: SyntheticHistoricalFillFeedV1,
  barIndex: number,
): boolean {
  const validPoint = cursor.phase === "active"
    ? cursor.pointIndex >= 0 && cursor.pointIndex < 4
    : cursor.phase === "complete" && cursor.pointIndex === 4 && cursor.fillOrdinal === 0;
  if (cursor.version !== 1 || cursor.sourceId !== feed.sourceId || cursor.revision !== feed.revision || cursor.barIndex !== barIndex || !Number.isSafeInteger(cursor.pointIndex) || !Number.isSafeInteger(cursor.fillOrdinal) || cursor.fillOrdinal < 0 || !Number.isSafeInteger(cursor.fillCount) || cursor.fillCount < 0 || cursor.fillCount > 32 || cursor.fillOrdinal > cursor.fillCount || !validPoint) {
    throw new Error("Historical fill transition cursor is invalid");
  }
  return cursor.phase === "complete";
}

/**
 * Internal, unadmitted one-fill transaction. The caller must commit both the
 * returned state and cursor together; production calc_on_order_fills is still
 * guarded. Historical rollback and script re-execution are not owned here.
 */
export function transitionSyntheticHistoricalFillPoint(options: {
  readonly state: Readonly<MutableStrategyState>;
  readonly host: StrategyRuntimeHost;
  readonly feed: SyntheticHistoricalFillFeedV1;
  readonly cursor: SyntheticHistoricalFillCursorV1;
  readonly candidates: readonly HistoricalOrderCandidateV1[];
}): SyntheticHistoricalFillTransitionV1 {
  const { state, host, feed, cursor, candidates } = options;
  const barIndex = host.barIndex();
  const parent = host.bars()[barIndex];
  if (parent === undefined || !Number.isSafeInteger(barIndex) || barIndex < 0) {
    throw new Error("Historical fill parent bar is unavailable");
  }
  const events = admitSyntheticHistoricalFillFeed(parent, feed);
  if (syntheticHistoricalFillCursorComplete(cursor, feed, barIndex)) throw new Error("Historical fill schedule is complete");
  if (state.config.use_bar_magnifier || state.config.calc_on_every_tick || state.config.process_orders_on_close || state.config.backtest_fill_limits_assumption !== 0 || state.config.margin_long !== 100 || state.config.margin_short !== 100 || state.riskRules.maxIntradayFilledOrders !== undefined || state.riskRules.maxDrawdown !== undefined || state.riskRules.maxDrawdownPercentRule !== undefined || state.riskRules.maxIntradayLoss !== undefined || state.riskRules.maxIntradayLossPercentRule !== undefined || state.riskRules.maxConsecutiveLossDays !== undefined) {
    throw new Error("Historical fill transition combination is not admitted");
  }
  if (candidates.length !== state.orders.length) {
    throw new Error("Historical fill order instance inventory is incomplete");
  }
  const event = events[cursor.pointIndex]!;
  const expansionOrigins: HistoricalOrderCandidateV1[] = [];
  const pendingExits: MutableStrategyOrder[] = [];
  const pendingTrailingExits: MutableStrategyOrder[] = [];
  for (const candidate of candidates) {
    const order = state.orders[candidate.orderIndex];
    if (order === undefined || candidate.created.ordinal !== candidate.orderIndex || order.id !== candidate.id || order.status !== candidate.status || order.createdBarIndex !== candidate.created.barIndex || order.command === "margin_call") {
      throw new Error("Historical fill order instance or type is not admitted");
    }
    if (order.type === "stop-limit" && ((order.command !== "entry" && order.command !== "order")
      || !Number.isFinite(order.stop) || !Number.isFinite(order.limit)
      || (order.stopTriggered !== undefined && typeof order.stopTriggered !== "boolean"))) {
      throw new Error("Historical fill stop-limit levels are invalid");
    }
    if (order.status === "pending" && order.command === "exit") {
      pendingExits.push(order);
      if (typeof order.targetEntryId !== "string") throw new Error("Historical fill exit target is invalid");
      const matching = state.openTrades.filter((trade) => (order.targetEntryId === "" || trade.entryId === order.targetEntryId) && (order.targetTradeId === undefined || trade.id === order.targetTradeId));
      const trailing = order.trailOffset !== undefined || order.trailPrice !== undefined || order.trailPoints !== undefined
        || order.trailArmed !== undefined || order.trailPeak !== undefined;
      if (trailing) {
        pendingTrailingExits.push(order);
        if (matching.length === 0 || (matching.length > 1 && (order.targetTradeId !== undefined
          || order.trailArmed !== undefined || order.trailPeak !== undefined
          || order.reservedQuantity !== undefined || order.reservationBasisQuantity !== undefined))) {
          throw new Error("Historical fill trailing exit is not admitted");
        }
        for (const trade of matching) admitSampledTrailingExit(order, trade, host.symbolInfo().mintick, event.point.price);
        if (matching.length > 1) expansionOrigins.push(candidate);
      } else if (matching.length > 0) {
        admitSampledNonTrailingExit(order, matching, host.symbolInfo().mintick);
        if (matching.length > 1) expansionOrigins.push(candidate);
      }
    }
  }
  const oneTradePartialTrailing = pendingTrailingExits.length === 1
    && isSingleTradePartialTrailingExit(pendingTrailingExits[0]!, state.openTrades);
  const sameTradePartialTrailingCalls = areSameTradePartialTrailingCalls(
    pendingExits, pendingTrailingExits, state.openTrades,
  );
  const carriedSingleTrailingOca = isCarriedSingleTrailingReduceOca(
    state.orders, pendingExits, pendingTrailingExits, state.openTrades, state.closedTrades, barIndex,
  );
  const twoByTwoPartialTrailingMatrix = isTwoByTwoPartialTrailingMatrix(
    state.orders, pendingExits, pendingTrailingExits, state.openTrades, state.closedTrades, barIndex,
  );
  const hasTrailingOca = pendingTrailingExits.some((order) => order.ocaName !== undefined || order.ocaType !== undefined);
  if (hasTrailingOca && !sameTradePartialTrailingCalls && !carriedSingleTrailingOca) {
    throw new Error("Historical fill concurrent trailing exits are not admitted");
  }
  if (pendingTrailingExits.length > 0 && pendingExits.length > 1
    && !oneTradePartialTrailing && !sameTradePartialTrailingCalls
    && !twoByTwoPartialTrailingMatrix
    && !sameSampledTrailingExitGroup(pendingExits, pendingTrailingExits, state.openTrades)) {
    throw new Error("Historical fill concurrent trailing exits are not admitted");
  }
  admitSampledExitOcaGroups(state.orders, pendingExits);

  const price = event.point.price;
  const pointBar: MarketBar = {
    openTime: event.point.timestamp,
    closeTime: event.point.timestamp,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  };
  const runtime = new StrategyRuntime(true, state.config, host, true, PINE_COMPATIBILITY.strict);
  runtime.strategy = structuredClone(state) as MutableStrategyState;
  const next = runtime.strategy;
  const expandedCandidates = [...candidates];
  const expandedOrderOrigins: { readonly orderIndex: number; readonly sourceOrderIndex: number }[] = [];
  for (const origin of expansionOrigins) {
    const order = next.orders[origin.orderIndex]!;
    const priorLength = next.orders.length;
    runtime.expandStrategyExitOrder(order);
    for (let orderIndex = priorLength; orderIndex < next.orders.length; orderIndex += 1) {
      const added = next.orders[orderIndex]!;
      expandedCandidates.push({ orderIndex, id: added.id, status: added.status,
        created: { ...origin.created, ordinal: orderIndex } });
      expandedOrderOrigins.push({ orderIndex, sourceOrderIndex: origin.orderIndex });
    }
  }
  reserveSampledExitQuantities(next, expandedOrderOrigins);
  const eligible = eligibleHistoricalOrders(expandedCandidates.map((candidate) => ({
    ...candidate, status: next.orders[candidate.orderIndex]!.status,
  })), barIndex, cursor.pointIndex);
  runtime.markStrategyToMarket(price);
  runtime.beginStrategyDayAt(parent.openTime);

  for (const candidate of eligible) {
    const order = next.orders[candidate.orderIndex]!;
    if (order.status !== "pending") continue;
    const trigger = eventFillTrigger(runtime, order, pointBar);
    if (trigger === undefined) continue;
    if ((order.command === "entry" || order.command === "order") && (runtime.strategyOrderBlocked(order) || !runtime.strategyHasMarginForOrder(order, trigger.price))) {
      order.status = "cancelled";
      continue;
    }
    if (cursor.fillCount >= 32) throw new Error("Historical fill transition exceeds the 32-fill budget");
    const fillPrice = trigger.kind === "exit"
      ? runtime.strategyExitFillPrice(trigger.price, trigger.direction, trigger.exitKind)
      : trigger.price + order.direction * next.config.slippage * tickValue(host);
    order.status = "filled";
    order.fillPrice = fillPrice;
    order.fillBarIndex = barIndex;
    order.fillTime = event.point.timestamp;
    if (trigger.kind === "exit") {
      order.direction = trigger.direction;
      const quantity = runtime.executeStrategyExit(order, fillPrice, event.point.timestamp, trigger.exitKind, order.reservedQuantity);
      if (order.status !== "filled" || quantity <= 0) {
        order.status = "cancelled";
        clearUnfilledPrice(order);
        continue;
      }
      const alertMessage = trigger.exitKind === "profit" ? order.alertProfit : trigger.exitKind === "loss" ? order.alertLoss : order.alertTrailing;
      if (alertMessage !== undefined) order.alertMessage = alertMessage;
      applySampledExitOcaFill(next, order, quantity);
    } else if (order.command === "close" || order.command === "close_all") {
      runtime.executeStrategyClose(order, fillPrice, event.point.timestamp);
      if (order.status !== "filled") {
        clearUnfilledPrice(order);
        continue;
      }
    } else if (order.command === "entry") {
      runtime.executeStrategyEntry(order, fillPrice, event.point.timestamp, false, barIndex);
      runtime.applyStrategyOcaFill(order);
    } else {
      runtime.executeStrategyOrder(order, fillPrice, event.point.timestamp);
      runtime.applyStrategyOcaFill(order);
    }
    next.intradayFills += 1;
    runtime.markStrategyToMarket(price);
    runtime.evaluateStrategyRiskHalts();
    return {
      state: next,
      cursor: Object.freeze({ ...cursor, fillOrdinal: cursor.fillOrdinal + 1, fillCount: cursor.fillCount + 1 }),
      event,
      filledOrderIndex: candidate.orderIndex,
      fillPrice,
      cancelledOrderIndices: newlyCancelledOrderIndices(state, next),
      expandedOrderOrigins: Object.freeze(expandedOrderOrigins),
    };
  }

  return {
    state: next,
    cursor: Object.freeze({ ...cursor, phase: cursor.pointIndex + 1 === events.length ? "complete" : "active", pointIndex: cursor.pointIndex + 1, fillOrdinal: 0 }),
    event,
    cancelledOrderIndices: newlyCancelledOrderIndices(state, next),
    expandedOrderOrigins: Object.freeze(expandedOrderOrigins),
  };
}

function newlyCancelledOrderIndices(before: Readonly<MutableStrategyState>, after: MutableStrategyState): readonly number[] {
  return Object.freeze(after.orders.flatMap((order, index) => order.status === "cancelled"
    && (before.orders[index] === undefined || before.orders[index]?.status === "pending") ? [index] : []));
}

function admitSampledNonTrailingExit(order: MutableStrategyOrder, trades: readonly MutableStrategyTrade[], mintick: number | undefined): void {
  const invalid = (): never => { throw new Error("Historical fill multi-trade exit is not admitted"); };
  const bracket = [order.limit, order.stop, order.profitTicks, order.lossTicks];
  if (order.type !== "market" || !Number.isFinite(order.quantity) || order.quantity < 0
    || (order.quantity === 0 && order.quantityPercent !== undefined && (!Number.isFinite(order.quantityPercent)
      || order.quantityPercent <= 0 || order.quantityPercent > 100))
    || (order.ocaName === undefined) !== (order.ocaType === undefined)
    || (order.ocaName !== undefined && (order.ocaName.length === 0 || order.ocaType !== "reduce"))
    || order.trailOffset !== undefined || order.trailPrice !== undefined || order.trailPoints !== undefined
    || order.trailArmed !== undefined || order.trailPeak !== undefined
    || (order.limit !== undefined && order.profitTicks !== undefined)
    || (order.stop !== undefined && order.lossTicks !== undefined)
    || !bracket.some((level) => level !== undefined)
    || bracket.some((level) => level !== undefined && !Number.isFinite(level))
    || (order.profitTicks !== undefined && order.profitTicks < 0)
    || (order.lossTicks !== undefined && order.lossTicks < 0)
    || (order.reservedQuantity !== undefined && (!Number.isFinite(order.reservedQuantity)
      || order.reservedQuantity <= 0 || order.targetTradeId === undefined
      || (order.quantity > 0 && order.reservedQuantity > order.quantity)))
    || (order.reservedQuantity === undefined) !== (order.reservationBasisQuantity === undefined)
    || (order.reservationBasisQuantity !== undefined && (!Number.isFinite(order.reservationBasisQuantity)
      || order.reservationBasisQuantity <= 0))
    || !Number.isFinite(mintick) || mintick! <= 0) invalid();
  const direction = trades[0]?.direction;
  const ids = new Set<string>();
  for (const trade of trades) {
    if (!trade.id || ids.has(trade.id) || trade.status !== "open" || trade.direction !== direction
      || (trade.direction !== 1 && trade.direction !== -1)
      || !Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.quantity) || trade.quantity <= 0
      || (order.profitTicks !== undefined && !Number.isFinite(trade.entryPrice + trade.direction * order.profitTicks * mintick!))
      || (order.lossTicks !== undefined && !Number.isFinite(trade.entryPrice - trade.direction * order.lossTicks * mintick!))) invalid();
    ids.add(trade.id);
  }
}

/** Explicit exit OCA groups are isolated from entry/order groups in this fixture slice. */
function admitSampledExitOcaGroups(
  orders: readonly MutableStrategyOrder[], pendingExits: readonly MutableStrategyOrder[],
): void {
  for (const exit of pendingExits) {
    if (exit.ocaName === undefined) continue;
    if (orders.some((order) => order.status === "pending" && order.ocaName === exit.ocaName
      && (order.command !== "exit" || order.ocaType !== "reduce"))) {
      throw new Error("Historical fill exit OCA group is not admitted");
    }
  }
}

/** Reduce only another reservation for the same concrete trade. */
function applySampledExitOcaFill(
  state: MutableStrategyState, filled: MutableStrategyOrder, filledQuantity: number,
): void {
  if (filled.ocaName === undefined) return;
  if (filled.ocaType !== "reduce" || filled.targetTradeId === undefined
    || !Number.isFinite(filledQuantity) || filledQuantity <= 0) {
    throw new Error("Historical fill exit OCA group is not admitted");
  }
  for (const sibling of state.orders) {
    if (sibling === filled || sibling.status !== "pending" || sibling.ocaName !== filled.ocaName
      || sibling.targetTradeId !== filled.targetTradeId) continue;
    if (sibling.command !== "exit" || sibling.ocaType !== "reduce"
      || sibling.reservedQuantity === undefined || !Number.isFinite(sibling.reservedQuantity)
      || sibling.reservedQuantity <= 0) {
      throw new Error("Historical fill exit OCA group is not admitted");
    }
    sibling.reservedQuantity = Math.max(0, sibling.reservedQuantity - filledQuantity);
    if (sibling.reservedQuantity === 0) sibling.status = "cancelled";
  }
}

/** Reserve per trade in source-call order; no later exit may reuse the units. */
function reserveSampledExitQuantities(
  state: MutableStrategyState,
  expandedOrigins: readonly { readonly orderIndex: number; readonly sourceOrderIndex: number }[],
): void {
  const sourceIndex = new Map(expandedOrigins.map((origin) => [origin.orderIndex, origin.sourceOrderIndex]));
  const ordered = state.orders.map((order, index) => ({ order, index, source: sourceIndex.get(index) ?? index }))
    .sort((left, right) => left.source - right.source || left.index - right.index);
  const reserved = new Map<string, number>();
  for (const { order } of ordered) {
    if (order.status !== "pending" || order.command !== "exit") continue;
    const matches = state.openTrades.filter((trade) => (order.targetEntryId === "" || trade.entryId === order.targetEntryId)
      && (order.targetTradeId === undefined || trade.id === order.targetTradeId));
    if (matches.length === 0) {
      order.status = "cancelled";
      continue;
    }
    if (matches.length !== 1) throw new Error("Historical fill exit expansion is incomplete");
    const trade = matches[0]!;
    order.targetTradeId = trade.id;
    const available = trade.quantity - (reserved.get(trade.id) ?? 0);
    if (!Number.isFinite(available) || available < 0) throw new Error("Historical fill exit reservations are inconsistent");
    if (order.reservedQuantity !== undefined) {
      const basis = order.reservationBasisQuantity!;
      const originalQuantity = trade.quantity + state.closedTrades
        .filter((closed) => closed.id.startsWith(`${trade.id}-partial-`))
        .reduce((sum, closed) => sum + closed.quantity, 0);
      const requested = order.quantity > 0 ? order.quantity
        : order.quantityPercent !== undefined ? basis * order.quantityPercent / 100 : basis;
      if (!Number.isFinite(originalQuantity) || !Number.isFinite(requested)
        || basis < trade.quantity || basis > originalQuantity
        || order.reservedQuantity > requested || order.reservedQuantity > available) {
        throw new Error("Historical fill exit reservations are inconsistent");
      }
    } else {
      const desired = order.quantity > 0 ? order.quantity
        : order.quantityPercent !== undefined ? trade.quantity * order.quantityPercent / 100 : trade.quantity;
      if (!Number.isFinite(desired) || desired <= 0) throw new Error("Historical fill exit quantity is invalid");
      order.reservedQuantity = Math.min(desired, available);
      if (order.reservedQuantity <= 0) {
        delete order.reservedQuantity;
        order.status = "cancelled";
        continue;
      }
      order.reservationBasisQuantity = trade.quantity;
      order.reservationOriginBarIndex = order.createdBarIndex;
      order.reservationOriginTime = order.createdTime;
      order.reservationIssuedBarIndex = order.createdBarIndex;
      order.reservationIssuedTime = order.createdTime;
    }
    reserved.set(trade.id, (reserved.get(trade.id) ?? 0) + order.reservedQuantity);
  }
}

function admitSampledTrailingExit(order: MutableStrategyOrder, trade: MutableStrategyTrade | undefined,
  mintick: number | undefined, price: number): void {
  const invalid = (): never => { throw new Error("Historical fill trailing exit is not admitted"); };
  if (trade === undefined) throw new Error("Historical fill trailing exit is not admitted");
  if (!Number.isFinite(trade.entryPrice) || !Number.isFinite(trade.quantity) || trade.quantity <= 0
    || (trade.direction !== 1 && trade.direction !== -1)
    || order.type !== "market" || !Number.isFinite(order.quantity) || order.quantity < 0
    || (order.quantity === 0 && order.quantityPercent !== undefined && (!Number.isFinite(order.quantityPercent)
      || order.quantityPercent <= 0 || order.quantityPercent > 100))
    || (order.ocaName === undefined) !== (order.ocaType === undefined)
    || (order.ocaName !== undefined && (order.ocaName.length === 0 || order.ocaType !== "reduce"))
    || (order.reservedQuantity !== undefined && (!Number.isFinite(order.reservedQuantity)
      || order.reservedQuantity <= 0 || order.targetTradeId === undefined))
    || (order.reservedQuantity === undefined) !== (order.reservationBasisQuantity === undefined)
    || (order.reservationBasisQuantity !== undefined && (!Number.isFinite(order.reservationBasisQuantity)
      || order.reservationBasisQuantity <= 0))
    || !Number.isSafeInteger(order.trailOffset) || order.trailOffset! <= 0
    || (order.trailPrice === undefined) === (order.trailPoints === undefined)
    || (order.trailPrice !== undefined && !Number.isFinite(order.trailPrice))
    || (order.trailPoints !== undefined && (!Number.isSafeInteger(order.trailPoints) || order.trailPoints < 0))
    || order.limit !== undefined || order.stop !== undefined || order.profitTicks !== undefined || order.lossTicks !== undefined
    || (order.trailArmed !== undefined && typeof order.trailArmed !== "boolean")
    || (order.trailArmed === true ? !Number.isFinite(order.trailPeak) : order.trailPeak !== undefined)
    || !Number.isFinite(mintick) || mintick! <= 0) invalid();
  const offset = order.trailOffset! * mintick!;
  const activation = order.trailPrice ?? trade.entryPrice + trade.direction * order.trailPoints! * mintick!;
  if (!Number.isFinite(offset) || offset <= 0 || !Number.isFinite(activation)
    || (order.trailArmed === true && (trade.direction === 1 ? order.trailPeak! < activation : order.trailPeak! > activation))
    || (order.trailArmed === true && !Number.isFinite(order.trailPeak! - trade.direction * offset))
    || !Number.isFinite(price - trade.direction * offset)) invalid();
}

function isSingleTradePartialTrailingExit(order: MutableStrategyOrder, openTrades: readonly MutableStrategyTrade[]): boolean {
  const matching = matchingOpenTrades(order, openTrades);
  if (matching.length !== 1) return false;
  const trade = matching[0]!;
  let requested = trade.quantity;
  if (order.quantity > 0) requested = order.quantity;
  else if (order.quantityPercent !== undefined) requested = trade.quantity * order.quantityPercent / 100;
  return Number.isFinite(requested) && requested > 0 && requested < trade.quantity;
}

const MAX_SAME_TRADE_PARTIAL_TRAILING_CALLS = 32;

/** Bounded ungrouped calls, or one reviewed two-call reduce group, may share one trade. */
function areSameTradePartialTrailingCalls(
  pendingExits: readonly MutableStrategyOrder[], pendingTrailingExits: readonly MutableStrategyOrder[],
  openTrades: readonly MutableStrategyTrade[],
): boolean {
  if (pendingTrailingExits.length < 2
    || pendingTrailingExits.length > MAX_SAME_TRADE_PARTIAL_TRAILING_CALLS
    || pendingExits.length !== pendingTrailingExits.length) return false;
  const first = pendingTrailingExits[0]!;
  const ungrouped = first.ocaName === undefined && first.ocaType === undefined;
  const reduceGroup = first.ocaName !== undefined && first.ocaName.length > 0 && first.ocaType === "reduce";
  if (!ungrouped && !reduceGroup || reduceGroup && pendingTrailingExits.length !== 2) return false;
  const callIds = new Set<string>();
  let sharedTradeId: string | undefined;
  let sharedBasis: number | undefined;
  let totalRequested = 0;
  for (const order of pendingTrailingExits) {
    if (!order.id || callIds.has(order.id)
      || order.targetEntryId !== first.targetEntryId
      || order.ocaName !== first.ocaName || order.ocaType !== first.ocaType) return false;
    callIds.add(order.id);
    const matching = matchingOpenTrades(order, openTrades);
    if (matching.length !== 1) return false;
    const trade = matching[0]!;
    if (sharedTradeId !== undefined && trade.id !== sharedTradeId) return false;
    sharedTradeId = trade.id;
    const basis = order.reservationBasisQuantity ?? trade.quantity;
    const requested = order.quantity > 0 ? order.quantity
      : order.quantityPercent !== undefined ? basis * order.quantityPercent / 100 : basis;
    if (!Number.isFinite(basis) || basis <= 0 || !Number.isFinite(requested)
      || requested <= 0 || requested >= basis) return false;
    if (sharedBasis !== undefined && basis !== sharedBasis) return false;
    sharedBasis = basis;
    totalRequested += requested;
  }
  return sharedBasis !== undefined && Number.isFinite(totalRequested)
    && (reduceGroup || totalRequested < sharedBasis);
}

function matchingOpenTrades(
  order: MutableStrategyOrder, openTrades: readonly MutableStrategyTrade[],
): readonly MutableStrategyTrade[] {
  return openTrades.filter((trade) => (order.targetEntryId === "" || trade.entryId === order.targetEntryId)
    && (order.targetTradeId === undefined || trade.id === order.targetTradeId));
}

/** Exactly two ungrouped partial calls may cover one complete two-trade entry set. */
function isTwoByTwoPartialTrailingMatrix(
  orders: readonly MutableStrategyOrder[],
  pendingExits: readonly MutableStrategyOrder[], pendingTrailingExits: readonly MutableStrategyOrder[],
  openTrades: readonly MutableStrategyTrade[], closedTrades: readonly MutableStrategyTrade[], barIndex: number,
): boolean {
  if (pendingExits.length !== pendingTrailingExits.length
    || pendingTrailingExits.length < 2 || pendingTrailingExits.length > 4) return false;
  const first = pendingTrailingExits[0]!;
  if (!first.targetEntryId || pendingTrailingExits.some((order) => !order.id
    || order.targetEntryId !== first.targetEntryId
    || order.ocaName !== undefined || order.ocaType !== undefined)) return false;
  const trades = openTrades.filter((trade) => trade.entryId === first.targetEntryId);
  if (trades.length !== 2 || trades[0]!.id === trades[1]!.id
    || trades[0]!.direction !== trades[1]!.direction) return false;
  const unexpanded = pendingTrailingExits.every((order) => order.targetTradeId === undefined);
  if (unexpanded) return isInitialTwoByTwoPartialTrailingMatrix(pendingTrailingExits, trades);
  if (pendingTrailingExits.some((order) => order.targetTradeId === undefined)) return false;
  return isCarriedTwoByTwoPartialTrailingMatrix(
    orders, pendingTrailingExits, trades, closedTrades, barIndex,
  );
}

function isInitialTwoByTwoPartialTrailingMatrix(
  calls: readonly MutableStrategyOrder[], trades: readonly MutableStrategyTrade[],
): boolean {
  if (calls.length !== 2 || calls[0]!.id === calls[1]!.id
    || calls[0]!.createdBarIndex !== calls[1]!.createdBarIndex
    || calls[0]!.createdTime !== calls[1]!.createdTime
    || calls.some((order) => order.reservedQuantity !== undefined
      || order.reservationBasisQuantity !== undefined || order.trailArmed !== undefined
      || order.trailPeak !== undefined || order.reservationOriginBarIndex !== undefined
      || order.reservationOriginTime !== undefined || order.reservationIssuedBarIndex !== undefined
      || order.reservationIssuedTime !== undefined || order.direction !== -trades[0]!.direction)) return false;
  return trades.every((trade) => {
    const requests = calls.map((order) => trailingMatrixRequestedQuantity(order, trade.quantity));
    return requests.every((requested) => Number.isFinite(requested)
      && requested > 0 && requested < trade.quantity)
      && requests[0]! + requests[1]! < trade.quantity;
  });
}

function isCarriedTwoByTwoPartialTrailingMatrix(
  orders: readonly MutableStrategyOrder[], pending: readonly MutableStrategyOrder[],
  trades: readonly MutableStrategyTrade[], closedTrades: readonly MutableStrategyTrade[], barIndex: number,
): boolean {
  const tradeById = new Map(trades.map((trade) => [trade.id, trade]));
  const pendingPairs = new Set<string>();
  const basisByTrade = new Map<string, number>();
  for (const order of pending) {
    const trade = order.targetTradeId === undefined ? undefined : tradeById.get(order.targetTradeId);
    const basis = order.reservationBasisQuantity;
    const reserved = order.reservedQuantity;
    const originBarIndex = order.reservationOriginBarIndex;
    const originTime = order.reservationOriginTime;
    const issuedBarIndex = order.reservationIssuedBarIndex;
    const issuedTime = order.reservationIssuedTime;
    const pair = `${order.id}\u0000${order.targetTradeId}`;
    if (trade === undefined || pendingPairs.has(pair)
      || !Number.isFinite(basis) || basis! <= 0 || !Number.isFinite(reserved) || reserved! <= 0
      || !Number.isSafeInteger(originBarIndex) || originBarIndex! < 0 || !Number.isFinite(originTime)
      || !Number.isSafeInteger(issuedBarIndex) || issuedBarIndex !== order.createdBarIndex
      || issuedTime !== order.createdTime || originBarIndex! > issuedBarIndex! || originTime! > issuedTime!
      || basis! < trade.quantity || order.direction !== -trade.direction) return false;
    const existingBasis = basisByTrade.get(trade.id);
    if (existingBasis !== undefined && existingBasis !== basis) return false;
    basisByTrade.set(trade.id, basis!);
    pendingPairs.add(pair);
  }
  if (trades.some((trade) => !basisByTrade.has(trade.id))) return false;

  const filled = orders.filter((candidate) => candidate.status === "filled"
    && candidate.command === "exit" && candidate.id && candidate.targetEntryId === pending[0]!.targetEntryId
    && candidate.targetTradeId !== undefined && tradeById.has(candidate.targetTradeId)
    && candidate.ocaName === undefined && candidate.ocaType === undefined && isTrailingOrder(candidate)
    && candidate.reservationBasisQuantity === basisByTrade.get(candidate.targetTradeId)
    && isValidFilledTrailingMatrixMember(candidate, tradeById.get(candidate.targetTradeId)!, closedTrades, barIndex));
  const callIds = new Set(pending.map((order) => order.id));
  if (callIds.size === 1) {
    const missingIds = new Set(filled.map((order) => order.id).filter((id) => !callIds.has(id)));
    if (missingIds.size !== 1) return false;
    callIds.add([...missingIds][0]!);
  }
  if (callIds.size !== 2) return false;

  const members = new Map<string, MutableStrategyOrder>();
  for (const callId of callIds) {
    for (const trade of trades) {
      const pair = `${callId}\u0000${trade.id}`;
      const pendingMembers = pending.filter((order) => order.id === callId && order.targetTradeId === trade.id);
      const filledMembers = filled.filter((order) => order.id === callId && order.targetTradeId === trade.id);
      if (pendingMembers.length === 1 && filledMembers.length === 0) members.set(pair, pendingMembers[0]!);
      else if (pendingMembers.length === 0 && filledMembers.length === 1) members.set(pair, filledMembers[0]!);
      else return false;
    }
  }
  for (const callId of callIds) {
    const pair = trades.map((trade) => members.get(`${callId}\u0000${trade.id}`)!);
    if (!sameTrailingMatrixCallParameters(pair[0]!, pair[1]!)) return false;
  }
  const matrixMembers = [...members.values()];
  const matrixOriginBarIndex = matrixMembers[0]!.reservationOriginBarIndex;
  const matrixOriginTime = matrixMembers[0]!.reservationOriginTime;
  if (matrixMembers.some((member) => member.reservationOriginBarIndex !== matrixOriginBarIndex
    || member.reservationOriginTime !== matrixOriginTime)) return false;
  return trades.every((trade) => {
    const basis = basisByTrade.get(trade.id)!;
    const pair = [...callIds].map((callId) => members.get(`${callId}\u0000${trade.id}`)!);
    const requests = pair.map((order) => trailingMatrixRequestedQuantity(order, basis));
    const originalQuantity = trade.quantity + closedTrades
      .filter((closed) => closed.id.startsWith(`${trade.id}-partial-`))
      .reduce((sum, closed) => sum + closed.quantity, 0);
    return basis <= originalQuantity && requests.every((requested) => Number.isFinite(requested)
      && requested > 0 && requested < basis)
      && requests[0]! + requests[1]! < basis;
  });
}

function trailingMatrixRequestedQuantity(order: MutableStrategyOrder, basis: number): number {
  if (order.quantity > 0) return order.quantity;
  if (order.quantityPercent !== undefined) return basis * order.quantityPercent / 100;
  return basis;
}

function sameTrailingMatrixCallParameters(first: MutableStrategyOrder, second: MutableStrategyOrder): boolean {
  return first.id === second.id && first.type === "market" && second.type === "market"
    && first.quantity === second.quantity && first.quantityPercent === second.quantityPercent
    && first.trailPrice === second.trailPrice && first.trailPoints === second.trailPoints
    && first.trailOffset === second.trailOffset
    && first.reservationOriginBarIndex === second.reservationOriginBarIndex
    && first.reservationOriginTime === second.reservationOriginTime;
}

function isTrailingOrder(order: MutableStrategyOrder): boolean {
  return order.trailOffset !== undefined || order.trailPrice !== undefined || order.trailPoints !== undefined
    || order.trailArmed !== undefined || order.trailPeak !== undefined;
}

function isValidFilledTrailingMatrixMember(
  candidate: MutableStrategyOrder, trade: MutableStrategyTrade,
  closedTrades: readonly MutableStrategyTrade[], barIndex: number,
): boolean {
  const basis = candidate.reservationBasisQuantity;
  const reserved = candidate.reservedQuantity;
  const originBarIndex = candidate.reservationOriginBarIndex;
  const originTime = candidate.reservationOriginTime;
  const issuedBarIndex = candidate.reservationIssuedBarIndex;
  const issuedTime = candidate.reservationIssuedTime;
  const requested = basis === undefined ? Number.NaN : trailingMatrixRequestedQuantity(candidate, basis);
  const relatedClosed = closedTrades.filter((closed) => closed.id.startsWith(`${trade.id}-partial-`));
  const originalQuantity = trade.quantity + relatedClosed.reduce((sum, closed) => sum + closed.quantity, 0);
  return candidate.type === "market" && candidate.direction === -trade.direction
    && Number.isFinite(candidate.quantity) && candidate.quantity >= 0
    && (candidate.quantity !== 0 || candidate.quantityPercent === undefined
      || (Number.isFinite(candidate.quantityPercent) && candidate.quantityPercent > 0
        && candidate.quantityPercent <= 100))
    && Number.isSafeInteger(candidate.trailOffset) && candidate.trailOffset! > 0
    && (candidate.trailPrice === undefined) !== (candidate.trailPoints === undefined)
    && (candidate.trailPrice === undefined || Number.isFinite(candidate.trailPrice))
    && (candidate.trailPoints === undefined
      || (Number.isSafeInteger(candidate.trailPoints) && candidate.trailPoints >= 0))
    && candidate.trailArmed === true && Number.isFinite(candidate.trailPeak)
    && Number.isFinite(reserved) && reserved! > 0 && Number.isFinite(basis) && basis! > 0
    && Number.isSafeInteger(originBarIndex) && originBarIndex! >= 0 && Number.isFinite(originTime)
    && Number.isSafeInteger(issuedBarIndex) && issuedBarIndex === candidate.createdBarIndex
    && issuedTime === candidate.createdTime && originBarIndex! <= issuedBarIndex! && originTime! <= issuedTime!
    && Number.isFinite(requested) && requested > 0 && reserved! <= requested
    && basis! >= trade.quantity && basis! <= originalQuantity
    && Number.isFinite(candidate.fillPrice) && Number.isSafeInteger(candidate.fillBarIndex)
    && candidate.fillBarIndex! >= originBarIndex! && candidate.fillBarIndex! <= barIndex
    && Number.isFinite(candidate.fillTime) && candidate.fillTime! >= originTime!
    && relatedClosed.some((closed) => closed.exitId === candidate.id && closed.quantity === reserved
      && closed.exitPrice === candidate.fillPrice && closed.exitBarIndex === candidate.fillBarIndex
      && closed.exitTime === candidate.fillTime);
}

/** Admit only a concrete, already-reserved sibling left by a prior reduce-OCA fill. */
function isCarriedSingleTrailingReduceOca(
  orders: readonly MutableStrategyOrder[],
  pendingExits: readonly MutableStrategyOrder[], pendingTrailingExits: readonly MutableStrategyOrder[],
  openTrades: readonly MutableStrategyTrade[], closedTrades: readonly MutableStrategyTrade[], barIndex: number,
): boolean {
  if (pendingExits.length !== 1 || pendingTrailingExits.length !== 1) return false;
  const order = pendingTrailingExits[0]!;
  const trade = matchingOpenTrades(order, openTrades)[0];
  return order.ocaName !== undefined && order.ocaName.length > 0 && order.ocaType === "reduce"
    && order.targetTradeId !== undefined && order.reservedQuantity !== undefined
    && order.reservationBasisQuantity !== undefined && trade !== undefined
    && orders.some((candidate) => isValidFilledTrailingOcaSibling(
      candidate, order, trade, closedTrades, barIndex,
    ));
}

function isValidFilledTrailingOcaSibling(
  candidate: MutableStrategyOrder, pending: MutableStrategyOrder, trade: MutableStrategyTrade,
  closedTrades: readonly MutableStrategyTrade[], barIndex: number,
): boolean {
  const basis = candidate.reservationBasisQuantity;
  const reserved = candidate.reservedQuantity;
  const relatedClosed = closedTrades.filter((closed) => closed.id.startsWith(`${trade.id}-partial-`));
  const originalQuantity = trade.quantity + relatedClosed.reduce((sum, closed) => sum + closed.quantity, 0);
  const requested = candidate.quantity > 0 ? candidate.quantity
    : candidate.quantityPercent !== undefined && basis !== undefined ? basis * candidate.quantityPercent / 100 : basis;
  return candidate.status === "filled" && candidate.command === "exit" && candidate.type === "market"
    && candidate.id !== pending.id && candidate.ocaName === pending.ocaName && candidate.ocaType === "reduce"
    && candidate.targetEntryId === pending.targetEntryId && candidate.targetTradeId === trade.id
    && candidate.direction === -trade.direction
    && Number.isFinite(candidate.quantity) && candidate.quantity >= 0
    && (candidate.quantity !== 0 || candidate.quantityPercent === undefined
      || (Number.isFinite(candidate.quantityPercent) && candidate.quantityPercent > 0 && candidate.quantityPercent <= 100))
    && Number.isSafeInteger(candidate.trailOffset) && candidate.trailOffset! > 0
    && (candidate.trailPrice === undefined) !== (candidate.trailPoints === undefined)
    && (candidate.trailPrice === undefined || Number.isFinite(candidate.trailPrice))
    && (candidate.trailPoints === undefined
      || (Number.isSafeInteger(candidate.trailPoints) && candidate.trailPoints >= 0))
    && candidate.trailArmed === true && Number.isFinite(candidate.trailPeak)
    && Number.isFinite(reserved) && reserved! > 0 && Number.isFinite(basis) && basis! > 0
    && Number.isFinite(requested) && requested! > 0 && reserved! <= requested!
    && basis! >= trade.quantity && basis! <= originalQuantity
    && Number.isFinite(candidate.fillPrice) && Number.isSafeInteger(candidate.fillBarIndex)
    && Number.isFinite(candidate.fillTime)
    && (candidate.fillBarIndex === pending.createdBarIndex || candidate.fillBarIndex === barIndex)
    && relatedClosed.some((closed) => closed.exitId === candidate.id && closed.quantity === reserved
      && closed.exitPrice === candidate.fillPrice && closed.exitBarIndex === candidate.fillBarIndex
      && closed.exitTime === candidate.fillTime);
}

/** Only cloned orders from one consistently reserved trailing call may coexist. */
function sameSampledTrailingExitGroup(
  pendingExits: readonly MutableStrategyOrder[], pendingTrailingExits: readonly MutableStrategyOrder[],
  openTrades: readonly MutableStrategyTrade[],
): boolean {
  if (pendingExits.length !== pendingTrailingExits.length) return false;
  const first = pendingTrailingExits[0];
  if (first?.targetTradeId === undefined) return false;
  const targets = new Set<string>();
  for (const order of pendingTrailingExits) {
    if (order.targetTradeId === undefined || targets.has(order.targetTradeId)
      || order.id !== first.id || order.targetEntryId !== first.targetEntryId
      || order.createdBarIndex !== first.createdBarIndex || order.createdTime !== first.createdTime
      || order.trailPrice !== first.trailPrice || order.trailPoints !== first.trailPoints
      || order.trailOffset !== first.trailOffset || order.quantity !== first.quantity
      || order.quantityPercent !== first.quantityPercent) return false;
    const trade = openTrades.find((candidate) => candidate.id === order.targetTradeId);
    const basis = order.reservationBasisQuantity;
    const reserved = order.reservedQuantity;
    if (trade === undefined || basis === undefined || reserved === undefined
      || !Number.isFinite(basis) || basis <= 0 || !Number.isFinite(reserved) || reserved <= 0
      || basis !== trade.quantity
      || reserved !== Math.min(order.quantity > 0 ? order.quantity
        : order.quantityPercent !== undefined ? basis * order.quantityPercent / 100 : basis, basis)) return false;
    targets.add(order.targetTradeId);
  }
  const matchingTrades = openTrades.filter((trade) => first.targetEntryId === "" || trade.entryId === first.targetEntryId);
  return matchingTrades.length === targets.size && matchingTrades.every((trade) => targets.has(trade.id));
}

function eventFillTrigger(runtime: StrategyRuntime, order: MutableStrategyOrder, bar: MarketBar):
  | { readonly kind: "regular"; readonly price: number }
  | { readonly kind: "exit"; readonly price: number; readonly direction: 1 | -1; readonly exitKind: "profit" | "loss" | "trailing" }
  | undefined {
  const price = bar.close;
  if (order.command === "exit") {
    const trigger = runtime.strategyExitTrigger(order, bar, order.trailOffset === undefined);
    return trigger === undefined ? undefined : { kind: "exit", price, direction: trigger.direction, exitKind: trigger.kind };
  }
  if (order.type === "market") return { kind: "regular", price };
  if (order.type === "stop-limit") {
    const stop = order.stop!;
    const limit = order.limit!;
    if (order.stopTriggered !== true) {
      const activated = order.direction === 1 ? price >= stop : price <= stop;
      if (!activated) return undefined;
      order.stopTriggered = true;
    }
    const favorable = order.direction === 1 ? price <= limit : price >= limit;
    return favorable ? { kind: "regular", price } : undefined;
  }
  const threshold = order.type === "limit" ? order.limit : order.stop;
  if (threshold === undefined) return undefined;
  const met = order.type === "limit"
    ? (order.direction === 1 ? price <= threshold : price >= threshold)
    : (order.direction === 1 ? price >= threshold : price <= threshold);
  return met ? { kind: "regular", price } : undefined;
}

function tickValue(host: StrategyRuntimeHost): number {
  const value = host.symbolInfo().mintick;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function clearUnfilledPrice(order: MutableStrategyOrder): void {
  delete order.fillPrice;
  delete order.fillBarIndex;
  delete order.fillTime;
}
