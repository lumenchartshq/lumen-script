import { describe, expect, it } from "vitest";
import { compile } from "../compiler/index.js";
import { DrawingRuntime, isPineLine, isPineLinefill, isPinePolyline } from "./drawings.js";
import { PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";

function drawings(compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  const result = compile({ compatibility, source: '//@version=6\nindicator("D5")' });
  expect(result.diagnostics).toEqual([]);
  return new DrawingRuntime(result.program!, () => ({ time: 1000, index: 0 }));
}

describe("linefill/polyline runtime admission", () => {
  it("rejects foreign and expired line identities without changing the active pair", () => {
    const owner = drawings();
    const foreign = drawings();
    const first = owner.lineCall("new", [0, 20, 2, 22]);
    const second = owner.lineCall("new", [0, 10, 2, 8]);
    const outsider = foreign.lineCall("new", [0, 30, 2, 32]);
    expect(isPineLine(first) && isPineLine(second) && isPineLine(outsider)).toBe(true);
    if (!isPineLine(first) || !isPineLine(second)) throw new Error("Expected line handles");
    expect(owner.linefillCall("new", [first, outsider, "#111111"])).toBeNaN();
    expect(owner.linefills).toHaveLength(0);
    const fill = owner.linefillCall("new", [first, second, "#222222"]);
    expect(isPineLinefill(fill)).toBe(true);
    expect(owner.linefillCall("new", [structuredClone(first), structuredClone(second), "#aaaaaa"])).toBeNaN();
    expect(owner.linefillCall("new", [first, outsider, "#aaaaaa"])).toBeNaN();
    expect(owner.linefills).toHaveLength(1);
    expect(owner.linefills[0]?.color).toBe("#222222");
    expect(owner.linefillCall("get_line1", [fill])).toBe(first);
    expect(owner.linefillCall("get_line2", [fill])).toBe(second);
    expect(() => owner.linefillCall("new", [first, second, true])).toThrow();
    expect(() => owner.linefillCall("set_color", [fill, true])).toThrow();
    expect(owner.linefills).toHaveLength(1);
    expect(owner.linefills[0]?.color).toBe("#222222");
    owner.lineCall("delete", [first]);
    expect(owner.linefillCall("get_line1", [fill])).toBeNaN();
    owner.linefillCall("set_color", [fill, "#ffffff"]);
    expect(owner.linefills[0]?.color).toBe("#222222");
    expect(owner.linefillCall("new", [first, second, "#aaaaaa"])).toBeNaN();
    expect(owner.linefills).toHaveLength(1);
  });

  it("validates polyline structure and selected anchors before mutating IDs", () => {
    const owner = drawings();
    const valid = { __pineChartPoint: true, time: 1000, index: 0, price: 20 } as const;
    const another = { __pineChartPoint: true, time: 2000, index: 1, price: 18 } as const;
    for (const args of [
      [[valid, 5]], [[valid, another], false, false, "wrong"],
      [[valid, another], false, false, "bt", "#000", Number.NaN, "style_arrow_right"],
      [[valid, another], false, false, "bt", "#000", Number.NaN, "style_solid", 0],
      [[valid, another], false, false, "bt", true],
      [[valid, another], 1, false, "bt"],
      [[{ ...valid, time: null }, another], false, false, "bt"],
      [[{ ...valid, price: Number.NaN }, another]],
    ] as const) {
      expect(() => owner.polylineCall("new", args)).toThrow();
      expect(owner.polylines).toHaveLength(0);
      expect(owner.nextPolylineId).toBe(0);
    }
    const path = owner.polylineCall("new", [[valid, another], true, false, "bt"]);
    expect(isPinePolyline(path)).toBe(true);
    expect(owner.polylines).toHaveLength(1);
    const outsider = drawings().polylineCall("new", [[valid, another]]);
    owner.polylineCall("delete", [outsider]);
    expect(owner.polylines[0]?.deleted).toBe(false);
    owner.polylineCall("delete", [path]);
    expect(owner.polylines[0]?.deleted).toBe(true);
  });

  it("leaves the sealed same-pair identity and permissive point handling intact", () => {
    const owner = drawings(PINE_COMPATIBILITY.legacy);
    const first = owner.lineCall("new", [0, 20, 2, 22]);
    const second = owner.lineCall("new", [0, 10, 2, 8]);
    if (!isPineLine(first) || !isPineLine(second)) throw new Error("Expected line handles");
    const original = owner.linefillCall("new", [first, second, "#111111"]);
    expect(owner.linefillCall("new", [first, second, "#222222"])).toBe(original);
    expect(owner.linefills[0]?.color).toBe("#222222");
    expect(owner.linefillCall("new", [structuredClone(first), structuredClone(second), "#334455"])).toBe(original);
    expect(owner.linefillCall("new", [structuredClone(second), structuredClone(first), "#445566"])).toBe(original);
    expect(owner.linefills).toHaveLength(1);
    expect(owner.linefills[0]?.color).toBe("#445566");
    expect(owner.polylineCall("new", [[42, null]])).toMatchObject({ points: [] });
  });
});
