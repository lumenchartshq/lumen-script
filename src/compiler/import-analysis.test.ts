import { describe, expect, it } from "vitest";
import { hasUnresolvedImports } from "./import-analysis.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

describe("unresolved import analysis", () => {
  it("defers thousands of valid import declarations without repeated source copies", () => {
    const source =
      "//@version=6\n" +
      "import author/library/1 as lib\n".repeat(12_000) +
      'indicator("Imports")\nplot(close)\n';

    expect(
      hasUnresolvedImports(source, PINE_COMPATIBILITY.strict),
    ).toBe(true);
  });
});

it("accepts an implicit library-name alias only in the production lane", () => {
  const source = '//@version=6\nimport author/library/1\nindicator("Imports")\nplot(library.value(close))';
  expect(hasUnresolvedImports(source, PINE_COMPATIBILITY.strict)).toBe(true);
  expect(() => hasUnresolvedImports(source, PINE_COMPATIBILITY.legacy)).toThrow('Invalid library import declaration');
});
