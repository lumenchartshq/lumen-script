import { expect, describe, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot } from "../runtime/index.js";
import { PineEngine, compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compatibility = PINE_COMPATIBILITY.strict;

function program(source: string) {
  const result = compile({ source, compatibility });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

function bar(openTime: number, closeTime: number, close = 10): MarketBar {
  return { openTime, closeTime, open: close, high: close, low: close, close, volume: 1 };
}

describe("runtime compatibility", () => {
  for (const location of ["main", "tail"] as const) {
    it(`rejects enabled fill recalculation in a portable ${location} checkpoint before mutation`, async () => {
      const compiled = program('//@version=6\nstrategy("Restored checkpoint")\nplot(close)');
      const session = new PineEngine().createSession(compiled, { symbolInfo: { currency: "USD" } });
      await session.runBatch([bar(0, 60_000), bar(60_000, 120_000)]);
      const checkpoint = session.checkpoint();
      const encoded = location === "main" ? checkpoint.runtimeState! : checkpoint.tailState!.runtimeState;
      const snapshot = deserializeRuntimeSnapshot(encoded);
      const strategy = snapshot.strategy!;
      const modified = serializeRuntimeSnapshot({ ...snapshot, strategy: { ...strategy, config: { ...strategy.config, calc_on_order_fills: true } } });
      const corrupted = location === "main"
        ? { ...checkpoint, runtimeState: modified }
        : { ...checkpoint, tailState: { ...checkpoint.tailState!, runtimeState: modified } };
      await expect(session.restore(corrupted)).rejects.toThrow("calc_on_order_fills is unsupported");
      expect(session.checkpoint().runtimeState).toEqual(checkpoint.runtimeState);
      const restored = await session.restore({ ...checkpoint });
      expect(restored.strategy?.config.calc_on_order_fills).toBe(false);
    });
  }

  it("rejects enabled fill recalculation on precompiled strategy descriptors", () => {
    const compiled = program('//@version=6\nstrategy("Restored")\nplot(close)');
    const strategy = compiled.descriptor.strategy!;
    const restored = { ...compiled, descriptor: { ...compiled.descriptor, strategy: { ...strategy, calc_on_order_fills: true } } };
    expect(() => new PineEngine().createSession(restored, { symbolInfo: { currency: "USD" } })).toThrow("calc_on_order_fills is unsupported");
  });

  it("keeps the explicit Lumen Charts historical fill schedule out of ordinary engine sessions", () => {
    const result = compile({ compatibility, historicalFillSchedule: "lumencharts-v1",
      source: '//@version=6\nstrategy("Internal", calc_on_order_fills=true)\nplot(close)' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.historicalFillSchedule).toBe("lumencharts-v1");
    expect(() => new PineEngine().createSession(result.program!, { symbolInfo: { currency: "USD" } }))
      .toThrow("calc_on_order_fills is unsupported");
  });

  it("preserves legacy runtime admission with fill recalculation enabled", () => {
    const result = compile({ source: '//@version=6\nstrategy("Frozen", calc_on_order_fills=true)\nplot(close)', compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
    expect(() => new PineEngine().createSession(result.program!)).not.toThrow();
  });

  it("keeps an omitted math.round precision usable as an array index", async () => {
    const compiled = program([
      "//@version=6",
      "indicator(\"Rounded array index\")",
      "values = array.from(10.0, 20.0, 30.0)",
      "index = math.round(1.4)",
      "plot(values.get(index))",
    ].join("\n"));
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0, 60_000)]);

    expect(result.plots[0]?.points[0]?.value).toBe(20);
  });

  it("treats a confirmed batch tail as historical rather than realtime", async () => {
    const compiled = program(`//@version=6
indicator("Closed tail")
history = barstate.ishistory
realtime = barstate.isrealtime
confirmed = barstate.isconfirmed`);
    const result = await new PineEngine().createSession(compiled, { now: () => 180_000 }).runBatch([
      bar(0, 60_000),
      bar(60_000, 120_000),
    ]);

    expect(result.returned.history).toEqual([true, true]);
    expect(result.returned.realtime).toEqual([false, false]);
    expect(result.returned.confirmed).toEqual([true, true]);
  });

  it("does not leak an unclosed higher-timeframe value with lookahead off", async () => {
    const compiled = program(`//@version=6
indicator("Confirmed HTF")
value = request.security("TEST:DAILY", "D", close, gaps=barmerge.gaps_off, lookahead=barmerge.lookahead_off)
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "60",
      now: () => 10_800_000,
      marketDataGateway: { load: async () => ({ bars: [bar(0, 86_400_000, 100)] }) },
    }).runBatch([
      bar(0, 3_600_000, 10),
      bar(3_600_000, 7_200_000, 11),
    ]);

    expect(result.returned.value).toEqual([Number.NaN, Number.NaN]);
  });

  it("keeps local varip state across a realtime tail replacement while rolling var back", async () => {
    const compiled = program(`//@version=6
indicator("Local varip")
normal = 0
intrabar = 0
if true
    var int normalState = 0
    varip int intrabarState = 0
    normalState += 1
    intrabarState += 1
    normal := normalState
    intrabar := intrabarState
plot(normal, "normal")
plot(intrabar, "intrabar")`);
    const session = new PineEngine().createSession(compiled, { now: () => 90_000 });
    await session.runBatch([bar(0, 60_000), bar(60_000, 120_000)]);
    const replaced = await session.replaceTail([bar(60_000, 120_000)]);

    expect(replaced.plots.find((plot) => plot.title === "normal")?.points.map((point) => point.value)).toEqual([1, 2]);
    expect(replaced.plots.find((plot) => plot.title === "intrabar")?.points.map((point) => point.value)).toEqual([1, 3]);
  });

  it("keeps global varip state across a realtime tail replacement while rolling var back", async () => {
    const compiled = program(`//@version=6
indicator("Global varip")
var int normal = 0
varip int intrabar = 0
normal += 1
intrabar += 1
plot(normal, "normal")
plot(intrabar, "intrabar")`);
    const session = new PineEngine().createSession(compiled, { now: () => 90_000 });
    const initial = await session.runBatch([bar(0, 60_000), bar(60_000, 120_000)]);
    expect(initial.plots.find((plot) => plot.title === "normal")?.points.map((point) => point.value)).toEqual([1, 2]);
    expect(initial.plots.find((plot) => plot.title === "intrabar")?.points.map((point) => point.value)).toEqual([1, 2]);

    const replaced = await session.replaceTail([bar(60_000, 120_000)]);
    expect(replaced.plots.find((plot) => plot.title === "normal")?.points.map((point) => point.value)).toEqual([1, 2]);
    expect(replaced.plots.find((plot) => plot.title === "intrabar")?.points.map((point) => point.value)).toEqual([1, 3]);
  });

  it("keeps realtime flags and varip counters across tick, close and next open", async () => {
    // A recorded observation showed a realtime confirmed close followed by a new, unconfirmed
    // opening evaluation at the same wall-clock timestamp.
    const compiled = program(`//@version=6
indicator("Realtime flags")
var int ordinary = 0
varip int ticks = 0
if barstate.isnew
    ticks := 0
ordinary += 1
ticks += 1
log.info("{0},{1},{2},{3},{4},{5},{6},{7}", ordinary, ticks, barstate.islast, barstate.ishistory, barstate.isnew, barstate.islastconfirmedhistory, barstate.isconfirmed, barstate.isrealtime)
plot(ticks)`);
    let now = 90_000;
    const session = new PineEngine().createSession(compiled, { now: () => now });
    try {
      await session.runBatch([bar(0, 60_000), bar(60_000, 120_000)]);
      expect(session.logs().events.map(({ message }) => message)).toEqual([
        "1,1,false,true,true,true,true,false",
        "2,1,true,false,true,false,false,true",
      ]);
      await session.replaceTail([bar(60_000, 120_000, 11)]);
      expect(session.logs().events.at(-1)?.message).toBe("2,2,true,false,false,false,false,true");
      await session.replaceTail([bar(60_000, 120_000, 11)], { logCause: "realtime-tick" });
      expect(session.logs().events.at(-1)?.message).toBe("2,3,true,false,false,false,false,true");
      now = 120_001;
      await session.replaceTail([bar(60_000, 120_000, 12)], { logCause: "realtime-tick" });
      expect(session.logs().events.at(-1)).toMatchObject({
        message: "2,4,true,false,false,false,true,true",
        phase: "realtime",
        emittedAtMs: now,
      });
      await session.appendBars([bar(120_000, 180_000, 12)]);
      expect(session.logs().events.at(-1)?.message).toBe("3,1,true,false,true,false,false,true");
      await session.replaceTail([bar(120_000, 180_000, 13)], { logCause: "historical-correction" });
      expect(session.logs().events.at(-1)?.message).toBe("3,1,true,false,true,false,false,true");
    } finally {
      await session.close();
    }
  });

  it("emits once-per-bar-close alerts only after a tail is confirmed", async () => {
    const compiled = program(`//@version=6
indicator("Close alert")
if bar_index == 1
    alert("closed", alert.freq_once_per_bar_close)`);
    const session = new PineEngine().createSession(compiled, { now: () => 90_000, alertMode: "all" });
    const initial = await session.runBatch([bar(0, 60_000), bar(60_000, 120_000)]);
    expect(initial.alerts).toEqual([]);

    const closed = await session.replaceTail([bar(60_000, 90_000)]);
    expect(closed.alerts).toEqual([expect.objectContaining({ message: "closed", frequency: "alert.freq_once_per_bar_close", barIndex: 1 })]);
  });

  it("accepts valid general timeframe multipliers for request contexts", async () => {
    const compiled = program(`//@version=6
indicator("Two days")
value = request.security("TEST:DAILY", "2D", close)
plot(value)`);
    const requests: string[] = [];
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "60",
      marketDataGateway: {
        load: async (request) => {
          requests.push(request.timeframe);
          return { bars: [bar(0, 172_800_000, 100)] };
        },
      },
    }).runBatch([bar(0, 3_600_000)]);

    expect(requests).toEqual(["2D"]);
    expect(result.plots[0]?.points).toHaveLength(1);
  });

  it("resolves strategy currency.NONE to the chart currency in public results", async () => {
    const compiled = program(`//@version=6
strategy(initial_capital=1000, title="Chart account")
accountCurrency = strategy.account_currency
plot(accountCurrency == currency.MYR ? 1 : 0)`);
    expect(compiled.descriptor.strategy?.currency).toBe("NONE");

    const session = new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "MYR" },
    });
    const result = await session.runBatch([bar(0, 60_000)]);
    const reset = await session.runBatch([bar(60_000, 120_000)]);

    expect(result.returned.accountCurrency).toEqual(["MYR"]);
    expect(result.strategy?.config.currency).toBe("MYR");
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([1]);
    expect(reset.returned.accountCurrency).toEqual(["MYR"]);
    expect(reset.strategy?.config.currency).toBe("MYR");
  });

  it("allows an unknown chart currency for a flat NONE strategy while pure conversion returns na", async () => {
    const compiled = program(`//@version=6
strategy("Missing chart currency")
converted = strategy.convert_to_account(5)`);

    const session = new PineEngine().createSession(compiled);
    try { expect((await session.runBatch([bar(0, 60_000)])).returned.converted).toEqual([Number.NaN]); }
    finally { await session.close(); }
  });
});
