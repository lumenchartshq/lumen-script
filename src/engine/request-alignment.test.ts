import { expect, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import { timeframeEnd } from "../runtime/index.js";
import { alignLowerRequestArrays } from "./request-alignment.js";
const bar = (openTime: number, closeTime?: number): MarketBar => ({ openTime, ...(closeTime === undefined ? {} : { closeTime }), open: 1, high: 1, low: 1, close: 1, volume: 1 });

it("matches interval filtering for gaps, overlaps, reversed closes and tuple na", () => {
  const parents = [bar(0, 10), bar(2, 5), bar(6, 4), bar(10, 30), bar(40, 50)];
  const children = [bar(0, 1), bar(2, 1), bar(3, 4), bar(5, 9), bar(9, 10), bar(10, 20), bar(30, 40)];
  const values = [[1, 2], [3, 4], [5, 6], NaN, [9, 10], [11, 12]];
  const expected = parents.map((parent) => {
    const selected = children.flatMap((child, index) => child.openTime >= parent.openTime && child.openTime < parent.closeTime! && child.closeTime! > parent.openTime ? [values[index] ?? NaN] : []);
    return [0, 1].map((component) => selected.map((value) => Array.isArray(value) ? value[component] : NaN));
  });
  expect(alignLowerRequestArrays(parents, "1", children, values, "1S", 2)).toEqual(expected);
});

it("uses calendar close boundaries across DST for daily parents", () => {
  const timezone = "America/New_York";
  const parents = [bar(Date.UTC(2026, 2, 7, 5)), bar(Date.UTC(2026, 2, 8, 5)), bar(Date.UTC(2026, 2, 9, 4))];
  const children = Array.from({ length: 74 }, (_, index) => bar(parents[0]!.openTime + index * 3_600_000));
  const values = children.map((_, index) => index);
  const expected = parents.map((parent) => children.flatMap((child, index) => child.openTime >= parent.openTime && child.openTime < timeframeEnd(parent.openTime, "1D", timezone) ? [index] : []));
  expect(alignLowerRequestArrays(parents, "1D", children, values, "60", 0, timezone, timezone, true)).toEqual(expected);
});

it("bounds timestamp reads rather than scanning all children for every parent", () => {
  let reads = 0;
  const children = Array.from({ length: 10_000 }, (_, index) => ({ ...bar(index, index + 1), get openTime() { reads++; return index; } }));
  const parents = Array.from({ length: 1_000 }, (_, index) => bar(index * 10, index * 10 + 10));
  const result = alignLowerRequestArrays(parents, "1", children, children.map((_, index) => index), "1S", 0);
  expect(result[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(result.at(-1)).toEqual([9990, 9991, 9992, 9993, 9994, 9995, 9996, 9997, 9998, 9999]);
  expect(reads).toBeLessThan(40_000);
});
