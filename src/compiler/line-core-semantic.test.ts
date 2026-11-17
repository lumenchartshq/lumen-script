import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("Line core")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });

describe("P10 strict line core semantic contract", () => {
  it("types both constructors and namespace, method and named forms", () => {
    const metadata = PINE_PRODUCTION_CALLABLE_METADATA;
    expect(metadata["line.new"]?.typedOverloads).toHaveLength(2);
    expect(metadata["line.new"]?.typedOverloads?.map(({ returnType }) => returnType.kind)).toEqual(["reference", "reference"]);
    expect(metadata["line.get_x2"]?.returnType).toBe("series int");
    expect(metadata["line.get_y2"]?.returnType).toBe("series float");
    expect(metadata["line.get_price"]?.returnType).toBe("series float");
    expect(metadata["line.set_xy2"]?.returnType).toBe("void");
    expect(metadata["line.delete"]?.returnType).toBe("void");
    const result = strict(`chart.point first = chart.point.from_index(0, 10)
chart.point second = chart.point.from_index(1, 12)
series line fromPoints = line.new(first_point=first, second_point=second, xloc=xloc.bar_index)
series line fromNumbers = line.new(x1=0, y1=10, x2=1, y2=12)
series line reordered = line.new(y2=12, x2=1, y1=10, x1=0)
fromPoints.set_xy2(x=2, y=14)
line.set_xy2(id=fromNumbers, x=2, y=14)
series int x = fromPoints.get_x2()
series float y = line.get_y2(id=fromNumbers)
series float price = fromPoints.get_price(x=1)
fromPoints.delete()
line.delete(id=fromNumbers)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"line.new"');
    expect(result.program?.generatedSource).toContain('"set_xy2"');
  });

  it("rejects each form's wrong receiver, argument, declared result and void value", () => {
    const valid = "line id = line.new(0, 10, 1, 12)\n";
    const negatives = [
      ["line.new(0, 10)", "Missing required argument"],
      ["line.new(first_point=chart.point.from_index(0, 10), second_point=1)", "requires series chart.point"],
      ["line.new(0.5, 10, 1, 12)", "requires series int"],
      ["float result = line.new(0, 10, 1, 12)", "Cannot assign"],
      [valid + "line.set_xy2(id, 1.5, 14)", "requires series int"],
      [valid + "id.set_xy2(x=1, y=\"bad\")", "requires series float"],
      [valid + "x = line.set_xy2(id, 2, 14)", "Void expression"],
      [valid + "string x = line.get_x2(id)", "Cannot assign"],
      [valid + "line.get_x2(1)", "requires series line"],
      [valid + "int y = line.get_y2(id)", "Cannot assign"],
      [valid + "line.get_y2(1)", "requires series line"],
      [valid + "line.get_price(id, 1.5)", "requires series int"],
      [valid + "int p = line.get_price(id, 1)", "Cannot assign"],
      [valid + "line.delete(1)", "requires series line"],
      [valid + "x = id.delete()", "Void expression"],
      ["box b = box.new(0, 10, 1, 9)\nb.get_price(1)", "line receiver"],
    ] as const;
    for (const [body, message] of negatives) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message: actual }) => actual.includes(message)), body).toBe(true);
    }
  });

  it("keeps sealed metadata and base admission separate", () => {
    expect(PINE_CALLABLE_METADATA["line.get_x2"]?.returnType).not.toBe("series int");
    expect(PINE_CALLABLE_METADATA["line.new"]?.typedOverloads).toHaveLength(1);
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("line.new(0.5, 10, 1, 12)") }).program).toBeDefined();
  });

  it("admits tracked line option constants and rejects arbitrary option strings", () => {
    const accepted = strict(`string location = xloc.bar_index
string extension = extend.right
string stroke = line.style_dotted
line.new(0, 10, 1, 12, xloc=location, extend=extension, style=stroke)`);
    expect(accepted.diagnostics).toEqual([]);
    for (const [option, value] of [["xloc", '"bar_time"'], ["extend", '"both"'], ["style", '"dotted"'], ["xloc", "extend.right"]] as const) {
      const rejected = strict(`line.new(0, 10, 1, 12, ${option}=${value})`);
      expect(rejected.program).toBeUndefined();
      expect(rejected.diagnostics.some(({ message }) => message.includes(`Argument '${option}'`))).toBe(true);
    }
  });

  it("requires const force_overlay in both constructor overloads and fallback bindings", () => {
    const definitions = PINE_PRODUCTION_CALLABLE_METADATA["line.new"]?.typedOverloads ?? [];
    expect(definitions.map(({ parameters }) => parameters.find(({ name }) => name === "force_overlay")?.type)).toEqual([
      { kind: "bool", qualifier: "const" }, { kind: "bool", qualifier: "const" },
    ]);
    const points = "chart.point first = chart.point.from_index(0, 10)\nchart.point second = chart.point.from_index(1, 12)\n";
    const constructors = [
      (value: string) => `line.new(0, 10, 1, 12, force_overlay=${value})`,
      (value: string) => `line.new(0, 10, 1, 12, xloc.bar_index, extend.none, color.blue, line.style_solid, 1, ${value})`,
      (value: string) => `${points}line.new(first_point=first, second_point=second, force_overlay=${value})`,
      (value: string) => `${points}line.new(first, second, xloc.bar_index, extend.none, color.blue, line.style_solid, 1, ${value})`,
    ];
    for (const constructor of constructors) {
      for (const [declaration, value] of [["", "true"], ["const bool overlay = false\n", "overlay"]] as const) {
        const result = strict(declaration + constructor(value));
        expect(result.diagnostics, result.program?.source).toEqual([]);
        expect(result.program).toBeDefined();
      }
      for (const [declaration, value] of [
        ["input bool overlay = input.bool(true)\n", "overlay"],
        ["simple bool overlay = true\n", "overlay"],
        ["", "close > open"],
      ] as const) {
        const body = declaration + constructor(value);
        const result = strict(body);
        expect(result.program, body).toBeUndefined();
        expect(result.diagnostics.some(({ code, message }) => code === "SCRIPT2117" && message.includes("force_overlay") && message.includes("const bool")), body).toBe(true);
      }
    }
    const dynamicOtherArguments = strict(`chart.point first = chart.point.now(close)
chart.point second = chart.point.from_index(bar_index + 1, close + 1)
line.new(bar_index, close, bar_index + 1, close + 1, color=close > open ? color.red : color.blue, width=bar_index + 1, force_overlay=true)
line.new(first, second, color=close > open ? color.red : color.blue, width=bar_index + 1, force_overlay=false)`);
    expect(dynamicOtherArguments.diagnostics).toEqual([]);
    expect(dynamicOtherArguments.program).toBeDefined();
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("line.new(0, 10, 1, 12, force_overlay=close > open)") });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
