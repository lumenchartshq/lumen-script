import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";
import type { PineCompatibility } from "../contracts/index.js";

const strict = (body: string, version: 5 | 6 = 6) => compile({
  compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\n${body}`,
});

describe("S5B strict strategy declaration contract", () => {
  it("selects margin defaults by Pine version while preserving explicit values and sealed behavior", () => {
    const descriptor = (version: 5 | 6, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict, options = "") => {
      const result = compile({ compatibility, source: `//@version=${String(version)}\nstrategy("Margins"${options})` });
      expect(result.diagnostics).toEqual([]);
      return result.program!.descriptor.strategy!;
    };
    expect(descriptor(5)).toMatchObject({ margin_long: 0, margin_short: 0 });
    expect(descriptor(6)).toMatchObject({ margin_long: 100, margin_short: 100 });
    expect(descriptor(5, PINE_COMPATIBILITY.strict, ", margin_long=25, margin_short=50"))
      .toMatchObject({ margin_long: 25, margin_short: 50 });
    expect(descriptor(5, PINE_COMPATIBILITY.legacy)).toMatchObject({ margin_long: 100, margin_short: 100 });
  });
  it("binds all 32 positional options in the admitted order", () => {
    const values = [
      '"Positional"', '"Short"', "true", "format.percent", "0", "scale.none", "2",
      "false", "false", "5000", "2", "strategy.cash", "500", "1000", "currency.NONE",
      "2", "strategy.commission.cash_per_contract", "0.25", "true", '"ANY"', "0", "25",
      "true", "2", "2", "2", "-1", "true", "false", "2", "false", "false",
    ];
    expect(values).toHaveLength(32);
    const compiled = strict(`strategy(${values.join(", ")})\nplot(close)`);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.descriptor).toMatchObject({
      kind: "strategy", title: "Positional", shortTitle: "Short", overlay: true,
      format: "percent", precision: 0, scale: "none", scaleExplicit: true,
      maxBarsBack: 5000, explicitPlotZOrder: true, behindChart: false,
      dynamicRequests: false, drawingLimits: { lines: 2, labels: 2, boxes: 2, polylines: 2 },
      strategy: {
        pyramiding: 2, calc_on_order_fills: false, calc_on_every_tick: false,
        backtest_fill_limits_assumption: 2, default_qty_type: "cash", default_qty_value: 500,
        initial_capital: 1000, currency: "NONE", slippage: 2,
        commission_type: "cash_per_contract", commission_value: 0.25,
        process_orders_on_close: true, close_entries_rule: "ANY",
        margin_long: 0, margin_short: 25, risk_free_rate: -1,
        use_bar_magnifier: true, fill_orders_on_standard_ohlc: false,
      },
    });
  });

  it("resolves v5/v6 named constant aliases and keeps the literal fill-recalculation gate", () => {
    for (const version of [5, 6] as const) {
      const compiled = strict(`const int bars = 3\nconst float capital = 1000\nconst bool front = false
strategy("Aliases", max_bars_back=bars, initial_capital=capital, behind_chart=front, calc_on_order_fills=false)
plot(close)`, version);
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.descriptor).toMatchObject({
        maxBarsBack: 3, behindChart: false, dynamicRequests: version === 6,
        strategy: { initial_capital: 1000, calc_on_order_fills: false },
      });
    }
    const alias = strict('const bool off = false\nstrategy("Alias", calc_on_order_fills=off)');
    expect(alias.program).toBeUndefined();
    expect(alias.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2019" }));
  });

  it("preserves admitted numeric boundaries and normalizes pyramiding zero to one open slot", () => {
    const limits = strict('strategy("Boundaries", precision=16, max_bars_back=0, pyramiding=0, initial_capital=0, max_lines_count=500, max_labels_count=500, max_boxes_count=500, max_polylines_count=100)');
    expect(limits.diagnostics).toEqual([]);
    expect(limits.descriptor).toMatchObject({
      precision: 16, maxBarsBack: 0,
      drawingLimits: { lines: 500, labels: 500, boxes: 500, polylines: 100 },
      strategy: { pyramiding: 1, initial_capital: 0 },
    });
    const maximum = strict('strategy("Maximum", precision=0, max_bars_back=5000, pyramiding=1000)');
    expect(maximum.diagnostics).toEqual([]);
    expect(maximum.descriptor).toMatchObject({
      precision: 0, maxBarsBack: 5000, strategy: { pyramiding: 1000 },
    });
  });

  it.each([
    ["format", '"not-a-format"'], ["scale", '"center"'],
    ["default_qty_type", '"unknown"'], ["commission_type", '"unknown"'],
    ["close_entries_rule", '"LIFO"'],
    ["overlay", "close > open"], ["behind_chart", "input.bool(false)"],
    ["precision", "17"], ["precision", "-1"], ["pyramiding", "1001"],
    ["max_bars_back", "5001"], ["max_lines_count", "0"],
    ["max_labels_count", "501"], ["max_boxes_count", "0"],
    ["max_polylines_count", "101"], ["slippage", "-1"],
    ["backtest_fill_limits_assumption", "1000001"],
    ["initial_capital", "-1"], ["default_qty_value", "-1"],
    ["commission_value", "-1"], ["margin_long", "-1"], ["margin_short", "-1"],
    ["risk_free_rate", "close"],
  ] as const)("rejects invalid %s=%s before producing a program", (name, value) => {
    const result = strict(`strategy("Bad", ${name}=${value})`);
    expect(result.program).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(name))).toBe(true);
  });

  it.each([
    ["calc_on_order_fills", "true", "SCRIPT2019"],
    ["calc_on_every_tick", "true", "SCRIPT2020"],
    ["fill_orders_on_standard_ohlc", "true", "SCRIPT2020"],
  ] as const)("retains the ordinary %s execution gate", (name, value, code) => {
    const result = strict(`strategy("Gate", ${name}=${value})`);
    expect(result.program).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  it("rejects unknown, duplicate, nested, multiple and value declarations", () => {
    for (const body of [
      'strategy("Unknown", calc_bars_count=5)',
      'strategy("Duplicate", precision=2, precision=3)',
      'if close > open\n    strategy("Nested")',
      'strategy("First")\nstrategy("Second")',
      'value = strategy("As value")',
    ]) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error"), body).toBe(true);
    }
  });

  it("preserves sealed compatibility admission for previously accepted flags", () => {
    const source = '//@version=6\nstrategy("Sealed", calc_on_every_tick=true, fill_orders_on_standard_ohlc=true)\nplot(close)';
    const result = compile({ source, compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.strategy).toMatchObject({ calc_on_every_tick: true, fill_orders_on_standard_ohlc: true });
  });
});
