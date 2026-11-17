import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";

const strict = { strict: true } as const;

function floatMatrix(values: readonly (readonly number[])[]) {
  const result = matrixCall("new_float", [values.length, values[0]?.length ?? 0, 0], strict);
  for (const [row, entries] of values.entries()) for (const [column, value] of entries.entries()) {
    matrixCall("set", [result, row, column, value], strict);
  }
  return result;
}

function integerMatrix(values: readonly (readonly number[])[]) {
  const result = matrixCall("new_int", [values.length, values[0]?.length ?? 0, 0], strict);
  for (const [row, entries] of values.entries()) for (const [column, value] of entries.entries()) {
    matrixCall("set", [result, row, column, value], strict);
  }
  return result;
}

function cells(value: unknown): number[][] {
  return (value as { data: number[][] }).data;
}

describe("M4B strict float matrix numerical cases", () => {
  it("inverts represented small nonzero pivots without a fixed absolute threshold", () => {
    const matrix = floatMatrix([[1e-20, 0], [0, 2]]);
    expect(cells(matrixCall("inv", [matrix], strict))).toEqual([[1e20, 0], [0, 0.5]]);
    expect(cells(matrix)).toEqual([[1e-20, 0], [0, 2]]);
  });

  it("takes a rank-deficient rectangular pseudoinverse using its nonzero singular directions", () => {
    const matrix = floatMatrix([[1, 2], [2, 4], [3, 6]]);
    const pseudo = cells(matrixCall("pinv", [matrix], strict));
    expect(pseudo).toHaveLength(2);
    expect(pseudo[0]).toHaveLength(3);
    for (let column = 0; column < 3; column += 1) {
      expect(pseudo[0]![column]).toBeCloseTo((column + 1) / 70, 12);
      expect(pseudo[1]![column]).toBeCloseTo((column + 1) / 35, 12);
    }
    expect(cells(matrix)).toEqual([[1, 2], [2, 4], [3, 6]]);
  });

  it("preserves transposed rank-deficient shape and missing output policy", () => {
    const wide = floatMatrix([[1, 2, 3], [2, 4, 6]]);
    const pseudo = cells(matrixCall("pinv", [wide], strict));
    expect(pseudo).toHaveLength(3);
    expect(pseudo[0]).toHaveLength(2);
    expect(pseudo[2]).toEqual([expect.closeTo(3 / 70, 12), expect.closeTo(3 / 35, 12)]);
    const missing = floatMatrix([[Number.NaN, 0], [0, 1]]);
    expect(cells(matrixCall("pinv", [missing], strict)).flat().every(Number.isNaN)).toBe(true);
  });

  it("reports the reference platform's singular inverse error for dense, diagonal and missing inputs", () => {
    // Recorded probe matrix-inverse-errors.txt and collections-errors.txt.
    const inputs = [
      floatMatrix([[2, 2], [2, 2]]),
      integerMatrix([[2, 2], [2, 2]]),
      floatMatrix([[0, 0], [0, 2]]),
      floatMatrix([[Number.NaN, 0], [0, 2]]),
    ];
    for (const input of inputs) {
      const before = cells(input).map((row) => [...row]);
      expect(() => matrixCall("inv", [input], strict)).toThrow(
        "In the 'matrix.inv()' function. Cannot inverse a singular matrix (matrix determinant is zero).",
      );
      expect(cells(input)).toEqual(before);
    }
    expect(cells(matrixCall("inv", [inputs[0]!])).flat().every(Number.isNaN)).toBe(true);
  });

  it("preserves subnormal pseudoinverse cells and rejects nonfinite inverse results", () => {
    const huge = floatMatrix([[1e308], [1e308]]);
    expect(cells(matrixCall("pinv", [huge], strict))[0]).toEqual([5e-309, 5e-309]);
    const nearMaximum = floatMatrix([[1.7e308], [1.7e308]]);
    const nearMaximumPseudo = cells(matrixCall("pinv", [nearMaximum], strict))[0]!;
    const expectedSubnormal = (1 / 1.7e308) / 2;
    for (const value of nearMaximumPseudo) expect(value / expectedSubnormal).toBeCloseTo(1, 3);
    const tiny = floatMatrix([[1e-308], [1e-308]]);
    expect(cells(matrixCall("pinv", [tiny], strict))[0]).toEqual([5e307, 5e307]);
    expect(() => matrixCall("inv", [floatMatrix([[Number.MIN_VALUE, 0], [0, 1]])], strict))
      .toThrow("finite float values or missing");
  });

  it("uses the same singular-value threshold for a monomial float pseudoinverse", () => {
    const separated = floatMatrix([[1, 0], [0, 1e-20]]);
    expect(cells(matrixCall("pinv", [separated], strict))).toEqual([[1, 0], [0, 0]]);
  });
});

