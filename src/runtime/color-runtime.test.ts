import { describe, expect, it } from "vitest";

import { colorComponent, colorGradient, colorNew, colorRgb } from "./scalar-builtins.js";

describe("strict color runtime", () => {
  it("clamps and rounds RGB channels and truncates transparency to a whole number", () => {
    expect(colorRgb([-1, 12.5, 300, 0], true)).toBe("#000DFF");
    expect(colorRgb([1.49, 1.5, 254.5, 50], true)).toBe("#0102FF80");
    expect(colorRgb([8, 153, 129], true)).toBe("#089981");
    expect(colorRgb([8, 153, 129, -1], true)).toBe("#089981");
    expect(colorRgb([8, 153, 129, 101], true)).toBe("#08998100");
    // The reference platform stores 40.5 as 40 and reports it back as 40.
    expect(colorRgb([8, 153, 129, 40.5], true)).toBe("#08998199");
    expect(colorComponent("t", "#08998199", true)).toBe(40);
  });

  it("replaces transparency without changing RGB and exposes exact components", () => {
    expect(colorNew("#F2364580", 0, true)).toBe("#F23645");
    expect(colorNew("#F23645", 100, true)).toBe("#F2364500");
    expect(colorNew("#F23645", 50, true)).toBe("#F2364580");
    expect(colorComponent("r", "#F2364580", true)).toBe(242);
    expect(colorComponent("g", "#F2364580", true)).toBe(54);
    expect(colorComponent("b", "#F2364580", true)).toBe(69);
    expect(colorComponent("t", "#F2364580", true)).toBe(50);
  });

  it("interpolates and clamps gradients with independently calculated channels", () => {
    const args = (value: number) => [value, 0, 10, "#F23645", "#2196F380"] as const;
    expect(colorGradient(args(-1), true)).toBe("#F23645");
    expect(colorGradient(args(0), true)).toBe("#F23645");
    expect(colorGradient(args(2.5), true)).toBe("#BE4E71DF");
    expect(colorGradient(args(5), true)).toBe("#8A669CC0");
    expect(colorGradient(args(10), true)).toBe("#2196F380");
    expect(colorGradient(args(11), true)).toBe("#2196F380");
  });

  it("treats a missing gradient endpoint as the other endpoint at zero alpha", () => {
    expect(colorGradient([0, 0, 10, Number.NaN, "#F23645"], true)).toBe("#F2364500");
    expect(colorGradient([5, 0, 10, Number.NaN, "#F23645"], true)).toBe("#F2364580");
    expect(colorGradient([10, 0, 10, Number.NaN, "#F23645"], true)).toBe("#F23645");
    expect(colorGradient([0, 0, 10, "#2196F3", Number.NaN], true)).toBe("#2196F3");
    expect(colorGradient([5, 0, 10, "#2196F3", Number.NaN], true)).toBe("#2196F380");
    expect(colorGradient([10, 0, 10, "#2196F3", Number.NaN], true)).toBe("#2196F300");
  });

  it("fails closed for missing, nonfinite and malformed strict values", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(colorRgb([value, 0, 0], true)).toEqual(Number.NaN);
      expect(colorNew("#F23645", value, true)).toEqual(Number.NaN);
    }
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(colorGradient([value, 0, 10, "#F23645", "#2196F3"], true)).toEqual(Number.NaN);
    }
    // The reference platform returns fully transparent black for an na gradient value.
    expect(colorGradient([Number.NaN, 0, 10, "#F23645", "#2196F3"], true)).toBe("#00000000");
    expect(colorNew(Number.NaN, 50, true)).toEqual(Number.NaN);
    expect(colorComponent("r", "#GGGGGG", true)).toEqual(Number.NaN);
    expect(colorGradient([5, 0, 10, Number.NaN, Number.NaN], true)).toEqual(Number.NaN);
    expect(colorGradient([5, 0, 10, "quoted", "#2196F3"], true)).toEqual(Number.NaN);
  });

  it("preserves the accepted sealed color behavior exactly", () => {
    expect(colorRgb([-1, 300, 12.5, 150])).toBe("rgba(-1, 300, 12.5, -0.5)");
    expect(colorNew("#F23645", 150)).toBe("#F23645-7F");
    expect(colorGradient([5, 0, 10, Number.NaN, "#F23645"])).toEqual(Number.NaN);
    expect(colorComponent("t", "#F2364580")).toBe(50);
  });
});
