import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const methods = ["min", "max", "mode", "trace"] as const;
const source = (body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) =>
  compile({ compatibility, source: `//@version=6\nindicator("Matrix numeric contracts")\n${body}` });

describe("strict matrix numeric generic contracts", () => {
  it("binds namespace positional and named calls and methods with exact int and float results", () => {
    for (const method of methods) {
      const name = `matrix.${method}`;
      expect(PINE_PRODUCTION_CALLABLE_METADATA[name]?.documentation).toContain("matrix<int>");
      expect(PINE_CALLABLE_METADATA[name]?.typedOverloads?.[0]?.returnType.kind).toBe("float");
      const result = source(`matrix<int> integers = matrix.new<int>(0, 0)
matrix<float> decimals = matrix.new<float>(0, 0)
series int a = matrix.${method}(integers)
series int b = matrix.${method}(id = integers)
series int c = integers.${method}()
series float d = matrix.${method}(decimals)
series float e = matrix.${method}(id = decimals)
series float f = decimals.${method}()
plot(a + b + c + d + e + f)`);
      expect(result.diagnostics, name).toEqual([]);
      expect(result.program?.generatedSource, name).toContain(`"matrix.${method}"`);
    }
  });

  it("rejects empty nonnumeric generics, nonmatrices, bad binding and incompatible declarations per form", () => {
    for (const method of methods) {
      const name = `matrix.${method}`;
      const invalid = [
        ["string", `matrix<string> m = matrix.new<string>(0, 0)\nvalue = m.${method}()`, "SCRIPT2122"],
        ["bool", `matrix<bool> m = matrix.new<bool>(0, 0)\nvalue = matrix.${method}(id = m)`, "SCRIPT2122"],
        ["object", `type Item\n    int value\nmatrix<Item> m = matrix.new<Item>(0, 0)\nvalue = matrix.${method}(m)`, "SCRIPT2122"],
        ["nonmatrix", `value = matrix.${method}(1)`, "SCRIPT2117"],
        ["unknown receiver", `value = matrix.${method}(na)`, "SCRIPT2117"],
        ["missing", `value = matrix.${method}()`, "SCRIPT2014"],
        ["extra", `matrix<int> m = matrix.new<int>(0, 0)\nvalue = m.${method}(1)`, "SCRIPT2014"],
        ["wrong name", `matrix<int> m = matrix.new<int>(0, 0)\nvalue = matrix.${method}(matrix_id = m)`, "SCRIPT2014"],
        ["wrong int result", `matrix<int> m = matrix.new<int>(0, 0)\nseries string value = m.${method}()`, "SCRIPT2102"],
        ["wrong float result", `matrix<float> m = matrix.new<float>(0, 0)\nseries int value = matrix.${method}(m)`, "SCRIPT2102"],
      ] as const;
      for (const [label, body, code] of invalid) {
        const result = source(body);
        expect(result.program, `${name}/${label}`).toBeUndefined();
        expect(result.diagnostics.some((diagnostic) => diagnostic.code === code), `${name}/${label}: ${JSON.stringify(result.diagnostics)}`).toBe(true);
      }
    }
  });

  it("preserves sealed admission for an empty nonnumeric matrix", () => {
    for (const method of methods) {
      const result = source(`matrix<string> m = matrix.new<string>(0, 0)\nvalue = matrix.${method}(m)`, PINE_COMPATIBILITY.legacy);
      expect(result.diagnostics, method).toEqual([]);
    }
  });
});
