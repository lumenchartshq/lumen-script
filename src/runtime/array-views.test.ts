import type { PineValue } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { arrayCall } from "./collections.js";
import { refreshPineArrayValue } from "./array-views.js";
import { deserializeRuntimeGraph, serializeRuntimeGraph } from "./runtime-value-graph.js";

const options = { strict: true, negativeIndices: true };
const cases: readonly [string, readonly PineValue[], readonly number[]][] = [
  ["set", [0, 9], [0, 1, 9, 3, 4]],
  ["push", [9], [0, 1, 2, 3, 9, 4]],
  ["pop", [], [0, 1, 2, 4]],
  ["unshift", [9], [0, 1, 9, 2, 3, 4]],
  ["shift", [], [0, 1, 3, 4]],
  ["clear", [], [0, 1, 4]],
  ["concat", [[9, 8]], [0, 1, 2, 3, 9, 8, 4]],
  ["reverse", [], [0, 1, 3, 2, 4]],
  ["insert", [1, 9], [0, 1, 2, 9, 3, 4]],
  ["remove", [0], [0, 1, 3, 4]],
  ["fill", [9], [0, 1, 9, 9, 4]],
  ["sort", ["descending"], [0, 1, 3, 2, 4]],
];

describe("linked array view owner", () => {
  it.each(cases)("propagates nested %s through every parent", (operation, args, expected) => {
    const root = [0, 1, 2, 3, 4];
    const outer = arrayCall("slice", [root, 1, 4], options);
    const inner = arrayCall("slice", [outer, 1, 3], options);
    arrayCall(operation, [inner, ...args], options);
    expect(root).toEqual(expected);
    expect(refreshPineArrayValue(outer)).toBe(outer);
    expect(outer).toEqual(expected.slice(1, -1));
  });
  it("refreshes parent writes before generic runtime reads while copies stay independent", () => {
    const root = [1, 2, 3];
    const view = arrayCall("slice", [root, 1, 3], options);
    const copy = arrayCall("copy", [view], options);
    arrayCall("set", [root, 1, 8], options);
    expect(refreshPineArrayValue(view)).toBe(view);
    expect(view).toEqual([8, 3]);
    expect(copy).toEqual([2, 3]);
  });
  it("preserves nested parent graphs and shared aliases through portable transport", () => {
    const root = [0, 1, 2, 3, 4];
    const outer = arrayCall("slice", [root, 1, 4], options);
    const inner = arrayCall("slice", [outer, 1, 3], options);
    const snapshot = { root, outer, inner, alias: inner };
    const restored = deserializeRuntimeGraph(serializeRuntimeGraph(snapshot)) as typeof snapshot;
    expect(restored.inner).toBe(restored.alias);
    arrayCall("push", [restored.inner, 9], options);
    expect(restored.root).toEqual([0, 1, 2, 3, 9, 4]);
    expect(refreshPineArrayValue(restored.outer)).toEqual([1, 2, 3, 9]);
    expect(root).toEqual([0, 1, 2, 3, 4]);
  });
  it("keeps lazy parent-range errors across snapshot transport", () => {
    const root = [0, 1, 2, 3];
    const view = arrayCall("slice", [root, 1, 4], options);
    arrayCall("pop", [root], options);
    const restored = deserializeRuntimeGraph(serializeRuntimeGraph({ root, view })) as { view: PineValue };
    expect(() => refreshPineArrayValue(restored.view)).toThrow("Slice is out of bounds");
  });
});
