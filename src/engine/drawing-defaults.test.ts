import { PINE_COMPATIBILITY } from "../contracts/index.js";
import { expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

it.each([
  { compatibility: PINE_COMPATIBILITY.strict, blue: "#2962FF", stroke: "#2962ff", white: "#ffffff", boxText: "#ffffff", tableText: "#363A45" },
  { compatibility: PINE_COMPATIBILITY.legacy, blue: "#2196F3", stroke: "", white: "", boxText: "#000000", tableText: "#000000" },
])("preserves observed drawing colors for $compatibility", async ({ compatibility, blue, stroke, white, boxText, tableText }) => {
  const compiled = compile({ compatibility, source: `//@version=6
indicator("Drawing default colors")
color selected = input.color(color.blue)
line.new(bar_index, high, bar_index + 1, high)
label.new(bar_index, high, "Label")
box.new(bar_index, high, bar_index + 1, low, text="Box")
var table t = table.new(position.bottom_right, 1, 1)
table.cell(t, 0, 0, "Cell")
plot(close, color=color.blue)
plot(close, color=selected)` });
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.program?.descriptor.inputs[0]?.defaultValue).toBe(blue);
  const session = new PineEngine().createSession(compiled.program!);
  try {
    const result = await session.runBatch([{ openTime: 60_000, closeTime: 120_000, open: 1, high: 2, low: 1, close: 2, volume: 1 }]);
    expect(result.drawings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "line", color: stroke, style: "style_solid", width: 1 }),
      expect.objectContaining({ kind: "label", color: stroke, textColor: white, style: "style_label_down" }),
      expect.objectContaining({ kind: "box", backgroundColor: "#2962ff", textColor: boxText }),
    ]));
    expect(result.tables[0]?.cells[0]?.[0]?.textColor).toBe(tableText);
    expect(result.plots.map((plot) => plot.points[0]?.options?.color)).toEqual([blue, blue]);
  } finally { await session.close(); }
});
