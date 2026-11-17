import { expect, it } from "vitest";
import { lex, PineSyntaxError } from "./lexer.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

it.each(['"""A\n  B"""', "'''A\n  B'''", '"A\n    B"'])("preserves following source locations after %s", (literal) => {
  const source = `value = ${literal}\nnext = 1`;
  const token = lex(source, PINE_COMPATIBILITY.strict).find((item) => item.value === "next");
  expect(token?.range.start).toEqual({ line: 3, column: 1, offset: source.indexOf("next") });
});

it("reports an unterminated multiline literal from its opening delimiter", () => {
  try {
    lex('value = """A\nB', PINE_COMPATIBILITY.strict);
    throw new Error("Expected a syntax error");
  } catch (error) {
    expect(error).toBeInstanceOf(PineSyntaxError);
    expect((error as PineSyntaxError).range.start).toEqual({ line: 1, column: 9, offset: 8 });
  }
});
