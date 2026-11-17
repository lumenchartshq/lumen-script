import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("M3")\n${body}` });
const sealed = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.legacy, source: `//@version=6\nindicator("M3 sealed")\n${body}` });

describe("strict M3 matrix signatures", () => {
  it("types namespace, reversed named and method arithmetic with compiler-resolved kinds", () => {
    const result = strict(`matrix<int> a = matrix.new<int>(2, 2, -2)
matrix<float> b = matrix.new<float>(2, 2, 3)
matrix<int> appended = matrix.concat(id2 = a.copy(), id1 = a)
matrix<float> difference = a.diff(1.0)
matrix<float> total = matrix.sum(id2 = b, id1 = a)
matrix<float> kron = matrix.kron(id2 = b, id1 = a)
matrix<int> product = a.mult(a)
array<float> vector = matrix.mult(id2 = array.from(1.0, 2.0), id1 = a)
matrix<float> scaled = b.mult(2)
matrix.sort(id = a, column = 1, order = order.descending)
b.sort(order = order.ascending, column = 0)
plot(matrix.avg(total) + array.avg(vector))`);
    expect(result.diagnostics).toEqual([]);
    const generated = result.program!.generatedSource;
    for (const method of ["concat", "sum", "kron", "mult", "sort"]) expect(generated).toContain(`"matrix.${method}"`);
    expect(generated).toContain('"diff",[1,"float"]');
    expect(generated).toContain('"matrix.sum",[r.get(0),r.get(1),"float"]');
    expect(generated).toContain('"matrix.mult",[r.get(0),r.call(9,"array.from",[1,2]),"float"]');
    expect(generated).toContain('"diff",[1,"float"]');
    expect(generated).toContain('"mult",[2,"float"]');
  });

  it("rejects each form's wrong operand, generic and declared result", () => {
    const prefix = `matrix<int> a = matrix.new<int>(1, 1, 2)\nmatrix<float> f = matrix.new<float>(1, 1, 2)\nmatrix<string> s = matrix.new<string>(1, 1, "2")`;
    const failures = [
      ["concat scalar", "matrix.concat(a, 2)", "SCRIPT2117"],
      ["concat generic", "matrix.concat(a, f)", "SCRIPT2111"],
      ["concat result", "matrix<float> wrong = a.concat(a)", "SCRIPT2102"],
      ["diff string", "matrix.diff(s, 1)", "SCRIPT2122"],
      ["diff bool", "matrix.diff(a, true)", "SCRIPT2117"],
      ["diff result", "matrix<int> wrong = a.diff(1.0)", "SCRIPT2102"],
      ["kron scalar", "matrix.kron(a, 2)", "SCRIPT2117"],
      ["kron string", "matrix.kron(a, s)", "SCRIPT2117"],
      ["kron result", "matrix<int> wrong = a.kron(f)", "SCRIPT2102"],
      ["mult string", "matrix.mult(s, 2)", "SCRIPT2122"],
      ["mult vector", "matrix.mult(a, array.from(" + '"x"' + "))", "SCRIPT2117"],
      ["mult result", "matrix<int> wrong = a.mult(array.from(2))", "SCRIPT2102"],
      ["sort scalar", "matrix.sort(2)", "SCRIPT2117"],
      ["sort bool", "matrix.sort(matrix.new<bool>(1, 1, true))", "SCRIPT2122"],
      ["sort column", "matrix.sort(a, column = 0.5)", "SCRIPT2117"],
      ["sort order", "matrix.sort(a, order = 0)", "SCRIPT2122"],
      ["sort result", "int wrong = a.sort()", "SCRIPT2137"],
      ["sum string", "matrix.sum(s, 2)", "SCRIPT2122"],
      ["sum bool", "matrix.sum(a, false)", "SCRIPT2117"],
      ["sum result", "matrix<int> wrong = a.sum(f)", "SCRIPT2102"],
    ] as const;
    for (const [label, body, code] of failures) {
      const result = strict(`${prefix}\n${body}`);
      expect(result.program, label).toBeUndefined();
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === code), label).toBe(true);
    }
  });

  it("keeps sealed coercive compilation and argument emission", () => {
    const source = `matrix<string> s = matrix.new<string>(1, 1, "2")\nmatrix<string> result = matrix.sum(s, 1)\nplot(matrix.rows(result))`;
    const legacy = sealed(source);
    expect(legacy.diagnostics).toEqual([]);
    expect(legacy.program?.generatedSource).toContain('"matrix.sum",[r.get(0),1]');
    expect(strict(source).diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2122")).toBe(true);
  });

  it("admits typed missing numeric operands while refusing ambiguous untyped na", () => {
    const source = `matrix<float> m = matrix.new<float>(1, 1, 1)\nmatrix<float> total = matrix.sum(m, float(na))\narray<float> vector = m.mult(array.from(float(na)))`;
    expect(strict(source).diagnostics).toEqual([]);
    const ambiguous = strict(`matrix<float> m = matrix.new<float>(1, 1, 1)\nvalue = matrix.diff(m, na)`);
    expect(ambiguous.diagnostics.some(({ code }) => code === "SCRIPT2117")).toBe(true);
  });

  it("binds each method's named receiver-relative parameters and rejects misplaced names", () => {
    const valid = strict(`matrix<int> a = matrix.new<int>(1, 1, 2)
matrix<int> joined = a.concat(id2 = a)
matrix<int> difference = a.diff(id2 = 1)
matrix<int> kronecker = a.kron(id2 = a)
matrix<int> product = a.mult(id2 = 2)
matrix<int> total = a.sum(id2 = 1)
a.sort(column = 0, order = order.descending)`);
    expect(valid.diagnostics).toEqual([]);
    for (const method of ["concat", "diff", "kron", "mult", "sum"]) {
      const invalid = strict(`matrix<int> a = matrix.new<int>(1, 1, 2)\nvalue = a.${method}(id1 = a)`);
      expect(invalid.diagnostics.some(({ code }) => code === "SCRIPT2014"), method).toBe(true);
    }
  });

  it("keeps the local UDT sort_field contract and rejects invalid selectors", () => {
    const prelude = `type Item\n    float score\n    bool enabled\nmatrix<Item> m = matrix.new<Item>(1, 1, Item.new(2.0, true))`;
    expect(strict(`${prelude}\nm.sort(column = 0, order = order.ascending, sort_field = "score")`).diagnostics).toEqual([]);
    for (const selector of ['"missing"', '"enabled"', "2"]) {
      const invalid = strict(`${prelude}\nm.sort(sort_field = ${selector})`);
      expect(invalid.diagnostics.some(({ code }) => code === "SCRIPT2122"), selector).toBe(true);
    }
    const scalarField = strict(`matrix<int> m = matrix.new<int>(1, 1, 1)\nm.sort(sort_field = 0)`);
    expect(scalarField.diagnostics.some(({ code }) => code === "SCRIPT2122")).toBe(true);
    const seriesField = strict(`${prelude}\nseries string field = close > 0 ? "score" : "enabled"\nm.sort(sort_field = field)`);
    expect(seriesField.diagnostics.some(({ code, message }) => code === "SCRIPT2122" && message.includes("const int or string"))).toBe(true);
    const inputField = strict(`${prelude}\nstring field = input.string("score")\nmatrix.sort(id = m, sort_field = field)`);
    expect(inputField.diagnostics.some(({ code, message }) => code === "SCRIPT2122" && message.includes("const int or string"))).toBe(true);
  });
});
