import { PINE_CALLABLE_METADATA, PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const source = (body: string) => `//@version=6\nindicator("P11 line")\n${body}`;
const strict = (body: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source: source(body) });
const id = "line guide = line.new(0, 10, 1, 12)\n";

describe("P11 strict line follow-on semantic contract", () => {
  it("types all five forms through namespace, method, named and positional calls", () => {
    const types = {
      "line.copy": "reference", "line.get_x1": "int", "line.get_y1": "float",
      "line.set_xy1": "void", "line.set_color": "void",
    } as const;
    for (const [name, kind] of Object.entries(types)) {
      const definition = PINE_PRODUCTION_CALLABLE_METADATA[name]!;
      expect(definition.typedOverloads?.[0]?.returnType.kind, name).toBe(kind);
      expect(definition.typedOverloads?.[0]?.returnType.qualifier, name).toBe("series");
    }
    const accepted = strict(id + `series line clone = line.copy(id=guide)
series line clone2 = guide.copy()
series int x = line.get_x1(guide)
series float widened = guide.get_x1()
series float y = guide.get_y1()
series float y2 = line.get_y1(id=guide)
guide.set_xy1(0, 14)
line.set_xy1(y=14, x=0, id=guide)
color chosen = close > open ? color.green : color.red
guide.set_color(chosen)
line.set_color(color=chosen, id=clone)`);
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.program).toBeDefined();
  });

  it("rejects per-form receivers, missing and extra arguments, wrong types, results and void uses", () => {
    const negatives = [
      ["line.copy(id=7)", "line.copy"], ["line.copy()", "line.copy"],
      ["box b = box.new(0, 10, 1, 9)\nline.copy(b)", "line.copy"],
      [id + "guide.copy(1)", "line.copy"], [id + "string copy = guide.copy()", "Cannot assign"],
      ["line.get_x1(id=7)", "line.get_x1"], ["line.get_x1()", "line.get_x1"],
      [id + "guide.get_x1(1)", "line.get_x1"], [id + "string x = guide.get_x1()", "Cannot assign"],
      ["line.get_y1(id=7)", "line.get_y1"], ["line.get_y1()", "line.get_y1"],
      [id + "guide.get_y1(1)", "line.get_y1"], [id + "int y = guide.get_y1()", "Cannot assign"],
      [id + "line.set_xy1(guide, 0.5, 14)", "line.set_xy1"],
      [id + "guide.set_xy1(x=0, y=\"bad\")", "line.set_xy1"],
      [id + "line.set_xy1(id=guide, x=0)", "line.set_xy1"],
      [id + "guide.set_xy1(x=0)", "line.set_xy1"],
      [id + "line.set_xy1(guide, 0, 14, 7)", "line.set_xy1"],
      [id + "int value = guide.set_xy1(0, 14)", "Void expression"],
      [id + "guide.set_color(\"green\")", "line.set_color"],
      [id + "line.set_color(guide, 7)", "line.set_color"],
      [id + "line.set_color(id=guide)", "line.set_color"],
      [id + "guide.set_color()", "line.set_color"],
      [id + "line.set_color(guide, color.red, color.blue)", "line.set_color"],
      [id + "int value = guide.set_color(color.red)", "Void expression"],
      ["box b = box.new(0, 10, 1, 9)\nb.get_x1()", "line receiver"],
      ["box b = box.new(0, 10, 1, 9)\nb.get_y1()", "line receiver"],
      ["box b = box.new(0, 10, 1, 9)\nb.set_xy1(0, 14)", "line receiver"],
      ["box b = box.new(0, 10, 1, 9)\nb.set_color(color.red)", "line receiver"],
    ] as const;
    for (const [body, diagnostic] of negatives) {
      const result = strict(body);
      expect(result.program, body).toBeUndefined();
      expect(result.diagnostics.some(({ message }) => message.includes(diagnostic)), body).toBe(true);
    }
  });

  it("leaves sealed callable metadata and permissive line coercion unchanged", () => {
    expect(PINE_CALLABLE_METADATA["line.get_x1"]?.returnType).not.toBe("series int");
    expect(PINE_CALLABLE_METADATA["line.copy"]?.returnType).toBe("line");
    expect(compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source(id + "guide.set_color(\"green\")") }).program).toBeDefined();
  });
});
