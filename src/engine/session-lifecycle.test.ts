import type { MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bar = (close: number, openTime = 0): MarketBar => ({ openTime, open: close, high: close, low: close, close, volume: 1 });
const program = (body = "value = close") => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Lifecycle")\n${body}` });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
};

describe("session operation ownership", () => {
  it("rejects overlapping operations before they can change the active dataset", async () => {
    const session = new PineEngine().createSession(program());
    try {
      const first = session.runBatch([bar(1)]);
      await expect(session.runBatch([bar(2)])).rejects.toThrow("busy");
      expect((await first).returned.value).toEqual([1]);
      expect((await session.runBatch([bar(2)])).returned.value).toEqual([2]);
    } finally { await session.close(); }
  });

  it("guards checkpoints and reentrant input updates inside progress callbacks", async () => {
    const session = new PineEngine().createSession(program());
    const rejected: Promise<void>[] = [];
    try {
      await session.runBatch([bar(1)], { onProgress() {
        expect(() => session.checkpoint()).toThrow("busy");
        rejected.push(expect(session.updateInputs({ changed: true })).rejects.toThrow("busy"));
      } });
      await Promise.all(rejected);
      expect(session.checkpoint().inputs).toEqual({});
    } finally { await session.close(); }
  });

  it.each(["return", "complete"] as const)("owns a suspended paginator until %s", async (finish) => {
    const session = new PineEngine().createSession(program());
    try {
      const pages = session.runPaginated([bar(1), bar(2, 1)], 1);
      await pages.next();
      await expect(session.appendBars([bar(3, 2)])).rejects.toThrow("busy");
      expect(() => session.checkpoint()).toThrow("busy");
      if (finish === "return") await pages.return(undefined);
      else { await pages.next(); await pages.next(); }
      expect((await session.runBatch([bar(3)])).returned.value).toEqual([3]);
    } finally { await session.close(); }
  });

  it("does not commit an empty evaluation closed across its first await", async () => {
    const session = new PineEngine().createSession(program());
    const run = session.runBatch([]);
    const closed = session.close();
    await expect(run).rejects.toThrow("closed");
    await closed;
    expect(() => session.checkpoint()).toThrow("closed");
  });

  it("checks cancellation after the final progress callback", async () => {
    const controller = new AbortController();
    const session = new PineEngine().createSession(program(), { signal: controller.signal });
    await expect(session.runBatch([bar(1)], { onProgress() { controller.abort(new Error("cancel final bar")); } })).rejects.toThrow("cancel final bar");
    await session.close();
  });
});

describe("failed evaluation recovery", () => {
  it.each(["runBatch", "restore"] as const)("requires a successful %s before checkpoint or incremental reuse", async (recovery) => {
    const session = new PineEngine().createSession(program('value = close\nif close == 99\n    runtime.error("bad bar")'));
    try {
      await session.runBatch([bar(1)]);
      const checkpoint = session.checkpoint();
      await expect(session.runBatch([bar(99)])).rejects.toThrow("bad bar");
      expect(() => session.checkpoint()).toThrow("failed evaluation");
      await expect(session.appendBars([])).rejects.toThrow("failed evaluation");
      await expect(session.replaceTail([bar(1)])).rejects.toThrow("failed evaluation");
      if (recovery === "restore") await session.restore(checkpoint);
      else await session.runBatch([bar(1)]);
      expect((await session.appendBars([bar(2, 1)])).returned.value).toEqual([1, 2]);
    } finally { await session.close(); }
  });

  it("invalidates reuse when a progress observer throws", async () => {
    const session = new PineEngine().createSession(program());
    try {
      await expect(session.runBatch([bar(1)], { onProgress() { throw new Error("observer failed"); } })).rejects.toThrow("observer failed");
      expect(() => session.checkpoint()).toThrow("failed evaluation");
      expect((await session.runBatch([bar(2)])).returned.value).toEqual([2]);
    } finally { await session.close(); }
  });

  it("can close a provider wait without allowing a late result to commit", async () => {
    let deliver!: (value: { bars: readonly MarketBar[] }) => void;
    const pending = new Promise<{ bars: readonly MarketBar[] }>((resolve) => { deliver = resolve; });
    const session = new PineEngine().createSession(program('value = request.security("OTHER", "D", close)'), {
      timeframe: "1", marketDataGateway: { load: () => pending },
    });
    const run = session.runBatch([bar(1)]);
    await session.close();
    deliver({ bars: [bar(2)] });
    await expect(run).rejects.toThrow("closed");
  });
});

