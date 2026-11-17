import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("P13 strokes")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const line = "line guide = line.new(0, 10, 1, 12)\n";

describe("P13 line stroke contracts", () => {
  it("binds exact series setters in namespace, method, named and positional forms", () => {
    for (const [method, parameter, kind, value] of [
      ["set_width", "width", "int", "4"], ["set_style", "style", "string", "line.style_dashed"],
    ] as const) {
      const definition = PINE_PRODUCTION_CALLABLE_METADATA[`line.${method}`]!;
      expect(definition.typedOverloads?.[0]?.parameters.map(({ name }) => name)).toEqual(["id", parameter]);
      expect(definition.typedOverloads?.[0]?.parameters[0]?.type).toMatchObject({ kind: "reference", name: "line", qualifier: "series" });
      expect(definition.typedOverloads?.[0]?.parameters[1]?.type).toMatchObject({ kind, qualifier: "series" });
      expect(definition.typedOverloads?.[0]?.returnType).toMatchObject({ kind: "void", qualifier: "series" });
      expect(PINE_CALLABLE_METADATA[`line.${method}`]?.typedOverloads?.[0]?.parameters[1]?.type.kind).toBe("unknown");
      const result = strict(line + `line.${method}(guide, ${value})\nline.${method}(${parameter}=${value}, id=guide)\nguide.${method}(${value})\nguide.${method}(${parameter}=${value})`);
      expect(result.diagnostics, method).toEqual([]);
    }
  });

  it("types three constants as const strings and permits scoped style provenance", () => {
    for (const style of ["solid", "dashed", "dotted"]) {
      expect(strict(`const string chosen = line.style_${style}\nline.new(0, 10, 1, 12, style=chosen)`).diagnostics).toEqual([]);
    }
    expect(strict(line + `line.style_solid == line.style_dashed
if close > open
    string chosen = line.style_dashed
    guide.set_style(chosen)
else
    string chosen = line.style_dotted
    line.set_style(guide, chosen)
string chosen = close > open ? line.style_solid : line.style_dashed
line.set_style(guide, chosen)`).diagnostics).toEqual([]);
  });

  it("rejects wrong receiver, width, style domain, arity, and void use", () => {
    for (const method of ["set_width", "set_style"] as const) {
      const valid = method === "set_width" ? "4" : "line.style_dashed";
      const wrong = method === "set_width" ? "2.5" : "hline.style_dashed";
      for (const [body, message] of [
        [line + `line.${method}(guide)`, `line.${method}`],
        [line + `guide.${method}()`, `line.${method}`],
        [line + `line.${method}(guide, ${valid}, 4)`, `line.${method}`],
        [line + `guide.${method}(${valid}, 4)`, `line.${method}`],
        [line + `line.${method}(guide, ${wrong})`, `line.${method}`],
        [line + `guide.${method}(${wrong})`, `line.${method}`],
        [`line.${method}(7, ${valid})`, "requires series line"],
        [`box b = box.new(0, 10, 1, 9)\nb.${method}(${valid})`, "line receiver"],
        [line + `int value = guide.${method}(${valid})`, "Void expression"],
      ] as const) {
        const result = strict(body);
        expect(result.program, body).toBeUndefined();
        expect(result.diagnostics.some(({ message: actual }) => actual.includes(message)), body).toBe(true);
      }
    }
    for (const style of ['"style_dashed"', "plot.linestyle_dashed", "hline.style_dotted", "7"]) {
      expect(strict(line + `guide.set_style(${style})`).program, style).toBeUndefined();
    }
  });

  it("preserves sealed permissive calls", () => {
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source(line + 'guide.set_width(2.5)\nguide.set_style("custom")') });
    expect(sealed.diagnostics).toEqual([]);
  });
});
