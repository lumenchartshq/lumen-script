import { PINE_CALLABLE_METADATA,
  PINE_PRODUCTION_CALLABLE_METADATA,
  PINE_COMPATIBILITY,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const compileStrict = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Matrix structural semantics")\n${body}`,
});

describe("strict matrix structural semantic contracts", () => {
  it("exposes the verified optional insertion and removal signatures only in production", () => {
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.add_row"]?.optionalParameters).toEqual(["row", "array_id"]);
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.add_col"]?.optionalParameters).toEqual(["column", "array_id"]);
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.remove_row"]?.optionalParameters).toEqual(["row"]);
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.remove_col"]?.optionalParameters).toEqual(["column"]);
    expect(PINE_CALLABLE_METADATA["matrix.remove_row"]?.optionalParameters).toBeUndefined();
    expect(PINE_CALLABLE_METADATA["matrix.remove_col"]?.optionalParameters).toBeUndefined();
  });

  it("binds namespace and method syntax with positional, named and omitted arguments", () => {
    const result = compileStrict(`matrix<int> values = matrix.new<int>(2, 2, 0)
array<int> rowValues = array.from(1, 2)
array<int> columnValues = array.from(3, 4, 5, 6)
matrix.add_row(values)
values.add_row(row = 1, array_id = rowValues)
matrix.add_col(id = values)
values.add_col(array_id = columnValues)
array<int> lastRow = matrix.remove_row(values)
array<int> firstRow = values.remove_row(row = 0)
array<int> lastColumn = matrix.remove_col(values)
array<int> firstColumn = values.remove_col(column = 0)
matrix.reshape(values, rows = 1, columns = 4)
values.reshape(2, 2)
matrix.swap_rows(values, row1 = 0, row2 = 1)
values.swap_columns(column1 = 0, column2 = 1)
matrix<int> namespaceTranspose = matrix.transpose(values)
matrix<int> methodTranspose = values.transpose()
plot(lastRow.size() + firstRow.size() + lastColumn.size() + firstColumn.size() + namespaceTranspose.rows() + methodTranspose.columns())`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"add_col",[undefined,');
    for (const method of ["add_col", "add_row", "remove_col", "remove_row", "reshape", "swap_columns", "swap_rows", "transpose"]) {
      expect(result.program?.generatedSource, method).toMatch(new RegExp(`"(?:matrix\\.)?${method}"`, "u"));
    }
  });

  it("preserves generic primitive and object result types", () => {
    const result = compileStrict(`type Item
    float value
matrix<float> floats = matrix.new<float>(1, 1, 1)
array<float> removedFloatRow = floats.remove_row()
matrix<float> floatTranspose = matrix.transpose(floats)
Item shared = Item.new(1)
matrix<Item> items = matrix.new<Item>(1, 1, shared)
array<Item> removedItemColumn = matrix.remove_col(items)
matrix<Item> itemTranspose = items.transpose()
plot(removedFloatRow.size() + floatTranspose.rows() + removedItemColumn.size() + itemTranspose.columns())`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("rejects wrong index, vector, receiver, result and void-value types", () => {
    const invalidCalls = [
      ["add row index", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.add_row(0.5)", "requires series int"],
      ["add column values", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.add_col(array_id = array.from(\"bad\"))", "Collection expects series int"],
      ["add row nonarray", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.add_row(array_id = 1)", "requires a series array"],
      ["remove row index", "matrix<int> m = matrix.new<int>(1, 1, 0)\nvalue = matrix.remove_row(m, 0.5)", "requires series int"],
      ["remove column index", "matrix<int> m = matrix.new<int>(1, 1, 0)\nvalue = m.remove_col(0.5)", "requires series int"],
      ["reshape rows", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.reshape(1.5, 1)", "requires series int"],
      ["swap row", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.swap_rows(0, 0.5)", "requires series int"],
      ["swap column", "matrix<int> m = matrix.new<int>(1, 1, 0)\nm.swap_columns(0.5, 0)", "requires series int"],
      ["receiver", "value = matrix.transpose(1)", "requires series matrix"],
    ] as const;
    for (const [label, source, message] of invalidCalls) {
      const result = compileStrict(source);
      expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes(message)), label).toBe(true);
      expect(result.program, label).toBeUndefined();
    }

    const wrongResults = compileStrict(`matrix<float> values = matrix.new<float>(1, 1, 1)
array<int> wrongRow = values.remove_row()
array<int> wrongColumn = matrix.remove_col(values)
matrix<int> wrongTranspose = values.transpose()
assignedAdd = values.add_row()
assignedReshape = matrix.reshape(values, 1, 1)
assignedSwap = values.swap_rows(0, 0)`);
    expect(wrongResults.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(3);
    expect(wrongResults.diagnostics.filter(({ code }) => code === "SCRIPT2137")).toHaveLength(3);
    expect(wrongResults.program).toBeUndefined();
  });

  it("keeps sealed omission and coercion admission unchanged", () => {
    const explicit = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed matrix structure")
m = matrix.new<int>(1, 1, 0)
m.add_row(0.5, array.from(1))
removed = m.remove_row(0.5)`,
    });
    expect(explicit.diagnostics).toEqual([]);
    expect(explicit.program).toBeDefined();

    const omittedRemoval = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed matrix removal")
m = matrix.new<int>(1, 1, 0)
removed = m.remove_row()`,
    });
    expect(omittedRemoval.diagnostics).toEqual([]);
    expect(omittedRemoval.program).toBeDefined();
  });
});
