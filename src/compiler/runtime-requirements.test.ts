import { PINE_CHART_FIELD_REQUIREMENTS, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { RuntimeRequirementCollector, mergeRuntimeRequirements } from "./runtime-requirements.js";

describe("runtime dependency ownership", () => {
  it.each(Object.entries(PINE_CHART_FIELD_REQUIREMENTS))("records supported field %s structurally", (field, requirement) => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Dependency")\nvalue = ${field}` });
    expect(result.diagnostics).toEqual([]);
    expect(result.program!.runtimeRequirements).toEqual({
      usesDatasetTail: false,
      usesExecutionClock: false,
      usesChartType: requirement === "type",
      usesVisibleRange: requirement === "visibleRange",
    });
  });
  it("unions child dependencies without changing previously published snapshots", () => {
    const collector = new RuntimeRequirementCollector(PINE_COMPATIBILITY.strict);
    collector.record("last_bar_time");
    const first = collector.snapshot();
    collector.record("timenow");
    collector.record("chart.is_heikinashi");
    collector.record("chart.right_visible_bar_time");
    expect(first.usesExecutionClock).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(mergeRuntimeRequirements(PINE_COMPATIBILITY.strict, [first, collector.snapshot()])).toEqual({
      usesDatasetTail: true, usesExecutionClock: true, usesChartType: true, usesVisibleRange: true,
    });
    expect(mergeRuntimeRequirements(PINE_COMPATIBILITY.legacy, [collector.snapshot()])).toEqual({
      usesDatasetTail: false, usesExecutionClock: false, usesChartType: false, usesVisibleRange: false,
    });
  });
  it("does not count string contents or shadowed locals as dependencies", () => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("chart.is_heikinashi")\ntimenow = 1\nlast_bar_time = 2\nvalue = timenow + last_bar_time` });
    expect(result.diagnostics).toEqual([]);
    expect(Object.values(result.program!.runtimeRequirements)).toEqual([false, false, false, false]);
  });
});
