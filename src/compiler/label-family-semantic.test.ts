import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("D3 labels")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const label = "label mark = label.new(0, 10, \"first\")\n";

describe("D3 label family semantic contract", () => {
  it("types numeric and chart.point constructors, getters, collection and all assigned setters", () => {
    const metadata = PINE_PRODUCTION_CALLABLE_METADATA;
    expect(metadata["label.new"]?.typedOverloads).toHaveLength(4);
    expect(metadata["label.set_size"]?.typedOverloads).toHaveLength(2);
    expect(metadata["label.set_xloc"]?.parameters).toEqual(["id", "x", "xloc"]);
    expect(metadata["label.get_text"]?.returnType).toBe("series string");
    expect(metadata["label.get_x"]?.returnType).toBe("series int");
    expect(metadata["label.get_y"]?.returnType).toBe("series float");
    const result = strict(`chart.point point = chart.point.from_index(1, 12)
series label a = label.new(x=0, y=10, text="one", style=label.style_label_up)
series label b = label.new(point=point, text="two", xloc=xloc.bar_index)
series label c = label.copy(id=a)
a.set_color(color.red)
a.set_point(point=point)
a.set_size(size.large)
a.set_size(19)
a.set_style(label.style_circle)
a.set_text("changed")
a.set_text_font_family(family=font.family_monospace)
a.set_textalign(text.align_right)
a.set_textcolor(color.blue)
a.set_tooltip("details")
a.set_x(2)
a.set_xloc(1700000000000, xloc.bar_time)
a.set_xloc(xloc=xloc.bar_index, x=2)
label.set_xloc(id=a, x=1700000000000, xloc=xloc.bar_time)
a.set_xy(x=3, y=14)
a.set_y(15)
a.set_yloc(yloc.abovebar)
series string text = a.get_text()
series int x = label.get_x(id=a)
series float y = b.get_y()
series int count = array.size(label.all)
c.delete()`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"label.new"');
    expect(result.program?.generatedSource).toContain('"set_point"');
    const integerSize = strict(`chart.point p = chart.point.from_index(0, 10)
label.new(0, 10, size=17)
label.new(point=p, size=18)
label.new(0, 10, size=0)
label.set_size(label.new(0, 10), 20)`);
    expect(integerSize.diagnostics).toEqual([]);
  });

  it("rejects wrong argument, receiver, result and option domains for every assigned call", () => {
    const negatives = [
      ["label.new(0.5, 10)", "requires series int"],
      ["label.new(point=chart.point.from_index(0, 10), text=4)", "requires series string"],
      ["int wrong = label.new(0, 10)", "Cannot assign"],
      [label + "label.copy(4)", "requires series label"],
      [label + "label.delete(4)", "requires series label"],
      [label + "int wrong = mark.get_text()", "Cannot assign"],
      [label + "string wrong = mark.get_x()", "Cannot assign"],
      [label + "string wrong = mark.get_y()", "Cannot assign"],
      [label + "mark.set_color(3)", "requires series color"],
      [label + "mark.set_point(3)", "requires series chart.point"],
      [label + "mark.set_size(\"gigantic\")", "size constant"],
      [label + "mark.set_size(-1)", "integer from 0 to 100"],
      [label + "mark.set_size(101)", "integer from 0 to 100"],
      [label + "mark.set_size(1.5)", "size constant or integer"],
      ["label.new(0, 10, size=-1)", "integer from 0 to 100"],
      [label + "mark.set_style(\"circle\")", "style constant"],
      [label + "mark.set_text(3)", "requires series string"],
      [label + "mark.set_text_font_family(\"fictional\")", "text_font_family constant"],
      [label + "mark.set_textalign(text.align_top)", "textalign constant"],
      [label + "mark.set_textcolor(3)", "requires series color"],
      [label + "mark.set_tooltip(3)", "requires series string"],
      [label + "mark.set_x(1.5)", "requires series int"],
      [label + "mark.set_xloc(2, \"invalid\")", "xloc constant"],
      [label + "mark.set_xloc(1.5, xloc.bar_time)", "requires series int"],
      [label + "mark.set_xloc(xloc.bar_time)", "Missing required argument"],
      [label + "mark.set_xy(1, \"bad\")", "requires series float"],
      [label + "mark.set_y(\"bad\")", "requires series float"],
      [label + "mark.set_yloc(\"invalid\")", "yloc constant"],
      ["array<float> wrong = label.all", "Cannot assign"],
      ["int wrong = label.style_circle", "Cannot assign"],
      ["int wrong = label.style_diamond", "Cannot assign"],
      ["int wrong = label.style_label_center", "Cannot assign"],
      ["int wrong = label.style_label_down", "Cannot assign"],
      ["int wrong = label.style_label_left", "Cannot assign"],
      ["int wrong = label.style_label_right", "Cannot assign"],
      ["int wrong = label.style_label_up", "Cannot assign"],
      ["int wrong = label.style_square", "Cannot assign"],
    ] as const;
    for (const [body, message] of negatives) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message: actual }) => actual.includes(message)), body).toBe(true);
    }
  });

  it("keeps the sealed profile's previous signature and admission", () => {
    expect(PINE_CALLABLE_METADATA["label.new"]?.typedOverloads).toHaveLength(1);
    expect(PINE_CALLABLE_METADATA["label.get_x"]?.returnType).not.toBe("series int");
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("label.new(0.5, 10)") }).program).toBeDefined();
  });

  it("admits dynamic string option values for runtime validation", () => {
    const result = strict(`styles = array.from(label.style_arrowdown, label.style_arrowup)
for style in styles
    label.new(bar_index, close, "dynamic", style=style)
label mark = label.new(0, 10)
string nextStyle = close > open ? label.style_circle : label.style_square
mark.set_style(nextStyle)`);
    expect(result.diagnostics).toEqual([]);
  });
});
