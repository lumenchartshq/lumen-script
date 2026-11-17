import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("D1 points")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });

describe("D1 point and remaining line signatures", () => {
  it("admits typed point construction, fields, copies, and line operations", () => {
    const result = strict(`chart.point p = chart.point.new(time, bar_index, close)
chart.point q = chart.point.from_time(time + 60000, 12)
chart.point r = chart.point.from_index(bar_index + 1, 13)
chart.point s = chart.point.now(close)
chart.point copy = p.copy()
series int t = copy.time
series int i = s.index
series float price = r.price
line guide = line.new(p, r)
guide.set_first_point(q)
line.set_second_point(id=guide, point=s)
guide.set_xloc(x1=time, x2=time + 60000, xloc=xloc.bar_time)
array<line> active = line.all`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("rejects wrong point and setter arguments, result types, and void values", () => {
    const prefix = "chart.point p = chart.point.from_index(0, 10)\nline guide = line.new(0, 10, 1, 11)\n";
    const negatives = [
      ["chart.point.from_index(1.5, 10)", "requires series int"],
      ["chart.point.from_time(1.5, 10)", "requires series int"],
      ["chart.point.new(0, 1.5, 10)", "requires series int"],
      ["chart.point.now(\"bad\")", "requires series float"],
      ["chart.point.copy(10)", "requires series chart.point"],
      ["int p = chart.point.from_index(0, 10)", "Cannot assign"],
      ["string p = chart.point.from_index(0, 10).price", "Cannot assign"],
      [prefix + "line.set_first_point(guide, 1)", "requires series chart.point"],
      [prefix + "guide.set_second_point(1)", "requires series chart.point"],
      [prefix + "guide.set_xloc(0.5, 1, xloc.bar_index)", "requires series int"],
      [prefix + "guide.set_xloc(0, 1, \"bad\")", "xloc constant"],
      [prefix + "int x = line.set_first_point(guide, p)", "Void expression"],
      ["array<float> active = line.all", "Cannot assign"],
    ] as const;
    for (const [body, message] of negatives) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message: actual }) => actual.includes(message)), body).toBe(true);
    }
  });

  it("keeps the sealed metadata unchanged", () => {
    expect(PINE_CALLABLE_METADATA["chart.point.from_index"]?.returnType).not.toBe("series chart.point");
    expect(PINE_PRODUCTION_CALLABLE_METADATA["chart.point.from_index"]?.returnType).toBe("series chart.point");
    expect(PINE_CALLABLE_METADATA["line.set_xloc"]?.returnType).toBe("unknown");
    expect(PINE_PRODUCTION_CALLABLE_METADATA["line.set_xloc"]?.returnType).toBe("void");
  });
});
