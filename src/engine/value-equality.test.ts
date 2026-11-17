import { expect, it } from "vitest";
import { structurallyEqual } from "./value-equality.js";

it("compares cycles, aliases and special scalars without recursive traversal", () => {
  const a: unknown[] = [NaN, -0]; a.push(a);
  const b: unknown[] = [NaN, -0]; b.push(b);
  expect(structurallyEqual(a, b)).toBe(true);
  b[1] = 0;
  expect(structurallyEqual(a, b)).toBe(false);
  const shared = { value: 1 };
  expect(structurallyEqual([shared, shared], [{ value: 1 }, { value: 1 }])).toBe(false);
  let left: unknown = null, right: unknown = null;
  for (let i = 0; i < 20_000; i++) { left = [left]; right = [right]; }
  expect(structurallyEqual(left, right)).toBe(true);
});

it("compares collection contents and own property keys", () => {
  expect(structurallyEqual(new Map([[1, new Set([2])]]), new Map([[1, new Set([2])]]))).toBe(true);
  expect(structurallyEqual(new Map([[1, 2]]), new Map([[1, 3]]))).toBe(false);
  expect(structurallyEqual({ a: undefined }, { b: undefined })).toBe(false);
  expect(structurallyEqual([], {})).toBe(false);
});
