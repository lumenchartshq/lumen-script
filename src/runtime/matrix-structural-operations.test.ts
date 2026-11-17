import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const strict = { strict: true, negativeIndices: true } as const;

type MatrixValue = { columnCount: number; data: unknown[][] };

const matrixData = (value: unknown): unknown[][] => (value as MatrixValue).data;

describe("strict matrix structural runtime", () => {
  it("inserts and removes first, middle, last and omitted vectors in row-major order", () => {
    const matrix = matrixCall("new_int", [2, 2, 0], strict);
    matrixCall("set", [matrix, 0, 0, 1], strict);
    matrixCall("set", [matrix, 0, 1, 2], strict);
    matrixCall("set", [matrix, 1, 0, 5], strict);
    matrixCall("set", [matrix, 1, 1, 6], strict);

    matrixCall("add_row", [matrix, 1, [3, 4]], strict);
    matrixCall("add_col", [matrix, 0, [10, 20, 30]], strict);
    matrixCall("add_col", [matrix], strict);
    matrixCall("add_row", [matrix], strict);
    expect(matrixData(matrix)).toEqual([
      [10, 1, 2, Number.NaN],
      [20, 3, 4, Number.NaN],
      [30, 5, 6, Number.NaN],
      [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    ]);

    expect(matrixCall("remove_row", [matrix, 1], strict)).toEqual([20, 3, 4, Number.NaN]);
    expect(matrixCall("remove_col", [matrix], strict)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
    expect(matrixData(matrix)).toEqual([[10, 1, 2], [30, 5, 6], [Number.NaN, Number.NaN, Number.NaN]]);
    expect(matrixCall("remove_row", [matrix], strict)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
  });

  it("defaults only undefined row insertion indexes while preserving explicit null coercion", () => {
    const rows = matrixCall("new_int", [1, 1, 7], strict);
    matrixCall("add_row", [rows, null, [9]], strict);
    matrixCall("add_row", [rows, undefined as never, [8]], strict);
    matrixCall("add_row", [rows], strict);
    expect(matrixData(rows)).toEqual([[9], [7], [8], [Number.NaN]]);
    const rowsSnapshot = JSON.stringify(rows);
    expect(() => matrixCall("add_row", [rows, Number.NaN, [1]], strict)).toThrow(PineRuntimeError);
    expect(JSON.stringify(rows)).toBe(rowsSnapshot);
  });

  it("defaults only undefined column insertion indexes while preserving explicit null coercion", () => {
    const columns = matrixCall("new_int", [1, 1, 7], strict);
    matrixCall("add_col", [columns, null, [9]], strict);
    matrixCall("add_col", [columns, undefined as never, [8]], strict);
    matrixCall("add_col", [columns], strict);
    expect(matrixData(columns)).toEqual([[9, 7, 8, Number.NaN]]);
    const columnsSnapshot = JSON.stringify(columns);
    expect(() => matrixCall("add_col", [columns, Number.NaN, [1]], strict)).toThrow(PineRuntimeError);
    expect(JSON.stringify(columns)).toBe(columnsSnapshot);
  });

  it("preserves zero-width and zero-row shape metadata through structural changes and JSON", () => {
    const zeroRows = matrixCall("new_int", [0, 3], strict);
    matrixCall("add_col", [zeroRows, 1, []], strict);
    expect(matrixCall("rows", [zeroRows], strict)).toBe(0);
    expect(matrixCall("columns", [zeroRows], strict)).toBe(4);
    expect(matrixCall("remove_col", [zeroRows], strict)).toEqual([]);
    expect(matrixCall("columns", [zeroRows], strict)).toBe(3);
    matrixCall("add_row", [zeroRows], strict);
    expect(matrixData(zeroRows)).toEqual([[Number.NaN, Number.NaN, Number.NaN]]);
    expect(matrixCall("remove_row", [zeroRows], strict)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
    expect(matrixCall("columns", [zeroRows], strict)).toBe(3);

    const zeroColumns = matrixCall("new_int", [3, 0], strict);
    matrixCall("add_col", [zeroColumns], strict);
    expect(matrixData(zeroColumns)).toEqual([[Number.NaN], [Number.NaN], [Number.NaN]]);
    expect(matrixCall("remove_col", [zeroColumns], strict)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
    expect(matrixCall("rows", [zeroColumns], strict)).toBe(3);
    expect(matrixCall("columns", [zeroColumns], strict)).toBe(0);

    const emptyByRows = matrixCall("new_int", [], strict);
    matrixCall("add_row", [emptyByRows, 0, [1, 2]], strict);
    expect(matrixData(emptyByRows)).toEqual([[1, 2]]);
    const emptyByColumns = matrixCall("new_int", [], strict);
    matrixCall("add_col", [emptyByColumns, 0, [1, 2]], strict);
    expect(matrixData(emptyByColumns)).toEqual([[1], [2]]);

    const transposed = matrixCall("transpose", [matrixCall("new_int", [2, 0], strict)], strict);
    expect(matrixCall("rows", [transposed], strict)).toBe(0);
    expect(matrixCall("columns", [transposed], strict)).toBe(2);
    const restored = JSON.parse(JSON.stringify(transposed)) as never;
    expect(matrixCall("columns", [restored], strict)).toBe(2);
    matrixCall("reshape", [restored, 0, 100_000], strict);
    expect(matrixCall("columns", [restored], strict)).toBe(100_000);
  });

  it("reshapes, swaps and transposes exact non-square row-major contents", () => {
    const matrix = matrixCall("new_int", [2, 3, 0], strict);
    for (const [index, value] of [1, 2, 3, 4, 5, 6].entries()) {
      matrixCall("set", [matrix, Math.floor(index / 3), index % 3, value], strict);
    }
    matrixCall("reshape", [matrix, 3, 2], strict);
    expect(matrixData(matrix)).toEqual([[1, 2], [3, 4], [5, 6]]);
    matrixCall("swap_rows", [matrix, 0, 2], strict);
    matrixCall("swap_columns", [matrix, 0, 1], strict);
    expect(matrixData(matrix)).toEqual([[6, 5], [4, 3], [2, 1]]);

    const transposed = matrixCall("transpose", [matrix], strict);
    expect(matrixCall("rows", [transposed], strict)).toBe(2);
    expect(matrixCall("columns", [transposed], strict)).toBe(3);
    expect(matrixData(transposed)).toEqual([[6, 4, 2], [5, 3, 1]]);
    matrixCall("set", [transposed, 0, 0, -1], strict);
    expect(matrixCall("get", [matrix, 0, 0], strict)).toBe(6);
  });

  it("owns structural containers while retaining shallow object references", () => {
    const shared = { __pineType: "Item", value: 1 };
    const inserted = [shared, shared];
    const matrix = matrixCall("new_Item", [], strict);
    matrixCall("add_col", [matrix, 0, inserted as never], strict);
    inserted[0] = { __pineType: "Item", value: -1 };
    expect(matrixCall("get", [matrix, 0, 0], strict)).toBe(shared);

    const observedColumn = matrixCall("col", [matrix, 0], strict) as unknown[];
    const copied = matrixCall("copy", [matrix], strict);
    const transposed = matrixCall("transpose", [matrix], strict);
    const removed = matrixCall("remove_row", [matrix, 0], strict) as Array<{ value: number }>;
    removed[0] = { value: -2 };
    expect(observedColumn[0]).toBe(shared);
    expect(matrixCall("get", [copied, 0, 0], strict)).toBe(shared);
    expect(matrixCall("get", [transposed, 0, 1], strict)).toBe(shared);
    shared.value = 7;
    expect((observedColumn[0] as { value: number }).value).toBe(7);
    expect((matrixCall("get", [copied, 1, 0], strict) as { value: number }).value).toBe(7);
  });

  it("validates indexes, dimensions, products and vectors atomically before mutation", () => {
    const matrix = matrixCall("new_int", [2, 2, 1], strict);
    const unchanged = JSON.stringify(matrix);
    for (const [method, args] of [
      ["add_row", [matrix, -1, [1, 2]]],
      ["add_row", [matrix, 3, [1, 2]]],
      ["add_col", [matrix, 0.5, [1, 2]]],
      ["add_col", [matrix, 0, [1]]],
      ["remove_row", [matrix, 2]],
      ["remove_col", [matrix, Number.NaN]],
      ["reshape", [matrix, 1, 3]],
      ["reshape", [matrix, -1, -4]],
      ["swap_rows", [matrix, 0, 2]],
      ["swap_columns", [matrix, 0, Number.POSITIVE_INFINITY]],
    ] as const) {
      expect(() => matrixCall(method, args, strict), method).toThrow(PineRuntimeError);
      expect(JSON.stringify(matrix), method).toBe(unchanged);
    }

    const atLimit = matrixCall("new_int", [1, 99_999, 0], strict);
    matrixCall("add_col", [atLimit], strict);
    expect(matrixCall("elements_count", [atLimit], strict)).toBe(100_000);
    const atLimitSnapshot = JSON.stringify(atLimit);
    expect(() => matrixCall("add_col", [atLimit], strict)).toThrow("maximum of 100000");
    expect(JSON.stringify(atLimit)).toBe(atLimitSnapshot);

    const hugeZeroWidth = matrixCall("new_int", [0, 100_000], strict);
    expect(() => matrixCall("add_col", [hugeZeroWidth], strict)).toThrow("column count exceeds");
    expect(matrixCall("columns", [hugeZeroWidth], strict)).toBe(100_000);
    expect(() => matrixCall("reshape", [hugeZeroWidth, 0, 100_001], strict)).toThrow("column count exceeds");
    expect(matrixCall("columns", [hugeZeroWidth], strict)).toBe(100_000);
  });

  it("preserves sealed coercion, padding, resize and collapsed empty-shape behavior", () => {
    const matrix = matrixCall("new_int", [2, 2, 1]);
    matrixCall("add_row", [matrix, 0.9, [2]]);
    expect(matrixData(matrix)).toEqual([[2, Number.NaN], [1, 1], [1, 1]]);
    matrixCall("add_col", [matrix, 99, [3]]);
    expect(matrixData(matrix)).toEqual([[2, Number.NaN, 3], [1, 1, Number.NaN], [1, 1, Number.NaN]]);
    expect(matrixCall("remove_row", [matrix])).toEqual([2, Number.NaN, 3]);
    expect(matrixCall("remove_col", [matrix])).toEqual([1, 1]);
    matrixCall("reshape", [matrix, 1, 5]);
    expect(matrixData(matrix)).toEqual([[1, Number.NaN, 1, Number.NaN, Number.NaN]]);
    matrixCall("swap_rows", [matrix, 9, 0]);
    matrixCall("swap_columns", [matrix, 9, 0]);
    expect(matrixData(matrix)).toEqual([[1, Number.NaN, 1, Number.NaN, Number.NaN]]);

    const collapsed = matrixCall("transpose", [matrixCall("new_int", [2, 0])]);
    expect(matrixCall("rows", [collapsed])).toBe(0);
    expect(matrixCall("columns", [collapsed])).toBe(0);
  });
});
