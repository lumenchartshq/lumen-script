import { compile as compilePine, type CompiledProgram } from "../compiler/index.js";
import type { MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import {
  appendSyntheticHistoricalFillFixture,
  correctSyntheticHistoricalFillFixtureTail,
  runSyntheticHistoricalFillFixture,
  type SyntheticHistoricalFillFixtureCheckpointV1,
  type SyntheticHistoricalFillFixtureResult,
} from "./synthetic-historical-fill-fixture.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot, type SyntheticHistoricalFillFeedV1 } from "../runtime/index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1_000, closeTime: 1_040, open: 100, high: 102, low: 99, close: 101, volume: 40 },
  { openTime: 2_000, closeTime: 2_040, open: 103, high: 105, low: 98, close: 102, volume: 50 },
];

function compile(request: { readonly compatibility: typeof PINE_COMPATIBILITY.strict; readonly source: string }) {
  return compilePine({ ...request, historicalFillSchedule: "lumencharts-v1" });
}

function feed(bar: MarketBar, index: number): SyntheticHistoricalFillFeedV1 {
  const highFirst = index === 0;
  const middle = highFirst ? ["high", "low"] as const : ["low", "high"] as const;
  return {
    version: 1, source: "synthetic", sourceId: "sya546-schedule", revision: "fixture-1",
    parentOpenTime: bar.openTime,
    points: [
      { sequence: 0, timestamp: bar.openTime, kind: "open", price: bar.open, cumulativeVolume: 0 },
      { sequence: 1, timestamp: bar.openTime + 10, kind: middle[0], price: bar[middle[0]], cumulativeVolume: 10 },
      { sequence: 2, timestamp: bar.openTime + 20, kind: middle[1], price: bar[middle[1]], cumulativeVolume: 20 },
      { sequence: 3, timestamp: bar.closeTime!, kind: "close", price: bar.close, cumulativeVolume: bar.volume },
    ],
  };
}

function program(body: string): CompiledProgram {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict,
    source: `//@version=6\nstrategy("Z10 internal", calc_on_order_fills=true)\n${body}` });
  expect(compiled.diagnostics).toEqual([]);
  return compiled.program!;
}

function run(compiled: CompiledProgram, count = bars.length) {
  return runSyntheticHistoricalFillFixture(compiled, bars.slice(0, count), bars.slice(0, count).map(feed),
    { symbolInfo: { currency: "USD", mintick: 0.01 }, alertMode: "all" });
}

const fixtureOptions = { symbolInfo: { currency: "USD", mintick: 0.01 }, alertMode: "all" as const };

function portable(checkpoint: SyntheticHistoricalFillFixtureCheckpointV1): SyntheticHistoricalFillFixtureCheckpointV1 {
  return JSON.parse(JSON.stringify(checkpoint)) as SyntheticHistoricalFillFixtureCheckpointV1;
}

function reseal(checkpoint: SyntheticHistoricalFillFixtureCheckpointV1): SyntheticHistoricalFillFixtureCheckpointV1 {
  const source = JSON.stringify([checkpoint.bars, checkpoint.feeds, checkpoint.runtimeState, checkpoint.logState]);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return { ...checkpoint, payloadFingerprint: hash.toString(16).padStart(16, "0") };
}

function comparable(actual: SyntheticHistoricalFillFixtureResult) {
  return {
    returned: actual.result.returned,
    plots: actual.result.plots,
    drawings: actual.result.drawings,
    tables: actual.result.tables,
    alerts: actual.result.alerts,
    strategy: actual.result.strategy,
    logs: actual.logs.events.map((event) => ({ ...event, logEpoch: "" })),
  };
}

function comparableJournal(actual: SyntheticHistoricalFillFixtureResult) {
  return {
    firstRetainedSequence: actual.logs.firstRetainedSequence,
    nextSequence: actual.logs.nextSequence,
    droppedCount: actual.logs.droppedCount,
    historyUnavailable: actual.logs.historyUnavailable,
    events: actual.logs.events.map((event) => ({ ...event, logEpoch: "" })),
  };
}

describe("Z10 internal synthetic historical fill event owner", () => {
  it("S0 executes once at each close and finalizes one timeline row per bar", () => {
    const actual = run(program('log.info("close {0}", close)\nplot(close)'), 2);
    expect(actual.trace.map(({ kind, barIndex, pointIndex }) => [kind, barIndex, pointIndex]))
      .toEqual([["close", 0, 3], ["close", 1, 3]]);
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([101, 102]);
    expect(actual.result.strategy?.timeline).toHaveLength(2);
    expect(actual.logs.events.map((event) => event.message)).toEqual(["close 101", "close 102"]);
  });

  it("S1 fills a prior-bar market order at open, reruns immediately, then commits one close visual", () => {
    const actual = run(program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
log.info("position {0}", strategy.position_size)
plot(strategy.position_size)`));
    expect(actual.trace.map(({ kind, barIndex, pointIndex, positionSize }) => [kind, barIndex, pointIndex, positionSize]))
      .toEqual([["close", 0, 3, 0], ["fill", 1, 0, 1], ["rerun", 1, 0, 1], ["close", 1, 3, 1]]);
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 1]);
    expect(actual.result.strategy?.timeline).toHaveLength(2);
    expect(actual.result.strategy?.orders[0]).toMatchObject({ status: "filled", createdTime: 1_040, fillTime: 2_000 });
    expect(actual.logs.events.map((event) => event.message)).toEqual(["position 0", "position 1", "position 1"]);
  });

  it("S2 processes two prior-bar orders at separate points without future-point lookahead", () => {
    const actual = run(program(`if bar_index == 0
    strategy.order("Low", strategy.long, qty=1, limit=100)
    strategy.order("High", strategy.long, qty=1, stop=104)
plot(strategy.position_size)`));
    expect(actual.trace.filter((entry) => entry.kind === "fill").map((entry) => [entry.pointIndex, entry.orderIndex, entry.positionSize]))
      .toEqual([[1, 0, 1], [2, 1, 2]]);
    expect(actual.trace.filter((entry) => entry.kind === "rerun")).toHaveLength(2);
    expect(actual.result.strategy?.orders.map((order) => order.fillTime)).toEqual([2_010, 2_020]);
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 2]);
    expect(actual.result.strategy?.timeline).toHaveLength(2);
  });

  it("S3 makes a fill-created protective exit eligible only at the following point", () => {
    const actual = run(program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if strategy.position_size > 0
    strategy.exit("P", "L", stop=100)
log.info("position {0}", strategy.position_size)
plot(strategy.position_size)`));
    expect(actual.trace.map(({ kind, barIndex, pointIndex, orderIndex, positionSize }) =>
      [kind, barIndex, pointIndex, orderIndex, positionSize]))
      .toEqual([
        ["close", 0, 3, undefined, 0],
        ["fill", 1, 0, 0, 1],
        ["rerun", 1, 0, undefined, 1],
        ["fill", 1, 1, 1, 0],
        ["rerun", 1, 1, undefined, 0],
        ["close", 1, 3, undefined, 0],
      ]);
    expect(actual.result.strategy?.orders[1]).toMatchObject({ status: "filled", createdTime: 2_000, fillTime: 2_010 });
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 0]);
    expect(actual.logs.events.map((event) => event.message)).toEqual([
      "position 0", "position 1", "position 0", "position 0",
    ]);
  });

  it("S4 accepts one same-point OCA winner and cancels its sibling", () => {
    const actual = run(program(`if bar_index == 0
    strategy.order("A", strategy.long, qty=1, limit=100, oca_name="pair", oca_type=strategy.oca.cancel)
    strategy.order("B", strategy.long, qty=1, limit=99, oca_name="pair", oca_type=strategy.oca.cancel)
plot(strategy.position_size)`));
    expect(actual.trace.filter((entry) => entry.kind === "fill").map((entry) => [entry.pointIndex, entry.orderIndex]))
      .toEqual([[1, 0]]);
    expect(actual.result.strategy?.orders.map((order) => order.status)).toEqual(["filled", "cancelled"]);
  });

  it("keeps a stop-limit activated across a completed checkpoint and fills only on a later point", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1, stop=104, limit=100)
