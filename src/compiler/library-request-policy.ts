import type { Diagnostic } from "../contracts/index.js";
import type { CallNode, ExpressionStatementNode } from "./ast.js";
import { maskPineImports } from "./import-analysis.js";
import { lex, PineSyntaxError } from "./lexer.js";
import { parse } from "./parser.js";
import { dynamicRequestRanges } from "./request-plan-compilation.js";
import { bindProgram } from "./semantic-binder.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

/** Check only a library's request policy; provider imports and export admission belong to their owners. */
export function validatePineLibraryRequestPolicy(source: string, expectedName?: string): readonly Diagnostic[] {
  const versionMarker = source.match(/^\s*\/\/@version\s*=\s*(5|6)\s*$/mu);
  if (!versionMarker) return [diagnostic("SCRIPT2130", "A library must declare version 5 or 6.")];
  const version = Number(versionMarker[1]) as 5 | 6;
  try {
    const masked = maskPineImports(maskExportedTypeKeywords(source), PINE_COMPATIBILITY.strict).source;
    const parsed = parse(masked, version, PINE_COMPATIBILITY.strict);
    const declarations = parsed.statements.filter(
      (statement): statement is ExpressionStatementNode & { expression: CallNode } =>
        statement.kind === "expression" && statement.expression.kind === "call"
        && statement.expression.callee.kind === "identifier"
        && statement.expression.callee.name === "library",
    );
    if (declarations.length !== 1) return [diagnostic("SCRIPT2132", "A library must contain exactly one global library() declaration.")];
    if (expectedName !== undefined && parsed.statements.some((statement) => statement.kind === "expression"
      && statement.expression.kind === "call" && statement.expression.callee.kind === "identifier"
      && (statement.expression.callee.name === "indicator" || statement.expression.callee.name === "strategy"))) {
      return [diagnostic("SCRIPT2132", "A library cannot also declare indicator() or strategy().")];
    }

    const options = ["title", "overlay", "dynamic_requests"] as const;
    const bound = new Map<string, CallNode["arguments"][number]["value"]>();
    let positional = 0;
    let named = false;
    for (const argument of declarations[0]!.expression.arguments) {
      if (argument.name === undefined && named) return [diagnostic("SCRIPT2014", "Positional arguments cannot follow named arguments in 'library'.")];
      if (argument.name !== undefined) named = true;
      const key = argument.name ?? options[positional++];
      if (!key || !options.includes(key as typeof options[number]) || bound.has(key)) {
        return [diagnostic("SCRIPT2136", "The library() declaration has an unknown or duplicate option.")];
      }
      bound.set(key, argument.value);
    }
    if (expectedName !== undefined) {
      const title = bound.get("title");
      if (title?.kind !== "literal" || title.value !== expectedName) {
        return [diagnostic("SCRIPT2133", "The library() title must match the resolved name.", title?.range)];
      }
      const overlay = bound.get("overlay");
      if (overlay !== undefined && (overlay.kind !== "literal" || typeof overlay.value !== "boolean")) {
        return [diagnostic("SCRIPT2136", "The library() overlay option must be a literal boolean.", overlay.range)];
      }
    }
    const supplied = bound.get("dynamic_requests");
    if (supplied !== undefined && (supplied.kind !== "literal" || typeof supplied.value !== "boolean")) {
      return [diagnostic("SCRIPT2136", "The library() dynamic_requests option must be a literal boolean.", supplied.range)];
    }
    const dynamicRequests = supplied === undefined ? version === 6 : supplied.value === true;
    if (dynamicRequests) return [];

    const semantic = bindProgram(parsed, PINE_COMPATIBILITY.strict);
    return dynamicRequestRanges(parsed, semantic).map((range) =>
      diagnostic("SCRIPT2012", "Series request selectors require dynamic_requests=true", range));
  } catch (error) {
    if (error instanceof PineSyntaxError) return [diagnostic("SCRIPT1003", error.message, error.range)];
    throw error;
  }
}

/** The compiler parser accepts type/enum declarations, but their export marker is linker-only syntax. */
function maskExportedTypeKeywords(source: string): string {
  const tokens = lex(source, PINE_COMPATIBILITY.strict);
  const characters = source.split("");
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1]!;
    if (token.value !== "export" || (next.value !== "type" && next.value !== "enum")
      || token.range.start.line !== next.range.start.line) continue;
    for (let offset = token.range.start.offset; offset < next.range.end.offset; offset += 1) characters[offset] = " ";
    for (let offset = 0; offset < next.value.length; offset += 1) characters[token.range.start.offset + offset] = next.value[offset]!;
  }
  return characters.join("");
}

function diagnostic(code: string, message: string, range?: Diagnostic["range"]): Diagnostic {
  return { severity: "error", code, message, ...(range === undefined ? {} : { range }) };
}
