import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const strict = { strict: true } as const;
const data = (matrix: unknown): unknown[][] => (matrix as { data: unknown[][] }).data;
const kind = (matrix: unknown): unknown => (matrix as { elementKind?: unknown }).elementKind;
const matrix = (kindName: "int" | "float", rows: readonly (readonly number[])[]) => {
  const result = matrixCall(`new_${kindName}`, [rows.length, rows[0]?.length ?? 0], strict);
  for (const [row, values] of rows.entries()) for (const [column, value] of values.entries()) matrixCall("set", [result, row, column, value], strict);
  return result;
};

describe("strict M3 matrix operations", () => {
  it("computes literal signed rectangular sums, differences, products and vectors without changing inputs", () => {
    const left = matrix("int", [[2, -1, 3], [0, 4, -2]]);
    const peer = matrix("int", [[-5, 6, 1], [7, -3, 2]]);
    const before = JSON.stringify(left);
    expect(data(matrixCall("sum", [left, peer, "int"], strict))).toEqual([[-3, 5, 4], [7, 1, 0]]);
    expect(data(matrixCall("diff", [left, peer, "int"], strict))).toEqual([[7, -7, 2], [-7, 7, -4]]);
    const wholeFloats = matrix("float", [[2, -1, 3], [0, 4, -2]]);
    const mixed = matrixCall("sum", [peer, wholeFloats, "float"], strict);
    expect(kind(mixed)).toBe("float");
    expect(data(mixed)).toEqual([[-3, 5, 4], [7, 1, 0]]);
    const scalar = matrixCall("diff", [left, -1.5, "float"], strict);
    expect(kind(scalar)).toBe("float");
    expect(data(scalar)).toEqual([[3.5, 0.5, 4.5], [1.5, 5.5, -0.5]]);
    const doubled = matrixCall("mult", [left, -2, "int"], strict);
    expect(data(doubled)).toEqual([[-4, 2, -6], [0, -8, 4]]);
    const right = matrix("int", [[1, 2], [-3, 0], [4, -1]]);
    expect(data(matrixCall("mult", [left, right, "int"], strict))).toEqual([[17, 1], [-20, 2]]);
    expect(matrixCall("mult", [left, [2, -1, 3], "int"], strict)).toEqual([14, -10]);
    expect(matrixCall("mult", [left, [2, -1, 3], "float"], strict)).toEqual([14, -10]);
    expect(JSON.stringify(left)).toBe(before);
  });

  it("computes rectangular Kronecker products and kind promotion from declared matrix kinds", () => {
    const left = matrix("int", [[2, -1]]);
    const right = matrix("float", [[-3, 4], [0, 5]]);
    const product = matrixCall("kron", [left, right], strict);
    expect(kind(product)).toBe("float");
    expect(data(product)).toEqual([[-6, 8, 3, -4], [0, 10, 0, -5]]);
    const integral = matrixCall("kron", [left, matrix("int", [[-3, 4], [0, 5]])], strict);
    expect(kind(integral)).toBe("int");
    expect(data(integral)).toEqual(data(product));
  });

  it("propagates missing values, rejects nonnumeric operands and overflow, and checks dimensions", () => {
    const left = matrix("float", [[1, 2], [3, 4]]);
    matrixCall("set", [left, 0, 1, Number.NaN], strict);
    expect(Number.isNaN(data(matrixCall("sum", [left, 1, "float"], strict))[0]![1])).toBe(true);
    expect(Number.isNaN(data(matrixCall("diff", [left, null, "float"], strict))[1]![0])).toBe(true);
    expect(Number.isNaN((matrixCall("mult", [left, [1, 2], "float"], strict) as number[])[0])).toBe(true);
    expect(Number.isNaN(data(matrixCall("kron", [left, matrix("float", [[2]])], strict))[0]![1])).toBe(true);
    for (const [name, operand, resultKind] of [
      ["sum", "2", "float"], ["diff", true, "float"], ["mult", [1, "2"], "float"],
      ["kron", matrixCall("new_string", [1, 1, "2"], strict), undefined],
    ] as const) {
      const before = JSON.stringify(left);
      expect(() => matrixCall(name, resultKind === undefined ? [left, operand] : [left, operand, resultKind], strict), name).toThrow(PineRuntimeError);
      expect(JSON.stringify(left), name).toBe(before);
    }
    const nonnumeric = matrixCall("new_string", [1, 1, "2"], strict);
    for (const name of ["sum", "diff", "mult", "kron"] as const) {
      expect(() => matrixCall(name, [nonnumeric, name === "kron" ? nonnumeric : 1, "int"], strict), name).toThrow(/int or float matrix/u);
    }
    expect(() => matrixCall("kron", [left, 2], strict)).toThrow(PineRuntimeError);
    expect(() => matrixCall("sum", [left, matrix("float", [[1]]), "float"], strict)).toThrow(/dimensions/u);
    expect(() => matrixCall("mult", [left, matrix("float", [[1]]), "float"], strict)).toThrow(/columns must match/u);
    expect(() => matrixCall("mult", [left, [1], "float"], strict)).toThrow(/vector length/u);
    expect(() => matrixCall("kron", [matrixCall("new_int", [1_000, 0], strict), matrixCall("new_int", [101, 0], strict)], strict)).toThrow(/row count exceeds/u);
    expect(() => matrixCall("kron", [matrixCall("new_int", [1_000, 1, 1], strict), matrixCall("new_int", [1, 101, 1], strict)], strict)).toThrow(/maximum/u);
    expect(() => matrixCall("mult", [matrixCall("new_int", [501, 1, 1], strict), matrixCall("new_int", [1, 200, 1], strict), "int"], strict)).toThrow(/maximum/u);
    expect(() => matrixCall("sum", [matrix("float", [[1e308]]), 1e308, "float"], strict)).toThrow(/finite float/u);
    const zeroByThree = matrixCall("new_int", [0, 3], strict);
    expect(kind(matrixCall("sum", [zeroByThree, 2, "int"], strict))).toBe("int");
    expect(data(matrixCall("mult", [zeroByThree, matrixCall("new_int", [3, 2], strict), "int"], strict))).toEqual([]);
    expect((matrixCall("mult", [zeroByThree, [1, 2, 3], "int"], strict) as unknown[])).toEqual([]);
  });

  it("concatenates atomically with self alias, independent rows, shaped empties and bounded capacity", () => {
    const left = matrix("int", [[1, 2], [3, 4]]);
    const right = matrix("int", [[5, 6]]);
    expect(matrixCall("concat", [left, right], strict)).toBe(left);
    expect(data(left)).toEqual([[1, 2], [3, 4], [5, 6]]);
    matrixCall("set", [right, 0, 0, 9], strict);
    expect(data(left)[2]).toEqual([5, 6]);
    expect(matrixCall("concat", [left, left], strict)).toBe(left);
    expect(data(left)).toEqual([[1, 2], [3, 4], [5, 6], [1, 2], [3, 4], [5, 6]]);
    const before = JSON.stringify(left);
    for (const other of [matrix("int", [[1]]), matrixCall("new_float", [1, 2, 1], strict)]) {
      expect(() => matrixCall("concat", [left, other], strict)).toThrow(PineRuntimeError);
      expect(JSON.stringify(left)).toBe(before);
    }
    expect(() => matrixCall("concat", [left, 2], strict)).toThrow(PineRuntimeError);
    const empty = matrixCall("new_int", [0, 0], strict);
    matrixCall("concat", [empty, matrixCall("new_int", [0, 3], strict)], strict);
    expect(matrixCall("columns", [empty], strict)).toBe(3);
    expect(() => matrixCall("concat", [empty, matrixCall("new_int", [0, 2], strict)], strict)).toThrow(/column counts/u);
    matrixCall("concat", [empty, matrixCall("new_int", [2, 3, 1], strict)], strict);
    expect(data(empty)).toEqual([[1, 1, 1], [1, 1, 1]]);
    matrixCall("concat", [empty, matrixCall("new_int", [0, 0], strict)], strict);
    expect(data(empty)).toHaveLength(2);
    const zeroWidth = matrixCall("new_int", [50_000, 0], strict);
    matrixCall("concat", [zeroWidth, zeroWidth], strict);
    expect(data(zeroWidth)).toHaveLength(100_000);
    expect(() => matrixCall("concat", [zeroWidth, matrixCall("new_int", [1, 0], strict)], strict)).toThrow(/row count exceeds/u);
    const shared = { __pineType: "Item", value: 1 };
    const objects = matrixCall("new_Item", [1, 1, shared], strict);
    const objectResult = matrixCall("concat", [objects, objects], strict);
    expect(data(objectResult)[0]).not.toBe(data(objectResult)[1]);
    expect(data(objectResult)[0]![0]).toBe(data(objectResult)[1]![0]);
  });

  it("sorts stable associated rows with missing, string and UDT keys and fails before mutation", () => {
    const numeric = matrix("float", [[2, 10], [1, 11], [2, 12], [Number.NaN, 13], [2, 14]]);
    expect(matrixCall("sort", [numeric], strict)).toBeNull();
    expect(data(numeric)).toEqual([[1, 11], [2, 10], [2, 12], [2, 14], [Number.NaN, 13]]);
    matrixCall("sort", [numeric, 0, 0], strict);
    expect(data(numeric)).toEqual([[Number.NaN, 13], [2, 10], [2, 12], [2, 14], [1, 11]]);
    const strings = matrixCall("new_string", [3, 2, ""], strict);
    for (const [row, key, companion] of [[0, "b", "B"], [1, "", "E"], [2, "A", "A"]] as const) {
      matrixCall("set", [strings, row, 0, key], strict);
      matrixCall("set", [strings, row, 1, companion], strict);
    }
    matrixCall("sort", [strings], strict);
    expect(data(strings)).toEqual([["A", "A"], ["b", "B"], ["", "E"]]);
    const obj = (score: number, tag: string) => ({ __pineType: "Item", score, tag });
    const udt = matrixCall("new_Item", [3, 1, obj(2, "a")], strict);
    matrixCall("set", [udt, 1, 0, obj(1, "b")], strict);
    matrixCall("set", [udt, 2, 0, obj(2, "c")], strict);
    matrixCall("sort", [udt, 0, 1, "score"], strict);
    expect(data(udt).map((row) => (row[0] as { tag: string }).tag)).toEqual(["b", "a", "c"]);
    const before = JSON.stringify(udt);
    for (const args of [[1.5], [-1], [1], [0, "bad"], [0, 1, "missing"]] as const) {
      expect(() => matrixCall("sort", [udt, ...args], strict)).toThrow(PineRuntimeError);
      expect(JSON.stringify(udt)).toBe(before);
    }
    const laterBad = matrixCall("new_Item", [3, 1, obj(2, "a")], strict);
    matrixCall("set", [laterBad, 2, 0, { __pineType: "Item", score: true, tag: "bad" }], strict);
    const beforeBad = JSON.stringify(laterBad);
    expect(() => matrixCall("sort", [laterBad, 0, 1, "score"], strict)).toThrow(PineRuntimeError);
    expect(JSON.stringify(laterBad)).toBe(beforeBad);
    expect(matrixCall("sort", [matrixCall("new_int", [0, 0], strict)], strict)).toBeNull();
    expect(() => matrixCall("sort", [matrixCall("new_int", [1, 0], strict)], strict)).toThrow(/column/u);
  });

  it("retains sealed arithmetic coercion and sort semantics", () => {
    const legacy = matrixCall("new_string", [1, 1, "2"]);
    expect(data(matrixCall("sum", [legacy, 1]))).toEqual([[3]]);
    const sorted = matrixCall("new_int", [2, 1, 0]);
    matrixCall("set", [sorted, 0, 0, 2]);
    matrixCall("set", [sorted, 1, 0, 1]);
    matrixCall("sort", [sorted]);
    expect(data(sorted)).toEqual([[1], [2]]);
  });
});