plot(strategy.position_size)`);
    const third = { openTime: 3_000, closeTime: 3_040, open: 99, high: 101, low: 98, close: 100, volume: 60 };
    const allBars = [...bars, third];
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    const beforeFill = run(compiled);
    expect(beforeFill.result.strategy?.orders[0]).toMatchObject({ status: "pending", stopTriggered: true });
    expect(beforeFill.trace.filter((entry) => entry.kind === "fill")).toHaveLength(0);
    const restored = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(restored.runtimeState).strategy?.orders[0]?.stopTriggered).toBe(true);
    const appended = appendSyntheticHistoricalFillFixture(compiled, restored, [third], [feed(third, 2)], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill"))
      .toEqual([{ barIndex: 2, pointIndex: 0, kind: "fill", orderIndex: 0, positionSize: 1 }]);
    expect(appended.result.strategy?.orders[0]).toMatchObject({ status: "filled", fillTime: 3_000, fillPrice: 99 });
    expect(appended.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 0, 1]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries an armed single-trade trailing exit across a completed checkpoint", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if strategy.position_size > 0
    strategy.exit("T", "L", trail_price=104, trail_offset=400)
plot(strategy.position_size)`);
    const third = { openTime: 3_000, closeTime: 3_040, open: 103, high: 107, low: 102, close: 102, volume: 60 };
    const allBars = [...bars, third];
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    const armed = run(compiled);
    expect(armed.result.strategy?.openTrades).toBe(1);
    expect(armed.result.strategy?.orders.find((order) => order.status === "pending" && order.command === "exit"))
      .toMatchObject({ trailArmed: true, trailPeak: 105 });
    const restored = portable(armed.checkpoint);
    expect(deserializeRuntimeSnapshot(restored.runtimeState).strategy?.orders.find((order) => order.status === "pending" && order.command === "exit"))
      .toMatchObject({ trailArmed: true, trailPeak: 105 });
    const appended = appendSyntheticHistoricalFillFixture(compiled, restored, [third], [feed(third, 2)], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...armed.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 2))
      .toEqual([{ barIndex: 2, pointIndex: 3, kind: "fill", orderIndex: 2, positionSize: 0 }]);
    expect(appended.result.strategy?.orders.find((order) => order.command === "exit" && order.status === "filled"))
      .toMatchObject({ fillTime: 3_040, fillPrice: 102 });
    expect(appended.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 1, 0]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(armed.checkpoint));
  });

  it("carries separate full-size trailing exits for two entries through a completed checkpoint", () => {
    const source = `//@version=6
strategy("Z10 multi-entry trail", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index >= 2 and strategy.opentrades == 2
    strategy.exit("T", "L", trail_points=200, trail_offset=400)
plot(strategy.position_size)`;
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const fourth = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const fifth = { openTime: 5_000, closeTime: 5_040, open: 104, high: 106, low: 101, close: 102, volume: 80 };
    const allBars = [...bars, third, fourth, fifth];
    const fifthFeed: SyntheticHistoricalFillFeedV1 = { ...feed(fifth, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 104, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 101, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 102, cumulativeVolume: 80 },
    ] };
    const allFeeds = [...allBars.slice(0, 4).map(feed), fifthFeed];
    const armed = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 4), allBars.slice(0, 4).map(feed), fixtureOptions);
    const restored = portable(armed.checkpoint);
    const pending = deserializeRuntimeSnapshot(restored.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(pending).toHaveLength(2);
    expect(pending?.map((order) => [order.targetTradeId, order.trailArmed, order.trailPeak]))
      .toEqual([["trade-0", undefined, undefined], ["trade-1", true, 104]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, restored, [fifth], [fifthFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allFeeds, fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...armed.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4))
      .toEqual([
        { barIndex: 4, pointIndex: 2, kind: "fill", orderIndex: 4, positionSize: 1 },
        { barIndex: 4, pointIndex: 2, kind: "fill", orderIndex: 5, positionSize: 0 },
      ]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.entryPrice, trade.exitId, trade.exitPrice]))
      .toEqual([[103, "T", 101], [98, "T", 101]]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(armed.checkpoint));
  });

  it("carries one partial trailing reservation per matching entry through checkpoint append", () => {
    const source = `//@version=6
strategy("Z10 partial multi-entry trail", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index >= 2 and strategy.opentrades == 2
    strategy.exit("T", "L", qty=0.5, trail_price=105, trail_offset=100)
plot(strategy.position_size)`;
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 103, low: 103, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 103, low: 103, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const followup = { openTime: 6_000, closeTime: 6_040, open: 104, high: 104, low: 104, close: 104, volume: 90 };
    const allBars = [...bars, creation, quiet, trigger, followup];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 4),
      allBars.slice(0, 4).map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const pending = deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(pending?.map((order) => [order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["trade-0", 0.5, 1], ["trade-1", 0.5, 1]]);
    const afterFirstFill = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger],
      [feed(trigger, 4)], fixtureOptions);
    const afterFirstCheckpoint = portable(afterFirstFill.checkpoint);
    expect(deserializeRuntimeSnapshot(afterFirstCheckpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity,
        order.trailArmed, order.trailPeak]))
      .toEqual([["trade-1", 0.5, 1, true, 106]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, afterFirstCheckpoint, [followup],
      [feed(followup, 5)], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...afterFirstFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect([...afterFirstFill.trace, ...appended.trace].filter((entry) => entry.kind === "fill" && entry.barIndex >= 4)
      .map((entry) => [entry.barIndex, entry.pointIndex, entry.positionSize]))
      .toEqual([[4, 3, 1.5], [5, 0, 1]]);
    expect(appended.result.strategy?.closedTradeRecords
      .map((trade) => [trade.entryPrice, trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([[103, "T", 0.5, 104], [98, "T", 0.5, 104]]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
    expect(JSON.stringify(afterFirstCheckpoint)).toBe(JSON.stringify(afterFirstFill.checkpoint));
  });

  it("carries a two-call by two-trade partial trailing matrix through checkpoint append", () => {
    const source = `//@version=6
strategy("Z10 partial trailing matrix", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index >= 2 and bar_index <= 4 and strategy.opentrades == 2
    strategy.exit("fast", "L", qty=0.25, trail_price=105, trail_offset=100)
    strategy.exit("slow", "L", qty=0.25, trail_price=105, trail_offset=200)
plot(strategy.position_size)`;
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 103, low: 103, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 103, low: 103, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const followup = { openTime: 6_000, closeTime: 6_040, open: 103, high: 105, low: 100, close: 102, volume: 90 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const followupFeed: SyntheticHistoricalFillFeedV1 = { ...feed(followup, 5), points: [
      { sequence: 0, timestamp: 6_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 6_010, kind: "high", price: 105, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 6_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 6_040, kind: "close", price: 102, cumulativeVolume: 90 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.targetTradeId, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([
        ["fast", "trade-0", 0.25, 1], ["slow", "trade-0", 0.25, 1],
        ["fast", "trade-1", 0.25, 1], ["slow", "trade-1", 0.25, 1],
      ]);
    const afterFast = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const afterFastCheckpoint = portable(afterFast.checkpoint);
    expect(deserializeRuntimeSnapshot(afterFastCheckpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.targetTradeId, order.reservedQuantity, order.trailPeak]))
      .toEqual([["slow", "trade-0", 0.25, 106], ["slow", "trade-1", 0.25, 106]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, afterFastCheckpoint, [followup],
      [followupFeed], fixtureOptions);
    const allBars = [...prefixBars, trigger, followup];
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars,
      [...prefixBars.map(feed), triggerFeed, followupFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...afterFast.trace, ...appended.trace]).toEqual(batch.trace);
    expect([...afterFast.trace, ...appended.trace]
      .filter((entry) => entry.kind === "fill" && entry.barIndex >= 4)
      .map((entry) => [entry.barIndex, entry.pointIndex, entry.positionSize]))
      .toEqual([[4, 2, 1.75], [4, 3, 1.5], [5, 0, 1.25], [5, 0, 1]]);
    expect(appended.result.strategy?.closedTradeRecords
      .map((trade) => [trade.entryPrice, trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([
        [103, "fast", 0.25, 100], [98, "fast", 0.25, 104],
        [103, "slow", 0.25, 103], [98, "slow", 0.25, 103],
      ]);
    expect(deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
    expect(JSON.stringify(afterFastCheckpoint)).toBe(JSON.stringify(afterFast.checkpoint));
  });

  it("carries two partial trailing calls for one trade through checkpoint append", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    strategy.exit("fast", "L", qty=1, trail_price=105, trail_offset=100)
    strategy.exit("slow", "L", qty=0.5, trail_price=105, trail_offset=200)
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["fast", 1, 2], ["slow", 0.5, 2]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, [...prefixBars, trigger],
      [...prefixBars.map(feed), triggerFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[2, 1], [3, 0.5]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 1, 100], ["slow", 0.5, 104]]);
    expect(deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries three ungrouped partial trailing calls through fills on later observed points", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=4)
if bar_index >= 2 and bar_index <= 4 and strategy.position_size > 0
    strategy.exit("fast", "L", qty=1, trail_price=105, trail_offset=100)
    strategy.exit("medium", "L", qty=1, trail_price=105, trail_offset=200)
    strategy.exit("slow", "L", qty=1, trail_price=105, trail_offset=300)
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const followup = { openTime: 6_000, closeTime: 6_040, open: 102, high: 103, low: 101, close: 102, volume: 90 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["fast", 1, 4], ["medium", 1, 4], ["slow", 1, 4]]);
    const afterTrigger = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const afterTriggerCheckpoint = portable(afterTrigger.checkpoint);
    expect(deserializeRuntimeSnapshot(afterTriggerCheckpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity,
        order.trailArmed, order.trailPeak]))
      .toEqual([["slow", 1, 4, true, 106]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, afterTriggerCheckpoint, [followup],
      [feed(followup, 5)], fixtureOptions);
    const allBars = [...prefixBars, trigger, followup];
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars,
      [...prefixBars.map(feed), triggerFeed, feed(followup, 5)], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...afterTrigger.trace, ...appended.trace]).toEqual(batch.trace);
    expect([...afterTrigger.trace, ...appended.trace]
      .filter((entry) => entry.kind === "fill" && entry.barIndex >= 4)
      .map((entry) => [entry.barIndex, entry.pointIndex, entry.positionSize]))
      .toEqual([[4, 2, 3], [4, 3, 2], [5, 0, 1]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 1, 100], ["medium", 1, 104], ["slow", 1, 102]]);
    expect(deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
    expect(JSON.stringify(afterTriggerCheckpoint)).toBe(JSON.stringify(afterTrigger.checkpoint));
  });

  it("rejects an added ungrouped trailing call on a fill-triggered rerun", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=4)
if bar_index >= 2 and strategy.position_size > 0
    if strategy.position_size == 4
        strategy.exit("fast", "L", qty=1, trail_price=105, trail_offset=100)
    else
        strategy.exit("replacement", "L", qty=0.5, trail_price=105, trail_offset=100)
    strategy.exit("medium", "L", qty=1, trail_price=105, trail_offset=200)
    strategy.exit("slow", "L", qty=1, trail_price=105, trail_offset=300)
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions))
      .toThrow("Synthetic historical fill trailing refresh is not admitted");
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries and reduces two partial trailing calls in one explicit OCA group", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    strategy.exit("fast", "L", qty=0.5, trail_price=105, trail_offset=100, oca_name="trail-shared")
    strategy.exit("slow", "L", qty=1, trail_price=105, trail_offset=200, oca_name="trail-shared")
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.ocaName, order.ocaType, order.reservedQuantity]))
      .toEqual([["fast", "trail-shared", "reduce", 0.5], ["slow", "trail-shared", "reduce", 1]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, [...prefixBars, trigger],
      [...prefixBars.map(feed), triggerFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[2, 1.5], [3, 1]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["fast", 0.5, 100], ["slow", 0.5, 104]]);
    expect(deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("rejects changed trailing OCA parameters on a fill-triggered refresh", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    if strategy.position_size == 2
        strategy.exit("fast", "L", qty=0.5, trail_price=105, trail_offset=100, oca_name="trail-shared")
    else
        strategy.exit("fast", "L", qty=0.5, trail_price=106, trail_offset=100, oca_name="trail-shared")
    strategy.exit("slow", "L", qty=1, trail_price=105, trail_offset=200, oca_name="trail-shared")
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions))
      .toThrow("Synthetic historical fill trailing refresh is not admitted");
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("rejects a replaced trailing OCA call identity on a fill-triggered refresh", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    if strategy.position_size == 2
        strategy.exit("fast", "L", qty=0.5, trail_price=105, trail_offset=100, oca_name="trail-shared")
    else
        strategy.exit("new-fast", "L", qty=0.5, trail_price=105, trail_offset=100, oca_name="trail-shared")
    strategy.exit("slow", "L", qty=1, trail_price=105, trail_offset=200, oca_name="trail-shared")
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 103, high: 104, low: 102, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 102, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 103, high: 106, low: 100, close: 104, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 103, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 100, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 104, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions))
      .toThrow("Synthetic historical fill trailing refresh is not admitted");
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries one full-quantity exit for two matching trades through a completed checkpoint", () => {
    const source = `//@version=6
strategy("Z10 multi-entry", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 2 and strategy.opentrades == 2
    strategy.exit("X", "L", limit=110)
plot(strategy.position_size)`;
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const fourth = { openTime: 4_000, closeTime: 4_040, open: 104, high: 106, low: 103, close: 105, volume: 70 };
    const fifth = { openTime: 5_000, closeTime: 5_040, open: 106, high: 111, low: 104, close: 107, volume: 80 };
    const allBars = [...bars, third, fourth, fifth];
    const beforeExit = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 3), allBars.slice(0, 3).map(feed), fixtureOptions);
    expect(beforeExit.result.strategy?.openTrades).toBe(2);
    expect(beforeExit.result.strategy?.orders.filter((order) => order.command === "exit" && order.status === "pending")).toHaveLength(1);
    const beforeExpansion = portable(beforeExit.checkpoint);
    const expanded = appendSyntheticHistoricalFillFixture(compiled, beforeExpansion, [fourth], [feed(fourth, 3)], fixtureOptions);
    const expandedExits = deserializeRuntimeSnapshot(expanded.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(expandedExits).toHaveLength(2);
    expect(expandedExits?.every((order) => typeof order.targetTradeId === "string")).toBe(true);
    expect(new Set(expandedExits?.map((order) => order.targetTradeId)).size).toBe(2);
    const restored = portable(expanded.checkpoint);
    const appended = appendSyntheticHistoricalFillFixture(compiled, restored, [fifth], [feed(fifth, 4)], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeExit.trace, ...expanded.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4))
      .toEqual([
        { barIndex: 4, pointIndex: 2, kind: "fill", orderIndex: 2, positionSize: 1 },
        { barIndex: 4, pointIndex: 2, kind: "fill", orderIndex: 3, positionSize: 0 },
      ]);
    expect(appended.result.strategy?.orders.filter((order) => order.command === "exit"))
      .toMatchObject([
        { id: "X", status: "filled", fillTime: 5_020, fillPrice: 111 },
        { id: "X", status: "filled", fillTime: 5_020, fillPrice: 111 },
      ]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.entryPrice, trade.exitPrice]))
      .toEqual([[103, 111], [98, 111]]);
    expect(appended.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 2, 2, 2, 0]);
    expect(JSON.stringify(beforeExpansion)).toBe(JSON.stringify(beforeExit.checkpoint));
    expect(JSON.stringify(restored)).toBe(JSON.stringify(expanded.checkpoint));
  });

  it("carries disjoint partial-exit reservations through a completed checkpoint", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 1 and strategy.position_size == 2
    strategy.exit("A", "L", qty=1.5, limit=110)
    strategy.exit("B", "L", qty=2, stop=90)
plot(strategy.position_size)`);
    const quiet = { ...bars[1]!, openTime: 3_000, closeTime: 3_040 };
    const trigger = { openTime: 4_000, closeTime: 4_040, open: 100, high: 111, low: 89, close: 101, volume: 60 };
    const allBars = [...bars, quiet, trigger];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 3),
      allBars.slice(0, 3).map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const pending = deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(pending).toMatchObject([
      { id: "A", reservedQuantity: 1.5, reservationBasisQuantity: 2 },
      { id: "B", reservedQuantity: 0.5, reservationBasisQuantity: 2 },
    ]);
    expect(new Set(pending?.map((order) => order.targetTradeId)).size).toBe(1);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [feed(trigger, 3)], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 3)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[1, 1.5], [2, 0]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => trade.quantity)).toEqual([0.5, 1.5]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries and reduces an explicit OCA exit group through checkpoint append", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    strategy.exit("take", "L", qty=0.5, limit=105, oca_name="shared")
    strategy.exit("stop", "L", qty=1, stop=100, oca_name="shared")
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 101, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 102, high: 106, low: 99, close: 101, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 102, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 99, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 101, cumulativeVolume: 80 },
    ] };
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, [...bars, creation, quiet],
      [...bars.map(feed), feed(creation, 2), feed(quiet, 3)], fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")
      .map((order) => [order.id, order.ocaName, order.ocaType, order.reservedQuantity]))
      .toEqual([["take", "shared", "reduce", 0.5], ["stop", "shared", "reduce", 1]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, [...bars, creation, quiet, trigger],
      [...bars.map(feed), feed(creation, 2), feed(quiet, 3), triggerFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[1, 1.5], [2, 1]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["take", 0.5, 106], ["stop", 0.5, 99]]);
    expect(appended.result.strategy?.openTrades).toBe(1);
    const finalOrders = deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit");
    expect(finalOrders?.filter((order) => order.status === "filled")
      .map((order) => [order.id, order.status, order.reservedQuantity]))
      .toEqual([["take", "filled", 0.5], ["stop", "filled", 0.5]]);
    expect(finalOrders?.filter((order) => order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("rejects changed explicit OCA parameters on a fill-triggered refresh", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index >= 2 and strategy.position_size > 0
    if strategy.position_size == 2
        strategy.exit("take", "L", qty=0.5, limit=105, oca_name="shared")
    else
        strategy.exit("take", "L", qty=0.5, limit=106, oca_name="shared")
    strategy.exit("stop", "L", qty=1, stop=100, oca_name="shared")
plot(strategy.position_size)`);
    const creation = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 101, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 102, high: 106, low: 99, close: 101, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 102, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 99, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 101, cumulativeVolume: 80 },
    ] };
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, [...bars, creation, quiet],
      [...bars.map(feed), feed(creation, 2), feed(quiet, 3)], fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions))
      .toThrow("Synthetic historical fill exit OCA refresh is not admitted");
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("keeps a reissued explicit OCA group isolated per matching trade", () => {
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
strategy("Z10 multi-entry OCA", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index >= 2 and strategy.opentrades == 2
    strategy.exit("take", "L", qty=0.5, limit=105, oca_name="shared")
    strategy.exit("stop", "L", qty=1, stop=100, oca_name="shared")
plot(strategy.position_size)` });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const creation = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 101, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 102, high: 106, low: 99, close: 101, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 102, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 99, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 101, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, [...prefixBars, trigger],
      [...prefixBars.map(feed), triggerFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[1, 1.5], [2, 1]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.entryPrice, trade.exitId, trade.quantity]))
      .toEqual([[103, "take", 0.5], [98, "stop", 0.5]]);
    const finalOrders = deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders;
    expect(finalOrders?.filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("isolates a reused explicit OCA name between different entry IDs", () => {
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
strategy("Z10 entry-scoped OCA", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("B", strategy.long, qty=1)
if bar_index >= 2 and strategy.opentrades == 2
    strategy.exit("takeA", "A", qty=0.5, limit=105, oca_name="shared")
    strategy.exit("stopA", "A", qty=1, stop=100, oca_name="shared")
    strategy.exit("takeB", "B", qty=0.5, limit=110, oca_name="shared")
    strategy.exit("stopB", "B", qty=1, stop=100, oca_name="shared")
plot(strategy.position_size)` });
    expect(compiledResult.diagnostics).toEqual([]);
    const compiled = compiledResult.program!;
    const creation = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const quiet = { openTime: 4_000, closeTime: 4_040, open: 103, high: 104, low: 101, close: 103, volume: 70 };
    const trigger = { openTime: 5_000, closeTime: 5_040, open: 102, high: 106, low: 99, close: 101, volume: 80 };
    const triggerFeed: SyntheticHistoricalFillFeedV1 = { ...feed(trigger, 4), points: [
      { sequence: 0, timestamp: 5_000, kind: "open", price: 102, cumulativeVolume: 0 },
      { sequence: 1, timestamp: 5_010, kind: "high", price: 106, cumulativeVolume: 10 },
      { sequence: 2, timestamp: 5_020, kind: "low", price: 99, cumulativeVolume: 20 },
      { sequence: 3, timestamp: 5_040, kind: "close", price: 101, cumulativeVolume: 80 },
    ] };
    const prefixBars = [...bars, creation, quiet];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, prefixBars, prefixBars.map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [triggerFeed], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, [...prefixBars, trigger],
      [...prefixBars.map(feed), triggerFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.entryId, trade.exitId, trade.quantity]))
      .toEqual([["A", "takeA", 0.5], ["B", "stopB", 0.5]]);
    expect(deserializeRuntimeSnapshot(appended.checkpoint.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending")).toEqual([]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("carries a partial trailing reservation beside a protective exit through checkpoint append", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 1 and strategy.position_size == 2
    strategy.exit("T", "L", qty=1, trail_price=105, trail_offset=100)
    strategy.exit("S", "L", qty=1, stop=101)
plot(strategy.position_size)`);
    const quiet = { openTime: 3_000, closeTime: 3_040, open: 103, high: 103, low: 103, close: 103, volume: 50 };
    const trigger = { openTime: 4_000, closeTime: 4_040, open: 103, high: 106, low: 100, close: 104, volume: 60 };
    const entryBar = { ...quiet, openTime: 2_000, closeTime: 2_040 };
    const allBars = [bars[0]!, entryBar, quiet, trigger];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 3),
      allBars.slice(0, 3).map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const pending = deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(pending?.map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["T", 1, 2], ["S", 1, 2]]);
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [trigger], [feed(trigger, 3)], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 3)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[1, 1], [3, 0]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.exitId, trade.quantity, trade.exitPrice]))
      .toEqual([["S", 1, 100], ["T", 1, 104]]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("fills two partial exits for each matching entry after checkpoint append", () => {
    const source = `//@version=6
strategy("Z10 partial multi-entry", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 2 and strategy.opentrades == 2
    strategy.exit("Half", "L", qty=0.5, limit=110)
    strategy.exit("Rest", "L", qty=1, limit=110)
plot(strategy.position_size)`;
    const compilation = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compilation.diagnostics).toEqual([]);
    const compiled = compilation.program!;
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const fourth = { openTime: 4_000, closeTime: 4_040, open: 104, high: 106, low: 103, close: 105, volume: 70 };
    const fifth = { openTime: 5_000, closeTime: 5_040, open: 106, high: 111, low: 104, close: 107, volume: 80 };
    const allBars = [...bars, third, fourth, fifth];
    const beforeFill = runSyntheticHistoricalFillFixture(compiled, allBars.slice(0, 4),
      allBars.slice(0, 4).map(feed), fixtureOptions);
    const saved = portable(beforeFill.checkpoint);
    const pending = deserializeRuntimeSnapshot(saved.runtimeState).strategy?.orders
      .filter((order) => order.command === "exit" && order.status === "pending");
    expect(pending).toHaveLength(4);
    expect(pending?.map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
      .toEqual([["Half", 0.5, 1], ["Rest", 0.5, 1], ["Half", 0.5, 1], ["Rest", 0.5, 1]]);
    const targets = [...new Set(pending?.map((order) => order.targetTradeId))];
    expect(targets).toHaveLength(2);
    expect(targets.every((target) => typeof target === "string" && target.length > 0)).toBe(true);
    for (const target of targets) {
      expect(pending?.filter((order) => order.targetTradeId === target)
        .map((order) => [order.id, order.reservedQuantity, order.reservationBasisQuantity]))
        .toEqual([["Half", 0.5, 1], ["Rest", 0.5, 1]]);
    }
    const appended = appendSyntheticHistoricalFillFixture(compiled, saved, [fifth], [feed(fifth, 4)], fixtureOptions);
    const batch = runSyntheticHistoricalFillFixture(compiled, allBars, allBars.map(feed), fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(batch));
    expect([...beforeFill.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 4)
      .map((entry) => [entry.pointIndex, entry.positionSize])).toEqual([[2, 1.5], [2, 1], [2, 0.5], [2, 0]]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => trade.quantity)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(appended.result.strategy?.closedTradeRecords.map((trade) => [trade.entryPrice, trade.exitId]))
      .toEqual([[103, "Half"], [103, "Rest"], [98, "Half"], [98, "Rest"]]);
    expect(JSON.stringify(saved)).toBe(JSON.stringify(beforeFill.checkpoint));
  });

  it("retains a fill-created multi-exit's creation point through same-bar expansion and reruns", () => {
    const source = `//@version=6
strategy("Z10 same-bar multi-entry", pyramiding=2, calc_on_order_fills=true)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 1 and strategy.closedtrades == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1 and strategy.opentrades == 2
    strategy.exit("X", "L", limit=104)
plot(strategy.position_size)`;
    const compiledResult = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiledResult.diagnostics).toEqual([]);
    const actual = run(compiledResult.program!);
    expect(actual.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 1))
      .toEqual([
        { barIndex: 1, pointIndex: 0, kind: "fill", orderIndex: 0, positionSize: 1 },
        { barIndex: 1, pointIndex: 1, kind: "fill", orderIndex: 1, positionSize: 2 },
        { barIndex: 1, pointIndex: 2, kind: "fill", orderIndex: 2, positionSize: 1 },
        { barIndex: 1, pointIndex: 2, kind: "fill", orderIndex: 3, positionSize: 0 },
      ]);
    expect(actual.result.strategy?.closedTrades).toBe(2);
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 0]);
  });

  it("S5 preserves genuine rerun alerts and logs while rolling back speculative visuals", () => {
    const actual = run(program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
varip int executions = 0
executions += 1
alert("once", alert.freq_once_per_bar)
log.info("execution {0}", executions)
plot(executions)`));
    expect(actual.trace.filter((entry) => entry.kind === "rerun")).toHaveLength(1);
    expect(actual.logs.events.map((event) => event.message)).toHaveLength(3);
    expect(actual.result.alerts.filter((alert) => alert.barIndex === 1)).toHaveLength(1);
    expect(actual.result.plots[0]?.points).toHaveLength(2);
    expect(actual.result.plots[0]?.points[1]?.value).toBe(3);
  });

  it("keeps historical barstate confirmed while close-only fixture alerts wait for the close point", () => {
    const actual = run(program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
log.info("confirmed {0} realtime {1}", barstate.isconfirmed, barstate.isrealtime)
alert("close " + str.tostring(close), alert.freq_once_per_bar_close)
plot(barstate.isconfirmed ? 1 : 0)`));
    expect(actual.logs.events.map((event) => event.message)).toEqual([
      "confirmed true realtime false",
      "confirmed true realtime false",
      "confirmed true realtime false",
    ]);
    expect(actual.result.alerts.map((alert) => alert.barIndex)).toEqual([0, 1]);
    expect(actual.result.alerts.map((alert) => alert.message)).toEqual(["close 101", "close 102"]);
    expect(actual.result.plots[0]?.points.map((point) => point.value)).toEqual([1, 1]);
  });

  it("discards the whole attempt when a cumulative runtime budget fails after an earlier log", () => {
    const compiled = program('log.info("attempt")\nplot(close)');
    expect(() => runSyntheticHistoricalFillFixture(compiled, bars, bars.map(feed),
      { symbolInfo: { currency: "USD" }, limits: { maxOperationsPerBar: 1 } })).toThrow();
  });

  it("S7 rejects an already-aborted signal before any runtime is admitted", () => {
    const controller = new AbortController();
    controller.abort(new Error("fixture cancelled"));
    expect(() => runSyntheticHistoricalFillFixture(program("plot(close)"), bars, bars.map(feed),
      { symbolInfo: { currency: "USD" }, signal: controller.signal })).toThrow("signal is invalid");
  });

  it("S7 aborts an in-progress fill without returning a partial result", () => {
    let checks = 0;
    const signal = {
      get aborted() { return ++checks >= 13; },
      reason: new Error("cancel during fill"),
    } as AbortSignal;
    const compiled = program('if bar_index == 0\n    strategy.entry("L", strategy.long, qty=1)\nplot(strategy.position_size)');
    expect(() => runSyntheticHistoricalFillFixture(compiled, bars, bars.map(feed),
      { symbolInfo: { currency: "USD", mintick: 0.01 }, signal })).toThrow("cancel during fill");
    expect(checks).toBeGreaterThanOrEqual(13);
  });

  it("S7 errors on the 33rd eligible fill instead of truncating to the 32-fill cap", () => {
    const orders = Array.from({ length: 33 }, (_, index) =>
      `    strategy.order("O${String(index)}", strategy.long, qty=1)`).join("\n");
    const compiled = program(`if bar_index == 0\n${orders}\nplot(strategy.position_size)`);
    expect(() => run(compiled)).toThrow("32-fill budget");
  });

  it("S8 rejects request plans, host sources and whole-bar strategy modes", () => {
    for (const body of [
      'plot(request.security(syminfo.tickerid, "D", close))',
      "plot(timenow)",
      "plot(last_bar_index)",
    ]) {
      const rejected = compile({ compatibility: PINE_COMPATIBILITY.strict,
        source: `//@version=6\nstrategy("Unsafe", calc_on_order_fills=true)\n${body}` });
      expect(rejected.program, body).toBeUndefined();
      expect(rejected.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2020"), body).toBe(true);
    }
    expect(() => run(program("plot(barstate.islast ? 1 : 0)")))
      .toThrow("dataset-tail or execution-clock value is not admitted");
    expect(() => run(program('plot(time("1"))'))).toThrow("time() overload is not admitted");
    expect(() => runSyntheticHistoricalFillFixture(program("plot(close)"), bars, bars.map(feed),
      { symbolInfo: { currency: "USD" }, sourceSeries: { close: [1, 2] } } as Parameters<typeof runSyntheticHistoricalFillFixture>[3])).toThrow("host sources or intrabars");
    const wholeBar = compile({ compatibility: PINE_COMPATIBILITY.strict,
      source: '//@version=6\nstrategy("Unsafe", calc_on_order_fills=true, process_orders_on_close=true)\nplot(close)' });
    expect(wholeBar.program).toBeUndefined();
    expect(wholeBar.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2020")).toBe(true);
  });

  it("rejects a stale feed before returning a result or running the script", () => {
    const invalid = { ...feed(bars[1]!, 1), parentOpenTime: 999 };
    const compiled = program('log.info("should not run")\nplot(close)');
    expect(() => runSyntheticHistoricalFillFixture(compiled, bars, [feed(bars[0]!, 0), invalid],
      { symbolInfo: { currency: "USD" } })).toThrow("parent time is invalid");
  });

  it("S6 resumes a JSON-portable completed boundary with one-bar append equivalent to batch", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if strategy.position_size > 0
    strategy.exit("P", "L", stop=100)
log.info("position {0}", strategy.position_size)
plot(strategy.position_size)
plot(close)`);
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const batch = runSyntheticHistoricalFillFixture(compiled, [...bars, third],
      [...bars.map(feed), feed(third, 2)], fixtureOptions);
    const first = run(compiled, 1);
    const restored = portable(first.checkpoint);
    const appended = appendSyntheticHistoricalFillFixture(compiled, restored, bars.slice(1), [feed(bars[1]!, 1)], fixtureOptions);
    expect(appended.result.stats.processedBars).toBe(1);
    const final = appendSyntheticHistoricalFillFixture(compiled, portable(appended.checkpoint), [third], [feed(third, 2)], fixtureOptions);
    expect(final.result.stats.processedBars).toBe(1);
    expect(comparable(final)).toEqual(comparable(batch));
    expect([...first.trace, ...appended.trace, ...final.trace]).toEqual(batch.trace);
    expect(final.logs.logEpoch).toBe(first.logs.logEpoch);
    expect(final.checkpoint.bars).toHaveLength(3);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(first.checkpoint));
  });

  it("S6 replays a corrected completed tail atomically and preserves the prior checkpoint", () => {
    const compiled = program('log.info("close {0}", close)\nplot(close)');
    const baseline = run(compiled);
    const saved = portable(baseline.checkpoint);
    const savedText = JSON.stringify(saved);
    const corrected = { ...bars[1]!, close: 104 };
    const correctedFeed = { ...feed(corrected, 1), revision: "fixture-2" } as const;
    const replaced = correctSyntheticHistoricalFillFixtureTail(compiled, saved, [corrected], [correctedFeed], fixtureOptions);
    const fresh = runSyntheticHistoricalFillFixture(compiled, [bars[0]!, corrected],
      [feed(bars[0]!, 0), correctedFeed], fixtureOptions);
    expect(comparable(replaced)).toEqual(comparable(fresh));
    expect(replaced.logs.logEpoch).not.toBe(baseline.logs.logEpoch);
    expect(JSON.stringify(saved)).toBe(savedText);
    expect(() => correctSyntheticHistoricalFillFixtureTail(compiled, saved,
      [{ ...corrected, openTime: 3_000 }], [correctedFeed], fixtureOptions)).toThrow("completed tail");
    expect(JSON.stringify(saved)).toBe(savedText);
  });

  it("S6 rejects stale revision, wrong program/options and incomplete or forged checkpoint state", () => {
    const compiled = program('log.info("bar")\nplot(close)');
    const first = run(compiled, 1);
    const saved = portable(first.checkpoint);
    const incoming = [{ ...feed(bars[1]!, 1), revision: "stale" }];
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, [], [], fixtureOptions))
      .toThrow("append is empty");
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1), incoming, fixtureOptions))
      .toThrow("source revision changed");
    expect(() => appendSyntheticHistoricalFillFixture(program("plot(open)"), saved, bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("identity or shape");
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1),
      [feed(bars[1]!, 1)], { ...fixtureOptions, timezone: "America/New_York" })).toThrow("identity or shape");
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1),
      [feed(bars[1]!, 1)], { ...fixtureOptions, randomSeed: 2 } as Parameters<typeof appendSyntheticHistoricalFillFixture>[4]))
      .toThrow("options are invalid");
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1),
      [feed(bars[1]!, 1)], { ...fixtureOptions, limits: { maxBars: Number.POSITIVE_INFINITY } }))
      .toThrow("limits are invalid");
    expect(() => runSyntheticHistoricalFillFixture(compiled, bars, bars.map(feed),
      { ...fixtureOptions, limits: { maxOperationsPerBar: Number.NaN } })).toThrow("limits are invalid");
    const incomplete = deserializeRuntimeSnapshot(saved.runtimeState);
    incomplete.strategy!.timeline.pop();
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      reseal({ ...saved, runtimeState: serializeRuntimeSnapshot(incomplete) }), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("completed bar boundary");
    const wrongTimeline = deserializeRuntimeSnapshot(saved.runtimeState);
    wrongTimeline.strategy!.timeline[0] = { ...wrongTimeline.strategy!.timeline[0]!, time: 999 };
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      reseal({ ...saved, runtimeState: serializeRuntimeSnapshot(wrongTimeline) }), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("completed bar boundary");
    const forgedPosition = deserializeRuntimeSnapshot(saved.runtimeState);
    forgedPosition.strategy!.positionSize = 99;
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      { ...saved, runtimeState: serializeRuntimeSnapshot(forgedPosition) }, bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("identity or shape");
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      reseal({ ...saved, runtimeState: serializeRuntimeSnapshot(forgedPosition) }), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("completed bar boundary");
    const wrongLog = JSON.parse(saved.logState) as { events: { barOpenTimeMs: number }[] };
    wrongLog.events[0]!.barOpenTimeMs = 999;
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      reseal({ ...saved, logState: JSON.stringify(wrongLog) }), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("completed bar boundary");
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      { ...saved, pointIndex: 2 } as SyntheticHistoricalFillFixtureCheckpointV1, bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("identity or shape");
    expect(() => appendSyntheticHistoricalFillFixture(compiled,
      reseal({ ...saved, logState: "{}" }), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).toThrow("Invalid Script log checkpoint");
  });

  it("S6 fingerprints admitted host-option values instead of later caller-owned getter values", () => {
    let mintickReads = 0;
    const symbolInfo = {
      currency: "USD",
      get mintick() { return ++mintickReads === 1 ? 0.01 : 0.02; },
    };
    const compiled = program("plot(close)");
    const first = runSyntheticHistoricalFillFixture(compiled, bars.slice(0, 1), [feed(bars[0]!, 0)],
      { symbolInfo, alertMode: "all" });
    expect(mintickReads).toBe(1);
    expect(() => appendSyntheticHistoricalFillFixture(compiled, portable(first.checkpoint), bars.slice(1),
      [feed(bars[1]!, 1)], fixtureOptions)).not.toThrow();
  });

  it("S6 leaves a completed checkpoint unchanged on append abort or operation exhaustion", () => {
    const compiled = program(`if bar_index == 1
    total = 0
    for i = 0 to 100
        total += i
plot(close)`);
    const options = { ...fixtureOptions, limits: { maxOperationsPerBar: 30 } };
    const first = runSyntheticHistoricalFillFixture(compiled, bars.slice(0, 1),
      [feed(bars[0]!, 0)], options);
    const saved = portable(first.checkpoint);
    const before = JSON.stringify(saved);
    const controller = new AbortController();
    controller.abort(new Error("append cancelled"));
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1),
      [feed(bars[1]!, 1)], { ...options, signal: controller.signal })).toThrow("append cancelled");
    expect(() => appendSyntheticHistoricalFillFixture(compiled, saved, bars.slice(1),
      [feed(bars[1]!, 1)], options)).toThrow("Operation budget exceeded");
    expect(JSON.stringify(saved)).toBe(before);
  });

  it("S6 replays a multi-bar corrected tail with fill-created exit, varip, visuals and logs", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if strategy.position_size > 0
    strategy.exit("P", "L", stop=100)
varip int calls = 0
calls += 1
label.new(bar_index, close, str.tostring(calls))
var table board = table.new(position.top_right, 1, 1)
table.cell(board, 0, 0, str.tostring(close))
alert("once", alert.freq_once_per_bar)
log.info("call {0} close {1}", calls, close)
plot(calls)`);
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const baselineBars = [...bars, third];
    expect(run(compiled, 1).result.strategy?.orders[0]?.status).toBe("pending");
    const baseline = runSyntheticHistoricalFillFixture(compiled, baselineBars, baselineBars.map(feed), fixtureOptions);
    const saved = portable(baseline.checkpoint);
    const savedText = JSON.stringify(saved);
    const correctedSecond = { ...bars[1]!, high: 106, close: 105 };
    const correctedThird = { ...third, open: 105, high: 107, close: 106 };
    const replacements = [correctedSecond, correctedThird];
    const replacementFeeds = replacements.map((bar, index) => ({ ...feed(bar, index + 1), revision: "fixture-2" }));
    const corrected = correctSyntheticHistoricalFillFixtureTail(compiled, saved, replacements, replacementFeeds, fixtureOptions);
    const fresh = runSyntheticHistoricalFillFixture(compiled, [bars[0]!, ...replacements],
      [feed(bars[0]!, 0), ...replacementFeeds], fixtureOptions);
    expect(comparable(corrected)).toEqual(comparable(fresh));
    expect(corrected.trace).toEqual(fresh.trace);
    expect(corrected.trace.filter((entry) => entry.kind === "fill")).toHaveLength(2);
    expect(corrected.result.strategy?.closedTrades).toBe(1);
    expect(corrected.result.strategy?.orders[1]).toMatchObject({ createdTime: 2_000, fillTime: 2_010 });
    expect(corrected.result.plots[0]?.points.map((point) => point.value)).toEqual([1, 4, 5]);
    expect(corrected.result.drawings.filter((drawing) => drawing.kind === "label")).toHaveLength(3);
    expect(corrected.result.tables).toHaveLength(1);
    expect(corrected.result.tables[0]?.cells[0]?.[0]?.text).toBe("106");
    expect(corrected.result.alerts).toHaveLength(3);
    expect(corrected.logs.events).toHaveLength(5);
    expect(JSON.stringify(saved)).toBe(savedText);
    expect(() => correctSyntheticHistoricalFillFixtureTail(compiled, saved, replacements,
      [{ ...replacementFeeds[0]!, parentOpenTime: 999 }, replacementFeeds[1]!], fixtureOptions))
      .toThrow("parent time is invalid");
    expect(JSON.stringify(saved)).toBe(savedText);
  });

  it("S6 replays a corrected tail from an already-open trade and pending protective exit", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if strategy.position_size > 0
    strategy.exit("P", "L", stop=90)
log.info("position {0} close {1}", strategy.position_size, close)
plot(strategy.position_size)`);
    const third = { openTime: 3_000, closeTime: 3_040, open: 102, high: 104, low: 101, close: 103, volume: 60 };
    const baseline = runSyntheticHistoricalFillFixture(compiled, [...bars, third], [...bars.map(feed), feed(third, 2)], fixtureOptions);
    const openBoundary = run(compiled);
    expect(openBoundary.result.strategy?.openTrades).toBe(1);
    expect(openBoundary.result.strategy?.orders.some((order) => order.status === "pending" && order.command === "exit")).toBe(true);
    const openSaved = portable(openBoundary.checkpoint);
    const openSavedText = JSON.stringify(openSaved);
    const saved = portable(baseline.checkpoint);
    const savedText = JSON.stringify(saved);
    const correctedThird = { ...third, low: 89, close: 100 };
    const correctedFeed = { ...feed(correctedThird, 2), revision: "fixture-2" };
    const appendedFeed = feed(correctedThird, 2);
    const appended = appendSyntheticHistoricalFillFixture(compiled, openSaved,
      [correctedThird], [appendedFeed], fixtureOptions);
    const corrected = correctSyntheticHistoricalFillFixtureTail(compiled, saved, [correctedThird], [correctedFeed], fixtureOptions);
    const freshAppend = runSyntheticHistoricalFillFixture(compiled, [...bars, correctedThird],
      [...bars.map(feed), appendedFeed], fixtureOptions);
    const freshCorrection = runSyntheticHistoricalFillFixture(compiled, [...bars, correctedThird],
      [...bars.map(feed), correctedFeed], fixtureOptions);
    expect(comparable(appended)).toEqual(comparable(freshAppend));
    expect([...openBoundary.trace, ...appended.trace]).toEqual(freshAppend.trace);
    expect(appended.checkpoint.feeds[2]?.revision).toBe("fixture-1");
    expect(comparable(corrected)).toEqual(comparable(freshCorrection));
    expect(corrected.trace).toEqual(freshCorrection.trace);
    expect(corrected.checkpoint.feeds[2]?.revision).toBe("fixture-2");
    expect(corrected.result.strategy?.closedTrades).toBe(1);
    expect(corrected.result.strategy?.openTrades).toBe(0);
    expect(corrected.trace.filter((entry) => entry.kind === "fill" && entry.barIndex === 2)).toHaveLength(1);
    expect(corrected.result.plots[0]?.points.map((point) => point.value)).toEqual([0, 1, 0]);
    expect(JSON.stringify(openSaved)).toBe(openSavedText);
    expect(JSON.stringify(saved)).toBe(savedText);
  });

  it("S6 preserves bounded log retention across batch, append and corrected-tail replay", () => {
    const compiled = program(`for i = 0 to 5100
    log.info("bar {0} row {1} close {2}", bar_index, i, close)
plot(close)`);
    const batch = run(compiled);
    const first = run(compiled, 1);
    const appended = appendSyntheticHistoricalFillFixture(compiled, portable(first.checkpoint),
      bars.slice(1), [feed(bars[1]!, 1)], fixtureOptions);
    expect(comparableJournal(appended)).toEqual(comparableJournal(batch));
    expect(appended.logs.logEpoch).toBe(first.logs.logEpoch);
    expect(appended.logs.events.every((event) => event.logEpoch === first.logs.logEpoch)).toBe(true);
    expect(appended.logs.events).toHaveLength(10_000);
    expect(appended.logs.droppedCount).toBe(202);
    const replacement = { ...bars[1]!, high: 106, close: 105 };
    const replacementFeed = { ...feed(replacement, 1), revision: "fixture-2" };
    const corrected = correctSyntheticHistoricalFillFixtureTail(compiled, portable(appended.checkpoint),
      [replacement], [replacementFeed], fixtureOptions);
    const fresh = runSyntheticHistoricalFillFixture(compiled, [bars[0]!, replacement],
      [feed(bars[0]!, 0), replacementFeed], fixtureOptions);
    expect(comparableJournal(corrected)).toEqual(comparableJournal(fresh));
    expect(corrected.logs.logEpoch).not.toBe(appended.logs.logEpoch);
    expect(corrected.logs.events.every((event) => event.logEpoch === corrected.logs.logEpoch)).toBe(true);
  });

  it("S6 preserves log overflow when an opening fill causes a real rerun", () => {
    const compiled = program(`if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
for i = 0 to 5100
    log.info("bar {0} row {1} close {2}", bar_index, i, close)
plot(strategy.position_size)`);
    const batch = run(compiled);
    const first = run(compiled, 1);
    const appended = appendSyntheticHistoricalFillFixture(compiled, portable(first.checkpoint),
      bars.slice(1), [feed(bars[1]!, 1)], fixtureOptions);
    expect(comparableJournal(appended)).toEqual(comparableJournal(batch));
    expect([...first.trace, ...appended.trace]).toEqual(batch.trace);
    expect(appended.trace.filter((entry) => entry.barIndex === 1).map((entry) => entry.kind))
      .toEqual(["fill", "rerun", "close"]);
    expect(appended.logs.events).toHaveLength(10_000);
    expect(appended.logs).toMatchObject({ firstRetainedSequence: 5_303, nextSequence: 15_303, droppedCount: 5_303 });
    expect(appended.logs.logEpoch).toBe(first.logs.logEpoch);
    expect(appended.logs.events.every((event) => event.logEpoch === first.logs.logEpoch)).toBe(true);
    const replacement = { ...bars[1]!, high: 106, close: 105 };
    const replacementFeed = { ...feed(replacement, 1), revision: "fixture-2" };
    const corrected = correctSyntheticHistoricalFillFixtureTail(compiled, portable(appended.checkpoint),
      [replacement], [replacementFeed], fixtureOptions);
    const fresh = runSyntheticHistoricalFillFixture(compiled, [bars[0]!, replacement],
      [feed(bars[0]!, 0), replacementFeed], fixtureOptions);
    expect(comparableJournal(corrected)).toEqual(comparableJournal(fresh));
    expect(corrected.trace).toEqual(fresh.trace);
    expect(corrected.logs).toMatchObject({ firstRetainedSequence: 5_303, nextSequence: 15_303, droppedCount: 5_303 });
    expect(corrected.logs.logEpoch).not.toBe(appended.logs.logEpoch);
    expect(corrected.logs.events.every((event) => event.logEpoch === corrected.logs.logEpoch)).toBe(true);
  });
});
