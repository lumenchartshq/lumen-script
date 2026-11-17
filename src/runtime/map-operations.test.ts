import type { PineValue } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { mapCall, pineMapIteration } from "./collections.js";

const strict = { strict: true, negativeIndices: true } as const;

interface TestMap {
  readonly [key: string]: PineValue;
  readonly __pineMap: true;
  readonly entries: [PineValue, PineValue][];
}

const pineMap = (entries: [PineValue, PineValue][] = []): TestMap => ({ __pineMap: true, entries });

describe("strict map operations", () => {
  it("distinguishes a present missing value from an absent key", () => {
    const values = pineMap();
    mapCall("put", [values, "present", Number.NaN] as PineValue[], strict);

    expect(mapCall("contains", [values, "present"] as PineValue[], strict)).toBe(true);
    expect(mapCall("get", [values, "present"] as PineValue[], strict)).toBeNaN();
    expect(mapCall("contains", [values, "absent"] as PineValue[], strict)).toBe(false);
    expect(mapCall("get", [values, "absent"] as PineValue[], strict)).toBeNaN();
  });

  it("preserves replacement order and moves removed/reinserted keys to the end", () => {
    const values = pineMap();
    for (const [key, value] of [["first", 1], ["second", 2], ["third", 3]] as const) {
      mapCall("put", [values, key, value] as PineValue[], strict);
    }
    mapCall("put", [values, "second", 20] as PineValue[], strict);
    expect(mapCall("keys", [values] as PineValue[], strict)).toEqual(["first", "second", "third"]);
    expect(mapCall("values", [values] as PineValue[], strict)).toEqual([1, 20, 3]);

    expect(mapCall("remove", [values, "second"] as PineValue[], strict)).toBe(20);
    mapCall("put", [values, "second", 200] as PineValue[], strict);
    expect(mapCall("keys", [values] as PineValue[], strict)).toEqual(["first", "third", "second"]);
  });

  it("merges overlaps in place, appends new keys, and treats self-merge as a no-op", () => {
    const target = pineMap([["first", 1], ["second", 2]]);
    const source = pineMap([["second", 20], ["third", 3]]);

    expect(mapCall("put_all", [target, source] as PineValue[], strict)).toBeNull();
    expect(target.entries).toEqual([["first", 1], ["second", 20], ["third", 3]]);
    expect(mapCall("put_all", [target, target] as PineValue[], strict)).toBeNull();
    expect(target.entries).toEqual([["first", 1], ["second", 20], ["third", 3]]);
  });

  it("keeps iterators valid across existing-key replacement and overlap-only merges", () => {
    const target = pineMap([["first", 1], ["second", 2]]);
    const overlap = pineMap([["first", 10], ["second", 20]]);
    const entries = pineMapIteration(target as unknown as PineValue);

    expect(entries[0]).toEqual(["first", 1]);
    mapCall("put", [target, "second", 5] as PineValue[], strict);
    mapCall("put_all", [target, overlap] as PineValue[], strict);
    expect(entries[1]).toEqual(["second", 2]);
    expect(target.entries).toEqual([["first", 10], ["second", 20]]);
  });

  it("reads live replacements and still invalidates on the next structural read", () => {
    const target = pineMap([["first", 1], ["second", 2], ["third", 3]]);
    const entries = pineMapIteration(target, true);

    expect(entries[0]).toEqual(["first", 1]);
    mapCall("put", [target, "second", 20], strict);
    expect(entries[1]).toEqual(["second", 20]);
    mapCall("put", [target, "fourth", 4], strict);
    expect(() => entries[2]).toThrow("Cannot modify a map while iterating over its key-value pairs");
  });

  it.each([
    ["put insertion", (target: TestMap) => mapCall("put", [target, "third", 3] as PineValue[], strict)],
    ["put_all insertion", (target: TestMap) => mapCall("put_all", [target, pineMap([["third", 3]])] as PineValue[], strict)],
    ["remove", (target: TestMap) => mapCall("remove", [target, "second"] as PineValue[], strict)],
    ["clear", (target: TestMap) => mapCall("clear", [target] as PineValue[], strict)],
  ])("invalidates iterators after structural %s", (_label, mutate) => {
    const target = pineMap([["first", 1], ["second", 2]]);
    const entries = pineMapIteration(target as unknown as PineValue);

    expect(entries[0]).toEqual(["first", 1]);
    mutate(target);
    expect(() => entries[1]).toThrow(
      "Cannot modify a map while iterating over its key-value pairs with a `for...in` loop. Loop through a `copy()` of the map or its `keys()` array, or use a `for` or `while` loop instead.",
    );
  });

  it("keeps copy containers and key/value arrays independent while sharing object values", () => {
    const shared = { value: 1 } as unknown as PineValue;
    const source = pineMap([[1, shared]]);
    const copied = mapCall("copy", [source] as PineValue[], strict) as unknown as TestMap;
    const keys = mapCall("keys", [source] as PineValue[], strict) as PineValue[];
    const values = mapCall("values", [source] as PineValue[], strict) as PineValue[];

    (copied.entries[0]![1] as unknown as { value: number }).value = 2;
    expect((source.entries[0]![1] as unknown as { value: number }).value).toBe(2);
    copied.entries.push([2, 3]);
    keys[0] = 99;
    values[0] = 0;
    expect(source.entries).toEqual([[1, shared]]);
  });

  it("preflights put_all capacity without partial writes", () => {
    const target = pineMap(Array.from({ length: 49_999 }, (_, index) => [index, index] as [number, number]));
    const source = pineMap([[0, -1], [50_000, 1], [50_001, 2]]);
    const beforeTail = target.entries.slice(-2).map((entry) => [...entry]);

    expect(() => mapCall("put_all", [target, source] as PineValue[], strict)).toThrow("maximum of 50000");
    expect(target.entries).toHaveLength(49_999);
    expect(target.entries[0]).toEqual([0, 0]);
    expect(target.entries.slice(-2)).toEqual(beforeTail);
  });

  it("checks map capacity before allocating key, value, or copy snapshots", () => {
    const oversized = pineMap(Array.from({ length: 50_001 }, (_, index) => [index, index] as [number, number]));
    for (const operation of ["keys", "values", "copy"] as const) {
      expect(() => mapCall(operation, [oversized] as PineValue[], strict), operation).toThrow("maximum of 50000");
    }
  });

  it("retains sealed unbounded merge behavior", () => {
    const target = pineMap(Array.from({ length: 50_000 }, (_, index) => [index, index] as [number, number]));
    const source = pineMap([[50_000, 50_000]]);

    expect(mapCall("put_all", [target, source] as PineValue[])).toBeNull();
    expect(target.entries).toHaveLength(50_001);
  });
});
