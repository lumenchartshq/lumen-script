import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const header = '//@version=6\nindicator("D6", overlay=false)\n';
const strict = PINE_COMPATIBILITY.strict;

function accepted(source: string) {
  const result = compile({ source: header + source, compatibility: strict });
  expect(result.diagnostics, source).toEqual([]);
  return result.program!;
}

describe("D6 hline and fill binding", () => {
  it("returns assigned hline handles and selects both fill handle families", () => {
    const program = accepted(`const string caption = "Upper"\nconst string lineStyle = hline.style_dashed\n` +
      `hline upper = hline(price=20, title=caption, color=color.red, linestyle=lineStyle, linewidth=2, display=display.pane)\n` +
      `hline lower = hline(10, "Lower")\nfill(upper, lower, color.blue, "Levels")\n` +
      `plot highPlot = plot(high, "High")\nplot lowPlot = plot(low, "Low")\nfill(plot1=highPlot, plot2=lowPlot, color=color.green, title="Prices")`);
    expect(program.generatedSource).toContain('r.hline("plot-0",20,"Upper"');
    expect(program.generatedSource).toContain('r.fill("plot-2",r.get(2),r.get(3),"Levels"');
    expect(program.generatedSource).toContain('r.fill("plot-5",r.get(4),r.get(5),"Prices"');
    expect(program.descriptor.plots).toHaveLength(6);
  });

  it("selects plot and hline gradients by the handle types, including positional calls", () => {
    const program = accepted(`hline a = hline(20)\nhline b = hline(10)\n` +
      `fill(a, b, 20, 10, color.red, color.blue, "H gradient")\n` +
      `plot p = plot(high)\nplot q = plot(low)\n` +
      `fill(p, q, 20, 10, color.red, color.blue, "P gradient")`);
    expect(program.generatedSource).toContain('"top_value":20');
    expect(program.generatedSource).toContain('"bottom_color":');
  });

  it.each([
    ["hline()", "SCRIPT2014"],
    ["hline(close)", "SCRIPT2117"],
    ["hline(10, color=close > open ? color.red : color.blue)", "SCRIPT2117"],
    ["hline(10, linestyle=line.style_dashed)", "SCRIPT2117"],
    ["hline(10, linewidth=1.5)", "SCRIPT2117"],
    ["fill(hline(10), plot(close), color.red)", "SCRIPT2117"],
    ["fill(plot(close), plot(open), color=true)", "SCRIPT2117"],
    ["fill()", "SCRIPT2014"],
  ])("rejects invalid visual call %s", (source, code) => {
    const result = compile({ source: header + source, compatibility: strict });
    expect(result.program, source).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === code), source).toBe(true);
  });

  it("keeps sealed visual coercion behavior", () => {
    const result = compile({ source: header + "hline(close, linestyle=line.style_dashed)", compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
  });
});
