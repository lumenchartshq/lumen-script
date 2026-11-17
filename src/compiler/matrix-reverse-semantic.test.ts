import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("Matrix reverse")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });

describe("strict matrix.reverse semantic contract", () => {
  it("admits generic matrices through namespace and method syntax and returns void", () => {
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.reverse"]?.typedOverloads?.[0]?.parameters[0]?.name).toBe("id");
    expect(PINE_PRODUCTION_CALLABLE_METADATA["matrix.reverse"]?.typedOverloads?.[0]?.returnType.kind).toBe("void");
    expect(PINE_CALLABLE_METADATA["matrix.reverse"]?.typedOverloads?.[0]?.parameters[0]?.type.kind).toBe("unknown");
    const result = strict(`type Item\n    float value
matrix<int> numbers = matrix.new<int>(1, 2, 0)
matrix.reverse(numbers)
numbers.reverse()
matrix.reverse(id = numbers)
matrix<string> words = matrix.new<string>(1, 1, "x")
words.reverse()
matrix<Item> objects = matrix.new<Item>(1, 1, Item.new(1))
objects.reverse()`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"matrix.reverse"');
    expect(result.program?.generatedSource).toContain('"reverse"');
  });

  it("rejects wrong receiver, surplus arguments and value use", () => {
    for (const [body, message] of [
      ["matrix.reverse(1)", "requires series matrix"],
      ["matrix<int> m = matrix.new<int>(1, 1, 0)\nm.reverse(1)", "argument"],
      ["matrix<int> m = matrix.new<int>(1, 1, 0)\nmatrix.reverse(m, 1)", "argument"],
      ["matrix<int> m = matrix.new<int>(1, 1, 0)\nresult = m.reverse()", "void"],
      ["matrix<int> m = matrix.new<int>(1, 1, 0)\nresult = matrix.reverse(m)", "void"],
    ] as const) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message: actual }) => actual.toLowerCase().includes(message)), body).toBe(true);
    }
  });

  it("keeps the sealed receiver contract accepted at the base", () => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("matrix.reverse(1)") });
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });
});
