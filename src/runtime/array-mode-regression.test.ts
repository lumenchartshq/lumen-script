import { describe, expect, it } from "vitest";

import { arrayCall } from "./collections.js";

const strict = { strict: true } as const;

describe("array mode count reuse", () => {
  it("keeps strict numeric ties, no-repeat order and missing omission", () => {
    expect(arrayCall("mode", [[4, 4, 2, 2, 3]], strict)).toBe(2);
    expect(arrayCall("mode", [[4, 1, 3, 2]], strict)).toBe(1);
    expect(arrayCall("mode", [[Number.NaN, null, 7]], strict)).toBe(7);
    expect(arrayCall("mode", [[Number.NaN, null]], strict)).toBeNaN();
  });

  it("retains sealed string ordering, coercion and missing-frequency behavior", () => {
    expect(arrayCall("mode", [["z", "a", "z", "a"]])).toBe("a");
    expect(arrayCall("mode", [["2", "10", "2", "10"]])).toBe("10");
    expect(arrayCall("mode", [[Number.NaN, Number.NaN, 1]])).toBeNaN();
    expect(arrayCall("mode", [["5", "5", 1]])).toBe("5");
  });

  it("handles a full-capacity all-distinct input without argument spreading", () => {
    const values = Array.from({ length: 100_000 }, (_, index) => index);
    expect(arrayCall("mode", [values], strict)).toBe(0);
    expect(arrayCall("mode", [values])).toBe(0);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(99_999);
  });
});
