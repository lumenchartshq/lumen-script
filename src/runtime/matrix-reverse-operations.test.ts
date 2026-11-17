import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const strict = { strict: true } as const;
type Matrix = { columnCount: number; data: unknown[][] };
const asMatrix = (value: unknown) => value as Matrix;

function fromRows(rows: readonly (readonly unknown[])[]) {
  const numeric = rows.every((row) => row.every((cell) => typeof cell === "number"));
  const value = matrixCall(numeric ? "new_float" : "new_Item", [rows.length, rows[0]?.length ?? 0, numeric ? 0 : Number.NaN], strict);
  for (const [r, row] of rows.entries()) for (const [c, cell] of row.entries()) matrixCall("set", [value, r, c, cell as never], strict);
  return value;
}

describe("strict matrix.reverse runtime", () => {
  it("reverses whole row-major contents in place and restores them on a second call", () => {
    const value = fromRows([[1, 2, 3], [4, 5, 6]]);
    matrixCall("reverse", [value], strict);
    expect(asMatrix(value).data).toEqual([[6, 5, 4], [3, 2, 1]]);
    expect(matrixCall("rows", [value], strict)).toBe(2);
    expect(matrixCall("columns", [value], strict)).toBe(3);
    matrixCall("reverse", [value], strict);
    expect(asMatrix(value).data).toEqual([[1, 2, 3], [4, 5, 6]]);
    const words = fromRows([["a", "b"], ["c", "d"]]);
    matrixCall("reverse", [words], strict);
    expect(asMatrix(words).data).toEqual([["d", "c"], ["b", "a"]]);
    const sealed = fromRows([[1, 2], [3, 4]]);
    matrixCall("reverse", [sealed]);
    expect(asMatrix(sealed).data).toEqual([[4, 3], [2, 1]]);
  });

  it("preserves object aliases, missing values and empty shapes", () => {
    const item = { value: 1 };
    const value = fromRows([[item, Number.NaN], [{ value: 3 }, item]]);
    matrixCall("reverse", [value], strict);
    expect(asMatrix(value).data[0]?.[0]).toBe(item);
    expect(asMatrix(value).data[1]?.[1]).toBe(item);
    item.value = 9;
    expect(asMatrix(value).data[0]?.[0]).toEqual({ value: 9 });
    expect(asMatrix(value).data[1]?.[0]).toBeNaN();
    for (const [rows, columns] of [[0, 0], [0, 3], [3, 0], [1, 1]] as const) {
      const empty = matrixCall("new_int", [rows, columns, 7], strict);
      matrixCall("reverse", [empty], strict);
      expect(matrixCall("rows", [empty], strict)).toBe(rows);
      expect(matrixCall("columns", [empty], strict)).toBe(columns);
      expect(asMatrix(empty).data).toEqual(Array.from({ length: rows }, () => Array.from({ length: columns }, () => 7)));
    }
  });

  it("rejects malformed or oversized matrices before mutation", () => {
    const cases = [
      { columnCount: 2, data: [[1, 2], [3]] },
      { columnCount: 2, data: [[1, 2], [3, 4, 5]] },
      { columnCount: 3, data: [[1, 2]] },
      { columnCount: 2, data: [[1, 2], [3, 4]] },
      { columnCount: 100_001, data: [] },
    ];
    Reflect.deleteProperty(cases[3]!.data[1]!, "0");
    for (const candidate of cases) {
      const value = { __pineMatrix: true, elementKind: "int", ...candidate } as never;
      const before = JSON.stringify(value);
      expect(() => matrixCall("reverse", [value], strict)).toThrow(PineRuntimeError);
      expect(JSON.stringify(value)).toBe(before);
    }
    const boundary = matrixCall("new_int", [1, 100_000, 1], strict);
    matrixCall("reverse", [boundary], strict);
    expect(matrixCall("elements_count", [boundary], strict)).toBe(100_000);
    expect(() => matrixCall("new_int", [1, 100_001, 1], strict)).toThrow(PineRuntimeError);
  });
});
