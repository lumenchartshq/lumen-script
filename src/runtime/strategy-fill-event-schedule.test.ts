import { describe, expect, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import {
  admitSyntheticHistoricalFillFeed,
  eligibleHistoricalOrders,
  type HistoricalOrderCandidateV1,
  type SyntheticHistoricalFillFeedV1,
} from "./strategy-fill-event-schedule.js";

const parent: MarketBar = {
  openTime: 0, closeTime: 40, open: 100, high: 102, low: 99, close: 101, volume: 40,
};
const feed: SyntheticHistoricalFillFeedV1 = {
  version: 1,
  source: "synthetic",
  sourceId: "sya546-s0",
  revision: "fixture-1",
  parentOpenTime: 0,
  points: [
    { sequence: 0, timestamp: 0, kind: "open", price: 100, cumulativeVolume: 0 },
    { sequence: 1, timestamp: 10, kind: "high", price: 102, cumulativeVolume: 10 },
    { sequence: 2, timestamp: 20, kind: "low", price: 99, cumulativeVolume: 20 },
    { sequence: 3, timestamp: 40, kind: "close", price: 101, cumulativeVolume: 40 },
  ],
};

function candidate(id: string, barIndex: number, pointIndex: number | undefined, ordinal: number, orderIndex = ordinal): HistoricalOrderCandidateV1 {
  return { orderIndex, id, status: "pending", created: { barIndex, ...(pointIndex === undefined ? {} : { pointIndex }), ordinal } };
}

describe("Z10 synthetic historical fill point admission", () => {
  it("S0 provides only as-of OHLC/volume and one confirmed close point", () => {
    const events = admitSyntheticHistoricalFillFeed(parent, feed);
    expect(events.map((event) => event.asOfBar)).toEqual([
      { openTime: 0, closeTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { openTime: 0, closeTime: 10, open: 100, high: 102, low: 100, close: 102, volume: 10 },
      { openTime: 0, closeTime: 20, open: 100, high: 102, low: 99, close: 99, volume: 20 },
      parent,
    ]);
    expect(events.map((event) => event.confirmed)).toEqual([false, false, false, true]);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events[0]?.asOfBar)).toBe(true);
    expect(feed.points[0]?.price).toBe(100);
  });

  it("S1–S3 admit prior-bar orders at open but same-bar orders only after creation", () => {
    const orders = [candidate("protective", 1, 0, 2), candidate("opening", 0, undefined, 1)];
    expect(eligibleHistoricalOrders(orders, 1, 0).map((order) => order.id)).toEqual(["opening"]);
    expect(eligibleHistoricalOrders(orders, 1, 1).map((order) => order.id)).toEqual(["opening", "protective"]);
    expect(eligibleHistoricalOrders(orders, 1, 3).map((order) => order.id)).toEqual(["opening", "protective"]);
    expect(orders[0]?.status).toBe("pending");
  });

  it("S4 orders same-point candidates by explicit creation ordinal, not input array position", () => {
    const orders = [candidate("late", 0, undefined, 9), candidate("early", 0, undefined, 3)];
    expect(eligibleHistoricalOrders(orders, 1, 2).map((order) => order.id)).toEqual(["early", "late"]);
    expect(eligibleHistoricalOrders([{ ...orders[0]!, status: "cancelled" }, orders[1]!], 1, 2).map((order) => order.id)).toEqual(["early"]);
  });

  it("rejects source, point, parent and cursor ambiguity before making an event", () => {
    const badFeeds: SyntheticHistoricalFillFeedV1[] = [
      { ...feed, sourceId: "" },
      { ...feed, revision: "../unknown" },
      { ...feed, parentOpenTime: 1 },
      { ...feed, points: feed.points.slice(0, 3) },
      { ...feed, points: feed.points.map((point, index) => index === 2 ? { ...point, sequence: 1 } : point) },
      { ...feed, points: feed.points.map((point, index) => index === 2 ? { ...point, timestamp: 5 } : point) },
      { ...feed, points: feed.points.map((point, index) => index === 1 ? { ...point, price: Number.NaN } : point) },
      { ...feed, points: feed.points.map((point, index) => index === 1 ? { ...point, kind: "low" } : index === 2 ? { ...point, kind: "high" } : point) },
      { ...feed, points: feed.points.map((point, index) => index === 1 ? { ...point, cumulativeVolume: 41 } : point) },
      { ...feed, points: feed.points.map((point, index) => index === 3 ? { ...point, price: 104 } : point) },
    ];
    for (const invalid of badFeeds) expect(() => admitSyntheticHistoricalFillFeed(parent, invalid)).toThrow();
    expect(() => eligibleHistoricalOrders([candidate("same-bar-without-point", 1, undefined, 1)], 1, 0)).toThrow();
    expect(() => eligibleHistoricalOrders([candidate("future", 2, 0, 1)], 1, 0)).toThrow();
    expect(() => eligibleHistoricalOrders([candidate("a", 0, undefined, 1), candidate("b", 0, undefined, 1)], 1, 0)).toThrow();
    expect(() => eligibleHistoricalOrders([candidate("a", 0, undefined, 1), candidate("b", 0, undefined, 2, 1)], 1, 0)).toThrow();
    expect(eligibleHistoricalOrders([candidate("same-id", 0, undefined, 1), candidate("same-id", 0, undefined, 2)], 1, 0)).toHaveLength(2);
  });
});
