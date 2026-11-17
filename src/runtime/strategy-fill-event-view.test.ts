import { compile } from "../compiler/index.js";
import type { MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.js";
import type { SyntheticHistoricalFillFeedV1 } from "./strategy-fill-event-schedule.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const program = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: '//@version=6\nstrategy("Event view")\nplot(close)',
}).program!;
const bars: MarketBar[] = [
  { openTime: 900, closeTime: 940, open: 90, high: 95, low: 89, close: 94, volume: 20 },
  { openTime: 1_000, closeTime: 1_040, open: 100, high: 102, low: 99, close: 101, volume: 40 },
];
const feed: SyntheticHistoricalFillFeedV1 = {
  version: 1,
  source: "synthetic",
  sourceId: "sya546-event-view",
  revision: "fixture-1",
  parentOpenTime: 1_000,
  points: [
    { sequence: 0, timestamp: 1_000, kind: "open", price: 100, cumulativeVolume: 0 },
    { sequence: 1, timestamp: 1_010, kind: "high", price: 102, cumulativeVolume: 10 },
    { sequence: 2, timestamp: 1_020, kind: "low", price: 99, cumulativeVolume: 20 },
    { sequence: 3, timestamp: 1_040, kind: "close", price: 101, cumulativeVolume: 40 },
  ],
};

function runtime() {
  const context = createRuntime(program, { symbolInfo: { currency: "USD" } });
  context.reset(bars);
  context.beginBar(1);
  return context;
}

describe("Z10 internal synthetic historical data view", () => {
  it("reads only the current point prefix and keeps prior bars unchanged", () => {
    const context = runtime();
    const expected = [
      [100, 100, 100, 100, 0, 1_000],
      [100, 102, 100, 102, 10, 1_010],
      [100, 102, 99, 99, 20, 1_020],
      [100, 102, 99, 101, 40, 1_040],
    ];
    for (const [pointIndex, row] of expected.entries()) {
      const event = context.setSyntheticHistoricalFillDataView(feed, pointIndex);
      expect(event.confirmed).toBe(pointIndex === 3);
      expect(["open", "high", "low", "close", "volume", "time_close"].map((name) => context.data(name))).toEqual(row);
      expect(context.data("hlc3")).toBe((row[1]! + row[2]! + row[3]!) / 3);
      expect(context.data("high", 1)).toBe(95);
    }
    context.clearSyntheticHistoricalFillDataView();
    expect(context.data("high")).toBe(102);
  });

  it("clears the view on restore, begin and end rather than leaking an old point", () => {
    const context = runtime();
    const state = context.snapshot();
    context.setSyntheticHistoricalFillDataView(feed, 0);
    expect(context.data("high")).toBe(100);
    context.restore(state, bars);
    expect(context.data("high")).toBe(102);
    context.setSyntheticHistoricalFillDataView(feed, 0);
    context.beginBar(1);
    expect(context.data("high")).toBe(102);
    context.setSyntheticHistoricalFillDataView(feed, 0);
    context.endBar();
    expect(context.data("high")).toBe(102);
    context.setSyntheticHistoricalFillDataView(feed, 0);
    context.restoreTail({ kind: "rollback", restore: () => undefined }, bars);
    expect(context.data("high")).toBe(102);
    context.setSyntheticHistoricalFillDataView(feed, 0);
    context.reset(bars);
    context.beginBar(1);
    expect(context.data("high")).toBe(102);
  });

  it("rejects invalid points and feeds without replacing the last admitted point", () => {
    const context = runtime();
    context.setSyntheticHistoricalFillDataView(feed, 1);
    expect(() => context.setSyntheticHistoricalFillDataView(feed, 4)).toThrow("point is invalid");
    expect(() => context.setSyntheticHistoricalFillDataView({ ...feed, sourceId: "" }, 2)).toThrow("identity is invalid");
    expect(context.data("close")).toBe(102);
  });

  it("rejects request programs and host source-series inputs until an as-of contract exists", () => {
    const withSource = createRuntime(program, { symbolInfo: { currency: "USD" }, sourceSeries: { custom: [1, 2] } });
    withSource.reset(bars);
    withSource.beginBar(1);
    expect(() => withSource.setSyntheticHistoricalFillDataView(feed, 0)).toThrow("does not admit");

    const hiddenSource: Record<string, readonly number[]> = {};
    Object.defineProperty(hiddenSource, "close", { value: [1, 999], enumerable: false });
    const withHidden = createRuntime(program, { symbolInfo: { currency: "USD" }, sourceSeries: hiddenSource });
    withHidden.reset(bars);
    withHidden.beginBar(1);
    expect(() => withHidden.setSyntheticHistoricalFillDataView(feed, 0)).toThrow("does not admit");

    const inheritedSource = Object.create({ close: [1, 999] }) as Record<string, readonly number[]>;
    const withInherited = createRuntime(program, { symbolInfo: { currency: "USD" }, sourceSeries: inheritedSource });
    withInherited.reset(bars);
    withInherited.beginBar(1);
    expect(() => withInherited.setSyntheticHistoricalFillDataView(feed, 0)).toThrow("does not admit");

    const lateSource: Record<string, readonly number[]> = {};
    const withLateSource = createRuntime(program, { symbolInfo: { currency: "USD" }, sourceSeries: lateSource });
    withLateSource.reset(bars);
    withLateSource.beginBar(1);
    withLateSource.setSyntheticHistoricalFillDataView(feed, 0);
    lateSource.close = [1, 999];
    expect(() => withLateSource.data("close")).toThrow("source series changed");
    expect(() => withLateSource.data("close", 1)).toThrow("source series changed");

    const deceptiveSource = new Proxy({} as Record<string, readonly number[]>, {
      get: (_target, key) => key === "close" ? [1, 999] : undefined,
      getPrototypeOf: () => Object.prototype as object,
      ownKeys: () => [],
    });
    const withDeceptive = createRuntime(program, { symbolInfo: { currency: "USD" }, sourceSeries: deceptiveSource });
    withDeceptive.reset(bars);
    withDeceptive.beginBar(1);
    withDeceptive.setSyntheticHistoricalFillDataView(feed, 0);
    expect(withDeceptive.data("close")).toBe(100);
    expect(withDeceptive.data("close", 1)).toBe(94);

    const requested = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: '//@version=6\nstrategy("Request view")\nplot(request.security(syminfo.tickerid, "D", close))',
    }).program!;
    expect(requested.requestPlans.length).toBeGreaterThan(0);
    const withRequest = createRuntime(requested, { symbolInfo: { currency: "USD" } });
    withRequest.reset(bars);
    withRequest.beginBar(1);
    expect(() => withRequest.setSyntheticHistoricalFillDataView(feed, 0)).toThrow("does not admit");
  });
});
