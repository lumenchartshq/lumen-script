import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

describe("strategy order-fill recalculation admission", () => {
  for (const version of [5, 6]) {
    for (const option of ["", ", calc_on_order_fills=false"]) {
      it(`accepts ordinary v${version} execution ${option}`, () => {
        const result = compile({ source: `//@version=${version}\nstrategy("Ordinary"${option})\nplot(close)`, compatibility: PINE_COMPATIBILITY.strict });
        expect(result.diagnostics).toEqual([]);
        expect(result.program?.descriptor.strategy?.calc_on_order_fills).toBe(false);
      });
    }
    for (const expression of ["true", "false or true", "not true", "input.bool(false)"]) {
      it(`rejects unsupported or unresolved v${version} option ${expression}`, () => {
        const result = compile({ source: `//@version=${version}\nstrategy("Unsupported", calc_on_order_fills=${expression})\nplot(close)`, compatibility: PINE_COMPATIBILITY.strict });
        expect(result.program).toBeUndefined();
        expect(result.diagnostics.find((item) => item.code === "SCRIPT2019")?.range?.start.line).toBe(2);
      });
    }
  }

  it("checks positional options without rejecting literal false", () => {
    for (const enabled of [true, false]) {
      const result = compile({ source: `//@version=6\nstrategy("Positional", "", true, format.price, 2, scale.right, 0, ${enabled})\nplot(close)`, compatibility: PINE_COMPATIBILITY.strict });
      expect(result.diagnostics.some((item) => item.code === "SCRIPT2019")).toBe(enabled);
      expect(result.program !== undefined).toBe(!enabled);
    }
  });

  it("does not infer literal false from an unresolved alias", () => {
    const result = compile({ source: '//@version=6\nconst bool enabled = false\nstrategy("Alias", calc_on_order_fills=enabled)\nplot(close)', compatibility: PINE_COMPATIBILITY.strict });
    expect(result.program).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "SCRIPT2019")).toBe(true);
  });

  it("preserves the frozen compatibility lane", () => {
    const result = compile({ source: '//@version=6\nstrategy("Frozen", calc_on_order_fills=true)\nplot(close)', compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.strategy?.calc_on_order_fills).toBe(true);
  });

  it("admits only the explicit bounded Lumen Charts historical fill schedule", () => {
    const accepted = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      historicalFillSchedule: "lumencharts-v1",
      source: '//@version=6\nstrategy("Lumen Charts", calc_on_order_fills=true)\nplot(close)',
    });
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.program?.historicalFillSchedule).toBe("lumencharts-v1");
    expect(accepted.program?.descriptor.strategy?.calc_on_order_fills).toBe(true);

    for (const declaration of [
      'strategy("Missing")',
      'strategy("Alias", calc_on_order_fills=not false)',
      'strategy("Tick", calc_on_order_fills=true, calc_on_every_tick=true)',
      'strategy("Close", calc_on_order_fills=true, process_orders_on_close=true)',
      'strategy("Magnifier", calc_on_order_fills=true, use_bar_magnifier=true)',
      'strategy("Margin", calc_on_order_fills=true, margin_long=50)',
      'strategy("Limit assumption", calc_on_order_fills=true, backtest_fill_limits_assumption=1)',
    ]) {
      const rejected = compile({ compatibility: PINE_COMPATIBILITY.strict, historicalFillSchedule: "lumencharts-v1",
        source: `//@version=6\n${declaration}\nplot(close)` });
      expect(rejected.program, declaration).toBeUndefined();
      expect(rejected.diagnostics.some((item) => item.code === "SCRIPT2019" || item.code === "SCRIPT2020"), declaration)
        .toBe(true);
    }
    const request = compile({ compatibility: PINE_COMPATIBILITY.strict, historicalFillSchedule: "lumencharts-v1",
      source: '//@version=6\nstrategy("Request", calc_on_order_fills=true)\nplot(request.security("", "D", close))' });
    expect(request.program).toBeUndefined();
    expect(request.diagnostics.some((item) => item.code === "SCRIPT2020")).toBe(true);

    for (const [declaration, option] of [
      ['const bool on = true\nstrategy("Tick alias", calc_on_order_fills=true, calc_on_every_tick=on)', "calc_on_every_tick"],
      ['const bool on = true\nstrategy("Close alias", calc_on_order_fills=true, process_orders_on_close=on)', "process_orders_on_close"],
      ['const bool on = true\nstrategy("Magnifier alias", calc_on_order_fills=true, use_bar_magnifier=on)', "use_bar_magnifier"],
      ['const float margin = 100\nstrategy("Margin alias", calc_on_order_fills=true, margin_long=margin)', "margin_long"],
      ['const int ticks = 0\nstrategy("Limit alias", calc_on_order_fills=true, backtest_fill_limits_assumption=ticks)', "backtest_fill_limits_assumption"],
      ['const int slots = 2\nstrategy("Pyramiding alias", calc_on_order_fills=true, pyramiding=slots)', "pyramiding"],
    ] as const) {
      const rejected = compile({ compatibility: PINE_COMPATIBILITY.strict, historicalFillSchedule: "lumencharts-v1",
        source: `//@version=6\n${declaration}\nplot(close)` });
      expect(rejected.program, option).toBeUndefined();
      expect(rejected.diagnostics.some((item) => item.code === "SCRIPT2020" && item.message.includes(option)), option)
        .toBe(true);
    }
  });
});
