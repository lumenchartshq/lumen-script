import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compileCurrent = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Array constructors")\n${body}`,
});

describe("strict array constructor bindings", () => {
  it("binds generic, specialized, enum, UDT, handle, and homogeneous array.from results exactly", () => {
    const result = compileCurrent(`enum Side
    long
    short
type Item
    float value
array<bool> bools = array.new_bool(2)
array<box> boxes = array.new_box(2)
array<color> colors = array.new_color(2)
array<float> floats = array.new<float>(2, 1)
array<int> ints = array.new_int(initial_value = 3, size = 2)
array<label> labels = array.new_label(2)
array<line> lines = array.new_line(2)
array<linefill> linefills = array.new_linefill(2)
array<string> strings = array.new_string(2)
array<table> tables = array.new_table(2)
array<Side> sides = array.new<Side>(2, Side.long)
array<Item> items = array.new<Item>(2, Item.new(1))
array<float> widened = array.from(1, 2.5, na)
array<Item> inferredItems = array.from(Item.new(2), Item.new(3))
array<line> inferredLines = array.from(line.new(0, 1, 1, 2), na)
bool firstBool = bools.get(0)
box firstBox = boxes.get(0)
color firstColor = colors.get(0)
float firstFloat = floats.get(0)
int firstInt = ints.get(0)
label firstLabel = labels.get(0)
line firstLine = lines.get(0)
linefill firstLinefill = linefills.get(0)
string firstString = strings.get(0)
table firstTable = tables.get(0)
Side firstSide = sides.get(0)
Item firstItem = items.get(0)
plot(widened.get(1) + inferredItems.get(0).value + inferredLines.size())`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"array.new_float"');
    expect(result.program?.generatedSource).toContain('"array.new_Item"');
    expect(result.program?.generatedSource).toContain('"array.from"');
  });

  it("rejects wrong constructor sizes, initial values, result elements, and collection mixtures", () => {
    const sources = [
      'values = array.new_bool("2")',
      'values = array.new_int(2, 1.5)',
      'values = array.new_float(2, "wrong")',
      'values = array.new_color(2, true)',
      'values = array.new_string(2, color.red)',
      'values = array.new_box(2, line.new(0, 1, 1, 2))',
      'values = array.new_label(2, box.new(0, 2, 1, 1))',
      'values = array.new_line(2, label.new(0, 1))',
      'values = array.new_linefill(2, line.new(0, 1, 1, 2))',
      'values = array.new_table(2, line.new(0, 1, 1, 2))',
      'values = array.new<int>(2, 1.5)',
      'array<int> values = array.new<float>(2)',
      'values = array.from(1, "wrong")',
      'values = array.from(array.from(1), array.from(2))',
    ];

    for (const source of sources) {
      const result = compileCurrent(source);
      expect(result.diagnostics.some(({ code }) => /^SCRIPT21/u.test(code)), source).toBe(true);
      expect(result.program, source).toBeUndefined();
    }
  });

  it("rejects missing, extra, and misplaced constructor type parameters and arguments", () => {
    const sources = [
      "values = array.new(2)",
      "values = array.new<int, float>(2)",
      "values = array.new<array<int>>(2)",
      "values = array.new<Missing>(2)",
      "values = array.new_int<float>(2)",
      "values = array.from<int>(1)",
      "values = array.new_int(1, 2, 3)",
      "values = array.new_int(size = 1, size = 2)",
      "values = array.new_int(missing = 1)",
      "values = array.from()",
    ];

    for (const source of sources) {
      const result = compileCurrent(source);
      expect(result.diagnostics.some(({ code }) => /^SCRIPT2/u.test(code)), source).toBe(true);
      expect(result.program, source).toBeUndefined();
    }
  });

  it("preserves the sealed constructor admission boundary", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed arrays")
generic = array.new(2)
mixed = array.from(1, "legacy")
ints = array.new_int(2, 1.5)
plot(array.size(generic) + array.size(mixed) + array.size(ints))`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });
});