describe("M4B exact structural paths", () => {
  it("handles represented huge negative diagonal powers without enormous denominators", () => {
    const matrix = integerMatrix([[-1, 0], [0, 2]]);
    expect(cells(matrixCall("inv", [matrix], strict))).toEqual([[-1, 0], [0, 0]]);
    expect(cells(matrixCall("pinv", [matrix], strict))).toEqual([[-1, 0], [0, 0]]);
    expect(cells(matrixCall("pow", [matrix, -Number.MAX_SAFE_INTEGER], strict))).toEqual([[-1, 0], [0, 0]]);
    expect(cells(matrix)).toEqual([[-1, 0], [0, 2]]);
  });

  it("uses exact signed permutation cycles and a rectangular monomial pseudoinverse", () => {
    const signed = integerMatrix([[0, -1], [1, 0]]);
    expect(cells(matrixCall("pow", [signed, -1], strict))).toEqual([[0, 1], [-1, 0]]);
    expect(cells(matrixCall("pow", [signed, 2], strict))).toEqual([[-1, 0], [0, -1]]);
    expect(cells(matrixCall("pow", [signed, 2 ** 53 + 2], strict))).toEqual([[-1, 0], [0, -1]]);
    const rectangular = integerMatrix([[2, 0, 0], [0, 0, -1]]);
    expect(cells(matrixCall("pinv", [rectangular], strict))).toEqual([[0, 0], [0, 0], [0, -1]]);
  });

  it("rejects invalid powers and singular inverses without mutating the source", () => {
    const matrix = integerMatrix([[0, 0], [0, 1]]);
    expect(() => matrixCall("pow", [matrix, 0.5], strict)).toThrow("finite integer power");
    expect(() => matrixCall("inv", [matrix], strict)).toThrow("Cannot inverse a singular matrix");
    expect(cells(matrix)).toEqual([[0, 0], [0, 1]]);
  });
});

describe("M4B exact integer matrix algebra", () => {
  it("keeps the sealed inverse and negative-power results separate", () => {
    const input = integerMatrix([[-5, -4], [-4, -3]]);
    expect(cells(matrixCall("inv", [input], strict))).toEqual([[3, -4], [-4, 5]]);
    expect(cells(matrixCall("inv", [input]))).toEqual([[2, -3], [-3, 4]]);
    expect(cells(matrixCall("pow", [input, -1]))).toEqual([[1, 0], [0, 1]]);
  });

  it("uses an independent inverse identity for signed powers and represented large cells", () => {
    const matrix = integerMatrix([[1, 2], [3, 5]]);
    expect(cells(matrixCall("pow", [matrix, -2], strict))).toEqual([[31, -12], [-18, 7]]);
    const huge = 2 ** 53 + 2;
    const represented = integerMatrix([[huge, 1], [1, 0]]);
    expect(cells(matrixCall("inv", [represented], strict))).toEqual([[0, 1], [1, -huge]]);
  });

  it("computes an exact rank-deficient square and rectangular pseudoinverse", () => {
    const deficient = integerMatrix([[1, 1, 0], [0, 1, 0], [0, 0, 0]]);
    expect(cells(matrixCall("pinv", [deficient], strict))).toEqual([[1, -1, 0], [0, 1, 0], [0, 0, 0]]);
    const wide = integerMatrix([[1, 1, 0], [0, 1, 0]]);
    expect(cells(matrixCall("pinv", [wide], strict))).toEqual([[1, -1], [0, 1], [0, 0]]);
    const sparse = integerMatrix([[2, 0, 0], [0, 3, 1], [0, 1, 2], [0, 0, 0]]);
    expect(cells(matrixCall("pinv", [sparse], strict))).toEqual([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const swapped = integerMatrix([[0, 1, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0]]);
    expect(cells(matrixCall("pinv", [swapped], strict))).toEqual([[0, 1, 0, 0], [1, 0, -1, 0], [0, 0, 1, 0]]);
    const skipped = integerMatrix([[0, 1, 1, 0], [0, 0, 1, 0], [0, 0, 0, 0]]);
    expect(cells(matrixCall("pinv", [skipped], strict))).toEqual([[0, 0, 0], [1, -1, 0], [0, 1, 0], [0, 0, 0]]);
  });

  it("uses BigInt multiplication for a huge represented positive shear power", () => {
    const shear = integerMatrix([[1, 1], [0, 1]]);
    expect(cells(matrixCall("pow", [shear, Number.MAX_SAFE_INTEGER], strict)))
      .toEqual([[1, Number.MAX_SAFE_INTEGER], [0, 1]]);
  });

  it("does not classify a nearly monomial float matrix as structural", () => {
    const near = floatMatrix([[1, 1e-20], [0, 1]]);
    expect(cells(matrixCall("inv", [near], strict))).toEqual([[1, -1e-20], [0, 1]]);
  });

  it("handles a nonnormal contracting inverse and singular negative powers", () => {
    const nonnormal = integerMatrix([[2, -8], [0, 2]]);
    expect(cells(matrixCall("pow", [nonnormal, -10], strict))).toEqual([[0, 0], [0, 0]]);
    expect(cells(matrixCall("pow", [nonnormal, -Number.MAX_SAFE_INTEGER], strict))).toEqual([[0, 0], [0, 0]]);
    const singular = integerMatrix([[1, 1], [1, 1]]);
    expect(cells(matrixCall("pow", [singular, -1], strict)).flat().every(Number.isNaN)).toBe(true);
    expect(cells(singular)).toEqual([[1, 1], [1, 1]]);
  });

  it("rejects finite input whose exact inverse cannot fit a finite result atomically", () => {
    const input = integerMatrix([[1, 1e200, 0], [0, 1, 1e200], [0, 0, 1]]);
    expect(() => matrixCall("inv", [input], strict)).toThrow("finite int values or missing");
    expect(cells(input)).toEqual([[1, 1e200, 0], [0, 1, 1e200], [0, 0, 1]]);
  });
});
