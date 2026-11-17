import { describe, expect, it } from "vitest";

import { arrayCall } from "./collections.js";

const strict = { strict: true, negativeIndices: true } as const;

describe("strict array constructor runtime", () => {
  it("creates false bool defaults and missing defaults for other element types", () => {
    expect(arrayCall("new_bool", [2], strict)).toEqual([false, false]);
    for (const name of ["new_color", "new_float", "new_int", "new_string", "new_Item"]) {
      const values = arrayCall(name, [2], strict);
      expect(values).toHaveLength(2);
      expect(values).not.toBe(arrayCall(name, [2], strict));
      expect((values as unknown[]).every((value) => typeof value === "number" && Number.isNaN(value))).toBe(true);
    }
    for (const name of ["new_box", "new_label", "new_line", "new_linefill", "new_table"]) {
      expect(arrayCall(name, [2], strict)).toEqual([null, null]);
    }
  });

  it("uses independent containers with shallow repeated element ownership", () => {
    const shared = { value: 1 } as never;
    const left = arrayCall("new_Item", [2, shared], strict) as unknown[];
    const right = arrayCall("new_Item", [2, shared], strict) as unknown[];
    expect(left).not.toBe(right);
    expect(left[0]).toBe(shared);
    expect(left[1]).toBe(shared);
    expect(right[0]).toBe(shared);
    (left[0] as { value: number }).value = 7;
    expect((right[1] as { value: number }).value).toBe(7);

    const from = arrayCall("from", [shared, shared], strict) as unknown[];
    expect(from).toEqual([shared, shared]);
    expect(from).not.toBe(left);
  });

  it("accepts exact boundary sizes and rejects invalid sizes before allocation", () => {
    expect(arrayCall("new_int", [0], strict)).toEqual([]);
    expect(arrayCall("new_int", [1, 4], strict)).toEqual([4]);
    expect((arrayCall("new_int", [100_000, 1], strict) as unknown[]).length).toBe(100_000);
    for (const size of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 100_001]) {
      expect(() => arrayCall("new_int", [size, 1], strict), String(size)).toThrow(/negative size|finite integer|maximum of 100000/u);
    }
  });

  it("retains sealed coercion and constructor defaults", () => {
    expect(arrayCall("new_int", [-2])).toEqual([]);
    expect(arrayCall("new_int", [2.8])).toEqual([0, 0]);
    expect(arrayCall("new_bool", [1])).toEqual([false]);
    expect(arrayCall("new_string", [1])).toEqual([""]);
    expect(arrayCall("new_float", [1])).toEqual([Number.NaN]);
  });
});
