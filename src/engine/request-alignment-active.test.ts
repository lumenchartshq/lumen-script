import { expect, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import { alignLowerRequestArrays, alignRequestValues, alignSameContextRequestValues } from "./request-alignment.js";

const minute = 60_000;
const start = Date.UTC(2025, 0, 2);
const at = (value: number) => start + value * minute;
const bar = (open: number, close: number, value: number): MarketBar => ({
  openTime: at(open), closeTime: at(close), open: value, high: value, low: value, close: value, volume: 1,
});

const parents = [bar(0, 30, 1), bar(30, 60, 2), bar(60, 90, 3), bar(90, 130, 4), bar(140, 170, 5)];
const higher = [bar(0, 60, 100), bar(60, 130, 200), bar(130, 190, 300)];
const lower = [bar(0, 15, 10), bar(15, 30, 11), bar(30, 45, 20), bar(45, 60, 21), bar(90, 105, 40), bar(105, 120, 41), bar(145, 160, 50)];
const equal = [bar(0, 30, 1), bar(30, 60, 2), bar(90, 130, 4), bar(140, 170, 5)];

function values(children: readonly MarketBar[]) { return children.map((child) => child.close); }
function aligned(children: readonly MarketBar[], timeframe: string, lookahead: boolean, gaps: boolean, now: number) {
  return alignRequestValues(parents, "30", children, values(children), timeframe, lookahead, gaps, true, at(now), "UTC", "UTC");
}

it("merges higher, lower and sparse equal supplied rows by independent fixed-clock literals", () => {
  expect(aligned(higher, "60", false, false, 112)).toEqual([NaN, 100, 100, 200, NaN]);
  expect(aligned(higher, "60", true, false, 112)).toEqual([100, 100, 200, 200, NaN]);
  expect(aligned(higher, "60", false, true, 112)).toEqual([NaN, 100, NaN, NaN, NaN]);
  expect(aligned(higher, "60", true, true, 112)).toEqual([100, NaN, 200, NaN, NaN]);

  expect(aligned(lower, "15", false, false, 112)).toEqual([11, 21, 21, 41, NaN]);
  expect(aligned(lower, "15", true, false, 112)).toEqual([10, 20, 20, 40, NaN]);
  expect(aligned(lower, "15", false, true, 112)).toEqual([11, 21, NaN, NaN, NaN]);
  expect(aligned(lower, "15", true, true, 112)).toEqual([10, 20, NaN, 40, NaN]);

  expect(aligned(equal, "30", false, false, 112)).toEqual([1, 2, 2, 4, NaN]);
  expect(aligned(equal, "30", true, false, 112)).toEqual([1, 2, 2, 4, NaN]);
  expect(aligned(equal, "30", false, true, 112)).toEqual([1, 2, NaN, NaN, NaN]);
  expect(aligned(equal, "30", true, true, 112)).toEqual([1, 2, NaN, NaN, NaN]);
  expect(alignLowerRequestArrays(parents, "30", lower, values(lower), "15", 0, "UTC", "UTC", true, at(112))).toEqual([
    [10, 11], [20, 21], [], [40, 41], [],
  ]);
});

it("moves from active to closed at boundary equality without admitting future parent rows", () => {
  expect(aligned(higher, "60", true, false, 130)).toEqual([100, 100, 200, 200, NaN]);
  expect(aligned(higher, "60", false, true, 130)).toEqual([NaN, 100, NaN, 200, NaN]);
  expect(aligned(higher, "60", true, true, 130)).toEqual([100, NaN, 200, NaN, NaN]);
  expect(aligned(lower, "15", false, true, 120)).toEqual([11, 21, NaN, 41, NaN]);
  expect(alignLowerRequestArrays(parents, "30", lower, values(lower), "15", 0, "UTC", "UTC", true, at(130))).toEqual([
    [10, 11], [20, 21], [], [40, 41], [],
  ]);
});

it("treats leading and trailing sparse higher/equal fallback as carry, not a new gaps-on value", () => {
  const sparseParents = [bar(0, 30, 1), bar(120, 180, 2), bar(180, 240, 3)];
  const sparseChild = [bar(0, 60, 7)];
  for (const childTimeframe of ["60", "120"]) {
    const align = (lookahead: boolean, gaps: boolean) => alignRequestValues(
      sparseParents, "60", sparseChild, [7], childTimeframe, lookahead, gaps, true, at(240), "UTC", "UTC",
    );
    expect(align(false, false)).toEqual([NaN, 7, 7]);
    expect(align(true, false)).toEqual([7, 7, 7]);
    expect(align(false, true)).toEqual([NaN, NaN, NaN]);
    expect(align(true, true)).toEqual([7, NaN, NaN]);
  }
});

it("preserves an explicit null in an available same-context row", () => {
  expect(alignSameContextRequestValues(parents, parents.slice(0, 4), [null, 2, 3, 4], undefined, at(112))).toEqual([
    null, 2, 3, 4, NaN,
  ]);
});
