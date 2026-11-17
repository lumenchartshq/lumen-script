import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { deserializeRuntimeSnapshot } from "../runtime/index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function program(body: string) {
  const result = compile({ source: `//@version=6\nindicator("History limits")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

function bars(count: number): MarketBar[] {
  return Array.from({ length: count }, (_, index) => ({
    openTime: index * 60_000,
    closeTime: (index + 1) * 60_000,
    open: index + 1,
    high: index + 1,
    low: index + 1,
    close: index + 1,
    volume: index + 1,
  }));
}

describe("production history limits", () => {
  it("bounds executable windows while retaining complete public values and plots", async () => {
    const count = 8192;
    const compiled = program("f(series float value) =>\n    local = value + 1\n    local[2]\noutput = f(close + 2)\nplot(output)");
    const session = new PineEngine().createSession(compiled);
    const result = await session.runBatch(bars(count));
    const snapshot = deserializeRuntimeSnapshot(session.checkpoint().runtimeState!);
    expect(result.returned.output).toHaveLength(count);
    expect(result.plots[0]?.points).toHaveLength(count);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(count + 1);
    expect(snapshot.variables[0]).toHaveLength(count);
    expect(snapshot.variableHistory[0]?.origin).toBe(count - 5001);
    expect(snapshot.variableHistory[0]?.values.length).toBeLessThanOrEqual(5001);
    expect([...snapshot.argumentSeries.values()].map((window) => window.values.length)).toEqual([5001]);
    expect([...snapshot.localState.values()].map((state) => state.values.values.length)).toEqual([5001]);
    await session.close();
  });

  it("restores bounded windows for append, replacement and portable checkpoints", async () => {
    const compiled = program("f(series float value) =>\n    local = value + 1\n    local[2]\noutput = f(close + 2)\nplot(output)");
    const fixture = bars(5010);
    const engine = new PineEngine();
    const incremental = engine.createSession(compiled);
    await incremental.runBatch(fixture.slice(0, 5008));
    const checkpoint = JSON.parse(JSON.stringify(incremental.checkpoint())) as SessionCheckpoint;
    const appended = await incremental.appendBars(fixture.slice(5008));
    const batch = await engine.createSession(compiled).runBatch(fixture);
    expect(appended.plots).toEqual(batch.plots);
    expect(appended.returned).toEqual(batch.returned);
    const revised = { ...fixture.at(-1)!, close: 99 };
    const replaced = await incremental.replaceTail([revised]);
    const revisedBatch = await engine.createSession(compiled).runBatch([...fixture.slice(0, -1), revised]);
    expect(replaced.plots).toEqual(revisedBatch.plots);
    await incremental.restore(checkpoint);
    expect((await incremental.appendBars(fixture.slice(5008))).plots).toEqual(batch.plots);
    await incremental.close();
  });

  it("keeps child request histories stable after the window wraps", async () => {
    const compiled = program("f(series float value) =>\n    local = value + 1\n    local[2]\nplot(request.security(\"A\", \"1\", f(close)))");
    const fixture = bars(5010);
    const options = { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" } };
    const engine = new PineEngine();
    const batch = await engine.createSession(compiled, options).runBatch(fixture);
    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(fixture.slice(0, 5008));
    const checkpoint = JSON.parse(JSON.stringify(incremental.checkpoint())) as SessionCheckpoint;
    expect((await incremental.appendBars(fixture.slice(5008))).plots).toEqual(batch.plots);
    await incremental.restore(checkpoint);
    expect((await incremental.appendBars(fixture.slice(5008))).plots).toEqual(batch.plots);
    await incremental.close();
  });

  it("preserves varip and a deep prior slot across realtime tail replacement", async () => {
    const fixture = bars(5010);
    const now = fixture.at(-1)!.openTime + 30_000;
    const compiled = program("varip int ticks = 0\nticks += 1\nplot(ticks[5000], \"past\")\nplot(ticks, \"current\")");
    const session = new PineEngine().createSession(compiled, { now: () => now });
    const initial = await session.runBatch(fixture);
    expect(initial.plots.find((plot) => plot.title === "past")?.points.at(-1)?.value).toBe(10);
    expect(initial.plots.find((plot) => plot.title === "current")?.points.at(-1)?.value).toBe(5010);
    const replaced = await session.replaceTail([{ ...fixture.at(-1)!, close: 99 }]);
    expect(replaced.plots.find((plot) => plot.title === "past")?.points.at(-1)?.value).toBe(10);
    expect(replaced.plots.find((plot) => plot.title === "current")?.points.at(-1)?.value).toBe(5011);
    await session.close();
  });
  it("uses targeted size as a realtime minimum without shrinking inferred history", async () => {
    const now = 1_000_000;
    const fixture = bars(5).map((bar, index) => ({ ...bar, closeTime: index === 4 ? now + 60_000 : now - 60_000 }));
    const engine = new PineEngine();
    const source = "offset = barstate.isrealtime ? 3 : 1\nplot(close[offset])";
    const without = engine.createSession(program(source), { now: () => now });
    await expect(without.runBatch(fixture)).rejects.toMatchObject({
      name: "PineRuntimeError",
      message: "History offset exceeds inferred buffer of 1 bars for this series",
      range: { start: { line: 4 } },
    });
    const withTarget = engine.createSession(program(`max_bars_back(close, 3)\n${source}`), { now: () => now });
    const result = await withTarget.runBatch(fixture);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(2);
    await expect(engine.createSession(program(`max_bars_back(close, 2)\n${source}`), { now: () => now }).runBatch(fixture))
      .rejects.toMatchObject({ name: "PineRuntimeError", message: "History offset exceeds inferred buffer of 2 bars for this series" });

    const grows = engine.createSession(program("max_bars_back(close, 2)\nplot(close[3])"), { now: () => now });
    expect((await grows.runBatch(bars(5))).plots[0]?.points.at(-1)?.value).toBe(2);
    await expect(engine.createSession(program("max_bars_back(close, 5000)\nplot(close[10001])")).runBatch(bars(1)))
      .rejects.toMatchObject({ name: "PineRuntimeError", message: "History offset exceeds 10000 bars for this series" });
  });

  it("applies a targeted realtime minimum to an unambiguous function local", async () => {
    const now = 1_000_000;
    const fixture = bars(5).map((bar, index) => ({ ...bar, closeTime: index === 4 ? now + 60_000 : now - 60_000 }));
    const body = "f() =>\n    local = close\n    max_bars_back(local, 3)\n    local[barstate.isrealtime ? 3 : 1]\nplot(f())";
    const result = await new PineEngine().createSession(program(body), { now: () => now }).runBatch(fixture);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(2);
  });

  it.each([
    ["open", "max_bars_back(open, 3)\nplot(open[barstate.isrealtime ? 3 : 1])", 2],
    ["high", "max_bars_back(high, 3)\nplot(high[barstate.isrealtime ? 3 : 1])", 12],
    ["low", "max_bars_back(low, 3)\nplot(low[barstate.isrealtime ? 3 : 1])", 0],
    ["close", "max_bars_back(close, 3)\nplot(close[barstate.isrealtime ? 3 : 1])", 3],
    ["volume", "max_bars_back(volume, 3)\nplot(volume[barstate.isrealtime ? 3 : 1])", 102],
    ["time", "max_bars_back(time, 3)\nplot(time[barstate.isrealtime ? 3 : 1])", 60_000],
    ["global", "custom = close * 2\nmax_bars_back(custom, 3)\nplot(custom[barstate.isrealtime ? 3 : 1])", 6],
    ["local", "f() =>\n    local = close * 2\n    max_bars_back(local, 3)\n    local[barstate.isrealtime ? 3 : 1]\nplot(f())", 6],
  ] as const)("admits a targeted %s history identity and rejects its no-call control", async (_name, body, firstValue) => {
    const now = 1_000_000;
    const fixture = bars(5).map((bar, index) => ({
      ...bar, open: index + 1, high: index + 11, low: index - 1, close: index + 2, volume: index + 101,
      closeTime: index === 4 ? now + 60_000 : now - 60_000,
    }));
    const engine = new PineEngine();
    const withTarget = engine.createSession(program(body), { now: () => now });
    const withoutTarget = engine.createSession(program(body.replace(/^[ \t]*max_bars_back\([^\n]+\)\n/mu, "")), { now: () => now });
    try {
      expect((await withTarget.runBatch(fixture)).plots[0]?.points.at(-1)?.value).toBe(firstValue);
      await expect(withoutTarget.runBatch(fixture)).rejects.toMatchObject({
        name: "PineRuntimeError", message: "History offset exceeds inferred buffer of 1 bars for this series",
      });
    } finally {
      await withTarget.close();
      await withoutTarget.close();
    }
  });

  it("honors the targeted 5000-bar upper bound at first realtime use", async () => {
    const fixture = bars(5001);
    const now = fixture.at(-1)!.openTime + 30_000;
    const source = "max_bars_back(close, 5000)\nplot(close[barstate.isrealtime ? 5000 : 1])";
    const session = new PineEngine().createSession(program(source), { now: () => now });
    try {
      expect((await session.runBatch(fixture)).plots[0]?.points.at(-1)?.value).toBe(1);
    } finally { await session.close(); }
  });

  it("preserves inferred and targeted depth across append, tail replay and checkpoint restore", async () => {
    const now = 1_000_000;
    const fixture = bars(5).map((bar, index) => ({ ...bar, closeTime: index === 4 ? now + 60_000 : now - 60_000 }));
    const compiled = program("max_bars_back(close, 3)\nplot(close[barstate.isrealtime ? 3 : 1])");
    const engine = new PineEngine();
    const options = { now: () => now };
    const batch = await engine.createSession(compiled, options).runBatch(fixture);
    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(fixture.slice(0, 4));
    const checkpoint = incremental.checkpoint();
    expect((await incremental.appendBars(fixture.slice(4))).plots).toEqual(batch.plots);
    await incremental.restore(checkpoint);
    expect((await incremental.appendBars(fixture.slice(4))).plots).toEqual(batch.plots);
    const revised = { ...fixture[4]!, close: 8 };
    const replayed = await incremental.replaceTail([revised]);
    const revisedBatch = await engine.createSession(compiled, options).runBatch([...fixture.slice(0, 4), revised]);
    expect(replayed.plots).toEqual(revisedBatch.plots);
  });
  it.each([
    ["custom", "custom = close * 2\nplot(custom[5001])", 5000],
    ["close", "plot(close[10001])", 10000],
    ["volume", "plot(volume[5001])", 5000],
    ["time", "plot(time[10001])", 10000],
    ["expression", "plot((close + 1)[5001])", 5000],
    ["shadowed close", "close = bar_index\nplot(close[5001])", 5000],
  ])("rejects %s history beyond its source-class ceiling", async (_name, source, ceiling) => {
    const session = new PineEngine().createSession(program(source));
    try {
      await expect(session.runBatch(bars(2))).rejects.toMatchObject({
        name: "PineRuntimeError",
        message: `History offset exceeds ${String(ceiling)} bars for this series`,
        range: { start: { line: source.includes("\n") ? 4 : 3 } },
      });
    } finally { await session.close(); }
  });

  it("keeps legal deep built-in and ordinary references, missing prehistory and negative errors", async () => {
    const engine = new PineEngine();
    const builtin = await engine.createSession(program("plot(close[10000])")).runBatch(bars(10002));
    const ordinary = await engine.createSession(program("custom = close * 2\nplot(custom[5000])")).runBatch(bars(5002));
    const missing = await engine.createSession(program("plot(close[2])")).runBatch(bars(1));
    expect(builtin.plots[0]?.points.at(-1)?.value).toBe(2);
    expect(ordinary.plots[0]?.points.at(-1)?.value).toBe(4);
    expect(missing.plots[0]?.points[0]?.value).toBeNaN();
    await expect(engine.createSession(program("plot(close[-1])")).runBatch(bars(1)))
      .rejects.toMatchObject({ name: "PineRuntimeError", message: "History offset must be a non-negative integer", range: { start: { line: 3 } } });
  });

  it("keeps batch, pagination and append results equal for legal history", async () => {
    const engine = new PineEngine();
    const compiled = program("custom = close * 2\nplot(custom[3])");
    const fixture = bars(9);
    const batch = await engine.createSession(compiled).runBatch(fixture);
    const paginated = engine.createSession(compiled);
    let last;
    for await (const page of paginated.runPaginated(fixture, 3)) last = page;
    const incremental = engine.createSession(compiled);
    await incremental.runBatch(fixture.slice(0, 4));
    const checkpoint = incremental.checkpoint();
    const appended = await incremental.appendBars(fixture.slice(4));
    expect(last?.plots).toEqual(batch.plots);
    expect(appended.plots).toEqual(batch.plots);
    await incremental.restore(checkpoint);
    const restored = await incremental.appendBars(fixture.slice(4));
    expect(restored.plots).toEqual(batch.plots);
  });
});
