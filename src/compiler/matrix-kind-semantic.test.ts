import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Matrix kinds")\n${body}` });
const sealed = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.legacy, source: `//@version=6\nindicator("Sealed matrix kinds")\n${body}` });

describe("strict matrix kind transport", () => {
  it("emits binder-resolved constructor and arithmetic kinds through named and method forms", () => {
    const result = strict(`matrix<int> integers = matrix.new<int>(rows = 1, columns = 1, initial_value = 2)
matrix<float> decimals = matrix.new<float>(1, 1, 2)
matrix<float> named = matrix.sum(id2 = 1.0, id1 = integers)
matrix<float> method = integers.diff(1.0)
matrix<float> product = integers.mult(2.0)
matrix<int> joined = matrix.sum(integers, integers)
plot(matrix.avg(named) + matrix.median(method) + matrix.avg(product) + matrix.avg(joined))`);
    expect(result.diagnostics).toEqual([]);
    const generated = result.program!.generatedSource;
    expect(generated).toContain('"matrix.new",[1,1,2,"int"]');
    expect(generated).toContain('"matrix.new",[1,1,2,"float"]');
    expect(generated).toContain('"matrix.sum",[r.get(0),1,"float"]');
    expect(generated).toContain('"diff",[1,"float"]');
    expect(generated).toContain('"mult",[2,"float"]');
    expect(generated).toContain('"matrix.sum",[r.get(0),r.get(0),"int"]');
  });

  it("rejects a float arithmetic result assigned to an int matrix", () => {
    for (const expression of ["matrix.sum(integers, 1.0)", "integers.diff(1.0)", "integers.mult(2.0)"]) {
      const result = strict(`matrix<int> integers = matrix.new<int>(1, 1, 2)\nmatrix<int> wrong = ${expression}`);
      expect(result.program, expression).toBeUndefined();
      expect(result.diagnostics.some(({ code }) => code === "SCRIPT2102"), expression).toBe(true);
    }
  });

  it("types same-kind and mixed Kronecker products from operands, including whole-valued floats", () => {
    const result = strict(`matrix<int> integers = matrix.new<int>(1, 1, -2)
matrix<float> floats = matrix.new<float>(1, 1, 2)
matrix<int> intProduct = matrix.kron(id1 = integers, id2 = integers)
matrix<float> mixedNamed = matrix.kron(id2 = floats, id1 = integers)
matrix<float> mixedMethod = floats.kron(integers)
series int intValue = matrix.avg(intProduct)
series float floatValue = mixedNamed.median() + mixedMethod.avg()
plot(intValue + floatValue)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program!.generatedSource).toContain('"matrix.kron"');
    expect(result.program!.generatedSource).toContain('"kron"');
    const wrong = strict(`matrix<int> integers = matrix.new<int>(1, 1, -2)
matrix<float> floats = matrix.new<float>(1, 1, 2)
matrix<int> wrong = matrix.kron(integers, floats)`);
    expect(wrong.program).toBeUndefined();
    expect(wrong.diagnostics.some(({ code }) => code === "SCRIPT2102")).toBe(true);
  });

  it("keeps sealed method inference and emitted argument shapes for arithmetic", () => {
    for (const [expression, method] of [
      ["m.sum(1.0)", "sum"], ["m.diff(1.0)", "diff"],
      ["m.mult(1.0)", "mult"], ["m.kron(m)", "kron"],
    ] as const) {
      const body = `matrix<int> m = matrix.new<int>(1, 1, 2)\nmatrix<int> result = ${expression}\nplot(matrix.avg(result))`;
      const legacy = sealed(body);
      expect(legacy.diagnostics, expression).toEqual([]);
      expect(legacy.program?.generatedSource, expression).toContain(`"${method}",[${method === "kron" ? "r.get(0)" : "1"}]`);
      expect(legacy.program?.generatedSource, expression).toContain('"matrix.new",[1,1,2]');
    }
  });
});
