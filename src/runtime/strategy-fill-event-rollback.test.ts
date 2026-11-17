import { compile } from "../compiler/index.js";
import { describe, expect, it } from "vitest";
import { createExecutor, createRuntime } from "./index.js";
import { prepareSyntheticHistoricalFillRecalculation } from "./strategy-fill-event-rollback.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const program = compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: '//@version=6\nstrategy("Event rollback")\nplot(close)',
}).program!;

function snapshots() {
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD" } });
  const baseline = runtime.snapshot();
  const current = { ...runtime.snapshot(), barIndex: 0 };
  return { baseline, current };
}

describe("Z10 internal historical post-fill rollback", () => {
  it("reruns a real compiled script from ordinary previous-bar state while varip advances", () => {
    const compiled = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: '//@version=6\nstrategy("Rollback fixture")\nvar ordinary = 0\nordinary += 1\nvarip intrabar = 0\nintrabar += 1\nplot(ordinary, "ordinary")\nplot(intrabar, "intrabar")',
    });
    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    const runtime = createRuntime(compiled.program!, { symbolInfo: { currency: "USD" }, alertMode: "all" });
    const execute = createExecutor(compiled.program!);
    const bars = [
      { openTime: 1, closeTime: 2, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { openTime: 3, closeTime: 4, open: 101, high: 101, low: 101, close: 101, volume: 1 },
    ];
    runtime.reset(bars);
    runtime.beginBar(0);
    execute(runtime);
    runtime.endBar();
    const baseline = runtime.snapshot();
    runtime.beginBar(1);
    execute(runtime);
    runtime.alert("once", "first", "alert.freq_once_per_bar");
    runtime.alert("all", "first", "alert.freq_all");
    const current = runtime.snapshot();
    current.strategy!.positionSize = 1;

    runtime.restore(prepareSyntheticHistoricalFillRecalculation(baseline, current), bars);
    execute(runtime);
    runtime.alert("once", "second", "alert.freq_once_per_bar");
    runtime.alert("all", "second", "alert.freq_all");
    const rerun = runtime.snapshot();
    expect([...rerun.plots.values()].map((plot) => plot.points[1]?.value)).toEqual([2, 3]);
    expect(rerun.strategy?.positionSize).toBe(1);
    expect(rerun.strategy?.timeline).toHaveLength(1);
    expect(rerun.alerts.map((event) => [event.id, event.message])).toEqual([
      ["once", "first"], ["all", "first"], ["all", "second"],
    ]);
  });

  it("retains fills, varip, alerts and operation cost while discarding current-bar visuals and ordinary state", () => {
    const initial = snapshots();
    const baseline = { ...initial.baseline, barIndex: 0, globalPersistence: ["var", "varip"] as const };
    const current = { ...initial.current, barIndex: 1, globalPersistence: ["var", "varip"] as const };
    baseline.strategy!.timeline.push({} as never);
    current.strategy!.timeline.push({} as never);
    baseline.variables.push([3], [5]);
    current.variables.push([3, 99], [5, 8]);
    current.variableHistory.push({ origin: 0, last: 1, indices: [0, 1], values: [3, 99] });
    baseline.variableHistory.push({ origin: 0, last: 0, indices: [0], values: [3] });
    baseline.variableHistory.push({ origin: 0, last: 0, indices: [0], values: [5] });
    current.variableHistory.push({ origin: 0, last: 1, indices: [0, 1], values: [5, 8] });
    current.localState.set("ordinary", { values: { origin: 1, last: 1, indices: [0, 1], values: [0, 50] }, initialized: true, persistence: "var", persistentValue: 50 });
    current.localState.set("intrabar", { values: { origin: 1, last: 1, indices: [0, 1], values: [0, 7] }, initialized: true, persistence: "varip", persistentValue: 7 });
    current.plots.set("line", { id: "line", title: "Line", points: [{ time: 1, value: 99 }], options: {} });
    current.alerts.push({ type: "alert", id: "a", message: "filled", barIndex: 1, time: 1 });
    current.firedAlerts.add("a:1");
    current.strategy!.positionSize = 1;
    const postFill = { ...current, operations: 17 };

    const prepared = prepareSyntheticHistoricalFillRecalculation(baseline, postFill);
    expect(prepared.barIndex).toBe(1);
    expect(prepared.variables).toEqual([[3], [5, 8]]);
    expect(prepared.variableHistory[0]?.last).toBe(0);
    expect(prepared.variableHistory[1]?.last).toBe(1);
    expect([...prepared.localState.keys()]).toEqual(["intrabar"]);
    expect(prepared.plots.size).toBe(0);
    expect(prepared.alerts).toEqual(postFill.alerts);
    expect(prepared.firedAlerts).toEqual(postFill.firedAlerts);
    expect(prepared.strategy?.positionSize).toBe(1);
    expect(prepared.operations).toBe(17);
    prepared.strategy!.positionSize = 4;
    prepared.variables[1]![1] = 10;
    prepared.localState.get("intrabar")!.persistentValue = 10;
    expect(current.strategy?.positionSize).toBe(1);
    expect(current.variables[1]?.[1]).toBe(8);
    expect(current.localState.get("intrabar")?.persistentValue).toBe(7);
  });

  it("rejects mismatched bars, finalized timelines and request values before modifying inputs", () => {
    const { baseline, current } = snapshots();
    const before = structuredClone(current);
    expect(prepareSyntheticHistoricalFillRecalculation(baseline, current).barIndex).toBe(0);
    expect(() => prepareSyntheticHistoricalFillRecalculation(baseline, { ...current, barIndex: 2 })).toThrow("adjacent");
    expect(() => prepareSyntheticHistoricalFillRecalculation({ ...baseline, barIndex: 0 }, { ...current, barIndex: 1 })).toThrow("completed previous bar");
    expect(() => prepareSyntheticHistoricalFillRecalculation(baseline, { ...current, requestSeries: { child: [1] } })).toThrow("request");
    expect(() => prepareSyntheticHistoricalFillRecalculation(baseline, { ...current, strategy: { ...current.strategy!, timeline: [{} as never] } })).toThrow("finalized");
    expect(current).toEqual(before);
  });
});
