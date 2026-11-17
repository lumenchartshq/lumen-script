import { describe, expect, it } from "vitest";
import { compile } from "../compiler/index.js";
import { DrawingRuntime, drawingCast } from "./drawings.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";

function owner(compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  const compiled = compile({ compatibility, source: '//@version=6\nindicator("D7")' });
  expect(compiled.diagnostics).toEqual([]);
  return new DrawingRuntime(compiled.program!, () => ({ time: 1_700_000_000_000, index: 0 }));
}

describe("D7 drawing cast identity", () => {
  it("preserves each owned alias, including deletion, without cloning or resurrection", () => {
    const drawings = owner();
    const line1 = drawings.lineCall("new", [0, 10, 1, 11]);
    const line2 = drawings.lineCall("new", [0, 8, 1, 9]);
    const cases = [
      ["line", line1, drawings.lines],
      ["box", drawings.boxCall("new", [0, 11, 1, 8]), drawings.boxes],
      ["label", drawings.labelCall("new", [0, 10, "label"]), drawings.labels],
      ["linefill", drawings.linefillCall("new", [line1, line2, "#112233"]), drawings.linefills],
      ["table", drawings.tableCall("new", ["top_right", 1, 1]), drawings.tables],
    ] as const;
    for (const [name, value, inventory] of cases) {
      const alias = drawingCast(name, value, drawings, true);
      expect(alias).toBe(value);
      expect(inventory).toHaveLength(name === "line" ? 2 : 1);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected drawing");
      const drawing = value as { deleted: boolean };
      drawing.deleted = true;
      expect(drawingCast(name, value, drawings, true)).toBe(value);
      expect(drawing.deleted).toBe(true);
    }
  });

  it("admits typed missing values and rejects wrong, cloned and foreign references", () => {
    const drawings = owner();
    const foreign = owner();
    const line = drawings.lineCall("new", [0, 10, 1, 11]);
    expect(drawingCast("line", Number.NaN, drawings, true)).toBeNull();
    expect(drawingCast("line", null, drawings, true)).toBeNull();
    for (const value of [42, true, "wrong", structuredClone(line), foreign.lineCall("new", [0, 10, 1, 11])]) {
      expect(() => drawingCast("line", value, drawings, true)).toThrow(PineRuntimeError);
    }
    expect(() => drawingCast("box", line, drawings, true)).toThrow(PineRuntimeError);
    expect(drawings.lines).toHaveLength(1);
  });

  it("retains sealed permissive null behavior", () => {
    expect(drawingCast("line", 42, owner(PINE_COMPATIBILITY.legacy), false)).toBeNull();
  });
});
