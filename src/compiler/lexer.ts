import type { PineCompatibility, SourcePosition, SourceRange } from "../contracts/index.js";
import { isStrictPineCompatibility, PINE_COMPATIBILITY } from "../contracts/index.js";

export type TokenKind = "color" | "identifier" | "number" | "string" | "operator" | "newline" | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly range: SourceRange;
}

export class PineSyntaxError extends Error {
  public constructor(message: string, public readonly range: SourceRange) {
    super(message);
    this.name = "PineSyntaxError";
  }
}

const twoCharacterOperators = new Set([":=", "==", "!=", "<=", ">=", "=>", "+=", "-=", "*=", "/=", "%="]);
const singleCharacterOperators = new Set("()[],.+-*/%?:=<>".split(""));

export function lex(source: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.legacy): readonly Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const position = (): SourcePosition => ({ offset, line, column });
  const advance = (): string => {
    const character = source[offset] ?? "";
    offset += 1;
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return character;
  };
  const push = (kind: TokenKind, value: string, start: SourcePosition): void => {
    tokens.push({ kind, value, range: { start, end: position() } });
  };

  while (offset < source.length) {
    const character = source[offset] ?? "";
    if (character === " " || character === "\t" || character === "\r") {
      advance();
      continue;
    }
    if (character === "\n") {
      const start = position();
      advance();
      push("newline", "\n", start);
      continue;
    }
    if (character === "/" && source[offset + 1] === "/") {
      while (offset < source.length && source[offset] !== "\n") advance();
      continue;
    }
    const start = position();
    if (/[A-Za-z_]/u.test(character)) {
      let value = "";
      while (offset < source.length && /[A-Za-z0-9_]/u.test(source[offset] ?? "")) value += advance();
      push("identifier", value, start);
      continue;
    }
    if (/\d/u.test(character) || (character === "." && /\d/u.test(source[offset + 1] ?? ""))) {
      let value = "";
      while (offset < source.length && /[\d_]/u.test(source[offset] ?? "")) value += advance();
      if (source[offset] === ".") {
        value += advance();
        while (offset < source.length && /[\d_]/u.test(source[offset] ?? "")) value += advance();
      }
      if ((source[offset] ?? "").toLowerCase() === "e") {
        value += advance();
        if (source[offset] === "+" || source[offset] === "-") value += advance();
        while (offset < source.length && /\d/u.test(source[offset] ?? "")) value += advance();
      }
      push("number", value.replaceAll("_", ""), start);
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = advance();
      const modern = isStrictPineCompatibility(compatibility);
      const multiline = modern && source.slice(offset, offset + 2) === quote.repeat(2);
      if (multiline) { advance(); advance(); }
      const delimiter = multiline ? quote.repeat(3) : quote;
      let value = "";
      let closed = false;
      while (offset < source.length) {
        if (source.startsWith(delimiter, offset)) {
          for (let index = 0; index < delimiter.length; index++) advance();
          closed = true;
          break;
        }
        const current = advance();
        if (current === "\\") {
          const escaped = advance();
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else value += escaped;
        } else if (modern && (current === "\n" || (current === "\r" && source[offset] === "\n"))) {
          if (current === "\r") advance();
          if (multiline) value += "\n";
          else {
            if (source[offset] !== " " && source[offset] !== "\t") throw new PineSyntaxError("A wrapped string continuation must be indented", { start, end: position() });
            while (source[offset] === " " || source[offset] === "\t") advance();
            value += " ";
          }
        } else value += current;
      }
      if (!closed) throw new PineSyntaxError("Unterminated string literal", { start, end: position() });
      push("string", value, start);
      continue;
    }
    if (character === "#") {
      let value = advance();
      while (offset < source.length && value.length < 9 && /[A-Fa-f0-9]/u.test(source[offset] ?? "")) value += advance();
      if (value.length !== 7 && value.length !== 9) {
        throw new PineSyntaxError(`Invalid color literal ${JSON.stringify(value)}; expected #RRGGBB or #RRGGBBAA`, { start, end: position() });
      }
      push("color", value, start);
      continue;
    }
    const pair = source.slice(offset, offset + 2);
    if (twoCharacterOperators.has(pair)) {
      advance();
      advance();
      push("operator", pair, start);
      continue;
    }
    if (singleCharacterOperators.has(character)) {
      advance();
      push("operator", character, start);
      continue;
    }
    throw new PineSyntaxError(`Unexpected character ${JSON.stringify(character)}`, { start, end: position() });
  }
  const end = position();
  tokens.push({ kind: "eof", value: "", range: { start: end, end } });
  return tokens;
}
