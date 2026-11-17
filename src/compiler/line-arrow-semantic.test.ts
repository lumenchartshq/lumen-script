import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const source = (body: string) => `//@version=6\nindicator("P15 arrows")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const styles = ["arrow_left", "arrow_right", "arrow_both"] as const;

describe("P15 line arrow constants", () => {
  it.each(styles)("types line.style_%s as const string and admits causal creation and mutation", (style) => {
    const constant = `line.style_${style}`;
    for (const body of [
      `const string chosen = ${constant}\nline.new(0, 10, 1, 12, style=chosen)`,
      `const string chosen = ${constant}\nline guide = line.new(0, 10, 1, 12)\nline.set_style(guide, chosen)`,
      `const string chosen = ${constant}\nline guide = line.new(0, 10, 1, 12)\nguide.set_style(style=chosen)`,
      `line guide = line.new(0, 10, 1, 12)\nstring chosen = close > open ? ${constant} : line.style_solid\nguide.set_style(chosen)`,
    ]) expect(strict(body).diagnostics, body).toEqual([]);
    const wrong = strict(`const int chosen = ${constant}`);
    expect(wrong.program).toBeUndefined();
    expect(wrong.diagnostics.some(({ code }) => code === "SCRIPT2102")).toBe(true);
  });

  it("rejects numbers, free strings and foreign provenance at both consumers", () => {
    for (const value of ["7", '"style_arrow_left"', "hline.style_solid", "plot.linestyle_solid"]) {
      for (const body of [
        `line.new(0, 10, 1, 12, style=${value})`,
        `line guide = line.new(0, 10, 1, 12)\nguide.set_style(${value})`,
      ]) expect(strict(body).program, body).toBeUndefined();
    }
  });

  it("retains sealed profile admission", () => {
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source('line.new(0, 10, 1, 12, style="custom")') }).diagnostics).toEqual([]);
  });
});
