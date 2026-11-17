import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compileStrict = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Matrix core semantics")\n${body}`,
});

describe("strict matrix core semantic contracts", () => {
  it("binds omitted and independently named dimensions to zero defaults", () => {
    const strict = compileStrict(`matrix<float> empty = matrix.new<float>()
matrix<float> rowsOnly = matrix.new<float>(2)
matrix<float> namedRows = matrix.new<float>(rows = 2)
matrix<float> namedColumns = matrix.new<float>(columns = 2)
matrix<float> reorderedEmpty = matrix.new<float>(columns = 0, rows = 0)
plot(empty.rows() + rowsOnly.rows() + namedRows.rows() + namedColumns.columns() + reorderedEmpty.columns())`);

    expect(strict.diagnostics).toEqual([]);
    expect(strict.program?.generatedSource).toContain('"matrix.new",[undefined,undefined,undefined,"float"]');
    expect(strict.program?.generatedSource).toContain('"matrix.new",[undefined,2,undefined,"float"]');

    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6\nindicator("Sealed matrix defaults")\nvalue = matrix.new<float>()`,
    });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });

  it("admits exact primitive, enum, UDT and object-reference element domains", () => {
    const result = compileStrict(`enum Side
    long
    short
type Item
    float value
matrix<bool> bools = matrix.new<bool>(0, 0)
matrix<color> colors = matrix.new<color>(0, 0)
matrix<float> floats = matrix.new<float>(rows = 2, columns = 2, initial_value = 1)
matrix<int> ints = matrix.new<int>(2, 2, 1)
matrix<string> strings = matrix.new<string>(0, 0)
matrix<Side> sides = matrix.new<Side>(1, 1, Side.long)
matrix<Item> items = matrix.new<Item>(1, 1, Item.new(1))
matrix<box> boxes = matrix.new<box>(0, 0)
matrix<chart.point> points = matrix.new<chart.point>(0, 0)
matrix<label> labels = matrix.new<label>(0, 0)
matrix<line> lines = matrix.new<line>(0, 0)
matrix<linefill> linefills = matrix.new<linefill>(0, 0)
matrix<polyline> polylines = matrix.new<polyline>(0, 0)
matrix<table> tables = matrix.new<table>(0, 0)
float namespaceGet = matrix.get(floats, 0, 0)
float methodGet = floats.get(row = 0, column = 0)
matrix.set(floats, 0, 1, 2)
floats.set(row = 1, column = 0, value = 3)
int rowCount = matrix.rows(floats)
int columnCount = floats.columns()
int elementCount = matrix.elements_count(floats)
matrix.fill(floats, 4, 0, 1, 0, 2)
floats.fill(value = 5, from_row = 1, to_row = 2, from_column = 0, to_column = 2)
matrix<float> copied = matrix.copy(floats)
matrix<float> methodCopy = floats.copy()
array<float> firstRow = matrix.row(floats, 0)
array<float> firstColumn = floats.col(column = 0)
matrix<float> section = matrix.submatrix(floats, 0, 1, 0, 2)
matrix<float> methodSection = floats.submatrix(from_row = 1, to_row = 2, from_column = 0, to_column = 2)
plot(namespaceGet + methodGet + rowCount + columnCount + elementCount + copied.get(0, 0) + methodCopy.get(0, 0) + firstRow.get(0) + firstColumn.get(0) + section.get(0, 0) + methodSection.get(0, 0))`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/"matrix\.(?:new|get|set|rows|columns|elements_count|fill|copy|row|col|submatrix)"/gu)?.length).toBeGreaterThanOrEqual(11);
  });

  it("rejects invalid constructor type arguments, dimensions and initial values", () => {
    const sources = [
      ["missing type", "value = matrix.new(1, 1)", "exactly one type parameter"],
      ["two types", "value = matrix.new<int, float>(1, 1)", "exactly one type parameter"],
      ["nested array", "value = matrix.new<array<int>>(1, 1)", "does not admit nested collection"],
      ["nested map", "value = matrix.new<map<int, int>>(1, 1)", "does not admit nested collection"],
      ["unknown type", "value = matrix.new<Missing>(1, 1)", "requires a known primitive"],
      ["row type", 'value = matrix.new<int>("1", 1)', "requires series int"],
      ["column type", 'value = matrix.new<int>(1, "1")', "requires series int"],
      ["initial type", 'value = matrix.new<int>(1, 1, "bad")', "requires series int"],
    ] as const;
    for (const [label, source, message] of sources) {
      const result = compileStrict(source);
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message)), label).toBe(true);
      expect(result.program, label).toBeUndefined();
    }
  });

  it("makes namespace and method argument failures agree", () => {
    const pairs = [
      ["matrix.get(values, 0.5, 0)", "values.get(0.5, 0)"],
      ["matrix.set(values, 0, 0.5, 1)", "values.set(0, 0.5, 1)"],
      ['matrix.set(values, 0, 0, "bad")', 'values.set(0, 0, "bad")'],
      ['matrix.fill(values, "bad")', 'values.fill("bad")'],
      ["matrix.fill(values, 1, 0.5, 1, 0, 1)", "values.fill(1, 0.5, 1, 0, 1)"],
      ["matrix.row(values, 0.5)", "values.row(0.5)"],
      ["matrix.col(values, 0.5)", "values.col(0.5)"],
      ["matrix.submatrix(values, 0.5, 1, 0, 1)", "values.submatrix(0.5, 1, 0, 1)"],
    ] as const;
    for (const [namespaceCall, methodCall] of pairs) {
      for (const expression of [namespaceCall, methodCall]) {
        const result = compileStrict(`matrix<int> values = matrix.new<int>(1, 1, 0)\n${expression}`);
        expect(result.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
        expect(result.program, expression).toBeUndefined();
      }
    }
  });

  it("types values, containers, counts and void effects exactly", () => {
    const result = compileStrict(`matrix<float> values = matrix.new<float>(2, 2, 0)
int wrongGet = values.get(0, 0)
simple float wrongQualifier = matrix.get(values, 0, 0)
array<int> wrongRow = values.row(0)
array<int> wrongColumn = matrix.col(values, 0)
matrix<int> wrongCopy = values.copy()
matrix<int> wrongSubmatrix = matrix.submatrix(values)
bool wrongRows = values.rows()
bool wrongColumns = matrix.columns(values)
bool wrongElements = values.elements_count()
assignedSet = values.set(0, 0, 1)
assignedFill = matrix.fill(values, 1)`);

    expect(result.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(9);
    expect(result.diagnostics.filter(({ code }) => code === "SCRIPT2137")).toHaveLength(2);
    expect(result.program).toBeUndefined();
  });

  it("rejects non-matrix receivers only in the strict profile", () => {
    const source = `//@version=6
indicator("Matrix receiver boundary")
value = matrix.get(1, 0, 0)`;
    const strict = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });

    expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    expect(strict.program).toBeUndefined();
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
