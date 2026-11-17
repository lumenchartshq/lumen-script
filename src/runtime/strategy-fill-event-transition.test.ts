import { describe, expect, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import { createStrategyState } from "./strategy-accounting.js";
import type { HistoricalOrderCandidateV1, SyntheticHistoricalFillFeedV1 } from "./strategy-fill-event-schedule.js";
import {
  syntheticHistoricalFillCursorComplete,
  transitionSyntheticHistoricalFillPoint,
  type SyntheticHistoricalFillCursorV1,
} from "./strategy-fill-event-transition.js";
import type { MutableStrategyOrder, MutableStrategyState, StrategyRuntimeHost } from "./strategy.js";

const parent: MarketBar = { openTime: 1_000, closeTime: 1_040, open: 100, high: 102, low: 99, close: 101, volume: 40 };
const feed: SyntheticHistoricalFillFeedV1 = {
  version: 1,
  source: "synthetic",
  sourceId: "sya546-transition",
  revision: "fixture-1",
  parentOpenTime: parent.openTime,
  points: [
    { sequence: 0, timestamp: 1_000, kind: "open", price: 100, cumulativeVolume: 0 },
    { sequence: 1, timestamp: 1_010, kind: "high", price: 102, cumulativeVolume: 10 },
    { sequence: 2, timestamp: 1_020, kind: "low", price: 99, cumulativeVolume: 20 },
    { sequence: 3, timestamp: 1_040, kind: "close", price: 101, cumulativeVolume: 40 },
  ],
};
const host: StrategyRuntimeHost = {
  barIndex: () => 1,
  bars: () => [{ ...parent, openTime: 900, closeTime: 940 }, parent],
  data: () => Number.NaN,
  symbolInfo: () => ({ currency: "USD", mintick: 0.01, pointvalue: 1 }),
  timezone: () => "Etc/UTC",
  executionBars: () => [],
  executionPoints: () => [],
};
const initialCursor: SyntheticHistoricalFillCursorV1 = {
  version: 1, phase: "active", sourceId: feed.sourceId, revision: feed.revision, barIndex: 1,
  pointIndex: 0, fillOrdinal: 0, fillCount: 0,
};

function entry(id: string, ocaName?: string): MutableStrategyOrder {
  return {
    id, command: "entry", direction: 1, quantity: 1, type: "market",
    createdBarIndex: 0, createdTime: 900, status: "pending",
    ...(ocaName === undefined ? {} : { ocaName, ocaType: "cancel" as const }),
  };
}

function candidates(state: MutableStrategyState, createdPoint?: number): HistoricalOrderCandidateV1[] {
  return state.orders.map((order, orderIndex) => ({
    orderIndex,
    id: order.id,
    status: order.status,
    created: {
      barIndex: order.createdBarIndex,
      ...(order.createdBarIndex === 1 && createdPoint !== undefined ? { pointIndex: createdPoint } : {}),
      ordinal: orderIndex,
    },
  }));
}

describe("Z10 internal one-point fill transition", () => {
  it.each(["maxDrawdownPercentRule", "maxIntradayLossPercentRule"] as const)("rejects unadmitted %s before changing the input", (rule) => {
    const state = createStrategyState(undefined);
    state.riskRules[rule] = { value: 0, type: "percent_of_equity" };
    state.orders.push(entry("opening"));
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) }))
      .toThrow("combination is not admitted");
    expect(state.orders[0]?.status).toBe("pending");
    expect(state.openTrades).toHaveLength(0);
  });

  it("S0 advances without fills and never uses a future point as the as-of price", () => {
    const state = createStrategyState(undefined);
    state.intradayKey = "previous-day";
    state.intradayFills = 7;
    state.currentDayRealizedProfit = -1;
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: [] });
    expect(first.filledOrderIndex).toBeUndefined();
    expect(first.cursor).toMatchObject({ pointIndex: 1, fillCount: 0 });
    expect(first.event.asOfBar).toMatchObject({ close: 100, high: 100, low: 100, volume: 0 });
    expect(first.state.intradayFills).toBe(0);
    expect(first.state.consecutiveLossDays).toBe(1);
    expect(state.equity).toBe(1_000_000);
    expect(state.intradayFills).toBe(7);
    let current = first;
    for (let index = 1; index < 4; index += 1) {
      current = transitionSyntheticHistoricalFillPoint({ state: current.state, host, feed, cursor: current.cursor, candidates: [] });
    }
    expect(current.cursor).toMatchObject({ phase: "complete", pointIndex: 4, fillOrdinal: 0 });
    expect(syntheticHistoricalFillCursorComplete(current.cursor, feed, 1)).toBe(true);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: current.state, host, feed, cursor: current.cursor, candidates: [] })).toThrow("schedule is complete");
  });

  it("S1 fills one prior-bar market entry at open and leaves the input unmodified", () => {
    const state = createStrategyState(undefined);
    state.orders.push(entry("opening"));
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 100, cursor: { pointIndex: 0, fillOrdinal: 1, fillCount: 1 } });
    expect(first.state.orders[0]).toMatchObject({ status: "filled", fillTime: 1_000, fillPrice: 100 });
    expect(first.state.positionSize).toBe(1);
    expect(first.state.openTrades).toHaveLength(1);
    expect(first.state.timeline).toHaveLength(0);
    expect(state.orders[0]?.status).toBe("pending");
    expect(state.openTrades).toHaveLength(0);
  });

  it("S3 permits a fill-created protective exit only at a later point", () => {
    const state = createStrategyState(undefined);
    state.orders.push(entry("opening"));
    const opened = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    opened.state.orders.push({
      id: "protective", command: "exit", direction: -1, quantity: 1, type: "market",
      stop: 100, targetEntryId: "", createdBarIndex: 1, createdTime: 1_000, status: "pending",
    });
    const afterOpen = transitionSyntheticHistoricalFillPoint({ state: opened.state, host, feed, cursor: opened.cursor, candidates: candidates(opened.state, 0) });
    expect(afterOpen.filledOrderIndex).toBeUndefined();
    expect(afterOpen.cursor.pointIndex).toBe(1);
    const afterHigh = transitionSyntheticHistoricalFillPoint({ state: afterOpen.state, host, feed, cursor: afterOpen.cursor, candidates: candidates(afterOpen.state, 0) });
    expect(afterHigh.filledOrderIndex).toBeUndefined();
    expect(afterHigh.cursor.pointIndex).toBe(2);
    const afterLow = transitionSyntheticHistoricalFillPoint({ state: afterHigh.state, host, feed, cursor: afterHigh.cursor, candidates: candidates(afterHigh.state, 0) });
    expect(afterLow).toMatchObject({ filledOrderIndex: 1, fillPrice: 99, cursor: { pointIndex: 2, fillCount: 2 } });
    expect(afterLow.state.positionSize).toBe(0);
    expect(afterLow.state.closedTrades[0]).toMatchObject({ exitPrice: 99, exitTime: 1_020 });
  });

  it("S4 fills only one same-point OCA candidate and cancels its sibling", () => {
    const state = createStrategyState(undefined);
    state.orders.push(entry("first", "pair"), entry("second", "pair"));
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first.filledOrderIndex).toBe(0);
    expect(first.cancelledOrderIndices).toEqual([1]);
    expect(first.state.orders.map((order) => order.status)).toEqual(["filled", "cancelled"]);
    expect(first.state.positionSize).toBe(1);
    const rest = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor, candidates: candidates(first.state) });
    expect(rest.filledOrderIndex).toBeUndefined();
    expect(rest.cursor).toMatchObject({ pointIndex: 1, fillCount: 1 });
  });

  it("keeps same-point fills ordered by order instance even when Pine IDs repeat", () => {
    const state = createStrategyState(undefined);
    state.orders.push(entry("reused"), entry("reused"));
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, cursor: { pointIndex: 0, fillOrdinal: 1, fillCount: 1 } });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor, candidates: candidates(first.state) });
    expect(second).toMatchObject({ filledOrderIndex: 1, cursor: { pointIndex: 0, fillOrdinal: 2, fillCount: 2 } });
    expect(second.state.positionSize).toBe(2);
    const advanced = transitionSyntheticHistoricalFillPoint({ state: second.state, host, feed, cursor: second.cursor, candidates: candidates(second.state) });
    expect(advanced.cursor).toMatchObject({ pointIndex: 1, fillOrdinal: 0, fillCount: 2 });
  });

  it("does not fill a limit from a later low before that point arrives", () => {
    const state = createStrategyState(undefined);
    state.orders.push({ ...entry("buy-low"), type: "limit", limit: 99 });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen.filledOrderIndex).toBeUndefined();
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor, candidates: candidates(atHigh.state) });
    expect(atLow).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, event: { point: { kind: "low" } } });
    expect(state.orders[0]?.status).toBe("pending");
  });

  it("activates a stop-limit before considering its limit and retains activation across points", () => {
    const state = createStrategyState(undefined);
    state.orders.push({ ...entry("long-stop-limit"), type: "stop-limit", stop: 101, limit: 100 });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen.filledOrderIndex).toBeUndefined();
    expect(atOpen.state.orders[0]?.status).toBe("pending");
    expect(atOpen.state.orders[0]?.stopTriggered).toBeUndefined();
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    expect(atHigh.state.orders[0]).toMatchObject({ status: "pending", stopTriggered: true });
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor, candidates: candidates(atHigh.state) });
    expect(atLow).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, event: { point: { kind: "low" } } });
    expect(state.orders[0]?.stopTriggered).toBeUndefined();
  });

  it("fills a favorable stop-limit at its activation point for either direction", () => {
    const long = createStrategyState(undefined);
    long.orders.push({ ...entry("long"), type: "stop-limit", stop: 101, limit: 103 });
    const longOpen = transitionSyntheticHistoricalFillPoint({ state: long, host, feed, cursor: initialCursor, candidates: candidates(long) });
    const longHigh = transitionSyntheticHistoricalFillPoint({ state: longOpen.state, host, feed, cursor: longOpen.cursor, candidates: candidates(longOpen.state) });
    expect(longHigh).toMatchObject({ filledOrderIndex: 0, fillPrice: 102, event: { point: { kind: "high" } } });
    expect(longHigh.state.orders[0]?.stopTriggered).toBe(true);
    const short = createStrategyState(undefined);
    short.orders.push({ ...entry("short"), direction: -1, type: "stop-limit", stop: 99, limit: 98 });
    const shortOpen = transitionSyntheticHistoricalFillPoint({ state: short, host, feed, cursor: initialCursor, candidates: candidates(short) });
    const shortHigh = transitionSyntheticHistoricalFillPoint({ state: shortOpen.state, host, feed, cursor: shortOpen.cursor, candidates: candidates(shortOpen.state) });
    const shortLow = transitionSyntheticHistoricalFillPoint({ state: shortHigh.state, host, feed, cursor: shortHigh.cursor, candidates: candidates(shortHigh.state) });
    expect(shortLow).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, event: { point: { kind: "low" } } });
    expect(shortLow.state.positionSize).toBe(-1);
  });

  it("keeps stop-limit activation separate from OCA cancellation and pre-fill risk", () => {
    const state = createStrategyState(undefined);
    state.orders.push(
      { ...entry("activated", "pair"), type: "stop-limit", stop: 101, limit: 100 },
      { ...entry("sibling", "pair"), type: "limit", limit: 99 },
    );
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    expect(atHigh.cancelledOrderIndices).toEqual([]);
    expect(atHigh.state.orders.map((order) => order.status)).toEqual(["pending", "pending"]);
    expect(atHigh.state.orders[0]?.stopTriggered).toBe(true);
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor, candidates: candidates(atHigh.state) });
    expect(atLow).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, cancelledOrderIndices: [1] });
    expect(atLow.state.orders.map((order) => order.status)).toEqual(["filled", "cancelled"]);
    const riskBlocked = structuredClone(atHigh.state);
    riskBlocked.riskRules.maxPositionSize = 0;
    const cancelled = transitionSyntheticHistoricalFillPoint({ state: riskBlocked, host, feed, cursor: atHigh.cursor, candidates: candidates(riskBlocked) });
    expect(cancelled.filledOrderIndex).toBeUndefined();
    expect(cancelled.cancelledOrderIndices).toEqual([0, 1]);
    expect(cancelled.state.orders.map((order) => order.status)).toEqual(["cancelled", "cancelled"]);
    expect(riskBlocked.orders.map((order) => order.status)).toEqual(["pending", "pending"]);
  });

  it("rejects malformed stop-limit levels before changing the accepted state", () => {
    const state = createStrategyState(undefined);
    state.orders.push({ ...entry("bad"), type: "stop-limit", stop: Number.NaN, limit: 100 });
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("stop-limit levels are invalid");
    expect(state.orders[0]?.status).toBe("pending");
    expect(state.orders[0]?.stopTriggered).toBeUndefined();
    state.orders[0]!.stop = 101;
    state.orders[0]!.limit = Number.POSITIVE_INFINITY;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("stop-limit levels are invalid");
    state.orders[0]!.limit = 100;
    state.orders[0]!.stopTriggered = "true" as unknown as boolean;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("stop-limit levels are invalid");
    state.orders[0]!.stopTriggered = false;
    state.orders[0]!.command = "exit";
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("stop-limit levels are invalid");
  });

  it("arms a single-trade trailing exit only at an observed point, then fills on a later adverse point", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "long", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "long", trailPrice: 101, trailOffset: 100,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen.filledOrderIndex).toBeUndefined();
    expect(atOpen.state.orders[0]?.trailArmed).toBeUndefined();
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    expect(atHigh.state.orders[0]).toMatchObject({ status: "pending", trailArmed: true, trailPeak: 102 });
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor, candidates: candidates(atHigh.state) });
    expect(atLow).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, event: { point: { kind: "low" } } });
    expect(atLow.state.positionSize).toBe(0);
    expect(atLow.state.closedTrades[0]).toMatchObject({ exitPrice: 99, exitTime: 1_020 });
    expect(state.orders[0]?.trailArmed).toBeUndefined();
    expect(state.openTrades[0]?.status).toBe("open");
  });

  it("arms a short trailing exit at a later low and fills only after an adverse rebound", () => {
    const state = createStrategyState(undefined);
    state.positionSize = -1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "short", direction: -1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: 1, quantity: 0, type: "market",
      targetEntryId: "short", trailPoints: 100, trailOffset: 100,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor, candidates: candidates(atHigh.state) });
    expect(atLow.filledOrderIndex).toBeUndefined();
    expect(atLow.state.orders[0]).toMatchObject({ status: "pending", trailArmed: true, trailPeak: 99 });
    const atClose = transitionSyntheticHistoricalFillPoint({ state: atLow.state, host, feed, cursor: atLow.cursor, candidates: candidates(atLow.state) });
    expect(atClose).toMatchObject({ filledOrderIndex: 0, fillPrice: 101, event: { point: { kind: "close" } } });
    expect(atClose.state.positionSize).toBe(0);
  });

  it("reserves a partial trailing exit before a disjoint protective exit", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "T", command: "exit", direction: -1, quantity: 1, type: "market", targetEntryId: "L",
        trailPrice: 101, trailOffset: 100, createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "S", command: "exit", direction: -1, quantity: 1, type: "market", targetEntryId: "L",
        stop: 99, createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => order.reservedQuantity)).toEqual([1, 1]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders[0]).toMatchObject({ trailArmed: true, trailPeak: 102, reservedQuantity: 1 });
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 99 });
    expect(first.state.positionSize).toBe(1);
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second).toMatchObject({ filledOrderIndex: 1, fillPrice: 99 });
    expect(second.state.positionSize).toBe(0);
    expect(second.state.closedTrades.map((trade) => [trade.exitId, trade.quantity]))
      .toEqual([["T", 1], ["S", 1]]);
    expect(state).toEqual(before);
  });

  it("keeps full-size trailing and concurrent exits unadmitted for one trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "T", command: "exit", direction: -1, quantity: 0, type: "market", targetEntryId: "L",
        trailPrice: 101, trailOffset: 100, createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "S", command: "exit", direction: -1, quantity: 1, type: "market", targetEntryId: "L",
        stop: 99, createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    for (const change of [
      () => {},
      () => { state.orders[0]!.quantity = 2; },
      () => { state.orders[0]!.quantity = 0; state.orders[0]!.quantityPercent = 100; },
    ]) {
      change();
      const before = structuredClone(state);
      expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
        candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
      expect(state).toEqual(before);
    }
  });

  it("freezes a percent trailing reservation before an earlier bracket shrinks the trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "A", command: "exit", direction: -1, quantity: 1, type: "market", targetEntryId: "L",
        limit: 100, createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "T", command: "exit", direction: -1, quantity: 0, quantityPercent: 50, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 100 });
    expect(first.state.orders[1]).toMatchObject({ status: "pending", reservedQuantity: 1, reservationBasisQuantity: 2 });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders[1]).toMatchObject({ trailArmed: true, trailPeak: 102, reservedQuantity: 1 });
    const atLow = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    expect(atLow).toMatchObject({ filledOrderIndex: 1, fillPrice: 99 });
    expect(atLow.state.positionSize).toBe(0);
    expect(atLow.state.closedTrades.map((trade) => [trade.exitId, trade.quantity])).toEqual([["A", 1], ["T", 1]]);
    expect(state.openTrades[0]?.quantity).toBe(2);
  });

  it("rejects an overbooked carried trailing reservation without mutating its caller", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "T", command: "exit", direction: -1, quantity: 0.5, type: "market",
      targetEntryId: "L", targetTradeId: "trade-0", trailPrice: 101, trailOffset: 100,
      reservedQuantity: 1, reservationBasisQuantity: 1,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const before = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("reservations are inconsistent");
    expect(state).toEqual(before);
    state.orders[0]!.reservedQuantity = 0.5;
    delete state.orders[0]!.targetTradeId;
    const untargeted = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state).toEqual(untargeted);
  });

  it("expands one full-size trailing call into independent trade peaks and ordered fills", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100.5;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "L", trailPoints: 100, trailOffset: 100,
      createdBarIndex: 0, createdTime: 940, status: "pending" });
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.targetTradeId, order.trailArmed]))
      .toEqual([["trade-0", undefined], ["trade-1", undefined]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBeUndefined();
    expect(atHigh.state.orders.map((order) => [order.trailArmed, order.trailPeak]))
      .toEqual([[true, 102], [true, 102]]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 99, cursor: { pointIndex: 2, fillOrdinal: 1 } });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second).toMatchObject({ filledOrderIndex: 1, fillPrice: 99, cursor: { pointIndex: 2, fillOrdinal: 2 } });
    expect(second.state.closedTrades.map((trade) => [trade.id, trade.entryPrice, trade.exitId]))
      .toEqual([["trade-0", 100, "trail"], ["trade-1", 101, "trail"]]);
    expect(second.state.positionSize).toBe(0);
    expect(state).toEqual(before);
  });

  it("expands one partial trailing call into frozen per-trade reservations", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100.5;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0.5, type: "market",
      targetEntryId: "L", trailPrice: 101, trailOffset: 100,
      createdBarIndex: 0, createdTime: 940, status: "pending" });
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) =>
      [order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["trade-0", 0.5, 1], ["trade-1", 0.5, 1]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders.map((order) => [order.trailArmed, order.trailPeak]))
      .toEqual([[true, 102], [true, 102]]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second.state.positionSize).toBe(1);
    expect(second.state.openTrades.map((trade) => [trade.id, trade.quantity]))
      .toEqual([["trade-0", 0.5], ["trade-1", 0.5]]);
    expect(second.state.closedTrades.map((trade) => [trade.entryPrice, trade.quantity, trade.exitId]))
      .toEqual([[100, 0.5, "trail"], [101, 0.5, "trail"]]);
    expect(state).toEqual(before);
  });

  it("freezes a partial trailing percentage independently for each matching trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 3;
    state.positionAveragePrice = 100;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, quantityPercent: 50,
      type: "market", targetEntryId: "L", trailPrice: 101, trailOffset: 100,
      createdBarIndex: 0, createdTime: 940, status: "pending" });
    const before = structuredClone(state);
    const result = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(result.state.orders.map((order) =>
      [order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["trade-0", 0.5, 1], ["trade-1", 1, 2]]);
    expect(state).toEqual(before);
  });

  it("expands and fills a two-call by two-trade partial trailing matrix", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100.5;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 0.25, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 0.25, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) =>
      [order.id, order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([
        ["fast", "trade-0", 0.25, 1], ["slow", "trade-0", 0.25, 1],
        ["fast", "trade-1", 0.25, 1], ["slow", "trade-1", 0.25, 1],
      ]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders.map((order) => [order.trailArmed, order.trailPeak]))
      .toEqual([[true, 102], [true, 102], [true, 102], [true, 102]]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    const missingClosedRecord = structuredClone(first.state);
    missingClosedRecord.closedTrades.splice(0);
    const missingBefore = structuredClone(missingClosedRecord);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: missingClosedRecord, host, feed,
      cursor: first.cursor, candidates: candidates(missingClosedRecord) }))
      .toThrow("concurrent trailing exits are not admitted");
    expect(missingClosedRecord).toEqual(missingBefore);
    const changedFilledParameters = structuredClone(first.state);
    changedFilledParameters.orders.find((order) => order.status === "filled")!.trailOffset = 999;
    const changedBefore = structuredClone(changedFilledParameters);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: changedFilledParameters, host, feed,
      cursor: first.cursor, candidates: candidates(changedFilledParameters) }))
      .toThrow("concurrent trailing exits are not admitted");
    expect(changedFilledParameters).toEqual(changedBefore);
    const staleFilledIdentity = structuredClone(first.state);
    staleFilledIdentity.orders.find((order) => order.status === "filled")!.createdTime = 1;
    const staleBefore = structuredClone(staleFilledIdentity);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: staleFilledIdentity, host, feed,
      cursor: first.cursor, candidates: candidates(staleFilledIdentity) }))
      .toThrow("concurrent trailing exits are not admitted");
    expect(staleFilledIdentity).toEqual(staleBefore);
    const mixedReservationOrigin = structuredClone(first.state);
    for (const order of mixedReservationOrigin.orders) {
      if (order.status === "pending" && order.id === "slow") order.reservationOriginTime = 900;
    }
    const mixedOriginBefore = structuredClone(mixedReservationOrigin);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: mixedReservationOrigin, host, feed,
      cursor: first.cursor, candidates: candidates(mixedReservationOrigin) }))
      .toThrow("concurrent trailing exits are not admitted");
    expect(mixedReservationOrigin).toEqual(mixedOriginBefore);
    let current = first;
    for (let index = 1; index < 4; index += 1) {
      current = transitionSyntheticHistoricalFillPoint({ state: current.state, host, feed, cursor: current.cursor,
        candidates: candidates(current.state) });
    }
    expect(current.state.positionSize).toBe(1);
    expect(current.state.openTrades.map((trade) => [trade.id, trade.quantity]))
      .toEqual([["trade-0", 0.5], ["trade-1", 0.5]]);
    expect(current.state.closedTrades.map((trade) => [trade.entryPrice, trade.exitId, trade.quantity]))
      .toEqual([[100, "fast", 0.25], [100, "slow", 0.25], [101, "fast", 0.25], [101, "slow", 0.25]]);
    expect(state).toEqual(before);
  });

  it("rejects incomplete, aggregate-full and three-call multi-trade trailing matrices", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 102, trailOffset: 100,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 102, trailOffset: 200,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
    );
    const aggregateFull = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(aggregateFull);
    state.orders[0]!.quantity = 0.25;
    state.orders[1]!.quantity = 0.25;
    state.orders.push({ ...state.orders[1]!, id: "third", quantity: 0.1 });
    const threeCalls = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(threeCalls);
    state.orders.splice(2);
    state.orders[1]!.targetTradeId = "trade-0";
    const incompleteTargets = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(incompleteTargets);
  });

  it("reserves and fills two distinct partial trailing calls against one trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 1, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([[1, 2], [0.5, 2]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders.map((order) => [order.trailArmed, order.trailPeak]))
      .toEqual([[true, 102], [true, 102]]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second.state.positionSize).toBe(0.5);
    expect(second.state.closedTrades.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 1, 99], ["slow", 0.5, 99]]);
    expect(state).toEqual(before);
  });

  it("reserves and fills three source-ordered ungrouped partial trailing calls", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 4;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 4, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 1, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "medium", command: "exit", direction: -1, quantity: 0.75, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 300,
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["fast", 1, 4], ["medium", 0.75, 4], ["slow", 0.5, 4]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders.map((order) => [order.id, order.trailArmed, order.trailPeak]))
      .toEqual([["fast", true, 102], ["medium", true, 102], ["slow", true, 102]]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    const third = transitionSyntheticHistoricalFillPoint({ state: second.state, host, feed, cursor: second.cursor,
      candidates: candidates(second.state) });
    expect(third.state.positionSize).toBe(1.75);
    expect(third.state.closedTrades.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 1, 99], ["medium", 0.75, 99], ["slow", 0.5, 99]]);
    expect(state).toEqual(before);
  });

  it("reduces two partial trailing reservations in one explicit OCA group", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100, ocaName: "trail-shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 1, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200, ocaName: "trail-shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([[0.5, 2], [1, 2]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    const first = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    expect(first.state.orders.map((order) => [order.status, order.reservedQuantity]))
      .toEqual([["filled", 0.5], ["pending", 0.5]]);
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second.state.positionSize).toBe(1);
    expect(second.state.closedTrades.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 0.5, 99], ["slow", 0.5, 99]]);
    expect(state).toEqual(before);
  });

  it("preserves source-ordered clipping for an over-requested exact-two trailing OCA group", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 1.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100, ocaName: "trail-shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 1.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200, ocaName: "trail-shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([[1.5, 2], [0.5, 2]]);
    expect(state).toEqual(before);
  });

  it("rejects concurrent and duplicate-target trailing groups before changing caller state", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "L", trailPrice: 101, trailOffset: 100,
      createdBarIndex: 0, createdTime: 940, status: "pending" });
    const original = structuredClone(state);
    state.orders.push({ ...state.orders[0]!, id: "other" });
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    state.orders.splice(1);
    state.orders[0]!.targetTradeId = "trade-0";
    state.orders.push({ ...state.orders[0]! });
    const forged = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(forged);
    state.orders[1]!.targetTradeId = "trade-1";
    state.openTrades.push({ id: "trade-2", entryId: "L", direction: 1, quantity: 1, entryPrice: 102,
      entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.positionSize = 3;
    const incomplete = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(incomplete);
    expect(original.orders).toHaveLength(1);
  });

  it("rejects duplicate-call and cross-trade partial trailing combinations", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 4;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 2, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push(
      { id: "trail", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", targetTradeId: "trade-0", trailPrice: 102, trailOffset: 100,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "trail", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", targetTradeId: "trade-0", trailPrice: 102, trailOffset: 200,
        createdBarIndex: 0, createdTime: 940, status: "pending" },
    );
    const duplicateCall = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(duplicateCall);
    state.orders[1]!.id = "other";
    state.orders[1]!.targetTradeId = "trade-1";
    const crossTrade = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(crossTrade);
  });

  it("rejects ungrouped partial trailing calls above the transition fill budget", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 100, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(...Array.from({ length: 33 }, (_, index) => ({
      id: `trail-${index}`, command: "exit" as const, direction: -1 as const, quantity: 1, type: "market" as const,
      targetEntryId: "L", targetTradeId: "trade-0", trailPrice: 102, trailOffset: index + 1,
      createdBarIndex: 0, createdTime: 900, status: "pending" as const,
    })));
    const before = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(before);
  });

  it("admits exactly the 32-call ungrouped partial trailing capacity", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 64;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 64, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(...Array.from({ length: 32 }, (_, index) => ({
      id: `trail-${index}`, command: "exit" as const, direction: -1 as const, quantity: 1, type: "market" as const,
      targetEntryId: "L", targetTradeId: "trade-0", trailPrice: 102, trailOffset: index + 1,
      createdBarIndex: 0, createdTime: 900, status: "pending" as const,
    })));
    const before = structuredClone(state);
    const result = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(result.cursor).toMatchObject({ pointIndex: 1, fillCount: 0 });
    expect(result.state.orders).toHaveLength(32);
    expect(result.state.orders.every((order) => order.reservedQuantity === 1
      && order.reservationBasisQuantity === 64)).toBe(true);
    expect(state).toEqual(before);
  });

  it("rejects aggregate-full and three-call grouped trailing profiles before mutation", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 4;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 4, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(...["fast", "medium", "slow"].map((id, index) => ({
      id, command: "exit" as const, direction: -1 as const, quantity: index === 2 ? 2 : 1,
      type: "market" as const, targetEntryId: "L", targetTradeId: "trade-0",
      trailPrice: 102, trailOffset: 100 + index * 100,
      createdBarIndex: 0, createdTime: 900, status: "pending" as const,
    })));
    const aggregateFull = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(aggregateFull);
    for (const order of state.orders) {
      order.quantity = 0.5;
      order.ocaName = "trail-shared";
      order.ocaType = "reduce";
    }
    const threeCallGroup = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(threeCallGroup);
  });

  it("rejects partial trailing calls with mismatched explicit OCA groups", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "fast", command: "exit", direction: -1, quantity: 0.5, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 100, ocaName: "first", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "slow", command: "exit", direction: -1, quantity: 1, type: "market",
        targetEntryId: "L", trailPrice: 101, trailOffset: 200, ocaName: "second", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(before);
    state.orders[1]!.ocaName = "first";
    state.orders[1]!.targetEntryId = "";
    const mismatchedEntry = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(mismatchedEntry);
    state.orders[1]!.targetEntryId = "L";
    delete state.orders[1]!.ocaType;
    const missingType = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state).toEqual(missingType);
    state.orders.splice(0, 1);
    state.orders[0]!.ocaType = "reduce";
    state.orders[0]!.targetTradeId = "trade-0";
    state.orders[0]!.reservedQuantity = 0.5;
    state.orders[0]!.reservationBasisQuantity = 2;
    const forgedCarriedSibling = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(forgedCarriedSibling);
    state.orders.unshift({ id: "old-nontrail", command: "exit", direction: -1, quantity: 0.5, type: "market",
      targetEntryId: "L", targetTradeId: "trade-0", limit: 101,
      ocaName: "first", ocaType: "reduce", reservedQuantity: 0.5, reservationBasisQuantity: 2,
      createdBarIndex: 0, createdTime: 900, status: "filled", fillBarIndex: 0, fillTime: 940, fillPrice: 101 });
    const forgedFromNonTrailing = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(forgedFromNonTrailing);
    Object.assign(state.orders[0]!, {
      type: "limit", trailPrice: 101, trailOffset: 100, trailArmed: true, trailPeak: 102,
      reservationBasisQuantity: 999,
    });
    const forgedMalformedTrailing = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(forgedMalformedTrailing);
    state.orders[0]!.type = "market";
    state.orders[0]!.reservationBasisQuantity = 2;
    delete state.orders[0]!.limit;
    const forgedWithoutClosedTrade = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("concurrent trailing exits are not admitted");
    expect(state).toEqual(forgedWithoutClosedTrade);
  });

  it("rejects malformed or combined trailing exits before mutating the accepted state", () => {
    const state = createStrategyState(undefined);
    state.openTrades.push({ id: "trade-0", entryId: "long", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "long", trailPrice: 101, trailPoints: 100, trailOffset: 100,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    delete state.orders[0]!.trailPoints;
    state.orders[0]!.trailOffset = Number.POSITIVE_INFINITY;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    state.orders[0]!.trailOffset = 100;
    state.orders[0]!.trailArmed = true;
    state.orders[0]!.trailPeak = Number.NaN;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    delete state.orders[0]!.trailArmed;
    delete state.orders[0]!.trailPeak;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host: { ...host,
      symbolInfo: () => ({ currency: "USD", mintick: Number.NaN }) }, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    state.openTrades.pop();
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state.orders[0]?.status).toBe("pending");
    expect(state.orders[0]?.trailArmed).toBeUndefined();
  });

  it("rejects a forged armed peak below or above its directional activation level", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "same", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "same", trailPrice: 101, trailOffset: 100, trailArmed: true, trailPeak: 100,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const beforeLong = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: { ...initialCursor, pointIndex: 2 },
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state).toEqual(beforeLong);
    state.positionSize = -1;
    state.openTrades[0]!.direction = -1;
    state.orders[0]!.direction = 1;
    state.orders[0]!.trailPrice = 99;
    const beforeShort = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: { ...initialCursor, pointIndex: 3 },
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state).toEqual(beforeShort);
  });

  it("rejects non-finite derived trailing activation and offset before mutation", () => {
    const state = createStrategyState(undefined);
    state.openTrades.push({ id: "trade-0", entryId: "long", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "long", trailPrice: 101, trailOffset: Number.MAX_SAFE_INTEGER,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const extremeHost = { ...host, symbolInfo: () => ({ currency: "USD", mintick: 1e300 }) };
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host: extremeHost, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    state.orders[0]!.trailOffset = 1;
    delete state.orders[0]!.trailPrice;
    state.orders[0]!.trailPoints = Number.MAX_SAFE_INTEGER;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host: extremeHost, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state.orders[0]?.status).toBe("pending");
  });

  it("does not reject an earlier point based on a later point's trailing arithmetic overflow", () => {
    const extremeParent: MarketBar = { ...parent, low: -Number.MAX_VALUE };
    const extremeFeed: SyntheticHistoricalFillFeedV1 = {
      ...feed,
      points: feed.points.map((point) => point.kind === "low" ? { ...point, price: -Number.MAX_VALUE } : point),
    };
    const extremeHost = {
      ...host,
      bars: () => [{ ...parent, openTime: 900, closeTime: 940 }, extremeParent],
      symbolInfo: () => ({ currency: "USD", mintick: 1e292 }),
    };
    const state = createStrategyState(undefined);
    state.positionSize = 1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "long", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "trail", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "long", trailPrice: 101, trailOffset: Number.MAX_SAFE_INTEGER,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host: extremeHost, feed: extremeFeed,
      cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen).toMatchObject({ cursor: { pointIndex: 1 }, state: { orders: [{ status: "pending" }] } });
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host: extremeHost, feed: extremeFeed,
      cursor: atOpen.cursor, candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders[0]).toMatchObject({ trailArmed: true, trailPeak: 102 });
    const beforeLow = structuredClone(atHigh.state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host: extremeHost, feed: extremeFeed,
      cursor: atHigh.cursor, candidates: candidates(atHigh.state) })).toThrow("trailing exit is not admitted");
    expect(atHigh.state).toEqual(beforeLow);
  });

  it("expands a full-quantity multi-entry exit into stable trade-targeted same-point fills", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100.5;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "take", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "L", profitTicks: 100, createdBarIndex: 0, createdTime: 940, status: "pending" });
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen.filledOrderIndex).toBeUndefined();
    expect(atOpen.state.orders).toMatchObject([
      { targetTradeId: "trade-0", status: "pending" },
      { targetTradeId: "trade-1", status: "pending" },
    ]);
    const first = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 102, cursor: { pointIndex: 1, fillOrdinal: 1 } });
    expect(first.state.closedTrades.map((trade) => trade.id)).toEqual(["trade-0"]);
    expect(first.state.openTrades.map((trade) => trade.id)).toEqual(["trade-1"]);
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second).toMatchObject({ filledOrderIndex: 1, fillPrice: 102, cursor: { pointIndex: 1, fillOrdinal: 2 } });
    expect(second.state.closedTrades.map((trade) => trade.id)).toEqual(["trade-0", "trade-1"]);
    expect(second.state.positionSize).toBe(0);
    expect(state).toEqual(before);
  });

  it("uses each matching trade's entry price for its relative exit trigger", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 101;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 102,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "take", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "L", profitTicks: 100, createdBarIndex: 0, createdTime: 940, status: "pending" });
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.filledOrderIndex).toBe(0);
    const samePoint = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    expect(samePoint.filledOrderIndex).toBeUndefined();
    expect(samePoint.state.orders[1]).toMatchObject({ targetTradeId: "trade-1", status: "pending" });
    expect(samePoint.state.openTrades.map((trade) => trade.id)).toEqual(["trade-1"]);
  });

  it("preserves the original current-bar creation cursor for every expanded exit", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "take", command: "exit", direction: -1, quantity: 0, type: "market",
      targetEntryId: "L", limit: 100, createdBarIndex: 1, createdTime: 1_000, status: "pending" });
    const atCreation = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state, 0) });
    expect(atCreation.filledOrderIndex).toBeUndefined();
    expect(atCreation.state.orders).toHaveLength(2);
    expect(atCreation.state.orders.every((order) => order.status === "pending")).toBe(true);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atCreation.state, host, feed, cursor: atCreation.cursor,
      candidates: candidates(atCreation.state, 0) });
    expect(atHigh).toMatchObject({ filledOrderIndex: 0, fillPrice: 102 });
  });

  it("reserves concurrent partial exits without closing the same units twice", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "first", command: "exit", direction: -1, quantity: 1.5, type: "market", limit: 100,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "second", command: "exit", direction: -1, quantity: 2, type: "market", stop: 100,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first).toMatchObject({ filledOrderIndex: 0, fillPrice: 100 });
    expect(first.state.orders).toMatchObject([{ reservedQuantity: 1.5 }, { reservedQuantity: 0.5, status: "pending" }]);
    expect(first.state.positionSize).toBe(0.5);
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second).toMatchObject({ filledOrderIndex: 1, fillPrice: 100 });
    expect(second.state.positionSize).toBe(0);
    expect(second.state.closedTrades.map((trade) => trade.quantity)).toEqual([1.5, 0.5]);
    expect(state).toEqual(before);
  });

  it("expands partial multi-entry exits per trade and cancels fully reserved later exits", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push(
      { id: "half", command: "exit", direction: -1, quantity: 0, quantityPercent: 50, type: "market", stop: 99,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "rest", command: "exit", direction: -1, quantity: 0, type: "market", stop: 99,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "excess", command: "exit", direction: -1, quantity: 0, type: "market", stop: 99,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 940, status: "pending" },
    );
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(atOpen.state.orders).toMatchObject([
      { targetTradeId: "trade-0", reservedQuantity: 0.5, status: "pending" },
      { targetTradeId: "trade-0", reservedQuantity: 0.5, status: "pending" },
      { targetTradeId: "trade-0", status: "cancelled" },
      { targetTradeId: "trade-1", reservedQuantity: 0.5, status: "pending" },
      { targetTradeId: "trade-1", reservedQuantity: 0.5, status: "pending" },
      { targetTradeId: "trade-1", status: "cancelled" },
    ]);
    expect(atOpen.expandedOrderOrigins).toEqual([
      { orderIndex: 3, sourceOrderIndex: 0 },
      { orderIndex: 4, sourceOrderIndex: 1 },
      { orderIndex: 5, sourceOrderIndex: 2 },
    ]);
    expect(state.orders).toHaveLength(3);
  });

  it("fills the frozen percent reservation after another partial exit shrinks the trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "first", command: "exit", direction: -1, quantity: 1, type: "market", limit: 100,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "second", command: "exit", direction: -1, quantity: 0, quantityPercent: 50, type: "market", stop: 100,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first.state.orders[1]).toMatchObject({ reservedQuantity: 1, status: "pending" });
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second.state.positionSize).toBe(0);
    expect(second.state.closedTrades.map((trade) => trade.quantity)).toEqual([1, 1]);
  });

  it("reduces explicit-OCA exit reservations only within the filled trade", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push(
      { id: "take", command: "exit", direction: -1, quantity: 0.5, type: "market", limit: 102,
        targetEntryId: "L", ocaName: "shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "stop", command: "exit", direction: -1, quantity: 0, quantityPercent: 50,
        type: "market", stop: 99,
        targetEntryId: "L", ocaName: "shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
      { id: "far", command: "exit", direction: -1, quantity: 0.25, type: "market", stop: 98,
        targetEntryId: "L", ocaName: "shared", ocaType: "reduce",
        createdBarIndex: 0, createdTime: 900, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => [order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([[0.5, 2], [1, 2], [0.25, 2]]);
    const atHigh = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(atHigh.state.orders.map((order) => [order.status, order.reservedQuantity]))
      .toEqual([["filled", 0.5], ["pending", 0.5], ["cancelled", 0]]);
    const afterHigh = transitionSyntheticHistoricalFillPoint({ state: atHigh.state, host, feed, cursor: atHigh.cursor,
      candidates: candidates(atHigh.state) });
    const atLow = transitionSyntheticHistoricalFillPoint({ state: afterHigh.state, host, feed, cursor: afterHigh.cursor,
      candidates: candidates(afterHigh.state) });
    expect(atLow.state.positionSize).toBe(1);
    expect(atLow.state.closedTrades.map((trade) => [trade.exitId, trade.quantity]))
      .toEqual([["take", 0.5], ["stop", 0.5]]);
    expect(state).toEqual(before);
  });

  it("does not reduce explicit-OCA clones belonging to different trades", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100.5;
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "take", command: "exit", direction: -1, quantity: 0, type: "market", limit: 102,
      targetEntryId: "L", ocaName: "shared", ocaType: "reduce",
      createdBarIndex: 0, createdTime: 940, status: "pending" });
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    const first = transitionSyntheticHistoricalFillPoint({ state: atOpen.state, host, feed, cursor: atOpen.cursor,
      candidates: candidates(atOpen.state) });
    expect(first.state.orders.map((order) => [order.targetTradeId, order.status, order.reservedQuantity]))
      .toEqual([["trade-0", "filled", 1], ["trade-1", "pending", 1]]);
    const second = transitionSyntheticHistoricalFillPoint({ state: first.state, host, feed, cursor: first.cursor,
      candidates: candidates(first.state) });
    expect(second.state.positionSize).toBe(0);
    expect(second.state.closedTrades.map((trade) => [trade.id, trade.exitId, trade.quantity]))
      .toEqual([["trade-0", "take", 1], ["trade-1", "take", 1]]);
    expect(state).toEqual(before);
  });

  it("rejects malformed explicit OCA and mixed-level partial trailing multi-entry exits before mutation", () => {
    const state = createStrategyState(undefined);
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "take", command: "exit", direction: -1, quantity: 1, type: "market",
      targetEntryId: "L", stop: 99, createdBarIndex: 0, createdTime: 940, status: "pending" });
    for (const [change, reason] of [
      [() => { state.orders[0]!.ocaName = "shared"; delete state.orders[0]!.ocaType; }, "multi-trade exit is not admitted"],
      [() => { state.orders[0]!.ocaType = "cancel"; }, "multi-trade exit is not admitted"],
      [() => {
        state.orders[0]!.ocaType = "reduce";
        state.orders.push({ id: "entry", command: "order", direction: 1, quantity: 1, type: "market",
          ocaName: "shared", ocaType: "reduce", createdBarIndex: 0, createdTime: 940, status: "pending" });
      }, "exit OCA group is not admitted"],
      [() => { state.orders.pop(); delete state.orders[0]!.ocaName; delete state.orders[0]!.ocaType; state.orders[0]!.trailPrice = 101; state.orders[0]!.trailOffset = 100; }, "trailing exit is not admitted"],
    ] as const) {
      change();
      const before = structuredClone(state);
      expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
        candidates: candidates(state) })).toThrow(reason);
      expect(state).toEqual(before);
    }
  });

  it("reserves the first full multi-entry exit and cancels a concurrent excess exit", () => {
    const state = createStrategyState(undefined);
    state.openTrades.push(
      { id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
        entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "L", direction: 1, quantity: 1, entryPrice: 101,
        entryBarIndex: 0, entryTime: 940, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push(
      { id: "take", command: "exit", direction: -1, quantity: 0, type: "market", limit: 102,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 940, status: "pending" },
      { id: "stop", command: "exit", direction: -1, quantity: 0, type: "market", stop: 99,
        targetEntryId: "L", createdBarIndex: 0, createdTime: 940, status: "pending" },
    );
    const before = structuredClone(state);
    const atOpen = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) });
    expect(atOpen.state.orders.map((order) => order.status)).toEqual([
      "pending", "cancelled", "pending", "cancelled",
    ]);
    expect(atOpen.state.orders[0]).toMatchObject({ targetTradeId: "trade-0", reservedQuantity: 1 });
    expect(atOpen.state.orders[2]).toMatchObject({ targetTradeId: "trade-1", reservedQuantity: 1 });
    expect(state).toEqual(before);
  });

  it("rejects malformed or overbooked carried reservations without changing accepted state", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 1;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 1, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "A", command: "exit", direction: -1, quantity: 0, type: "market", limit: 102,
      targetEntryId: "L", targetTradeId: "trade-0", reservedQuantity: 2, reservationBasisQuantity: 1,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    const before = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("reservations are inconsistent");
    state.orders[0]!.quantity = 1;
    const wrongRequest = structuredClone(state);
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("multi-trade exit is not admitted");
    expect(state).toEqual(wrongRequest);
    state.orders[0]!.quantity = 0;
    expect(state).toEqual(before);
    state.orders[0]!.reservedQuantity = Number.NaN;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("multi-trade exit is not admitted");
    state.orders[0]!.reservedQuantity = 0.5;
    state.orders.push({ id: "B", command: "exit", direction: -1, quantity: 0, type: "market", stop: 99,
      targetEntryId: "L", targetTradeId: "trade-0", reservedQuantity: 0.75, reservationBasisQuantity: 1,
      createdBarIndex: 0, createdTime: 900, status: "pending" });
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("reservations are inconsistent");
    state.orders.pop();
    state.orders[0]!.quantityPercent = 50;
    state.orders[0]!.reservedQuantity = 0.75;
    state.orders[0]!.reservationBasisQuantity = 3;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor,
      candidates: candidates(state) })).toThrow("reservations are inconsistent");
  });

  it("uses explicit qty while ignoring a conflicting qty_percent value", () => {
    const state = createStrategyState(undefined);
    state.positionSize = 2;
    state.positionAveragePrice = 100;
    state.openTrades.push({ id: "trade-0", entryId: "L", direction: 1, quantity: 2, entryPrice: 100,
      entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" });
    state.orders.push({ id: "A", command: "exit", direction: -1, quantity: 1, quantityPercent: 101,
      type: "market", limit: 100, targetEntryId: "L", createdBarIndex: 0, createdTime: 900, status: "pending" });
    const first = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(first.state.orders[0]).toMatchObject({ reservedQuantity: 1, status: "filled" });
    expect(first.state.positionSize).toBe(1);
  });

  it("pre-fill position risk cancels an entry without counting a fill", () => {
    const state = createStrategyState(undefined);
    state.riskRules.maxPositionSize = 0;
    state.orders.push(entry("blocked"));
    const result = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) });
    expect(result.cancelledOrderIndices).toEqual([0]);
    expect(result.cursor).toMatchObject({ pointIndex: 1, fillCount: 0 });
    expect(result.state.orders[0]?.status).toBe("cancelled");
    expect(state.orders[0]?.status).toBe("pending");
  });

  it("fails closed for mixed absolute-relative multi-trade and mixed trailing exits", () => {
    const state = createStrategyState(undefined);
    state.openTrades.push(
      { id: "trade-0", entryId: "long", direction: 1, quantity: 1, entryPrice: 100, entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
      { id: "trade-1", entryId: "long", direction: 1, quantity: 1, entryPrice: 200, entryBarIndex: 0, entryTime: 900, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" },
    );
    state.orders.push({ id: "generic", command: "exit", direction: -1, quantity: 0, type: "market", profitTicks: 10,
      limit: 150, targetEntryId: "long", createdBarIndex: 0, createdTime: 900, status: "pending" });
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) })).toThrow("multi-trade exit is not admitted");
    state.openTrades.pop();
    delete state.orders[0]!.limit;
    state.orders[0]!.trailOffset = 1;
    state.orders[0]!.trailPrice = 101;
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: candidates(state) })).toThrow("trailing exit is not admitted");
    expect(state.orders[0]?.status).toBe("pending");
  });

  it("rejects mismatched source, inventory and unsupported fill modes before mutation", () => {
    const state = createStrategyState(undefined);
    state.orders.push(entry("opening"));
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: { ...initialCursor, revision: "wrong" }, candidates: candidates(state) })).toThrow("cursor");
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: [] })).toThrow("inventory");
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: initialCursor, candidates: [{ ...candidates(state)[0]!, created: { barIndex: 0, ordinal: 4 } }] })).toThrow("instance");
    expect(() => transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor: { ...initialCursor, fillCount: 32 }, candidates: candidates(state) })).toThrow("32-fill budget");
    const unsafe = createStrategyState({ ...state.config, use_bar_magnifier: true });
    expect(() => transitionSyntheticHistoricalFillPoint({ state: unsafe, host, feed, cursor: initialCursor, candidates: [] })).toThrow("not admitted");
    expect(state.orders[0]?.status).toBe("pending");
  });
});
