import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const methods = ["det", "rank"] as const;
const source = (body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) =>
  compile({ compatibility, source: `//@version=6\nindicator("Matrix linear algebra")\n${body}` });

describe("strict matrix determinant and rank contracts", () => {
  it("binds named and method calls with exact declared result kinds", () => {
    const result = source(`matrix<int> i = matrix.new<int>(2, 2, 1)
series float determinant = matrix.det(id = i)
series int rank = i.rank()
plot(determinant + rank)`);
    expect(result.diagnostics).toEqual([]);
    for (const method of methods) {
      expect(result.program!.generatedSource).toMatch(new RegExp(`"(?:matrix\\.)?${method}"`, "u"));
      expect(PINE_PRODUCTION_CALLABLE_METADATA[`matrix.${method}`]?.documentation).toContain("matrix<int>");
      expect(PINE_CALLABLE_METADATA[`matrix.${method}`]?.typedOverloads?.[0]).toBeDefined();
    }
  });

  it("rejects nonnumeric matrices, wrong receivers, names and result declarations", () => {
    for (const method of methods) {
      const invalid = [
        [`matrix<string> m = matrix.new<string>(0, 0)\nvalue = matrix.${method}(m)`, "SCRIPT2122"],
        [`value = matrix.${method}(1)`, "SCRIPT2117"],
        [`matrix<int> m = matrix.new<int>(1, 1, 1)\nvalue = matrix.${method}()`, "SCRIPT2014"],
        [`matrix<int> m = matrix.new<int>(1, 1, 1)\nvalue = matrix.${method}(wrong = m)`, "SCRIPT2014"],
      ] as const;
      for (const [body, code] of invalid) {
        const result = source(body);
        expect(result.program, `${method}/${code}`).toBeUndefined();
        expect(result.diagnostics.some((diagnostic) => diagnostic.code === code), `${method}/${code}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
      }
    }
    for (const body of [
      "matrix<int> m = matrix.new<int>(1, 1, 1)\nseries int wrong = m.det()",
      "matrix<int> m = matrix.new<int>(1, 1, 1)\nseries string wrong = m.rank()",
    ]) expect(source(body).diagnostics.some(({ code }) => code === "SCRIPT2102"), body).toBe(true);
  });

  it("retains sealed generic admission", () => {
    for (const method of methods) {
      expect(source(`matrix<string> m = matrix.new<string>(0, 0)\nvalue = matrix.${method}(m)`, PINE_COMPATIBILITY.legacy).diagnostics, method).toEqual([]);
    }
  });
});
