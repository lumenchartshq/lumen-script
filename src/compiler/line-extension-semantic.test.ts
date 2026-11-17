import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const header = '//@version=6\nindicator("P14 extension")\n';
const line = "line guide = line.new(0, 10, 1, 12)\n";
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: header + body });

describe("P14 line.set_extend contract", () => {
  it("binds exact line, string and void types with namespace, method and named arguments", () => {
    const typed = PINE_PRODUCTION_CALLABLE_METADATA["line.set_extend"]!.typedOverloads![0]!;
    expect(typed.parameters.map(({ name }) => name)).toEqual(["id", "extend"]);
    expect(typed.parameters[0]!.type).toMatchObject({ kind: "reference", name: "line", qualifier: "series" });
    expect(typed.parameters[1]!.type).toMatchObject({ kind: "string", qualifier: "series" });
    expect(typed.returnType).toMatchObject({ kind: "void", qualifier: "series" });
    expect(PINE_CALLABLE_METADATA["line.set_extend"]!.typedOverloads?.[0]?.parameters[1]?.type.kind).toBe("unknown");
    for (const choice of ["none", "left", "right", "both"]) {
      const value = `extend.${choice}`;
      expect(strict(line + `line.set_extend(guide, ${value})\nline.set_extend(extend=${value}, id=guide)\nguide.set_extend(${value})\nguide.set_extend(extend=${value})`).diagnostics).toEqual([]);
    }
  });

  it("retains scope-aware aliases, conditionals and series choices", () => {
    expect(strict(line + `string chosen = close > open ? extend.left : extend.right
guide.set_extend(chosen)
if close > open
    string chosen = extend.both
    line.set_extend(guide, chosen)
else
    string chosen = extend.none
    guide.set_extend(chosen)`).diagnostics).toEqual([]);
  });

  it("rejects wrong receiver, domain, type, arity, names and void use", () => {
    const bad = [
      [line + "line.set_extend(guide)", "line.set_extend"],
      [line + "guide.set_extend()", "line.set_extend"],
      [line + "line.set_extend(guide, extend.right, extend.left)", "line.set_extend"],
      [line + "guide.set_extend(extend.right, extend.left)", "line.set_extend"],
      [line + "line.set_extend(extra=extend.right, id=guide)", "line.set_extend"],
      [line + "guide.set_extend(extra=extend.right)", "line.set_extend"],
      [line + "line.set_extend(guide, 7)", "line.set_extend"],
      [line + "line.set_extend(guide, line.style_solid)", "extend constant"],
      [line + "guide.set_extend(xloc.bar_index)", "extend constant"],
      [line + 'guide.set_extend("r")', "extend constant"],
      [line + "int value = guide.set_extend(extend.right)", "Void expression"],
      ["line.set_extend(7, extend.right)", "requires series line"],
      ["box b = box.new(0, 10, 1, 9)\nline.set_extend(b, extend.right)", "requires series line"],
    ] as const;
    for (const [body, message] of bad) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message: actual }) => actual.includes(message)), body).toBe(true);
    }
  });

  it("keeps sealed free-string setter behavior", () => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: header + line + 'guide.set_extend("custom")' });
    expect(result.diagnostics).toEqual([]);
  });
});
