import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("P12 coordinates")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const line = "line guide = line.new(0, 10, 1, 12)\n";
const setters = ["set_x1", "set_x2", "set_y1", "set_y2"] as const;

describe("P12 single-coordinate line setters", () => {
  it("binds each exact series line and coordinate signature in namespace and method forms", () => {
    for (const method of setters) {
      const definition = PINE_PRODUCTION_CALLABLE_METADATA[`line.${method}`]!;
      const parameters = definition.typedOverloads?.[0]?.parameters;
      expect(parameters?.map(({ name }) => name)).toEqual(["id", method.startsWith("set_x") ? "x" : "y"]);
      expect(parameters?.[0]?.type).toMatchObject({ kind: "reference", name: "line", qualifier: "series" });
      expect(parameters?.[1]?.type).toMatchObject({ kind: method.startsWith("set_x") ? "int" : "float", qualifier: "series" });
      expect(definition.typedOverloads?.[0]?.returnType).toMatchObject({ kind: "void", qualifier: "series" });
      expect(PINE_CALLABLE_METADATA[`line.${method}`]?.typedOverloads?.[0]?.parameters[1]?.type.kind).toBe("unknown");
      const coordinate = method.startsWith("set_x") ? "2" : "14";
      const argument = method.startsWith("set_x") ? "x" : "y";
      const result = strict(line + `line.${method}(guide, ${coordinate})\nline.${method}(${argument}=${coordinate}, id=guide)\nguide.${method}(${coordinate})\nguide.${method}(${argument}=${coordinate})`);
      expect(result.diagnostics, method).toEqual([]);
      expect(result.program).toBeDefined();
    }
    expect(strict(line + "guide.set_y1(14)\nseries float widened = line.get_x1(guide)").diagnostics).toEqual([]);
  });

  it("rejects missing, extra, wrong receiver, wrong coordinate and void value for each form", () => {
    for (const method of setters) {
      const valid = method.startsWith("set_x") ? "2" : "14";
      const invalid = method.startsWith("set_x") ? "2.5" : '"bad"';
      for (const [body, diagnostic] of [
        [line + `line.${method}(guide)`, `line.${method}`],
        [line + `guide.${method}()`, `line.${method}`],
        [line + `line.${method}(guide, ${valid}, 3)`, `line.${method}`],
        [line + `guide.${method}(${valid}, 3)`, `line.${method}`],
        [line + `line.${method}(guide, ${invalid})`, `line.${method}`],
        [line + `guide.${method}(${invalid})`, `line.${method}`],
        [`line.${method}(7, ${valid})`, "requires series line"],
        [`box b = box.new(0, 10, 1, 9)\nb.${method}(${valid})`, "line receiver"],
        [line + `int value = guide.${method}(${valid})`, "Void expression"],
      ] as const) {
        const result = strict(body);
        expect(result.program, body).toBeUndefined();
        expect(result.diagnostics.some(({ message }) => message.includes(diagnostic)), body).toBe(true);
      }
    }
  });

  it("keeps the sealed line setter binding permissive", () => {
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source(line + "guide.set_x1(2.5)\nguide.set_y2(\"14\")") });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
