import { describe, expect, it } from "vitest";
import { validatePineLibraryPublication } from "./index.js";

const valid =
  '//@version=6\nlibrary("MathKit")\nexport twice(float value) => value * 2';
const validate = (source: string, name = "MathKit") =>
  validatePineLibraryPublication(source, name);

describe("owner-private library publication validation", () => {
  it("compiles an exact title and typed exported function", () => {
    expect(validate(valid)).toMatchObject({
      diagnostics: [],
      exports: ["twice"],
    });
  });

  it("publishes exported user-defined types and enums as first-class exports", () => {
    const source = [
      "//@version=6",
      'library("MathKit")',
      "export enum Mode",
      "    add",
      "    subtract",
      "export type Item",
      "    float value",
      "    Mode mode = Mode.add",
      "export make(float value) => Item.new(value)",
    ].join("\n");
    expect(validate(source)).toEqual({
      diagnostics: [],
      exports: ["Mode", "Item", "make"],
    });
  });

  it("admits a type-only library interface", () => {
    expect(validate('//@version=6\nlibrary("MathKit")\nexport type Item\n    float value'))
      .toEqual({ diagnostics: [], exports: ["Item"] });
  });

  it.each([
    [
      "missing version",
      'library("MathKit")\nexport twice(float value) => value * 2',
      "SCRIPT2130",
    ],
    [
      "wrong script kind",
      '//@version=6\nindicator("MathKit")\nexport twice(float value) => value * 2',
      "SCRIPT2132",
    ],
    ["wrong title", valid.replace("MathKit", "Other"), "SCRIPT2133"],
    ["no export", valid.replace("export ", ""), "SCRIPT2134"],
    ["nested import", `${valid}\nimport own/Other/1 as other`, "SCRIPT2131"],
    [
      "unknown declaration option",
      valid.replace('library("MathKit")', 'library("MathKit", unknown=true)'),
      "SCRIPT2136",
    ],
    [
      "duplicate declaration option",
      valid.replace(
        'library("MathKit")',
        'library("MathKit", title="MathKit")',
      ),
      "SCRIPT2136",
    ],
    [
      "positional argument after named argument",
      valid.replace(
        'library("MathKit")',
        'library(overlay=true, "MathKit")',
      ),
      "SCRIPT2014",
    ],
  ])("rejects %s", (_label, source, code) => {
    expect(
      validate(source).diagnostics.some((item) => item.code === code),
    ).toBe(true);
  });

  it("rejects a malformed exported body instead of publishing a permanent broken version", () => {
    const result = validate(
      valid.replace("value * 2", "value + missingSymbol"),
    );
    expect(result.exports).toEqual([]);
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(
      true,
    );
  });

  it("rejects non-const global capture in the public export", () => {
    const result = validate(
      '//@version=6\nlibrary("MathKit")\nvar float factor = close\nexport twice(float value) => value * factor',
    );
    expect(result.exports).toEqual([]);
    expect(result.diagnostics.some((item) => item.code === "SCRIPT2123")).toBe(
      true,
    );
  });
});
