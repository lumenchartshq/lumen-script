import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const methods = [
  "is_antidiagonal", "is_antisymmetric", "is_binary", "is_diagonal", "is_identity",
  "is_square", "is_stochastic", "is_symmetric", "is_triangular", "is_zero",
] as const;

const source = (body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict, version = 6) => compile({
  compatibility,
  source: `//@version=${version}\nindicator("Matrix predicates")\n${body}`,
});

describe("strict matrix predicate semantic contracts", () => {
  it("types all ten production calls as series bool and binds namespace, named receiver and method forms in v5/v6", () => {
    for (const method of methods) {
      const name = `matrix.${method}`;
      expect(PINE_PRODUCTION_CALLABLE_METADATA[name]?.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
      if (method !== "is_square") {
        expect(PINE_PRODUCTION_CALLABLE_METADATA[name]?.documentation).toContain("matrix<int> or matrix<float>");
      }
      expect(PINE_PRODUCTION_CALLABLE_METADATA[name]?.typedOverloads?.[0]?.returnType).toEqual({ kind: "bool", qualifier: "series" });
      expect(PINE_CALLABLE_METADATA[name]?.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
      for (const version of [5, 6]) {
        const result = source(`matrix<int> m = matrix.new<int>(1, 1, 0)
series bool positional = matrix.${method}(m)
series bool named = matrix.${method}(id = m)
series bool receiver = m.${method}()
plot(positional and named and receiver ? 1 : 0)`, PINE_COMPATIBILITY.strict, version);
        expect(result.diagnostics, `${name}/v${version}`).toEqual([]);
        expect(result.program?.generatedSource, name).toContain(`"matrix.${method}"`);
      }
    }
    const anyMatrix = source(`matrix<string> m = matrix.new<string>(1, 1, "x")
series bool square = matrix.is_square(id = m)
plot(square ? 1 : 0)`);
    expect(anyMatrix.diagnostics).toEqual([]);
  });

  it("rejects wrong receiver, element type, arity and result qualifier independently", () => {
    for (const method of methods) {
      const name = `matrix.${method}`;
      const wrongReceiver = source(`series bool value = matrix.${method}(1)`);
      expect(wrongReceiver.diagnostics.some(({ message }) => message.includes("requires series matrix")), name).toBe(true);
      const wrongArity = source(`matrix<int> m = matrix.new<int>(1, 1, 0)
value = m.${method}(1)`);
      expect(wrongArity.diagnostics.length, name).toBeGreaterThan(0);
      const wrongResult = source(`matrix<int> m = matrix.new<int>(1, 1, 0)
simple bool value = m.${method}()`);
      expect(wrongResult.diagnostics.some(({ code }) => code === "SCRIPT2102"), name).toBe(true);
      if (method !== "is_square") {
        const wrongElements = source(`matrix<string> m = matrix.new<string>(1, 1, "x")
series bool value = matrix.${method}(m)`);
        expect(wrongElements.diagnostics.some(({ code }) => code === "SCRIPT2122"), name).toBe(true);
      }
    }
  });

  it("leaves sealed call admission and return typing intact", () => {
    const sealed = source(`matrix<string> m = matrix.new<string>(1, 1, "x")
value = matrix.is_binary(id = m)`, PINE_COMPATIBILITY.legacy);
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
