import { compile } from "../compiler/index.js";
import { describe, expect, it } from "vitest";
import { DrawingRuntime, isPineBox } from "./drawings.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function runtime() {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Box admission")' });
  expect(result.diagnostics).toEqual([]);
  return new DrawingRuntime(result.program!, () => ({ time: 1_700_000_000_000, index: 0 }));
}

describe("strict box mutation admission", () => {
  it("rejects invalid paired coordinates and selectors before touching the previous box", () => {
    const drawings = runtime();
    const handle = drawings.boxCall("new", [0, 20, 2, 10]);
    expect(isPineBox(handle)).toBe(true);
    if (!isPineBox(handle)) return;
    expect(() => drawings.boxCall("set_lefttop", [handle, 1, "wrong"])).toThrow(/numeric top/u);
    expect([handle.left, handle.top]).toEqual([0, 20]);
    expect(() => drawings.boxCall("set_xloc", [handle, 1, 2, "wrong"])).toThrow(/valid xloc/u);
    expect([handle.left, handle.right, handle.xloc]).toEqual([0, 2, "bi"]);
    expect(() => drawings.boxCall("set_border_style", [handle, "style_arrow_left"])).toThrow(/valid border_style/u);
    expect(handle.borderStyle).toBe("style_solid");
    expect(() => drawings.boxCall("set_text_halign", [handle, "bottom"])).toThrow(/valid text_halign/u);
    expect(handle.textHorizontalAlign).toBe("center");
  });

  it("does not allocate a new ID or evict an existing box for a rejected constructor", () => {
    const drawings = runtime();
    const first = drawings.boxCall("new", [0, 20, 2, 10]);
    expect(() => drawings.boxCall("new", [0, 20, 2, 10, "#112233", 1, "wrong"])).toThrow(/valid border_style/u);
    expect(() => drawings.boxCall("new", [0, 20, 2, 10, "#112233", 1, "style_solid", "n", "bi", "#334455", "words", 101])).toThrow(/0 to 100/u);
    expect(drawings.nextBoxId).toBe(1);
    expect(drawings.boxes).toHaveLength(1);
    expect(drawings.boxes[0]).toBe(first);
  });

  it("normalizes integer typography while rejecting invalid source values atomically", () => {
    const drawings = runtime();
    const box = drawings.boxCall("new", [0, 20, 2, 10, "#2962ff", 1, "style_solid", "n", "bi", "#2962ff", "words", 18]);
    expect(isPineBox(box)).toBe(true);
    if (!isPineBox(box)) return;
    expect(box.textSize).toBe("18");
    expect(() => drawings.boxCall("set_text_size", [box, "18"])).toThrow(/valid text_size/u);
    expect(() => drawings.boxCall("set_text_size", [box, 101])).toThrow(/0 to 100/u);
    expect(() => drawings.boxCall("set_text_size", [box, 18.5])).toThrow(/0 to 100/u);
    expect(box.textSize).toBe("18");
    const copied = drawings.boxCall("copy", [box]);
    expect(isPineBox(copied)).toBe(true);
    if (!isPineBox(copied)) return;
    expect(copied.textSize).toBe("18");
    drawings.boxCall("set_text_size", [copied, 0]);
    expect(copied.textSize).toBe("auto");
    expect(box.textSize).toBe("18");
  });
});
