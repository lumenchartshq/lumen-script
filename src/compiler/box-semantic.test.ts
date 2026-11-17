import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const header = '//@version=6\nindicator("Box", overlay=true)\n';
const base = 'box b = box.new(0, 20, 2, 10, border_color=color.red, text="wide words")\n';
const point = "chart.point p = chart.point.from_index(1, 15)\n";

function diagnostics(source: string) {
  return compile({ compatibility: PINE_COMPATIBILITY.strict, source: header + source }).diagnostics;
}

describe("production box contracts", () => {
  it("accepts numeric and chart.point constructors with named options", () => {
    expect(diagnostics(base)).toEqual([]);
    expect(diagnostics(point + "box b = box.new(top_left=p, bottom_right=chart.point.from_index(2, 10), xloc=xloc.bar_index, text_halign=text.align_left)")).toEqual([]);
  });

  it("accepts integer box typography on both constructors and setter call paths", () => {
    for (const source of [
      'box b = box.new(0, 20, 2, 10, text="numeric", text_size=18)\nbox.set_text_size(b, size=20)\nb.set_text_size(17)',
      point + 'box b = box.new(top_left=p, bottom_right=chart.point.from_index(2, 10), text="point", text_size=18)\nbox.set_text_size(id=b, size=0)',
      base + 'box.set_text_size(b, size.large)\nb.set_text_size(size.tiny)',
    ]) expect(diagnostics(source), source).toEqual([]);
  });

  it("rejects wrong box typography kinds and values with exact call paths", () => {
    for (const value of ["true", "18.5", '"18"', "-1", "101"]) {
      for (const source of [
        `box.new(0, 20, 2, 10, text_size=${value})`,
        point + `box.new(top_left=p, bottom_right=chart.point.from_index(2, 10), text_size=${value})`,
        base + `box.set_text_size(b, ${value})`,
        base + `b.set_text_size(${value})`,
      ]) expect(diagnostics(source).some((entry) => entry.code === "SCRIPT2117"), source).toBe(true);
    }
  });

  it("checks the border-style enum for namespace, named, and receiver calls", () => {
    for (const source of [
      base + "box.set_border_style(b, line.style_arrow_left)",
      base + "box.set_border_style(id=b, style=line.style_arrow_left)",
      base + "b.set_border_style(line.style_arrow_left)",
    ]) expect(diagnostics(source).some((entry) => entry.code === "SCRIPT2117"), source).toBe(true);
    expect(diagnostics(base + "box.set_border_style(id=b, style=line.style_dotted)\nb.set_border_style(line.style_solid)")).toEqual([]);
  });

  it("keeps the sealed callable metadata permissive", () => {
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: header + base + "b.set_text_size(19)\nbox.set_border_style(b, line.style_arrow_left)" });
    expect(sealed.program).toBeDefined();
    expect(sealed.diagnostics).toEqual([]);
  });

  const setters = [
    ["set_bgcolor", "color.blue", "true"], ["set_border_color", "color.blue", "true"],
    ["set_border_style", "line.style_dashed", "true"], ["set_border_width", "2", "true"],
    ["set_bottom", "8.5", "true"], ["set_bottom_right_point", "p", "true"],
    ["set_extend", "extend.right", "true"], ["set_left", "1", "true"],
    ["set_right", "3", "true"], ["set_text", '"hello"', "true"],
    ["set_text_color", "color.blue", "true"], ["set_text_font_family", "font.family_monospace", "true"],
    ["set_text_formatting", "text.format_bold", "true"], ["set_text_halign", "text.align_left", "true"],
    ["set_text_size", "size.large", "true"], ["set_text_valign", "text.align_top", "true"],
    ["set_text_wrap", "text.wrap_auto", "true"], ["set_top", "21.5", "true"],
    ["set_top_left_point", "p", "true"],
  ] as const;

  it.each(setters)("types namespace and method box.%s", (method, value) => {
    expect(diagnostics(base + point + `box.${method}(b, ${value})\nb.${method}(${value})`)).toEqual([]);
    expect(diagnostics(base + point + `box.${method}(b, true)`).some((entry) => entry.code === "SCRIPT2117")).toBe(true);
  });

  it.each([
    ["set_lefttop", "1, 21.5"], ["set_rightbottom", "3, 8.5"], ["set_xloc", "1, 3, xloc.bar_index"],
  ])("types paired setter box.%s", (method, args) => {
    expect(diagnostics(base + `box.${method}(b, ${args})\nb.${method}(${args})`)).toEqual([]);
    expect(diagnostics(base + `box.${method}(b, true, ${args.split(", ").slice(1).join(", ")})`).some((entry) => entry.code === "SCRIPT2117")).toBe(true);
  });

  it("types getters, copy, delete and box.all", () => {
    expect(diagnostics(base + "series int left = b.get_left()\nseries int right = box.get_right(b)\nseries float top = b.get_top()\nseries float bottom = box.get_bottom(b)\nbox c = box.copy(b)\nseries int count = array.size(box.all)\nc.delete()")).toEqual([]);
    for (const method of ["get_left", "get_right", "get_top", "get_bottom", "copy", "delete"]) {
      expect(diagnostics(base + `box.${method}(true)`).some((entry) => entry.code === "SCRIPT2117"), method).toBe(true);
    }
    expect(diagnostics("array<float> wrong = box.all").some((entry) => entry.code === "SCRIPT2102")).toBe(true);
  });

  it("rejects wrong argument and enum domains before runtime", () => {
    for (const source of [
      "box.new(true, 20, 2, 10)",
      "box.new(chart.point.from_index(0, 20), true)",
      "box.new(0, 20, 2, 10, xloc=\"wrong\")",
      base + "b.set_border_style(line.style_arrow_left)",
      base + "b.set_extend(\"wrong\")",
      base + "b.set_xloc(1, 2, \"wrong\")",
    ]) expect(diagnostics(source).some((entry) => entry.severity === "error"), source).toBe(true);
  });
});
