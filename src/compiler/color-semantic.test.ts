import { pineCallableMetadata, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const compileStrict = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Colors")\n${body}`,
});

describe("strict color semantics", () => {
  it("publishes exact production-only color signatures", () => {
    const strict = pineCallableMetadata(PINE_COMPATIBILITY.strict);
    const sealed = pineCallableMetadata(PINE_COMPATIBILITY.legacy);
    for (const name of ["color.r", "color.g", "color.b", "color.t"] as const) {
      expect(strict[name]?.returnType, name).toBe("series float");
      expect(strict[name]?.typedOverloads?.[0]?.parameters[0]?.type, name).toEqual({ kind: "color", qualifier: "series" });
      expect(strict[name]?.typedOverloads?.[0]?.returnType, name).toEqual({ kind: "float", qualifier: "series" });
      expect(sealed[name]?.returnType, name).toBe("series int");
    }
    expect(strict["color.new"]?.typedOverloads?.[0]?.parameters.map(({ name, type }) => [name, type.kind])).toEqual([
      ["color", "color"], ["transp", "float"],
    ]);
    expect(strict["color.rgb"]?.typedOverloads?.[0]?.parameters.map(({ name, type, optional }) => [name, type.kind, optional ?? false])).toEqual([
      ["red", "float", false], ["green", "float", false], ["blue", "float", false], ["transp", "float", true],
    ]);
    expect(strict["color.from_gradient"]?.typedOverloads?.[0]?.parameters.map(({ name, type }) => [name, type.kind])).toEqual([
      ["value", "float"], ["bottom_value", "float"], ["top_value", "float"], ["bottom_color", "color"], ["top_color", "color"],
    ]);
  });

  it("preserves const, input, simple and series qualifiers exactly", () => {
    const result = compileStrict(`
const color constNew = color.new(color.red, 50)
const color constRgb = color.rgb(8, 153, 129)
const float constRed = color.r(color.red)
input color inputBase = input.color(color.blue)
input int inputTransparency = input.int(25)
input color inputNew = color.new(inputBase, inputTransparency)
input float inputGreen = color.g(inputBase)
simple color simpleNew = color.new(chart.bg_color, 10)
simple float simpleBlue = color.b(chart.fg_color)
series color seriesNew = color.new(close > open ? color.green : color.red, close)
series color seriesRgb = color.rgb(close, open, high, low)
series float seriesTransparency = color.t(seriesNew)
series color gradient = color.from_gradient(close, low, high, color.red, color.blue)
plot(constRed + inputGreen + simpleBlue + seriesTransparency)
plot(close, color=gradient)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("binds positional, reordered named, default and nested constructor arguments", () => {
    const result = compileStrict(`
const color opaque = color.rgb(blue=129, red=8, green=153)
const color transparent = color.rgb(transp=100, green=54, blue=69, red=242)
const color nested = color.new(color.rgb(242.4, 53.6, 69.2), transp=50.5)
series color gradient = color.from_gradient(top_color=color.blue, bottom_color=color.red, top_value=10, value=close, bottom_value=0)
const float red = color.r(color=#F23645)
plot(red)
plot(close, color=opaque)
plot(close, color=transparent)
plot(close, color=nested)
plot(close, color=gradient)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"color.rgb",[8,153,129,undefined]');
    expect(result.program?.generatedSource).toContain('"color.from_gradient",[r.data("close"),0,10,r.constant("color.red"),r.constant("color.blue")]');
  });

  it("uses strict bound constructor order for input color descriptors only", () => {
    const strict = compileStrict(`
const color alias = color.rgb(blue=129, red=8, green=153)
input color reorderedRgb = input.color(color.rgb(blue=0, red=255, green=0))
input color defaultedRgb = input.color(color.rgb(blue=129, red=8, green=153))
input color reorderedNew = input.color(color.new(transp=50, color=color.red))
input color nestedGeneric = input(color.new(transp=20, color=alias))
plot(color.r(reorderedRgb) + color.g(defaultedRgb) + color.t(reorderedNew) + color.b(nestedGeneric))`);
    expect(strict.diagnostics).toEqual([]);
    expect(strict.program?.descriptor.inputs).toEqual([
      { id: "reorderedRgb", type: "color", title: "", defaultValue: "#FF0000" },
      { id: "defaultedRgb", type: "color", title: "", defaultValue: "#089981" },
      { id: "reorderedNew", type: "color", title: "", defaultValue: "#F2364580" },
      { id: "nestedGeneric", type: "color", title: "", defaultValue: "#089981CC" },
    ]);

    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed input colors")
rgb = input.color(color.rgb(blue=0, red=255, green=0))
replacement = input.color(color.new(transp=50, color=color.red))
plot(close)`,
    });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program?.descriptor.inputs).toEqual([
      { id: "rgb", type: "color", title: "", defaultValue: "#00FF00" },
      { id: "replacement", type: "color", title: "", defaultValue: null },
    ]);
  });

  it("distinguishes native color literals from quoted hexadecimal strings", () => {
    expect(compileStrict("const color native = color.new(#089981, 20)").diagnostics).toEqual([]);
    const quoted = compileStrict('value = color.new("#089981", 20)');
    expect(quoted.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    expect(quoted.diagnostics.find(({ code }) => code === "SCRIPT2117")?.message).toContain("requires series color");
    expect(quoted.program).toBeUndefined();
  });

  it("rejects invalid argument kinds and weaker result qualifiers", () => {
    const cases = [
      ['value = color.r("#F23645")', "requires series color"],
      ["value = color.g(1)", "requires series color"],
      ["value = color.new(color.red, true)", "requires series float"],
      ['value = color.rgb("1", 2, 3)', "requires series float"],
      ["value = color.from_gradient(false, 0, 1, color.red, color.blue)", "requires series float"],
      ['value = color.from_gradient(0.5, 0, 1, "red", color.blue)', "requires series color"],
    ] as const;
    for (const [body, message] of cases) {
      const result = compileStrict(body);
      expect(result.diagnostics.find(({ code }) => code === "SCRIPT2117")?.message, body).toContain(message);
      expect(result.program, body).toBeUndefined();
    }

    for (const body of [
      "const float invalid = color.r(input.color(color.red))",
      "const color invalid = color.new(color.red, input.int(10))",
      "simple color invalid = color.from_gradient(0.5, 0, 1, color.red, color.blue)",
    ]) {
      expect(compileStrict(body).diagnostics, body).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    }
  });

  it("preserves the sealed compiler admission and integer getter result", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed colors")
series int red = color.r("#F23645")
legacy = color.rgb("1", 2, 3)
plot(red)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });
});
