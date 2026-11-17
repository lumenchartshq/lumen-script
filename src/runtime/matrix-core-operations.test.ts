import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const strict = { strict: true, negativeIndices: true } as const;

describe("strict matrix core runtime", () => {
  it("constructs bounded rectangular matrices with typed-missing-compatible defaults", () => {
    const empty = matrixCall("new_int", [], strict);
    expect(empty).toMatchObject({ data: [] });
    expect(matrixCall("rows", [empty], strict)).toBe(0);
    expect(matrixCall("columns", [empty], strict)).toBe(0);

    const rowsOnly = matrixCall("new_float", [3], strict);
    expect(rowsOnly).toMatchObject({ data: [[], [], []] });
    expect(matrixCall("rows", [rowsOnly], strict)).toBe(3);
    expect(matrixCall("columns", [rowsOnly], strict)).toBe(0);

    const columnsOnly = matrixCall("new_float", [undefined as never, 3], strict);
    expect(columnsOnly).toMatchObject({ data: [] });
    expect(matrixCall("rows", [columnsOnly], strict)).toBe(0);
    expect(matrixCall("columns", [columnsOnly], strict)).toBe(3);
    expect(matrixCall("elements_count", [columnsOnly], strict)).toBe(0);
    expect(matrixCall("col", [columnsOnly, 2], strict)).toEqual([]);
    expect(matrixCall("columns", [matrixCall("copy", [columnsOnly], strict)], strict)).toBe(3);
    const restoredColumnsOnly = JSON.parse(JSON.stringify(columnsOnly)) as never;
    expect(matrixCall("columns", [restoredColumnsOnly], strict)).toBe(3);
    expect(() => matrixCall("submatrix", [restoredColumnsOnly, 0, 0, 0, 3], strict)).toThrow(PineRuntimeError);

    const scalar = matrixCall("new_float", [2, 2], strict) as { data: unknown[][] };
    expect(scalar.data.flat().every((value) => typeof value === "number" && Number.isNaN(value))).toBe(true);
    const atLimit = matrixCall("new_int", [250, 400, 7], strict) as { data: unknown[][] };
    expect(atLimit.data).toHaveLength(250);
    expect(atLimit.data[0]).toHaveLength(400);

    for (const [rows, columns] of [
      [-1, 1], [1, -1], [0.5, 1], [1, 0.5], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY],
      [100_001, 0], [0, 100_001], [500, 201],
    ] as const) {
      expect(() => matrixCall("new_int", [rows, columns, 0], strict), `${String(rows)}x${String(columns)}`)
        .toThrow(PineRuntimeError);
    }
  });

  it("reads, writes and fills exact row-major cells without partial failure", () => {
    const matrix = matrixCall("new_int", [2, 3, 0], strict);
    matrixCall("set", [matrix, 0, 0, 1], strict);
    matrixCall("set", [matrix, 0, 1, 2], strict);
    matrixCall("set", [matrix, 0, 2, 3], strict);
    matrixCall("set", [matrix, 1, 0, 4], strict);
    matrixCall("set", [matrix, 1, 1, 5], strict);
    matrixCall("set", [matrix, 1, 2, 6], strict);
    expect(matrixCall("rows", [matrix], strict)).toBe(2);
    expect(matrixCall("columns", [matrix], strict)).toBe(3);
    expect(matrixCall("elements_count", [matrix], strict)).toBe(6);
    expect(matrixCall("get", [matrix, 1, 2], strict)).toBe(6);

    matrixCall("fill", [matrix, 9, 0, 2, 1, 3], strict);
    expect(matrix).toMatchObject({ data: [[1, 9, 9], [4, 9, 9]] });
    matrixCall("fill", [matrix, 7, 1, 1, 0, 3], strict);
    expect(matrix).toMatchObject({ data: [[1, 9, 9], [4, 9, 9]] });

    for (const args of [
      [matrix, 0.5, 0, 8], [matrix, 0, Number.NaN, 8], [matrix, 2, 0, 8],
    ] as const) {
      expect(() => matrixCall("set", args, strict)).toThrow(PineRuntimeError);
      expect(matrix).toMatchObject({ data: [[1, 9, 9], [4, 9, 9]] });
    }
    for (const args of [
      [matrix, 8, -1, 1, 0, 1], [matrix, 8, 1, 0, 0, 1], [matrix, 8, 0, 3, 0, 1],
      [matrix, 8, 0, 1, 0.5, 1], [matrix, 8, 0, 1, 0, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => matrixCall("fill", args, strict)).toThrow(PineRuntimeError);
      expect(matrix).toMatchObject({ data: [[1, 9, 9], [4, 9, 9]] });
    }
  });

  it("returns independent containers while retaining shallow object aliases", () => {
    const shared = { __pineType: "Item", value: 1 } as never;
    const matrix = matrixCall("new_Item", [2, 2, shared], strict);
    const copied = matrixCall("copy", [matrix], strict) as { data: Array<Array<{ value: number }>> };
    const row = matrixCall("row", [matrix, 0], strict) as Array<{ value: number }>;
    const column = matrixCall("col", [matrix, 0], strict) as Array<{ value: number }>;
    const section = matrixCall("submatrix", [matrix, 0, 1, 0, 1], strict) as { data: Array<Array<{ value: number }>> };

    copied.data[0]![0] = { value: -1 };
    row[0] = { value: -2 };
    column[0] = { value: -3 };
    section.data[0]![0] = { value: -4 };
    expect(matrixCall("get", [matrix, 0, 0], strict)).toBe(shared);
    copied.data[1]![1]!.value = 7;
    expect((matrixCall("get", [matrix, 1, 1], strict) as { value: number }).value).toBe(7);
    expect(row[1]).toBe(shared);
    expect(column[1]).toBe(shared);
  });

  it("rejects invalid indexes, submatrix ranges, missing handles and ragged storage", () => {
    const matrix = matrixCall("new_int", [2, 2, 1], strict);
    for (const [method, args] of [
      ["get", [matrix, -1, 0]], ["get", [matrix, 0, 2]], ["row", [matrix, 2]], ["col", [matrix, 0.5]],
      ["submatrix", [matrix, 0, 0, 0, 1]], ["submatrix", [matrix, 1, 0, 0, 1]],
      ["submatrix", [matrix, 0, 3, 0, 1]], ["submatrix", [matrix, 0, 1, 0, Number.NaN]],
    ] as const) {
      expect(() => matrixCall(method, args, strict), method).toThrow(PineRuntimeError);
    }
    expect(() => matrixCall("get", [Number.NaN, 0, 0], strict)).toThrow("Expected a matrix");
    const ragged = { __pineMatrix: true, data: [[1, 2], [3]] } as never;
    expect(() => matrixCall("copy", [ragged], strict)).toThrow(PineRuntimeError);
    expect(() => matrixCall("submatrix", [ragged, 0, 1, 0, 1], strict)).toThrow(PineRuntimeError);
  });

  it("preserves the sealed coercion and permissive range boundary", () => {
    const omitted = matrixCall("new_int", []);
    expect(omitted).toMatchObject({ data: [] });
    expect(matrixCall("rows", [omitted])).toBe(0);
    expect(matrixCall("columns", [omitted])).toBe(0);
    const lostZeroRowWidth = matrixCall("new_int", [undefined as never, 3]);
    expect(matrixCall("columns", [lostZeroRowWidth])).toBe(0);

    const sealedSource = matrixCall("new_float", [2, 2, 1]);
    const emptySection = matrixCall("submatrix", [sealedSource, 0, 0, 0, 2]);
    expect(emptySection).toMatchObject({ data: [] });
    expect(matrixCall("columns", [emptySection])).toBe(0);
    expect(matrixCall("columns", [matrixCall("copy", [emptySection])])).toBe(0);
    const restoredEmptySection = JSON.parse(JSON.stringify(emptySection)) as never;
    expect(matrixCall("columns", [restoredEmptySection])).toBe(0);

    const matrix = matrixCall("new_int", [1.8, 2.9, 3]);
    expect(matrix).toMatchObject({ data: [[3, 3]] });
    expect(matrixCall("row", [matrix, 9])).toEqual([]);
    expect(matrixCall("col", [matrix, 9])).toEqual([]);
    matrixCall("fill", [matrix, 4, -10, 10, -10, 1]);
    expect(matrix).toMatchObject({ data: [[4, 3]] });
    expect(matrixCall("submatrix", [matrix, 0, 0, 0, 1])).toMatchObject({ data: [] });
    expect(matrixCall("new_int", [-2, 3, 1])).toMatchObject({ data: [] });
  });
});
