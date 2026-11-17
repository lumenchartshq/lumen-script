import type { MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1_000, open: 2, high: 4, low: 1, close: 3, volume: 10 },
  { openTime: 61_000, open: 4, high: 5, low: 2, close: 3, volume: 10 },
  { openTime: 121_000, open: 1, high: 3, low: 1, close: 2, volume: 10 },
];

const compileStrict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\n${body}` });

describe("B1 declaration and effect admission", () => {
  it("resolves constant declaration and alert metadata instead of defaulting it", () => {
    const indicator = compileStrict(`const string title = "Fold"
const bool isOverlay = true
const int history = 2
indicator(title + "ed", overlay=isOverlay, precision=1 + 2, max_bars_back=history)
alertcondition(close > open, title + " up", "constant " + "message")
plot(close)`);
    expect(indicator.diagnostics).toEqual([]);
    expect(indicator.descriptor).toMatchObject({
      title: "Folded", overlay: true, precision: 3, maxBarsBack: 2,
      alerts: [{ id: "alertcondition_0", title: "Fold up", message: "constant message" }],
    });
    const strategy = compileStrict('const float starting = 1000\nstrategy("Folded strategy", initial_capital=starting, default_qty_value=2 + 1)\nplot(close)');
    expect(strategy.diagnostics).toEqual([]);
    expect(strategy.descriptor?.strategy).toMatchObject({ initial_capital: 1000, default_qty_value: 3 });
    const targeted = compileStrict('indicator("Constant target")\nconst int depth = 3\nmax_bars_back(close, depth)\nplot(close[depth])');
    expect(targeted.diagnostics).toEqual([]);
    expect(targeted.program?.generatedSource).toContain('r.historyOffset(');
  });

  it("preserves omitted and literal-false strategy flags and the sealed profile", () => {
    for (const suffix of ["", ", calc_on_every_tick=false, fill_orders_on_standard_ohlc=false"]) {
      const result = compileStrict(`strategy("Supported"${suffix})\nplot(close)`);
      expect(result.diagnostics).toEqual([]);
      expect(result.descriptor?.strategy).toMatchObject({ calc_on_every_tick: false, fill_orders_on_standard_ohlc: false });
    }
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: '//@version=6\nstrategy("Sealed", calc_on_every_tick=true, fill_orders_on_standard_ohlc=true)\nplot(close)' });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.descriptor?.strategy).toMatchObject({ calc_on_every_tick: true, fill_orders_on_standard_ohlc: true });
  });

  it.each([
    ['indicator("Wrong", overlay=close > open)', "SCRIPT2018", "overlay"],
    ['indicator("Wrong", scale="diagonal")', "SCRIPT2018", "scale"],
    ['indicator("Wrong", max_lines_count=0)', "SCRIPT2018", "max_lines_count"],
    ['indicator("Wrong", precision=-1)', "SCRIPT2018", "precision"],
    ['indicator("Wrong", behind_chart=input.bool(false))', "SCRIPT2018", "behind_chart"],
    ['strategy("Wrong", default_qty_type="unknown")', "SCRIPT2018", "default_qty_type"],
    ['strategy("Wrong", commission_type="unknown")', "SCRIPT2018", "commission_type"],
    ['strategy("Wrong", pyramiding=-1)', "SCRIPT2018", "pyramiding"],
    ['strategy("Wrong", calc_on_every_tick=true)', "SCRIPT2020", "calc_on_every_tick"],
    ['strategy("Wrong", fill_orders_on_standard_ohlc=true)', "SCRIPT2020", "fill_orders_on_standard_ohlc"],
    ['strategy("Wrong", calc_on_order_fills=true)', "SCRIPT2019", "calc_on_order_fills"],
    ['indicator("Wrong")\nalert(1)', "SCRIPT2117", "message"],
    ['indicator("Wrong")\nalertcondition(close > open, close > open)', "SCRIPT2117", "title"],
    ['indicator("Wrong")\nruntime.error(1)', "SCRIPT2117", "message"],
    ['indicator("Wrong")\nmax_bars_back(close, 0)', "SCRIPT2018", "size"],
  ] as const)("rejects %s without silently applying defaults", (source, code, detail) => {
    const result = compileStrict(source);
    expect(result.program).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.message.includes(detail))).toBe(true);
  });

  it("emits literal alert events by call site, condition and frequency through replay", async () => {
    const result = compileStrict(`indicator("B1 alerts")
