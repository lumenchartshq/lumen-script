import { expect, it } from "vitest";
import { compile } from "../compiler/index.js";
import type { MarketBar } from "../contracts/index.js";
import { PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const minute = 60_000;
const start = Date.UTC(2025, 0, 2);
const at = (value: number) => start + value * minute;
const bar = (open: number, end: number, close: number): MarketBar => ({
  openTime: at(open), closeTime: at(end), open: close, high: close, low: close, volume: 1, close,
});
const parents = [bar(0, 30, 1), bar(30, 60, 2), bar(60, 90, 3), bar(90, 130, 4), bar(140, 170, 5)];
const lower = [bar(0, 15, 10), bar(15, 30, 11), bar(30, 45, 20), bar(45, 60, 21), bar(90, 105, 40), bar(105, 120, 41), bar(145, 160, 50)];

function program(body: string) {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("H3 active")\n${body}` });
  expect(compiled.diagnostics).toEqual([]);
  return compiled.program!;
}

function options(now: number) {
  return {
    timeframe: "30",
    now: () => at(now),
    symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL", timezone: "UTC", session: "24x7" },
    marketDataGateway: { load: async () => ({ bars: lower, symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT", timezone: "UTC", session: "24x7" } }) },
  } as const;
}

it("filters not-yet-opened child rows before cumulative child execution", async () => {
  const compiled = program(`values = request.security_lower_tf("NASDAQ:MSFT", "15", ta.cum(close) + last_bar_index)
plot(array.size(values) > 0 ? array.get(values, array.size(values) - 1) : na)`);
  const engine = new PineEngine();
  const at112 = await engine.createSession(compiled, options(112)).runBatch(parents);
  expect(at112.plots[0]?.points.map((point) => point.value)).toEqual([26, 67, NaN, 148, NaN]);
  const at145 = await engine.createSession(compiled, options(145)).runBatch(parents);
  expect(at145.plots[0]?.points.map((point) => point.value)).toEqual([27, 68, NaN, 149, 199]);
});

it("keeps available same-context values under gaps_on while masking a future primary row", async () => {
  const compiled = program("plot(request.security(syminfo.tickerid, timeframe.period, close, gaps=barmerge.gaps_on))");
  const result = await new PineEngine().createSession(compiled, options(112)).runBatch(parents);
  expect(result.plots[0]?.points.map((point) => point.value)).toEqual([1, 2, 3, 4, NaN]);
});

it("keeps the active equal-timeframe value when a later primary row is future", async () => {
  const primary = [
    { openTime: 0, closeTime: 60_000, close: 1 },
    { openTime: 60_000, closeTime: 120_000, close: 2 },
    { openTime: 120_000, closeTime: 180_000, close: 3 },
  ].map(({ openTime, closeTime, close }): MarketBar => ({ openTime, closeTime, open: close, high: close, low: close, close, volume: 1 }));
  const compiled = program("plot(request.security(syminfo.tickerid, timeframe.period, close, gaps=barmerge.gaps_on))");
  const result = await new PineEngine().createSession(compiled, {
    timeframe: "1", now: () => 90_000, symbolInfo: { ticker: "A", tickerid: "A" },
  }).runBatch(primary);
  expect(result.plots[0]?.points.map((point) => point.value)).toEqual([1, 2, NaN]);
});

it("maps same-context startup windows explicitly for scalar and lower array results", async () => {
  const scalar = program("plot(request.security(syminfo.tickerid, timeframe.period, close, gaps=barmerge.gaps_on, calc_bars_count=2))");
  const scalarResult = await new PineEngine().createSession(scalar, options(112)).runBatch(parents);
  expect(scalarResult.plots[0]?.points.map((point) => point.value)).toEqual([3, 4, NaN]);

  const lowerArrays = program(`values = request.security_lower_tf(syminfo.tickerid, timeframe.period, close, calc_bars_count=2)
plot(array.size(values))`);
  const lowerResult = await new PineEngine().createSession(lowerArrays, options(112)).runBatch(parents);
  expect(lowerResult.plots[0]?.points.map((point) => point.value)).toEqual([1, 1, 0]);
});

it("applies calc_bars_count to rows available at now before child execution", async () => {
  const compiled = program(`values = request.security_lower_tf("NASDAQ:MSFT", "15", close, calc_bars_count=2)
plot(array.size(values))`);
  const result = await new PineEngine().createSession(compiled, options(112)).runBatch(parents);
  expect(result.plots[0]?.points.map((point) => point.value)).toEqual([0, 0, 0, 2, 0]);
});

it("shares the widest child window between scalar and array requests for one context", async () => {
  // Shared limit probe: counts 3, 7 and 1 share the seven-bar window.
  const compiled = program(`first = request.security_lower_tf("NASDAQ:MSFT", "15", close * 3, calc_bars_count=1)
second = request.security_lower_tf("NASDAQ:MSFT", "15", close * 7, calc_bars_count=3)
scalar = request.security("NASDAQ:MSFT", "15", close, calc_bars_count=2)
plot(first.size())
plot(second.size())
plot(scalar)`);
  const result = await new PineEngine().createSession(compiled, options(112)).runBatch(parents);
  expect(result.plots.map(({ points }) => points.map(({ value }) => value))).toEqual([
    [0, 1, 0, 2, 0],
    [0, 1, 0, 2, 0],
    [NaN, 21, 21, 41, NaN],
  ]);
});

it("anchors a bounded chart context across appends, portable restore and input changes", async () => {
  // The reference platform starts at index zero, then reaches index two at the next minute.
  const compiled = program(`int count = input.int(2, "Count")
float selected = input.source(close, "Selected")
float recent = request.security(syminfo.tickerid, timeframe.period, close, calc_bars_count=count)
float wider = request.security(syminfo.tickerid, timeframe.period, close * 2)
int index = bar_index
float prior = recent[2]
plot(recent)`);
  const engine = new PineEngine();
  const context = {
    ...options(180),
    inputs: { Selected: "host" },
    sourceSeries: { host: [10, 20, 30, 40, 50] },
  };
  const live = engine.createSession(compiled, context);
  const restored = engine.createSession(compiled, context);
  try {
    const first = await live.runBatch(parents.slice(0, 4));
    expect(first.times).toEqual([at(60), at(90)]);
    expect(first.returned).toMatchObject({ recent: [3, 4], wider: [6, 8], selected: [30, 40], index: [0, 1] });
    const checkpoint = structuredClone(live.checkpoint());
    expect(checkpoint.firstEvaluatedBar).toBe(2);
    await restored.restore(checkpoint);
    const appended = await live.appendBars(parents.slice(4));
    expect(appended.fromIndex).toBe(2);
    expect(appended.returned).toMatchObject({ recent: [3, 4, 5], selected: [30, 40, 50], index: [0, 1, 2], prior: [NaN, NaN, 3] });
    expect((await restored.appendBars(parents.slice(4))).returned).toEqual(appended.returned);
    await restored.updateInputs({ Selected: "host", Count: 0 });
    const widened = await restored.replaceTail([]);
    expect(widened.fromIndex).toBe(0);
    expect(widened.returned.selected).toEqual([10, 20, 30, 40, 50]);
    const replayOnly = await restored.restore({ bars: parents, inputs: { Selected: "host" } });
    expect(replayOnly.returned.selected).toEqual([40, 50]);
  } finally {
    await Promise.all([live.close(), restored.close()]);
  }
});
