import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";

const strict = { strict: true } as const;

function matrix(values: readonly (readonly number[])[], element: "int" | "float" = "float") {
  const result = matrixCall(`new_${element}`, [values.length, values[0]?.length ?? 0, 0], strict);
  for (const [row, entries] of values.entries()) for (const [column, value] of entries.entries()) {
    matrixCall("set", [result, row, column, value], strict);
  }
  return result;
}

describe("strict matrix determinant and rank", () => {
  it("uses literal pivot, sign, rectangular and nonsymmetric rank oracles without mutation", () => {
    const swapped = matrix([[0, 2], [3, 4]]);
    const before = JSON.stringify(swapped);
    expect(matrixCall("det", [swapped], strict)).toBe(-6);
    expect(matrixCall("rank", [swapped], strict)).toBe(2);
    expect(JSON.stringify(swapped)).toBe(before);
    expect(matrixCall("rank", [matrix([[1, 2, 3], [0, 0, 1]])], strict)).toBe(2);
    expect(matrixCall("rank", [matrix([[1, 2], [2, 4]])], strict)).toBe(1);
    // Recorded probe collections-errors.txt.
    expect(() => matrixCall("det", [matrix([[2, 2, 2], [2, 2, 2]])], strict)).toThrow(
      "In the 'matrix.det()' function. Matrix determinant is not available for non-square matrices (2x3).",
    );
  });

  it("applies a relative rank tolerance separately from determinant", () => {
    const scaled = matrix([[1e-6, 0], [0, 1e6]]);
    expect(matrixCall("rank", [scaled], strict)).toBe(2);
    expect(matrixCall("det", [scaled], strict)).toBeCloseTo(1);
    expect(matrixCall("det", [matrix([[1e-200, 0], [0, 1e200]])], strict)).toBeCloseTo(1);
    expect(matrixCall("rank", [matrix([[1, 1e-160], [0, 0]])], strict)).toBe(1);
    const near = matrix([[1, 0], [0, Number.EPSILON / 4]]);
    expect(matrixCall("det", [near], strict)).toBe(Number.EPSILON / 4);
    expect(matrixCall("rank", [near], strict)).toBe(1);
  });

  it("handles empty and missing matrices and rejects invalid domains and overflow", () => {
    const zero = matrixCall("new_float", [0, 0], strict);
    expect([matrixCall("det", [zero], strict), matrixCall("rank", [zero], strict)]).toEqual([0, 0]);
    const missing = matrix([[1, 0], [0, 1]]);
    matrixCall("set", [missing, 0, 1, Number.NaN], strict);
    expect(matrixCall("det", [missing], strict)).toBeNaN();
    expect(matrixCall("rank", [missing], strict)).toBeNaN();
    const stringMatrix = matrixCall("new_string", [0, 0], strict);
    for (const name of ["det", "rank"] as const) {
      expect(() => matrixCall(name, [stringMatrix], strict)).toThrow(/int or float/u);
    }
    const huge = matrix([[1e308, 0], [0, 1e308]]);
    const before = JSON.stringify(huge);
    expect(() => matrixCall("det", [huge], strict)).toThrow(/overflow/u);
    expect(JSON.stringify(huge)).toBe(before);
  });

  it("preflights the numerical work ceiling while admitting maximum-capacity skinny rank shapes", () => {
    const tooWide = matrixCall("new_float", [70, 70, 0], strict);
    const before = JSON.stringify(tooWide);
    expect(() => matrixCall("rank", [tooWide], strict)).toThrow(/work-unit/u);
    expect(JSON.stringify(tooWide)).toBe(before);
    const tall = { __pineMatrix: true, elementKind: "float", columnCount: 2,
      data: Array.from({ length: 50_000 }, (_, row) => [row === 0 ? 1 : 0, row === 1 ? 2 : 0]) } as never;
    const wide = { __pineMatrix: true, elementKind: "float", columnCount: 50_000,
      data: [Array.from({ length: 50_000 }, (_, column) => column === 0 ? 1 : 0),
        Array.from({ length: 50_000 }, (_, column) => column === 1 ? 2 : 0)] } as never;
    expect(matrixCall("rank", [tall], strict)).toBe(2);
    expect(matrixCall("rank", [wide], strict)).toBe(2);
  });

  it("retains sealed coercive determinant behavior", () => {
    const sealed = matrixCall("new_float", [1, 1, "2"]);
    expect(matrixCall("det", [sealed])).toBe(2);
  });
});
