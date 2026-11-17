import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const methods = ["inv", "pinv", "pow"] as const;
const source = (body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) =>
  compile({ compatibility, source: `//@version=6\nindicator("Matrix inverse and power")\n${body}` });

describe("strict matrix inverse, pseudoinverse and power contracts", () => {
  it("binds named, method and positional calls with matching element kinds", () => {
    const result = source(`matrix<int> i = matrix.new<int>(2, 2, 1)
matrix<int> inverse = matrix.inv(id = i)
matrix<int> pseudo = i.pinv()
matrix<int> powered = matrix.pow(i, -2)
plot(inverse.get(0, 0) + pseudo.get(0, 0) + powered.get(0, 0))`);
    expect(result.diagnostics).toEqual([]);
    for (const method of methods) {
      expect(result.program!.generatedSource).toMatch(new RegExp(`"(?:matrix\\.)?${method}"`, "u"));
      expect(PINE_PRODUCTION_CALLABLE_METADATA[`matrix.${method}`]?.documentation).toContain("matrix<int>");
      expect(PINE_CALLABLE_METADATA[`matrix.${method}`]?.typedOverloads?.[0]).toBeDefined();
    }
  });

  it("rejects nonnumeric matrices, nonmatrix receivers, float powers and wrong output kinds", () => {
    for (const method of methods) {
      const suffix = method === "pow" ? ", 2" : "";
      const invalid = [
        [`matrix<string> m = matrix.new<string>(1, 1, "x")\nvalue = matrix.${method}(m${suffix})`, "SCRIPT2122"],
        [`value = matrix.${method}(1${suffix})`, "SCRIPT2117"],
        [`matrix<int> m = matrix.new<int>(1, 1, 1)\nmatrix<string> wrong = matrix.${method}(m${suffix})`, "SCRIPT2102"],
      ] as const;
      for (const [body, code] of invalid) {
        const result = source(body);
        expect(result.program, `${method}/${code}`).toBeUndefined();
        expect(result.diagnostics.some((diagnostic) => diagnostic.code === code), `${method}/${code}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
      }
    }
    for (const body of [
      "matrix<int> m = matrix.new<int>(1, 1, 2)\nvalue = matrix.pow(m, 1.5)",
      "matrix<int> m = matrix.new<int>(1, 1, 2)\nvalue = m.pow(1.5)",
    ]) {
      const result = source(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ code }) => code === "SCRIPT2117" || code === "SCRIPT2111"), body).toBe(true);
    }
  });

  it("keeps sealed generic matrix admission", () => {
    for (const method of methods) {
      const suffix = method === "pow" ? ", 2" : "";
      expect(source(`matrix<string> m = matrix.new<string>(1, 1, "x")\nvalue = matrix.${method}(m${suffix})`, PINE_COMPATIBILITY.legacy).diagnostics, method).toEqual([]);
    }
  });
});