it("lowers request expressions assigned into user-type members", async () => {
  const compiled = program('type Point\n    float value = 0\np = Point.new()\np.value := request.security("", "", close)\nvalue = p.value');
  expect(compiled.requestPlans).toHaveLength(1);
  const session = new PineEngine().createSession(compiled, { timeframe: "1" });
  try { expect((await session.runBatch([bar(7)])).returned.value).toEqual([7]); }
  finally { await session.close(); }
});

it("admits provider rows before awaiting symbol metadata or child execution", async () => {
  const providerBar = { ...bar(2) };
  const session = new PineEngine().createSession(program('value = request.security("CHILD", "1", close)'), {
    timeframe: "1",
    marketDataGateway: {
      async load() { return { bars: [providerBar] }; },
      async getSymbolInfo() { providerBar.close = 99; return { ticker: "CHILD" }; },
    },
  });
  try { expect((await session.runBatch([bar(1)])).returned.value).toEqual([2]); }
  finally { await session.close(); }
});

describe("bounded chart execution output", () => {
  it("omits unrequested histories while preserving plots, history reads and incremental results", async () => {
    const compiled = program('first = close\nsecond = first[1] + close\nplot(second)');
    const engine = new PineEngine();
    const full = engine.createSession(compiled);
    const selectedNames = ["second"];
    const selected = engine.createSession(compiled, { resultVariables: selectedNames });
    selectedNames.push("first");
    const lean = engine.createSession(compiled, { resultVariables: [] });
    try {
      const bars = [bar(1, 0), bar(2, 60_000), bar(3, 120_000)];
      const expected = await full.runBatch(bars);
      const result = await lean.runBatch(bars, { retainTailSnapshot: false });
      expect(result.returned).toEqual({});
      expect(result.plots).toEqual(expected.plots);
      expect((await selected.runBatch(bars)).returned).toEqual({ second: expected.returned.second });
      expect(lean.checkpoint().tailState).toBeUndefined();
      expect(full.checkpoint().tailState).toBeDefined();
      const next = [bar(4, 180_000)];
      expect((await lean.appendBars(next)).plots).toEqual((await full.appendBars(next)).plots);
      expect((await lean.replaceTail([bar(5, 180_000)])).plots).toEqual((await full.replaceTail([bar(5, 180_000)])).plots);
      expect(lean.checkpoint().tailState).toBeDefined();
    } finally { await Promise.all([full.close(), selected.close(), lean.close()]); }
  });

  it("preserves requested child expressions when root histories are omitted", async () => {
    const compiled = program('value = request.security("OTHER", "1", close * 2)\nplot(value)');
    const options = {
      timeframe: "1", symbolInfo: { ticker: "PRIMARY", tickerid: "PRIMARY" },
      marketDataGateway: { async load() { return { bars: [bar(3, 0), bar(4, 60_000)] }; } },
    };
    const full = new PineEngine().createSession(compiled, options);
    const lean = new PineEngine().createSession(compiled, { ...options, resultVariables: [] });
    try {
      const bars = [bar(1, 0), bar(2, 60_000)];
      const expected = await full.runBatch(bars);
      const result = await lean.runBatch(bars, { retainTailSnapshot: false });
      expect(result.returned).toEqual({});
      expect(result.plots).toEqual(expected.plots);
      expect(result.plots[0]?.points.map((point) => point.value)).toEqual([6, 8]);
    } finally { await Promise.all([full.close(), lean.close()]); }
  });

  it("preserves strategy fills and account output without retaining the historical tail graph", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
strategy("Retention", default_qty_type=strategy.fixed, default_qty_value=1)
if bar_index == 0
    strategy.entry("Long", strategy.long)
if bar_index == 2
    strategy.close("Long")
plot(strategy.equity)` }).program!;
    const options = { symbolInfo: { ticker: "TEST", currency: "USD", pointvalue: 1, mintick: 0.01 } };
    const full = new PineEngine().createSession(compiled, options);
    const lean = new PineEngine().createSession(compiled, { ...options, resultVariables: [] });
    try {
      const bars = Array.from({ length: 5 }, (_, index) => bar(10 + index, index * 60_000));
      const expected = await full.runBatch(bars);
      const result = await lean.runBatch(bars, { retainTailSnapshot: false });
      expect(result.strategy).toEqual(expected.strategy);
      expect(result.plots).toEqual(expected.plots);
      const checkpoint = lean.checkpoint();
      expect(checkpoint.tailState).toBeUndefined();
      expect((await lean.restore(checkpoint)).strategy).toEqual(expected.strategy);
    } finally { await Promise.all([full.close(), lean.close()]); }
  });
});
