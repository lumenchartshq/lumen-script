import { describe, expect, it } from "vitest";

import { arrayCall, matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const strict = { strict: true } as const;

describe("strict matrix numeric runtime candidate", () => {
  it("omits missing values and retains the smallest mode on ties and no repeat", () => {
    const matrix = matrixCall("new_float", [2, 3, Number.NaN], strict);
    for (const [row, column, value] of [[0, 0, 4], [0, 1, -2], [1, 0, 4], [1, 1, -2], [1, 2, 9]] as const) {
      matrixCall("set", [matrix, row, column, value], strict);
    }
    const before = JSON.stringify(matrix);
    expect(matrixCall("min", [matrix], strict)).toBe(-2);
    expect(matrixCall("max", [matrix], strict)).toBe(9);
    expect(matrixCall("mode", [matrix], strict)).toBe(-2);
    expect(JSON.stringify(matrix)).toBe(before);

    const unique = matrixCall("new_int", [1, 3, 0], strict);
    matrixCall("set", [unique, 0, 0, 7], strict);
    matrixCall("set", [unique, 0, 1, 1], strict);
    matrixCall("set", [unique, 0, 2, 3], strict);
    expect(matrixCall("mode", [unique], strict)).toBe(1);
    for (const empty of [matrixCall("new_float", [], strict), matrixCall("new_float", [1, 2], strict)]) {
      for (const name of ["min", "max", "mode"] as const) expect(matrixCall(name, [empty], strict)).toBeNaN();
    }
  });

  it("scans a full-capacity matrix without spread extrema or changing the source", () => {
    const matrix = matrixCall("new_float", [1, 100_000, 1], strict);
    matrixCall("set", [matrix, 0, 99_999, -3], strict);
    expect(matrixCall("min", [matrix], strict)).toBe(-3);
    expect(matrixCall("max", [matrix], strict)).toBe(1);
    expect(matrixCall("mode", [matrix], strict)).toBe(1);
    expect(matrixCall("get", [matrix, 0, 99_999], strict)).toBe(-3);

    const unique = {
      __pineMatrix: true,
      elementKind: "int",
      columnCount: 100_000,
      data: [Array.from({ length: 100_000 }, (_, index) => index)],
    } as never;
    expect(matrixCall("mode", [unique], strict)).toBe(0);
  });

  it("uses the partial rectangular diagonal and validates all host values", () => {
    const matrix = matrixCall("new_float", [2, 3, 0], strict);
    matrixCall("set", [matrix, 0, 0, 4], strict);
    matrixCall("set", [matrix, 1, 1, -7], strict);
    matrixCall("set", [matrix, 0, 2, Number.NaN], strict);
    expect(matrixCall("trace", [matrix], strict)).toBe(-3);
    expect(matrixCall("trace", [matrixCall("new_float", [], strict)], strict)).toBe(0);
    matrixCall("set", [matrix, 1, 1, Number.NaN], strict);
    expect(matrixCall("trace", [matrix], strict)).toBeNaN();

    for (const invalid of ["2", true, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => matrixCall("set", [matrix, 0, 2, invalid], strict)).toThrow(PineRuntimeError);
      const current = matrix as { __pineMatrix: true; elementKind: string; columnCount: number; data: unknown[][] };
      const corrupted = { ...current, data: current.data.map((row) => [...row]) } as never;
      (corrupted as { data: unknown[][] }).data[0]![2] = invalid;
      for (const name of ["min", "max", "mode", "trace"] as const) {
        expect(() => matrixCall(name, [corrupted], strict), name).toThrow(PineRuntimeError);
      }
    }

    const cancellation = matrixCall("new_float", [3, 3, 0], strict);
    matrixCall("set", [cancellation, 0, 0, 1e16], strict);
    matrixCall("set", [cancellation, 1, 1, -1e16], strict);
    matrixCall("set", [cancellation, 2, 2, 2], strict);
    expect(matrixCall("trace", [cancellation], strict)).toBe(2);
  });

  it("keeps copy and checkpoint values independent and sealed coercion intact", () => {
    const matrix = matrixCall("new_float", [1, 2, 1], strict);
    const copy = matrixCall("copy", [matrix], strict);
    const restored = JSON.parse(JSON.stringify(copy)) as never;
    matrixCall("set", [copy, 0, 0, -4], strict);
    expect(matrixCall("min", [matrix], strict)).toBe(1);
    expect(matrixCall("min", [restored], strict)).toBe(1);
    expect(matrixCall("min", [copy], strict)).toBe(-4);

    const sealed = matrixCall("new_float", [1, 2, "5"]);
    expect(matrixCall("min", [sealed])).toBe(5);
    expect(matrixCall("max", [sealed])).toBe(5);
    expect(matrixCall("mode", [sealed])).toBe(5);
    expect(matrixCall("trace", [sealed])).toBe(5);
    expect(arrayCall("mode", [["c", "a", "b", "c", "a"]])).toBe("a");
  });
});
