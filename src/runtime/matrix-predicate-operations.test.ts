import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";

const strict = { strict: true, negativeIndices: true } as const;

const names = [
  "is_antidiagonal", "is_antisymmetric", "is_binary", "is_diagonal", "is_identity",
  "is_square", "is_stochastic", "is_symmetric", "is_triangular", "is_zero",
] as const;

function fromRows(rows: readonly (readonly number[])[]) {
  const matrix = matrixCall("new_float", [rows.length, rows[0]?.length ?? 0, 0], strict);
  for (const [row, values] of rows.entries()) {
    for (const [column, value] of values.entries()) matrixCall("set", [matrix, row, column, value], strict);
  }
  return matrix;
}

describe("strict matrix predicate runtime", () => {
  it("distinguishes each exact true and false pattern without altering its source", () => {
    const cases = [
      ["is_antidiagonal", [[0, 2], [3, 0]], [[1, 2], [3, 0]]],
      ["is_antisymmetric", [[0, 2], [-2, 0]], [[0, 2], [-3, 0]]],
      ["is_binary", [[0, 1], [1, 0]], [[0, 1], [2, 0]]],
      ["is_diagonal", [[2, 0], [0, 3]], [[2, 1], [0, 3]]],
      ["is_identity", [[1, 0], [0, 1]], [[1, 0], [0, 2]]],
      ["is_square", [[1, 2], [3, 4]], [[1, 2, 3], [4, 5, 6]]],
      ["is_stochastic", [[0.25, 0.75], [0.6, 0.4]], [[0.25, 0.75], [-0.1, 1.1]]],
      ["is_symmetric", [[1, 2], [2, 3]], [[1, 2], [3, 3]]],
      ["is_triangular", [[1, 2], [0, 3]], [[1, 2], [3, 4]]],
      ["is_zero", [[0, 0], [0, 0]], [[0, 0], [0, 1]]],
    ] as const;
    for (const [name, positive, negative] of cases) {
      const yes = fromRows(positive);
      const no = fromRows(negative);
      const beforeYes = structuredClone(yes);
      const beforeNo = structuredClone(no);
      expect(matrixCall(name, [yes], strict), `${name}/true`).toBe(true);
      expect(matrixCall(name, [no], strict), `${name}/false`).toBe(false);
      expect(yes, `${name}/pure true`).toEqual(beforeYes);
      expect(no, `${name}/pure false`).toEqual(beforeNo);
    }
    expect(matrixCall("is_triangular", [fromRows([[1, 0], [2, 3]])], strict)).toBe(true);
    expect(matrixCall("is_antisymmetric", [fromRows([[1, 2], [-2, 0]])], strict)).toBe(false);
    expect(matrixCall("is_stochastic", [fromRows([[0.5, 0.5], [0.25, 0.5]])], strict)).toBe(false);
  });

  it("uses declared dimensions for empty, rectangular and singleton shapes", () => {
    const empty = matrixCall("new_int", [0, 0, 0], strict);
    const zeroRows = matrixCall("new_int", [0, 2, 0], strict);
    const zeroColumns = matrixCall("new_int", [2, 0, 0], strict);
    for (const matrix of [empty, zeroRows, zeroColumns]) {
      expect(matrixCall("is_zero", [matrix], strict)).toBe(true);
      for (const name of names.filter((candidate) => !["is_zero", "is_square"].includes(candidate))) {
        expect(matrixCall(name, [matrix], strict), name).toBe(false);
      }
    }
    expect(matrixCall("is_square", [empty], strict)).toBe(true);
    expect(matrixCall("is_square", [zeroRows], strict)).toBe(false);
    expect(matrixCall("is_square", [zeroColumns], strict)).toBe(false);
    expect(matrixCall("columns", [zeroRows], strict)).toBe(2);
    expect(matrixCall("rows", [zeroColumns], strict)).toBe(2);

    const rectangular = fromRows([[0, 0, 0], [0, 0, 0]]);
    for (const name of ["is_antidiagonal", "is_antisymmetric", "is_diagonal", "is_identity", "is_square", "is_symmetric", "is_triangular"]) {
      expect(matrixCall(name, [rectangular], strict), name).toBe(false);
    }
    expect(matrixCall("is_binary", [rectangular], strict)).toBe(true);
    expect(matrixCall("is_zero", [rectangular], strict)).toBe(true);
    for (const [cell, identity, zero, stochastic] of [[0, false, true, false], [1, true, false, true]] as const) {
      const singleton = fromRows([[cell]]);
      expect(matrixCall("is_identity", [singleton], strict)).toBe(identity);
      expect(matrixCall("is_zero", [singleton], strict)).toBe(zero);
      expect(matrixCall("is_stochastic", [singleton], strict)).toBe(stochastic);
      for (const name of ["is_antidiagonal", "is_antisymmetric", "is_binary", "is_diagonal", "is_square", "is_symmetric", "is_triangular"]) {
        expect(matrixCall(name, [singleton], strict), `${name}/${cell}`).toBe(name === "is_antisymmetric" ? cell === 0 : true);
      }
    }
  });

  it("requires finite stored numbers and applies only the bounded stochastic row tolerance", () => {
    const tolerance = 1e-10;
    expect(matrixCall("is_stochastic", [fromRows([[1 + tolerance / 2]])], strict)).toBe(true);
    expect(matrixCall("is_stochastic", [fromRows([[1 + tolerance * 2]])], strict)).toBe(false);
    expect(matrixCall("is_stochastic", [fromRows([[0.25, 0.75], [0.8, 0.2]])], strict)).toBe(true);
    for (const invalid of [Number.NaN]) {
      const bad = fromRows([[invalid]]);
      expect(matrixCall("is_square", [bad], strict)).toBe(true);
      for (const name of names.filter((candidate) => candidate !== "is_square")) {
        expect(matrixCall(name, [bad], strict), `${name}/${String(invalid)}`).toBe(false);
      }
    }
    for (const invalid of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const bad = fromRows([[0]]) as { data: number[][] };
      expect(() => matrixCall("set", [bad as never, 0, 0, invalid], strict)).toThrow();
      bad.data[0]![0] = invalid;
      for (const name of names) expect(() => matrixCall(name, [bad as never], strict)).toThrow();
    }
    const missingDiagonal = fromRows([[Number.NaN, 0], [0, 1]]);
    expect(matrixCall("is_diagonal", [missingDiagonal], strict)).toBe(false);
    const missingMirrored = fromRows([[0, Number.NaN], [Number.NaN, 0]]);
    expect(matrixCall("is_symmetric", [missingMirrored], strict)).toBe(false);
    const integral = matrixCall("new_int", [2, 2, 1], strict);
    expect(matrixCall("is_stochastic", [integral], strict)).toBe(false);
    matrixCall("set", [integral, 0, 1, 0], strict);
    matrixCall("set", [integral, 1, 0, 0], strict);
    expect(matrixCall("is_stochastic", [integral], strict)).toBe(true);
  });

  it("checks bounded admitted capacity and retains sealed predicate behavior", () => {
    const atLimit = matrixCall("new_int", [250, 400, 0], strict);
    const alias = atLimit;
    const before = structuredClone(atLimit);
    expect(matrixCall("is_zero", [atLimit], strict)).toBe(true);
    expect(matrixCall("is_binary", [atLimit], strict)).toBe(true);
    expect(alias).toEqual(before);
    const empty = matrixCall("new_int", [0, 0, 0], strict);
    expect(matrixCall("is_square", [empty])).toBe(false);
    expect(matrixCall("is_square", [empty], strict)).toBe(true);
    const sealed = fromRows([[0, Number.NaN], [0, 0]]);
    expect(matrixCall("is_diagonal", [sealed])).toBe(false);
    expect(matrixCall("is_diagonal", [sealed], strict)).toBe(false);
    const row = matrixCall("new_int", [1, 1, 7], strict);
    matrixCall("add_row", [row, null, [9]], strict);
    matrixCall("add_row", [row, undefined as never, [8]], strict);
    expect(row).toMatchObject({ data: [[9], [7], [8]] });
  });
});
