import type { PineValue } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { arrayCall, mapCall, matrixCall } from "./collections.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { compileSessionCorrections, correctedSessionTradingDayKey, isInSession, parseSessionSpec } from "./time.js";

const strictV6 = { strict: true, negativeIndices: true } as const;
const strictV5 = { strict: true, negativeIndices: false } as const;

describe("collection compatibility", () => {
  it("uses v6 negative indexes for get, insert, set, and remove", () => {
    const values = [1, 2, 3];
    expect(arrayCall("get", [values, -1], strictV6)).toBe(3);
    expect(arrayCall("insert", [values, -1, 9], strictV6)).toBeNull();
    expect(values).toEqual([1, 2, 9, 3]);
    expect(arrayCall("set", [values, -1, 4], strictV6)).toBeNull();
    expect(values).toEqual([1, 2, 9, 4]);
    expect(arrayCall("remove", [values, -1], strictV6)).toBe(4);
    expect(values).toEqual([1, 2, 9]);
  });

  it("applies bounded fill ranges without partial mutation", () => {
    const values = [1, 2, 3, 4];
    expect(arrayCall("fill", [values, 9, 1, 3], strictV6)).toBeNull();
    expect(values).toEqual([1, 9, 9, 4]);
    expect(arrayCall("fill", [values, 7, 2, 2], strictV6)).toBeNull();
    expect(values).toEqual([1, 9, 9, 4]);
    expect(arrayCall("fill", [values, 5], strictV6)).toBeNull();
    expect(values).toEqual([5, 5, 5, 5]);

    for (const range of [[1.5, 3], [1, 3.5], [-1, 2], [1, 5], [3, 2]] as const) {
      const before = [...values];
      expect(() => arrayCall("fill", [values, 0, ...range], strictV6)).toThrow();
      expect(values).toEqual(before);
    }
  });

  it("returns generic boundary elements and rejects empty reads", () => {
    expect(arrayCall("first", [[Number.NaN, 2]], strictV6)).toBeNaN();
    expect(arrayCall("last", [[1, Number.NaN]], strictV6)).toBeNaN();
    expect(arrayCall("first", [["first", "last"]], strictV6)).toBe("first");
    expect(arrayCall("last", [["first", "last"]], strictV6)).toBe("last");
    expect(() => arrayCall("first", [[]], strictV6)).toThrow("Array is empty");
    expect(() => arrayCall("last", [[]], strictV6)).toThrow("Array is empty");
    expect(() => arrayCall("shift", [[]], strictV6)).toThrow("Array is empty");
  });

  it("keeps copy and concat containers independent while sharing element references", () => {
    const shared = { value: 1 };
    const source = [shared];
    const copied = arrayCall("copy", [source as unknown as PineValue], strictV6) as unknown as Array<{ value: number }>;
    copied[0]!.value = 2;
    expect(source[0]!.value).toBe(2);
    arrayCall("clear", [copied as unknown as PineValue], strictV6);
    expect(source).toHaveLength(1);

    const right = [{ value: 3 }];
    const concatenated = arrayCall("concat", [source, right] as unknown as PineValue[], strictV6) as unknown as Array<{ value: number }>;
    expect(concatenated).toBe(source);
    right[0]!.value = 4;
    expect(concatenated[1]!.value).toBe(4);
    arrayCall("clear", [right], strictV6);
    expect(concatenated).toHaveLength(2);

    const self = [1, 2];
    expect(arrayCall("concat", [self, self], strictV6)).toBe(self);
    expect(self).toEqual([1, 2, 1, 2]);
  });

  it("rejects array growth beyond the limit before mutation", () => {
    const left = Array.from({ length: 50_001 }, () => 1);
    const right = Array.from({ length: 50_000 }, () => 2);
    expect(() => arrayCall("concat", [left, right], strictV6)).toThrow("maximum of 100000");
    expect(left).toHaveLength(50_001);
    const full = Array.from({ length: 100_000 }, () => 1);
    expect(() => arrayCall("insert", [full, 0, 2], strictV6)).toThrow("maximum of 100000");
    expect(full).toHaveLength(100_000);
    expect(full[0]).toBe(1);
  });

  it("reports the reference platform's get and slice bounds diagnostics", () => {
    // Recorded probe collections-errors.txt.
    const values = [10, 20, 30];
    expect(() => arrayCall("get", [values, -4], strictV6))
      .toThrow("In 'array.get()' function. Index -4 is out of bounds, array size is 3.");
    expect(() => arrayCall("slice", [values, -2, 3], strictV6))
      .toThrow("In 'array.slice()' function. Index -2 is out of bounds, array size is 3.");
  });

  it("requires a nonnegative index for percentrank in both Pine versions", () => {
    // Recorded probe collections-rank-endpoints.txt.
    expect(() => arrayCall("percentrank", [[1, 2, 3], -1], strictV6))
      .toThrow("In 'array.percentrank()' function. Index -1 is out of bounds, array size is 3.");
    expect(() => arrayCall("percentrank", [[1, 2, 3], -4], strictV6)).toThrow("out of bounds");
    expect(() => arrayCall("percentrank", [[1, 2, 3], -1], strictV5)).toThrow("out of bounds");
  });

  it("calculates strict medians, modes, percentiles, and percent ranks without mutating sources", () => {
    const values = [4, -2, 1.5, 1.5, Number.NaN, 9];
    const before = [...values];
    expect(arrayCall("median", [values], strictV6)).toBe(1.5);
    expect(arrayCall("mode", [values], strictV6)).toBe(1.5);
    expect(arrayCall("percentile_linear_interpolation", [values, 25], strictV6)).toBe(0.625);
    expect(arrayCall("percentile_nearest_rank", [values, 25], strictV6)).toBe(1.5);
    expect(arrayCall("percentrank", [values, 3], strictV6)).toBe(40);
    expect(values).toEqual(before);

    expect(arrayCall("median", [[1, 2]], strictV6)).toBe(1.5);
    expect(arrayCall("median", [[3]], strictV6)).toBe(3);
    expect(arrayCall("median", [[],], strictV6)).toBeNaN();
    expect(arrayCall("median", [[Number.NaN, null]], strictV6)).toBeNaN();
    expect(arrayCall("mode", [[4, 1, 3, 2]], strictV6)).toBe(1);
    expect(arrayCall("mode", [[4, 4, 2, 2, 3]], strictV6)).toBe(2);
    expect(arrayCall("mode", [[2, 4, 3, 2, 4]], strictV6)).toBe(2);
    expect(arrayCall("mode", [[Number.NaN, null]], strictV6)).toBeNaN();

    const ordered = [-10, 0, 10, 20];
    expect(arrayCall("percentile_linear_interpolation", [ordered, 0], strictV6)).toBe(-10);
    expect(arrayCall("percentile_linear_interpolation", [ordered, 25], strictV6)).toBe(-5);
    expect(arrayCall("percentile_linear_interpolation", [ordered, 50], strictV6)).toBe(5);
    expect(arrayCall("percentile_linear_interpolation", [ordered, 100], strictV6)).toBe(20);
    expect(arrayCall("percentile_nearest_rank", [ordered, 0], strictV6)).toBe(-10);
    expect(arrayCall("percentile_nearest_rank", [ordered, 25], strictV6)).toBe(-10);
    expect(arrayCall("percentile_nearest_rank", [ordered, 25.0001], strictV6)).toBe(0);
    expect(arrayCall("percentile_nearest_rank", [ordered, 50], strictV6)).toBe(0);
    expect(arrayCall("percentile_nearest_rank", [ordered, 50.0001], strictV6)).toBe(10);
    expect(arrayCall("percentile_nearest_rank", [ordered, 100], strictV6)).toBe(20);
    expect(arrayCall("percentile_nearest_rank", [[7], 37.5], strictV6)).toBe(7);
    expect(arrayCall("percentile_linear_interpolation", [[Number.NaN, -10, 10], 50], strictV6)).toBe(0);
    expect(arrayCall("percentile_nearest_rank", [[Number.NaN, -10, 10], 50], strictV6)).toBe(-10);

    const duplicates = [1, 2, 2, 4, Number.NaN];
    expect(arrayCall("percentrank", [duplicates, 0], strictV6)).toBe(0);
    expect(arrayCall("percentrank", [duplicates, 1], strictV6)).toBe(50);
    expect(arrayCall("percentrank", [duplicates, 2], strictV6)).toBe(50);
    expect(arrayCall("percentrank", [duplicates, 3], strictV6)).toBe(75);
    expect(arrayCall("percentrank", [[5], 0], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[], 0], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[1, Number.NaN, 3], 1], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[3, 3, 3], 1], strictV6)).toBe(100);
  });

  it("validates strict rank domains while preserving sealed rank behavior", () => {
    for (const method of ["median", "mode", "percentile_linear_interpolation", "percentile_nearest_rank", "percentrank"]) {
      const args: PineValue[] = method === "percentrank" ? [[1, "2"], 0] : method.startsWith("percentile") ? [[1, "2"], 50] : [[1, "2"]];
      expect(() => arrayCall(method, args, strictV6), method).toThrow(PineRuntimeError);
    }
    for (const percentage of [-0.1, 100.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => arrayCall("percentile_linear_interpolation", [[1, 2], percentage], strictV6)).toThrow("finite number from 0 to 100");
      expect(() => arrayCall("percentile_nearest_rank", [[1, 2], percentage], strictV6)).toThrow("finite number from 0 to 100");
    }
    const atCapacity = Array.from({ length: 100_000 }, (_, index) => index);
    expect(arrayCall("median", [atCapacity], strictV6)).toBe(49_999.5);
    expect(() => arrayCall("mode", [[...atCapacity, 1]], strictV6)).toThrow("maximum of 100000");

    expect(arrayCall("median", [[null, 2, 4]])).toBe(2);
    expect(arrayCall("median", [[null, 2, 4]], strictV6)).toBe(3);
    expect(arrayCall("percentile_linear_interpolation", [[0, 10, 20, 30], 25])).toBe(5);
    expect(arrayCall("percentile_nearest_rank", [[1, Number.NaN, 3], 50])).toBe(3);
    expect(arrayCall("percentile_nearest_rank", [[1, Number.NaN, 3], 50], strictV6)).toBe(1);
    expect(arrayCall("percentile_nearest_rank", [[1, Number.NaN, 3], 100])).toBeNaN();
    expect(arrayCall("percentile_nearest_rank", [[1, Number.NaN, 3], 100], strictV6)).toBe(3);
    expect(arrayCall("percentile_nearest_rank", [[1, 2, 3], 100.1])).toBe(3);
    expect(arrayCall("percentrank", [[1, 2, 2, 4], 1])).toBeCloseTo(100 / 3, 12);
    expect(arrayCall("percentrank", [[1, 2, 2, 4], 1], strictV6)).toBeCloseTo(200 / 3, 12);
    expect(arrayCall("percentrank", [[-1, null, 1], 1])).toBe(50);
    expect(arrayCall("percentrank", [[-1, null, 1], 1], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[-1, Number.NaN, 1], 1], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[-1, 1, null], 2], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[5], 0])).toBeNaN();
    expect(arrayCall("percentrank", [[5], 0], strictV6)).toBeNaN();
    expect(arrayCall("percentrank", [[], 0])).toBeNaN();
    expect(arrayCall("percentrank", [[], 0], strictV6)).toBeNaN();
  });

  it("returns na for all-na array aggregates and an empty standardized array", () => {
    for (const method of ["sum", "min", "max", "range"]) {
      expect(arrayCall(method, [[Number.NaN]], strictV6)).toBeNaN();
    }
    expect(arrayCall("standardize", [[Number.NaN]], strictV6)).toEqual([]);
  });

  it("calculates numeric transforms and aggregates without mutating their sources", () => {
    const values = [-4, 0, 1.5, Number.NaN, 2.5];
    const absolute = arrayCall("abs", [values], strictV6) as number[];
    expect(absolute).toEqual([4, 0, 1.5, Number.NaN, 2.5]);
    expect(absolute).not.toBe(values);
    absolute[0] = 99;
    expect(values).toEqual([-4, 0, 1.5, Number.NaN, 2.5]);
    expect(arrayCall("sum", [values], strictV6)).toBe(0);
    expect(arrayCall("avg", [values], strictV6)).toBe(0);
    expect(arrayCall("min", [values], strictV6)).toBe(-4);
    expect(arrayCall("max", [values], strictV6)).toBe(2.5);
    expect(arrayCall("range", [values], strictV6)).toBe(6.5);
    for (const method of ["avg", "min", "max", "range", "sum"]) {
      expect(arrayCall(method, [[]], strictV6)).toBeNaN();
      expect(arrayCall(method, [[Number.NaN]], strictV6)).toBeNaN();
    }
    expect(arrayCall("sum", [[1e16, 1, -1e16]], strictV6)).toBe(1);
    expect(arrayCall("avg", [[1e16, 1, -1e16]], strictV6)).toBeCloseTo(1 / 3, 10);

    const atCapacity = Array.from({ length: 100_000 }, (_, index) => index - 50_000);
    expect(arrayCall("min", [atCapacity], strictV6)).toBe(-50_000);
    expect(arrayCall("max", [atCapacity], strictV6)).toBe(49_999);
    expect(arrayCall("range", [atCapacity], strictV6)).toBe(99_999);
    expect(() => arrayCall("abs", [[...atCapacity, 1]], strictV6)).toThrow("maximum of 100000");
  });

  it("uses explicit population/sample and pairwise-missing statistical contracts", () => {
    const values = [-2, 1, 4, 7];
    expect(arrayCall("variance", [values], strictV6)).toBe(11.25);
    expect(arrayCall("variance", [values, false], strictV6)).toBe(15);
    expect(arrayCall("stdev", [values], strictV6)).toBeCloseTo(Math.sqrt(11.25), 10);
    expect(arrayCall("stdev", [values, false], strictV6)).toBeCloseTo(Math.sqrt(15), 10);
    expect(arrayCall("variance", [[5], true], strictV6)).toBe(0);
    expect(arrayCall("stdev", [[5], true], strictV6)).toBe(0);
    expect(arrayCall("variance", [[5], false], strictV6)).toBeNaN();
    expect(arrayCall("stdev", [[5], false], strictV6)).toBeNaN();
    expect(arrayCall("variance", [[], true], strictV6)).toBeNaN();
    expect(arrayCall("stdev", [[Number.NaN], true], strictV6)).toBeNaN();
    expect(arrayCall("variance", [[3, 3, Number.NaN], false], strictV6)).toBe(0);
    expect(arrayCall("stdev", [[3, 3, Number.NaN], false], strictV6)).toBe(0);

    const offset = [1e12 + 1, 1e12 + 2, 1e12 + 3, 1e12 + 4];
    expect(arrayCall("variance", [offset], strictV6)).toBe(1.25);
    expect(arrayCall("stdev", [offset], strictV6)).toBeCloseTo(Math.sqrt(1.25), 10);
    expect(arrayCall("variance", [offset], strictV6)).toBeCloseTo(
      (arrayCall("stdev", [offset], strictV6) as number) ** 2,
      9,
    );

    const left = [1, 2, Number.NaN, 4];
    const right = [2, 4, 100, 8];
    expect(arrayCall("covariance", [left, right], strictV6)).toBeCloseTo(28 / 9, 10);
    expect(arrayCall("covariance", [left, right, false], strictV6)).toBeCloseTo(14 / 3, 10);
    expect(arrayCall("covariance", [[1, 2, Number.NaN], [8, 4, 0]], strictV6)).toBe(-1);
    expect(arrayCall("covariance", [[1, 2], [3, 3]], strictV6)).toBe(0);
    expect(arrayCall("covariance", [[1], [2]], strictV6)).toBe(0);
    expect(arrayCall("covariance", [[1], [2], false], strictV6)).toBeNaN();
    expect(arrayCall("covariance", [[1], [1, 2]], strictV6)).toBeNaN();
    expect(arrayCall("covariance", [[], []], strictV6)).toBeNaN();
    expect(arrayCall("covariance", [[Number.NaN, 1], [2, Number.NaN]], strictV6)).toBeNaN();
    expect(left).toEqual([1, 2, Number.NaN, 4]);
    expect(right).toEqual([2, 4, 100, 8]);
  });

  it("standardizes into independent float arrays with explicit degenerate policies", () => {
    const values = [-1, 1, Number.NaN];
    const standardized = arrayCall("standardize", [values], strictV6) as number[];
    expect(standardized).toEqual([-1, 1, Number.NaN]);
    standardized[0] = 9;
    expect(values).toEqual([-1, 1, Number.NaN]);
    expect(arrayCall("standardize", [[3, 3, Number.NaN]], strictV6)).toEqual([1, 1, 1]);
    expect(arrayCall("standardize", [[5]], strictV6)).toEqual([1]);
    expect(arrayCall("standardize", [[Number.NaN]], strictV6)).toEqual([]);
    expect(arrayCall("standardize", [[]], strictV6)).toEqual([]);

    const smallSpread = arrayCall("standardize", [[1e-12, 3e-12]], strictV6) as number[];
    expect(smallSpread[0]).toBeCloseTo(-1, 12);
    expect(smallSpread[1]).toBeCloseTo(1, 12);
    const smallSpreadWithMissing = arrayCall("standardize", [[1e-12, Number.NaN, 3e-12]], strictV6) as number[];
    expect(smallSpreadWithMissing[0]).toBeCloseTo(-1, 12);
    expect(smallSpreadWithMissing[1]).toBeNaN();
    expect(smallSpreadWithMissing[2]).toBeCloseTo(1, 12);
    expect(arrayCall("standardize", [[1e12 + 1, 1e12 + 3]], strictV6)).toEqual([-1, 1]);
  });

  it("fails strict numeric domains before mutation and preserves sealed formulas", () => {
    const invalid = [1, "2"];
    for (const method of ["abs", "avg", "min", "max", "range", "sum", "variance", "stdev", "standardize"]) {
      expect(() => arrayCall(method, [invalid], strictV6)).toThrow(PineRuntimeError);
      expect(invalid).toEqual([1, "2"]);
    }
    expect(() => arrayCall("covariance", [[1, 2], [3, "4"]], strictV6)).toThrow(PineRuntimeError);
    expect(() => arrayCall("variance", [[1, 2], 1], strictV6)).toThrow("biased argument must be a bool");
    expect(() => arrayCall("covariance", [[1, 2], [3, 4], 0], strictV6)).toThrow("biased argument must be a bool");

    expect(arrayCall("sum", [[1e16, 1, -1e16]])).toBe(0);
    expect(arrayCall("sum", [[1e16, 1, -1e16]], strictV6)).toBe(1);
    const offset = [1e12 + 1, 1e12 + 2, 1e12 + 3, 1e12 + 4];
    expect(arrayCall("stdev", [offset])).toBe(0);
    expect(arrayCall("stdev", [offset], strictV6)).toBeCloseTo(Math.sqrt(1.25), 10);
    expect(arrayCall("stdev", [[5], false])).toBe(0);
    expect(arrayCall("stdev", [[5], false], strictV6)).toBeNaN();
    expect(arrayCall("standardize", [[3, 3, Number.NaN]])).toEqual([1, 1, 1]);
    expect(arrayCall("standardize", [[3, 3, Number.NaN]], strictV6)).toEqual([1, 1, 1]);

    const empty: PineValue[] = [];
    expect(arrayCall("sum", [empty])).toBeNaN();
    expect(arrayCall("sum", [empty], strictV6)).toBeNaN();
    expect(arrayCall("variance", [empty])).toBeNaN();
    expect(arrayCall("variance", [empty], strictV6)).toBeNaN();
    expect(arrayCall("stdev", [empty])).toBeNaN();
    expect(arrayCall("stdev", [empty], strictV6)).toBeNaN();
    expect(arrayCall("covariance", [empty, empty])).toBeNaN();
    expect(arrayCall("covariance", [empty, empty], strictV6)).toBeNaN();
    expect(arrayCall("standardize", [empty])).toEqual([]);
    expect(arrayCall("standardize", [empty], strictV6)).toEqual([]);

    const restoredMissing: PineValue[] = [null, Number.NaN];
    expect(arrayCall("sum", [restoredMissing])).toBe(0);
    expect(arrayCall("sum", [restoredMissing], strictV6)).toBeNaN();
    expect(arrayCall("variance", [restoredMissing])).toBe(0);
    expect(arrayCall("variance", [restoredMissing], strictV6)).toBeNaN();
    expect(arrayCall("stdev", [restoredMissing])).toBe(0);
    expect(arrayCall("stdev", [restoredMissing], strictV6)).toBeNaN();
    expect(arrayCall("covariance", [restoredMissing, restoredMissing])).toBe(0);
    expect(arrayCall("covariance", [restoredMissing, restoredMissing], strictV6)).toBeNaN();
    expect(arrayCall("standardize", [restoredMissing])).toEqual([1, 1]);
    expect(arrayCall("standardize", [restoredMissing], strictV6)).toEqual([]);

    expect(arrayCall("abs", [[null]])).toEqual([0]);
    expect(arrayCall("abs", [[null]], strictV6)).toEqual([Number.NaN]);
    expect(arrayCall("standardize", [[null, 2]])).toEqual([-1, 1]);
    expect(arrayCall("standardize", [[null, 2]], strictV6)).toEqual([1, 1]);
    expect(arrayCall("standardize", [[1e-12, 3e-12]])).toEqual([1, 1]);
    const strictSmallSpread = arrayCall("standardize", [[1e-12, 3e-12]], strictV6) as number[];
    expect(strictSmallSpread[0]).toBeCloseTo(-1, 12);
    expect(strictSmallSpread[1]).toBeCloseTo(1, 12);
    expect(arrayCall("standardize", [[1e-12, Number.NaN, 3e-12]])).toEqual([1, 1, 1]);
    const strictMissingSpread = arrayCall("standardize", [[1e-12, Number.NaN, 3e-12]], strictV6) as number[];
    expect(strictMissingSpread[0]).toBeCloseTo(-1, 12);
    expect(strictMissingSpread[1]).toBeNaN();
    expect(strictMissingSpread[2]).toBeCloseTo(1, 12);
    expect(arrayCall("standardize", [[1e12 + 1, 1e12 + 3]])).toEqual([1, 1]);
    expect(arrayCall("standardize", [[1e12 + 1, 1e12 + 3]], strictV6)).toEqual([-1, 1]);
    expect(arrayCall("standardize", [[3e-12, 3e-12, Number.NaN]])).toEqual([1, 1, 1]);
    expect(arrayCall("standardize", [[3e-12, 3e-12, Number.NaN]], strictV6)).toEqual([1, 1, 1]);
    expect(arrayCall("standardize", [[-1, 1, Number.NaN]])).toEqual([-1, 1, Number.NaN]);
    expect(arrayCall("standardize", [[-1, 1, Number.NaN]], strictV6)).toEqual([-1, 1, Number.NaN]);

    const sealedContinuation: PineValue[] = [];
    const strictContinuation: PineValue[] = [];
    for (const value of [0, 2, Number.NaN, 4]) {
      sealedContinuation.push(value);
      strictContinuation.push(value);
      expect(arrayCall("sum", [strictContinuation], strictV6)).toBe(arrayCall("sum", [sealedContinuation]));
      expect(arrayCall("variance", [strictContinuation], strictV6)).toBe(arrayCall("variance", [sealedContinuation]));
    }
  });

  it("searches exact values, duplicates, neighbors, sentinels, and missing elements", () => {
    const values = [-2, 0, 2, 2, 5, 5];
    expect(arrayCall("binary_search", [values, 2], strictV6)).toBe(2);
    expect(arrayCall("binary_search_leftmost", [values, 2], strictV6)).toBe(2);
    expect(arrayCall("binary_search_rightmost", [values, 2], strictV6)).toBe(3);
    expect(arrayCall("binary_search", [values, 3], strictV6)).toBe(-1);
    expect(arrayCall("binary_search_leftmost", [values, 3], strictV6)).toBe(3);
    expect(arrayCall("binary_search_rightmost", [values, 3], strictV6)).toBe(4);
    expect(arrayCall("binary_search_leftmost", [values, -3], strictV6)).toBe(-1);
    expect(arrayCall("binary_search_rightmost", [values, -3], strictV6)).toBe(0);
    expect(arrayCall("binary_search_leftmost", [values, 6], strictV6)).toBe(5);
    expect(arrayCall("binary_search_rightmost", [values, 6], strictV6)).toBe(6);
    expect(arrayCall("binary_search", [[], 1], strictV6)).toBe(-1);
    expect(arrayCall("binary_search_leftmost", [[], 1], strictV6)).toBe(-1);
    expect(arrayCall("binary_search_rightmost", [[], 1], strictV6)).toBe(0);
    expect(arrayCall("binary_search", [[1], 1], strictV6)).toBe(0);

    const duplicates = [Number.NaN, -1, 0, -1, Number.NaN];
    expect(arrayCall("includes", [duplicates, -1], strictV6)).toBe(true);
    expect(arrayCall("indexof", [duplicates, -1], strictV6)).toBe(1);
    expect(arrayCall("lastindexof", [duplicates, -1], strictV6)).toBe(3);
    expect(arrayCall("includes", [duplicates, Number.NaN], strictV6)).toBe(true);
    expect(arrayCall("indexof", [duplicates, Number.NaN], strictV6)).toBe(0);
    expect(arrayCall("lastindexof", [duplicates, Number.NaN], strictV6)).toBe(4);
    expect(arrayCall("indexof", [duplicates, 9], strictV6)).toBe(-1);
    expect(duplicates).toEqual([Number.NaN, -1, 0, -1, Number.NaN]);
  });

  it("sorts values, stable index ties, linked slices, and missing values without mutating sort-index sources", () => {
    const values = [3, Number.NaN, -1, 3, 0];
    const indices = arrayCall("sort_indices", [values], strictV6);
    expect(indices).toEqual([2, 4, 0, 3, 1]);
    expect(values).toEqual([3, Number.NaN, -1, 3, 0]);
    expect(arrayCall("sort", [values], strictV6)).toBeNull();
    expect(values).toEqual([-1, 0, 3, 3, Number.NaN]);
    arrayCall("sort", [values, 0], strictV6);
    expect(values).toEqual([Number.NaN, 3, 3, 0, -1]);

    const parent = [9, 3, 1, 2, 8];
    const slice = arrayCall("slice", [parent, 1, 4], strictV6);
    arrayCall("sort", [slice], strictV6);
    expect(parent).toEqual([9, 1, 2, 3, 8]);

    expect(arrayCall("sort_indices", [["z", "a", "a", "m"], 0], strictV6)).toEqual([0, 3, 1, 2]);
    expect(() => arrayCall("sort", [[1, 2], 7], strictV6)).toThrow("order.ascending");
    expect(() => arrayCall("sort", [[true]], strictV6)).toThrow("Sorting requires");
  });

  it("applies numeric and boolean predicates and bounded scalar joins", () => {
    expect(arrayCall("every", [[]], strictV6)).toBe(true);
    expect(arrayCall("some", [[]], strictV6)).toBe(false);
    expect(arrayCall("every", [[true, true]], strictV6)).toBe(true);
    expect(arrayCall("every", [[1, -2, 0.5]], strictV6)).toBe(true);
    expect(arrayCall("every", [[1, 0]], strictV6)).toBe(false);
    expect(arrayCall("some", [[0, Number.NaN, -2]], strictV6)).toBe(true);
    expect(arrayCall("some", [[0, false, Number.NaN]], strictV6)).toBe(false);

    expect(arrayCall("join", [[], "|"], strictV6)).toBe("");
    expect(arrayCall("join", [[1]], strictV6)).toBe("1");
    expect(arrayCall("join", [[1, -2, Number.NaN]], strictV6)).toBe("1,-2,NaN");
    expect(arrayCall("join", [["α", "β"], "✨"], strictV6)).toBe("α✨β");
    expect(arrayCall("join", [["a", "b"], ""], strictV6)).toBe("ab");
    expect(arrayCall("join", [["✨".repeat(40_960)]], strictV6)).toBe("✨".repeat(40_960));
    expect(arrayCall("join", [["a", "b"], "✨".repeat(40_958)], strictV6)).toBe(`a${"✨".repeat(40_958)}b`);
    expect(() => arrayCall("join", [["✨".repeat(40_961)]], strictV6)).toThrow("40960");
    expect(() => arrayCall("join", [["a", "b"], "✨".repeat(40_959)], strictV6)).toThrow("40960");
    const repeatedLargeValue = "x".repeat(40_960);
    let observedElements = 0;
    const repeatedLargeInput = new Proxy(Array.from({ length: 100_000 }, () => repeatedLargeValue), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) observedElements += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => arrayCall("join", [repeatedLargeInput], strictV6))
      .toThrowError(PineRuntimeError);
    expect(observedElements).toBeLessThan(10);
    expect(() => arrayCall("join", [[true, false]], strictV6)).toThrow("int, float, or string");
  });

  it("preserves sealed search, sort, and join coercion while strict contracts fail closed", () => {
    expect(arrayCall("includes", [[Number.NaN], Number.NaN])).toBe(false);
    expect(arrayCall("indexof", [[Number.NaN], Number.NaN])).toBe(-1);
    expect(arrayCall("lastindexof", [[Number.NaN], Number.NaN])).toBe(-1);
    const flags = [true, false];
    expect(arrayCall("sort", [flags])).toBeNull();
    expect(flags).toEqual([false, true]);
    expect(arrayCall("join", [[true, false]])).toBe("true,false");
    expect(arrayCall("join", [[1, 2], 7])).toBe("172");
    expect(arrayCall("join", [[1, 2], true])).toBe("1true2");
    expect(arrayCall("join", [[1, 2], Number.NaN])).toBe("1NaN2");
    expect(arrayCall("join", [[1, 2], null])).toBe("1,2");
    expect(arrayCall("join", [[1, 2]])).toBe("1,2");
    for (const separator of [7, true, Number.NaN, null]) {
      expect(() => arrayCall("join", [[1, 2], separator], strictV6)).toThrow("separator must be a string");
    }
    expect(arrayCall("join", [[1, 2]], strictV6)).toBe("1,2");

    const composed = "e\u0301";
    expect("é".localeCompare(composed)).toBe(0);
    expect(arrayCall("binary_search", [["é"], composed])).toBe(0);
    expect(() => arrayCall("binary_search", [["é"], composed], strictV6)).toThrow("numeric value");
  });

  it("keeps slice writes and structural mutations linked to the parent", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], strictV6);
    expect(arrayCall("set", [slice, 0, 9], strictV6)).toBeNull();
    expect(parent).toEqual([1, 9, 3]);
    expect(arrayCall("push", [slice, 4], strictV6)).toBeNull();
    expect(parent).toEqual([1, 9, 3, 4]);
    arrayCall("set", [parent, 2, 8], strictV6);
    expect(arrayCall("get", [slice, 1], strictV6)).toBe(8);
    const detached = arrayCall("copy", [slice], strictV6);
    arrayCall("set", [detached, 0, 7], strictV6);
    expect(parent).toEqual([1, 9, 8, 4]);
  });

  it("refreshes a linked slice used as a non-receiver array argument", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], strictV6);
    arrayCall("set", [parent, 1, 9], strictV6);
    const destination: number[] = [];
    expect(arrayCall("concat", [destination, slice], strictV6)).toEqual([9, 3]);
  });

  it("rejects invalid slice ranges and a slice invalidated by parent shrink", () => {
    const parent = [1, 2, 3];
    expect(arrayCall("slice", [parent, 2, 2], strictV6)).toEqual([]);
    expect(arrayCall("slice", [parent, 3, 3], strictV6)).toEqual([]);
    expect(() => arrayCall("slice", [parent, 2, 1], strictV6)).toThrow("Index 'from' should be less than index 'to'.");
    expect(() => arrayCall("slice", [parent, 1, 4], strictV6)).toThrow("out of bounds");
    expect(() => arrayCall("slice", [parent, -1, 2], strictV6)).toThrow("out of bounds");
    expect(() => arrayCall("slice", [parent, Number.NaN, 2], strictV6)).toThrow("integers");
    expect(() => arrayCall("slice", [parent, 1.5, 2], strictV6)).toThrow("integers");
    const slice = arrayCall("slice", [parent, 1, 3], strictV6);
    arrayCall("remove", [parent, 0], strictV6);
    expect(() => arrayCall("indexof", [slice, 2], strictV6)).toThrow("Slice is out of bounds of the parent array");
  });

  it("temporarily empties a slice when its entire range falls outside a cleared parent", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], strictV6);
    arrayCall("clear", [parent], strictV6);
    expect(arrayCall("size", [slice], strictV6)).toBe(0);
    expect(() => arrayCall("push", [slice, 9], strictV6)).toThrow("Slice is out of bounds");
    arrayCall("push", [parent, 7], strictV6);
    expect(arrayCall("size", [slice], strictV6)).toBe(0);
    arrayCall("push", [parent, 8], strictV6);
    arrayCall("push", [parent, 9], strictV6);
    expect(arrayCall("size", [slice], strictV6)).toBe(2);
    expect(arrayCall("get", [slice, 0], strictV6)).toBe(8);
  });

  it("rejects structural writes through nested slices whose root range is unavailable", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], strictV6);
    const nested = arrayCall("slice", [slice, 0, 2], strictV6);
    arrayCall("clear", [parent], strictV6);
    expect(() => arrayCall("push", [nested, 9], strictV6)).toThrow("Slice is out of bounds");
    expect(parent).toEqual([]);
  });

  it("returns the concatenated matrix and rejects incompatible matrix operations", () => {
    const left = matrixCall("new_int", [1, 1, 1], strictV6);
    const right = matrixCall("new_int", [1, 1, 2], strictV6);
    expect(matrixCall("concat", [left, right], strictV6)).toBe(left);
    expect(matrixCall("elements_count", [left], strictV6)).toBe(2);
    const incompatible = matrixCall("new_int", [1, 2, 1], strictV6);
    expect(() => matrixCall("sum", [left, incompatible], strictV6)).toThrow("dimensions");
    expect(() => matrixCall("mult", [incompatible, right], strictV6)).toThrow("columns");
    expect(() => matrixCall("det", [incompatible], strictV6)).toThrow("square");
    expect(() => matrixCall("inv", [incompatible], strictV6)).toThrow("square");
    expect(matrixCall("eigenvectors", [right], strictV6)).toMatchObject({ data: [[1]] });
    expect(() => matrixCall("pow", [incompatible, 2], strictV6)).toThrow("square");
    expect(() => matrixCall("add_row", [incompatible, 0, [1]], strictV6)).toThrow("column count");
    expect(() => matrixCall("add_col", [incompatible, 0, []], strictV6)).toThrow("row count");
    expect(() => matrixCall("submatrix", [incompatible, 0, 0, 0, 1], strictV6)).toThrow("nonempty");
  });

  it("computes bounded real eigensystems and rejects unsupported numeric domains", () => {
    const symmetric = matrixCall("new_float", [2, 2, 0], strictV6);
    matrixCall("set", [symmetric, 0, 0, 2], strictV6);
    matrixCall("set", [symmetric, 0, 1, 1], strictV6);
    matrixCall("set", [symmetric, 1, 0, 1], strictV6);
    matrixCall("set", [symmetric, 1, 1, 2], strictV6);
    expect(matrixCall("eigenvalues", [symmetric], strictV6)).toEqual([3, 1]);
    const vectors = matrixCall("eigenvectors", [symmetric], strictV6);
    expect(matrixCall("get", [vectors, 0, 0], strictV6)).toBeCloseTo(Math.SQRT1_2);
    expect(matrixCall("get", [vectors, 1, 0], strictV6)).toBeCloseTo(Math.SQRT1_2);

    const general = matrixCall("new_float", [2, 2, 0], strictV6);
    matrixCall("set", [general, 0, 0, 4], strictV6);
    matrixCall("set", [general, 0, 1, 1], strictV6);
    matrixCall("set", [general, 1, 0, 2], strictV6);
    matrixCall("set", [general, 1, 1, 3], strictV6);
    expect(matrixCall("eigenvalues", [general], strictV6)).toEqual([5, 2]);
    const generalVectors = matrixCall("eigenvectors", [general], strictV6);
    expect(matrixCall("get", [generalVectors, 0, 0], strictV6)).toBeCloseTo(Math.SQRT1_2);
    expect(matrixCall("get", [generalVectors, 1, 0], strictV6)).toBeCloseTo(Math.SQRT1_2);

    const three = matrixCall("new_float", [3, 3, 0], strictV6);
    for (const [row, values] of [[4, 1, 1], [1, 3, 0], [1, 0, 2]].entries()) {
      for (const [column, value] of values.entries()) matrixCall("set", [three, row, column, value], strictV6);
    }
    const threeValues = matrixCall("eigenvalues", [three], strictV6);
    const threeVectors = matrixCall("eigenvectors", [three], strictV6);
    for (let column = 0; column < 3; column += 1) {
      const eigenvalue = Number((threeValues as readonly number[])[column]);
      const vector = Array.from({ length: 3 }, (_, row) => Number(matrixCall("get", [threeVectors, row, column], strictV6)));
      for (let row = 0; row < 3; row += 1) {
        const projected = [4, 1, 1, 1, 3, 0, 1, 0, 2].slice(row * 3, row * 3 + 3)
          .reduce((sum, value, index) => sum + value * vector[index]!, 0);
        expect(projected).toBeCloseTo(eigenvalue * vector[row]!, 9);
      }
    }

    const complex = matrixCall("new_float", [2, 2, 0], strictV6);
    matrixCall("set", [complex, 0, 1, -1], strictV6);
    matrixCall("set", [complex, 1, 0, 1], strictV6);
    expect(() => matrixCall("eigenvalues", [complex], strictV6)).toThrow("complex eigenvalues");

    const nonsymmetric = matrixCall("new_float", [3, 3, 0], strictV6);
    matrixCall("set", [nonsymmetric, 0, 1, 1], strictV6);
    expect(() => matrixCall("eigenvectors", [nonsymmetric], strictV6)).toThrow("symmetric matrix");
    const oversized = matrixCall("new_float", [17, 17, 0], strictV6);
    expect(() => matrixCall("eigenvalues", [oversized], strictV6)).toThrow("limited to 16 rows");
  });

  it("retains sealed-profile negative-index behavior", () => {
    expect(arrayCall("get", [[1, 2, 3], -1])).toBe(1);
    const values = [1, 2, 3];
    expect(arrayCall("fill", [values, 9, 0.5, 2.5])).toBeNull();
    expect(values).toEqual([9, 9, 3]);
    expect(arrayCall("fill", [values, 7, 2, 1])).toBeNull();
    expect(values).toEqual([9, 9, 3]);
  });

  it("raises Pine-style collection bounds and capacity errors", () => {
    expect(() => arrayCall("get", [[1], 1], strictV6)).toThrow("out of bounds");
    expect(() => arrayCall("set", [[1], 2, 3], strictV6)).toThrow("out of bounds");
    expect(() => arrayCall("new_float", [100_001, 1], strictV6)).toThrow("maximum of 100000");
    expect(() => matrixCall("new_float", [100_001, 1, 0], strictV6)).toThrow("maximum of 100000");
    expect(() => matrixCall("get", [matrixCall("new_float", [1, 1, 0], strictV6), 1, 0], strictV6)).toThrow("out of bounds");
  });

  it("caps maps when a new key would exceed the documented pair limit", () => {
    const values = {
      __pineMap: true as const,
      entries: Array.from({ length: 50_000 }, (_, index) => [index, index] as [number, number]),
    };
    expect(() => mapCall("put", [values, 50_000, 50_000], strictV6)).toThrow("maximum of 50000");
  });
});