for i = 0 to 1
    alert("every", alert.freq_all)
    alert("once")
alertcondition(close > open, "Up", "Close above open")`);
    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.alerts).toEqual([{ id: "alertcondition_0", title: "Up", message: "Close above open" }]);
    const engine = new PineEngine();
    const fresh = engine.createSession(result.program!, { alertMode: "all" });
    const replay = engine.createSession(result.program!, { alertMode: "all" });
    try {
      const expected = await fresh.runBatch(bars);
      expect(expected.alerts.filter((event) => event.message === "every")).toHaveLength(6);
      expect(expected.alerts.filter((event) => event.message === "once")).toHaveLength(3);
      expect(expected.alerts.filter((event) => event.type === "alertcondition")).toEqual([
        expect.objectContaining({ id: "alertcondition_0", title: "Up", message: "Close above open", barIndex: 0, time: 1_000 }),
        expect.objectContaining({ id: "alertcondition_0", title: "Up", message: "Close above open", barIndex: 2, time: 121_000 }),
      ]);
      await replay.runBatch(bars.slice(0, 2));
      expect((await replay.appendBars(bars.slice(2))).alerts).toEqual(expected.alerts);
      const checkpoint = replay.checkpoint();
      const revised = { ...bars[2]!, close: 0 };
      expect((await replay.replaceTail([revised])).alerts.filter((event) => event.type === "alertcondition")).toHaveLength(1);
      expect((await replay.replaceTail([revised])).alerts).toEqual((await engine.createSession(result.program!, { alertMode: "all" }).runBatch([...bars.slice(0, 2), revised])).alerts);
      expect((await replay.restore(checkpoint)).alerts).toEqual(expected.alerts);
    } finally {
      await fresh.close();
      await replay.close();
    }
  });

  it("throws a typed error for an invalid dynamic alert frequency", async () => {
    const result = compileStrict('indicator("B1 invalid frequency")\nalert("message", input.string("invalid"))');
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!, { alertMode: "all" });
    try {
      await expect(session.runBatch(bars)).rejects.toMatchObject({
        name: "PineRuntimeError", code: "SCRIPT_RUNTIME_ERROR", method: "alert",
      });
    } finally { await session.close(); }
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: '//@version=6\nindicator("Sealed frequency")\nalert("message", "invalid")' });
    expect(sealed.diagnostics).toEqual([]);
    const frozenSession = new PineEngine().createSession(sealed.program!, { alertMode: "all" });
    try {
      const frozen = await frozenSession.runBatch(bars);
      expect(frozen.alerts).toHaveLength(bars.length);
      expect(frozen.alerts.every((event) => event.frequency === "alert.freq_once_per_bar")).toBe(true);
    } finally { await frozenSession.close(); }
  });

  it("stops on runtime.error and requires recovery before another append", async () => {
    const result = compileStrict('indicator("B1 error")\nif close < open\n    runtime.error("down bar")\nvalue = close');
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!);
    try {
      await session.runBatch(bars.slice(0, 1));
      const checkpoint = session.checkpoint();
      await expect(session.appendBars(bars.slice(1, 2))).rejects.toMatchObject({
        name: "PineRuntimeError", code: "SCRIPT_RUNTIME_ERROR", method: "runtime.error", message: "down bar",
      });
      await expect(session.appendBars(bars.slice(2))).rejects.toThrow("failed evaluation");
      await session.restore(checkpoint);
      expect((await session.appendBars([bars[2]!])).returned.value).toEqual([3, 2]);
    } finally { await session.close(); }
  });
});
