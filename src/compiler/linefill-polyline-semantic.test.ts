import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";

const header = '//@version=6\nindicator("Linefill polyline", overlay=true)\n';
const lines = 'line a = line.new(0, 10, 2, 11)\nline b = line.new(0, 8, 2, 7)\n';
const points = 'array<chart.point> pts = array.from(chart.point.from_index(0, 10), chart.point.from_index(1, 12))\n';

function errors(source: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  return compile({ source: header + source, compatibility }).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

describe("linefill and polyline production binding", () => {
  it("types every D5 call and collection through namespace and receiver syntax", () => {
    expect(errors(lines + points + `
linefill f = linefill.new(line1=a, line2=b, color=color.blue)
line first = linefill.get_line1(f)
line second = f.get_line2()
f.set_color(color.red)
linefill.set_color(id=f, color=color.green)
array<linefill> fills = linefill.all
linefill.delete(f)
polyline p = polyline.new(points=pts, curved=true, closed=true, xloc=xloc.bar_index, line_color=color.red, fill_color=color.blue, line_style=line.style_dashed, line_width=2, force_overlay=true)
array<polyline> paths = polyline.all
p.delete()
polyline.delete(p)`)).toEqual([]);
  });

  it("rejects wrong typed arguments, results and unrendered style domains", () => {
    for (const source of [
      lines + "linefill.new(a, true, color.red)",
      lines + "linefill.new(a, b, true)",
      lines + "linefill.get_line1(a)",
      lines + "linefill.delete(a)",
      lines + "linefill f = linefill.new(a, b, color.red)\nf.set_color(true)",
      lines + "linefill f = linefill.new(a, b, color.red)\nlinefill.set_color(f, true)",
      "array<float> wrong = linefill.all",
      "array<line> wrong = polyline.all",
      points + "polyline.new(array.from(1, 2))",
      points + "polyline.new(pts, curved=1)",
      points + "polyline.new(pts, xloc=\"bad\")",
      points + "polyline.new(pts, line_style=line.style_arrow_right)",
      points + "polyline.new(pts, line_width=1.5)",
      points + "polyline.new(pts, force_overlay=close > open)",
      points + "polyline p = polyline.new(pts)\np.delete(true)",
    ]) expect(errors(source).length, source).toBeGreaterThan(0);
  });

  it("does not narrow the sealed profile", () => {
    expect(errors(lines + points + "linefill.new(a, b, color.red)\npolyline.new(pts, line_style=line.style_arrow_right)", PINE_COMPATIBILITY.legacy)).toEqual([]);
  });
});