describe("session grammar", () => {
  it("applies day masks, comma-separated periods, 24x7, and overnight session days", () => {
    const saturdayAtTenNewYork = Date.parse("2025-01-04T15:00:00Z");
    const mondayAtTenNewYork = Date.parse("2025-01-06T15:00:00Z");
    const mondayAtLunchNewYork = Date.parse("2025-01-06T17:00:00Z");
    const mondayAtSixNewYork = Date.parse("2025-01-06T23:00:00Z");
    const tuesdayAtTwoAmNewYork = Date.parse("2025-01-07T07:00:00Z");
    const wednesdayAtTwoAmNewYork = Date.parse("2025-01-08T07:00:00Z");
    const sundayAtSixNewYork = Date.parse("2025-01-05T23:00:00Z");
    const saturdayAtSixNewYork = Date.parse("2025-01-04T23:00:00Z");

    expect(isInSession(saturdayAtTenNewYork, "0930-1600:23456", "America/New_York", 6)).toBe(false);
    expect(isInSession(mondayAtTenNewYork, "0930-1130,1300-1600:2", "America/New_York", 6)).toBe(true);
    expect(isInSession(mondayAtLunchNewYork, "0930-1130,1300-1600:2", "America/New_York", 6)).toBe(false);
    expect(isInSession(saturdayAtTenNewYork, "24x7", "America/New_York", 6)).toBe(true);
    expect(isInSession(mondayAtSixNewYork, "1700-1600:3", "America/New_York", 6)).toBe(true);
    expect(isInSession(tuesdayAtTwoAmNewYork, "1700-1600:3", "America/New_York", 6)).toBe(true);
    expect(isInSession(wednesdayAtTwoAmNewYork, "1700-1600:3", "America/New_York", 6)).toBe(false);
    expect(isInSession(sundayAtSixNewYork, "1700-0000:2", "America/New_York", 6)).toBe(true);
    expect(isInSession(saturdayAtSixNewYork, "1700-0000:1", "America/New_York", 6)).toBe(true);
  });

  it("uses all-day defaults in both v5 and v6 when no day mask is supplied", () => {
    const saturdayAtTenNewYork = Date.parse("2025-01-04T15:00:00Z");
    expect(isInSession(saturdayAtTenNewYork, "0930-1600", "America/New_York", 5)).toBe(true);
    expect(isInSession(saturdayAtTenNewYork, "0930-1600", "America/New_York", 6)).toBe(true);
  });

  it("rejects backwards correction offsets while preserving valid prior-day windows", () => {
    expect(compileSessionCorrections([
      { tradingDay: "20260831", session: "1000-1200F1" },
    ])).toEqual({
      ok: false,
      reason: "correction window '1000-1200F1' ends before its start day",
    });

    const recurring = parseSessionSpec("0930-1600:23456");
    const corrections = compileSessionCorrections([
      { tradingDay: "20260901", session: "1700F1-0200F1" },
      { tradingDay: "20260908", session: "1900F4-1845" },
    ]);
    if (!recurring.ok || !corrections.ok) throw new Error("Expected valid session correction fixtures");

    expect(correctedSessionTradingDayKey(Date.parse("2026-08-31T18:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBe("2026-09-01");
    expect(correctedSessionTradingDayKey(Date.parse("2026-09-01T01:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBe("2026-09-01");
    expect(correctedSessionTradingDayKey(Date.parse("2026-09-01T03:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBeUndefined();
    expect(correctedSessionTradingDayKey(Date.parse("2026-09-04T20:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBe("2026-09-08");
    expect(correctedSessionTradingDayKey(Date.parse("2026-09-08T18:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBe("2026-09-08");
    expect(correctedSessionTradingDayKey(Date.parse("2026-09-08T19:00:00Z"), recurring.value, corrections.value, "UTC"))
      .toBeUndefined();
  });
});
