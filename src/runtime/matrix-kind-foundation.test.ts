import { compile } from "../compiler/index.js";
import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { createRuntime } from "./index.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot } from "./runtime-snapshot.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const strict = { strict: true } as const;
const data = (matrix: unknown): unknown[][] => (matrix as { data: unknown[][] }).data;
const kind = (matrix: unknown): unknown => (matrix as { elementKind?: unknown }).elementKind;

describe("strict matrix kind foundation", () => {
  it("distinguishes equal integer cells from whole-valued floats, including negative and empty aggregates", () => {
    const integers = matrixCall("new_int", [1, 2, -1], strict);
    const floats = matrixCall("new_float", [1, 2, -1], strict);
    matrixCall("set", [integers, 0, 1, -2], strict);
    matrixCall("set", [floats, 0, 1, -2], strict);
    expect([kind(integers), kind(floats)]).toEqual(["int", "float"]);
    expect([matrixCall("avg", [integers], strict), matrixCall("median", [integers], strict)]).toEqual([-1, -1]);
    expect([matrixCall("avg", [floats], strict), matrixCall("median", [floats], strict)]).toEqual([-1.5, -1.5]);
    for (const matrix of [matrixCall("new_int", [], strict), matrixCall("new_float", [1, 1], strict)]) {
      expect(matrixCall("avg", [matrix], strict)).toBeNaN();
      expect(matrixCall("median", [matrix], strict)).toBeNaN();
    }
    expect(() => matrixCall("new", [1, 1, 1], strict)).toThrow(/explicit element kind/u);
    expect(() => matrixCall("new_int", [1, 1, 1.5], strict)).toThrow(/finite int/u);
    expect(() => matrixCall("new_float", [1, 1, Number.POSITIVE_INFINITY], strict)).toThrow(/finite float/u);
    const large = matrixCall("new_float", [1, 2, 1e308], strict);
    expect(matrixCall("avg", [large], strict)).toBe(1e308);
  });

  it("truncates exact integer means without a floating-point near-integer error", () => {
    for (const value of [61, -61]) {
      const constant = matrixCall("new_int", [1, 7, value], strict);
      expect(matrixCall("avg", [constant], strict)).toBe(value);
    }
    const below = matrixCall("new_int", [1, 7, 61], strict);
    matrixCall("set", [below, 0, 0, 60], strict);
    expect(matrixCall("avg", [below], strict)).toBe(60);
    const above = matrixCall("new_int", [1, 7, 61], strict);
    matrixCall("set", [above, 0, 0, 62], strict);
    expect(matrixCall("avg", [above], strict)).toBe(61);
    const negative = matrixCall("new_int", [1, 7, -61], strict);
    matrixCall("set", [negative, 0, 0, -60], strict);
    expect(matrixCall("avg", [negative], strict)).toBe(-60);
    const capacity = matrixCall("new_int", [1, 100_000, 61], strict);
    expect(matrixCall("avg", [capacity], strict)).toBe(61);
  });

  it("keeps kind through independent containers and shallow object aliases", () => {
    const source = matrixCall("new_float", [1, 2, 1], strict);
    const copy = matrixCall("copy", [source], strict);
    const transpose = matrixCall("transpose", [source], strict);
    const subset = matrixCall("submatrix", [source, 0, 1, 0, 2], strict);
    for (const value of [copy, transpose, subset]) expect(kind(value)).toBe("float");
    matrixCall("set", [copy, 0, 0, 2], strict);
    expect(matrixCall("get", [source, 0, 0], strict)).toBe(1);
    matrixCall("concat", [source, matrixCall("new_float", [1, 2, 3], strict)], strict);
    expect(kind(source)).toBe("float");
    const shared = { __pineType: "Item", value: 1 };
    const objects = matrixCall("new_Item", [1, 1, shared], strict);
    const objectsCopy = matrixCall("copy", [objects], strict);
    expect(data(objectsCopy)[0]![0]).toBe(shared);
    shared.value = 2;
    expect((data(objectsCopy)[0]![0] as { value: number }).value).toBe(2);
    expect(kind(objectsCopy)).toBe("other");
  });

  it("rejects invalid writes and mixed concat before any mutation", () => {
    const integers = matrixCall("new_int", [2, 2, 1], strict);
    const before = JSON.stringify(integers);
    for (const [name, args] of [
      ["set", [integers, 0, 0, 1.5]],
      ["fill", [integers, Number.POSITIVE_INFINITY]],
      ["add_row", [integers, 0, [1, 2.5]]],
      ["add_col", [integers, 0, [1, "bad"]]],
      ["concat", [integers, matrixCall("new_float", [1, 2, 1], strict)]],
    ] as const) {
      expect(() => matrixCall(name, args, strict), name).toThrow();
      expect(JSON.stringify(integers), name).toBe(before);
    }
    const forged = { __pineMatrix: true, elementKind: "int", columnCount: 2, data: [[1, 1.5]] } as never;
    expect(() => matrixCall("concat", [integers, forged], strict)).toThrow();
    expect(JSON.stringify(integers)).toBe(before);
  });

  it("uses compiler-resolved scalar result kind rather than JavaScript number shape", () => {
    const integers = matrixCall("new_int", [1, 1, 2], strict);
    const floated = matrixCall("sum", [integers, 1, "float"], strict);
    expect(kind(floated)).toBe("float");
    expect(matrixCall("avg", [floated], strict)).toBe(3);
    expect(() => matrixCall("sum", [integers, 1], strict)).toThrow(/compiler-resolved/u);
    const doubled = matrixCall("mult", [integers, 2, "int"], strict);
    expect(kind(doubled)).toBe("int");
    expect(matrixCall("avg", [doubled], strict)).toBe(4);
  });

  it("retains sealed constructor shape and numeric coercion for avg and median", () => {
    const sealed = matrixCall("new_float", [1, 2, "5"]);
    expect(Object.hasOwn(sealed as object, "elementKind")).toBe(false);
    expect(matrixCall("avg", [sealed])).toBe(5);
    expect(matrixCall("median", [sealed])).toBe(5);
    const strictOther = matrixCall("new_Item", [1, 1, { __pineType: "Item" }], strict);
    expect(() => matrixCall("avg", [strictOther], strict)).toThrow(/int or float/u);
    const stringMatrix = matrixCall("new_string", [1, 1, "2"], strict);
    expect(() => matrixCall("sum", [stringMatrix, 1, "string"], strict)).toThrow(/int or float matrix/u);
    const joined = matrixCall("concat", [stringMatrix, matrixCall("new_string", [1, 1, "3"], strict)], strict);
    expect(kind(joined)).toBe("other");
    expect(data(joined)).toEqual([["2"], ["3"]]);
  });

  it("applies the reviewed local int conversion only at linear-algebra result boundaries", () => {
    for (const [name, input, expected] of [
      ["inv", 2, 0], ["inv", -2, 0],
      ["pinv", 2, 0], ["pinv", -2, 0],
    ] as const) {
      const integers = matrixCall("new_int", [1, 1, input], strict);
      const floats = matrixCall("new_float", [1, 1, input], strict);
      const integerResult = matrixCall(name, [integers], strict);
      const floatResult = matrixCall(name, [floats], strict);
      expect(kind(integerResult)).toBe("int");
      expect(data(integerResult)).toEqual([[expected]]);
      expect(kind(floatResult)).toBe("float");
      expect(data(floatResult)).toEqual([[1 / input]]);
      expect(matrixCall("avg", [integerResult], strict)).toBe(expected);
    }
    const rectangular = matrixCall("new_int", [1, 2, 0], strict);
    matrixCall("set", [rectangular, 0, 0, 2], strict);
    expect(data(matrixCall("pinv", [rectangular], strict))).toEqual([[0], [0]]);
    const fractionalEigen = matrixCall("new_int", [2, 2, 0], strict);
    for (const [row, column, value] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 2]] as const) {
      matrixCall("set", [fractionalEigen, row, column, value], strict);
    }
    const integerVectors = matrixCall("eigenvectors", [fractionalEigen], strict);
    const floatVectors = matrixCall("eigenvectors", [matrixCall("new_float", [2, 2, 1], strict)], strict);
    expect(kind(integerVectors)).toBe("int");
    expect(data(integerVectors)).toEqual([[0, 0], [0, 0]]);
    expect(kind(floatVectors)).toBe("float");
    const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Matrix")\nplot(close)' }).program!;
    const state = { ...createRuntime(program, {}).snapshot(), variables: [[integerVectors]] };
    const restored = deserializeRuntimeSnapshot(serializeRuntimeSnapshot(state));
    expect(kind(restored.variables[0]?.[0])).toBe("int");
    expect(data(restored.variables[0]?.[0])).toEqual([[0, 0], [0, 0]]);
  });

  it("carries Kronecker kind from operands with whole-valued float cells and signed products", () => {
    const integers = matrixCall("new_int", [1, 1, -2], strict);
    const floats = matrixCall("new_float", [1, 1, 2], strict);
    const integral = matrixCall("kron", [integers, integers], strict);
    const mixed = matrixCall("kron", [integers, floats], strict);
    expect([kind(integral), data(integral)]).toEqual(["int", [[4]]]);
    expect([kind(mixed), data(mixed)]).toEqual(["float", [[-4]]]);
    expect(matrixCall("median", [mixed], strict)).toBe(-4);
    const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Kron")\nplot(close)' }).program!;
    const state = { ...createRuntime(program, {}).snapshot(), variables: [[mixed]] };
    const restored = deserializeRuntimeSnapshot(serializeRuntimeSnapshot(state));
    expect(kind(restored.variables[0]?.[0])).toBe("float");
    expect(data(restored.variables[0]?.[0])).toEqual([[-4]]);
    const tall = matrixCall("new_int", [1_000, 0], strict);
    const otherTall = matrixCall("new_int", [101, 0], strict);
    expect(() => matrixCall("kron", [tall, otherTall], strict)).toThrow(/row count exceeds/u);
  });

  it("rejects forged and kindless matrices recursively while preserving aliases and cycles", () => {
    const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Matrix state")\nplot(close)' }).program!;
    const state = createRuntime(program, {}).snapshot();
    const matrix = matrixCall("new_float", [1, 2, 1], strict);
    const nested: Record<string, unknown> = { array: [matrix], map: new Map([["matrix", matrix]]) };
    nested.self = nested;
    const candidate = { ...state, callState: new Map([["nested", nested]]) };
    const restored = deserializeRuntimeSnapshot(serializeRuntimeSnapshot(candidate));
    const revived = restored.callState.get("nested") as typeof nested;
    expect(revived.self).toBe(revived);
    expect((revived.array as unknown[])[0]).toBe((revived.map as Map<string, unknown>).get("matrix"));
    expect(kind((revived.array as unknown[])[0])).toBe("float");
    for (const change of [
      (value: Record<string, unknown>) => { delete value.elementKind; },
      (value: Record<string, unknown>) => { value.elementKind = "forged"; },
      (value: Record<string, unknown>) => { (value.data as unknown[][])[0]![1] = "bad"; },
      (value: Record<string, unknown>) => { value.columnCount = 3; },
    ]) {
      const copy = structuredClone(candidate);
      const target = ((copy.callState.get("nested") as typeof nested).array as Record<string, unknown>[])[0]!;
      change(target);
      expect(() => deserializeRuntimeSnapshot(serializeRuntimeSnapshot(copy))).toThrow(/checkpoint matrix/u);
    }
    expect(() => deserializeRuntimeSnapshot(serializeRuntimeSnapshot({ ...state, variables: [[{ __pineMatrix: true, columnCount: 0, data: [] }]] }))).toThrow(/checkpoint matrix/u);
  });
});
