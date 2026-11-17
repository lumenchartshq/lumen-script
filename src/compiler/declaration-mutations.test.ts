import { describe, expect, it } from "vitest";
import { findMutatedDeclarations } from "./declaration-mutations.js";
import { parse } from "./parser.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

describe("declaration mutation analysis", () => {
  it.each([
    ["x = 3\nx := 4", [["x", 1]]],
    ["x = 3\nif true\n    x = 4\n    x := 5", [["x", 3]]],
    ["x = 3\nif true\n    x := 5", [["x", 1]]],
    ["x = 3\nf(x) =>\n    x := 5\n    x", []],
    ["x = 3\nf() =>\n    x := 5\n    x", [["x", 1]]],
    ["x = 3\nfor x = 0 to 1\n    x := 5", []],
    ["x = 3\nfor x in array.from(1)\n    x := 5", []],
    ["x = 3\nif true\n    [x, y] = [1, 2]\n    x := 5", []],
    ["x = 3\ny = if true\n    x := 5\n    x\nelse\n    x", [["x", 1]]],
    ["x = 3\ny = for i = 0 to 1\n    x := 5\n    x", [["x", 1]]],
    ["x = 3\ny = for i in array.from(1)\n    x := 5\n    x", [["x", 1]]],
    ["x = 3\ny = while x < 5\n    x := 5\n    x", [["x", 1]]],
    ["x = 3\ny = switch\n    true =>\n        x := 5\n        x\n    => x", [["x", 1]]],
  ] as const)("resolves declaration identities for %s", (source, expected) => {
    const program = parse(source, 5, PINE_COMPATIBILITY.strict);
    expect([...findMutatedDeclarations(program)].map((node) => [node.name, node.range.start.line])).toEqual(expected);
  });
  it("returns original AST declarations without mutating the program", () => {
    const program = parse("x = 3\nx := 4", 5, PINE_COMPATIBILITY.strict);
    const original = JSON.stringify(program);
    expect([...findMutatedDeclarations(program)][0]).toBe(program.statements[0]);
    expect(JSON.stringify(program)).toBe(original);
  });
});
