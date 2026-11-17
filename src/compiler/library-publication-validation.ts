import type { Diagnostic } from "../contracts/index.js";
import type {
  CallNode,
  ExpressionStatementNode,
  FunctionDeclarationNode,
  MethodDeclarationNode,
  TypeDeclarationNode,
  EnumDeclarationNode,
} from "./ast.js";
import type { CompileRequest, CompileResult } from "./compiled-program.js";
import { hasUnresolvedImports } from "./import-analysis.js";
import { validatePineLibraryExports } from "./library-export-validation.js";
import { validatePineLibraryRequestPolicy } from "./library-request-policy.js";
import { PineSyntaxError } from "./lexer.js";
import { parse } from "./parser.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

export interface PineLibraryPublicationValidation {
  readonly diagnostics: readonly Diagnostic[];
  readonly exports: readonly string[];
}

/** Fail-closed compilation of the current owner-private, import-free library subset. */
export function validatePineLibraryPublicationSource(
  source: string,
  name: string,
  compileSource: (request: CompileRequest) => CompileResult,
): PineLibraryPublicationValidation {
  const fail = (
    code: string,
    message: string,
  ): PineLibraryPublicationValidation => ({
    diagnostics: [{ severity: "error", code, message }],
    exports: [],
  });
  const marker = source.match(/^\s*\/\/@version\s*=\s*(5|6)\s*$/mu);
  if (!marker)
    return fail(
      "SCRIPT2130",
      "A published library must declare version 5 or 6.",
    );
  try {
    if (hasUnresolvedImports(source, PINE_COMPATIBILITY.strict))
      return fail(
        "SCRIPT2131",
        "Published private libraries cannot import other libraries yet.",
      );
    const parsed = parse(
      source,
      Number(marker[1]) as 5 | 6,
      PINE_COMPATIBILITY.strict,
    );
    const declarations = parsed.statements.filter(
      (
        statement,
      ): statement is ExpressionStatementNode & { expression: CallNode } =>
        statement.kind === "expression" &&
        statement.expression.kind === "call" &&
        statement.expression.callee.kind === "identifier" &&
        ["library", "indicator", "strategy"].includes(
          statement.expression.callee.name,
        ),
    );
    if (
      declarations.length !== 1 ||
      declarations[0]!.expression.callee.kind !== "identifier" ||
      declarations[0]!.expression.callee.name !== "library"
    )
      return fail(
        "SCRIPT2132",
        "A published library must contain exactly one global library() declaration.",
      );
    const declaration = declarations[0]!.expression;
    const options = ["title", "overlay", "dynamic_requests"] as const;
    const bound = new Map<
      string,
      (typeof declaration.arguments)[number]["value"]
    >();
    let positional = 0;
    let sawNamed = false;
    for (const argument of declaration.arguments) {
      if (argument.name === undefined && sawNamed)
        return fail(
          "SCRIPT2014",
          "Positional arguments cannot follow named arguments in 'library'",
        );
      if (argument.name !== undefined) sawNamed = true;
      const key = argument.name ?? options[positional++];
      if (
        !key ||
        !options.includes(key as (typeof options)[number]) ||
        bound.has(key)
      )
        return fail(
          "SCRIPT2136",
          "The library() declaration has an unknown or duplicate option.",
        );
      bound.set(key, argument.value);
    }
    let dynamicRequests: boolean | undefined;
    for (const key of ["overlay", "dynamic_requests"] as const) {
      const value = bound.get(key);
      if (value === undefined) continue;
      if (value.kind !== "literal" || typeof value.value !== "boolean")
        return fail(
          "SCRIPT2136",
          `The library() ${key} option must be a literal boolean.`,
        );
      if (key === "dynamic_requests") dynamicRequests = value.value;
    }
    const title = bound.get("title");
    if (title?.kind !== "literal" || title.value !== name)
      return fail(
        "SCRIPT2133",
        "The library() title must match the published name.",
      );
    const exported = parsed.statements.filter(
      (
        statement,
      ): statement is FunctionDeclarationNode | MethodDeclarationNode | TypeDeclarationNode | EnumDeclarationNode =>
        (statement.kind === "function" || statement.kind === "method" || statement.kind === "type" || statement.kind === "enum") &&
        statement.exported === true,
    );
    if (!exported.length)
      return fail(
        "SCRIPT2134",
        "A published library needs at least one exported function, method, type, or enum.",
      );
    const exportList = exported.map((statement) => ({
      name: statement.name,
      line: statement.range.start.line,
    }));
    const requestPolicyDiagnostics = validatePineLibraryRequestPolicy(source);
    if (requestPolicyDiagnostics.length) return { diagnostics: requestPolicyDiagnostics, exports: [] };
    const characters = source.split("");
    for (
      let offset = declaration.range.start.offset;
      offset < declaration.range.end.offset;
      offset += 1
    ) {
      if (characters[offset] !== "\n" && characters[offset] !== "\r")
        characters[offset] = " ";
    }
    const requestPolicy = dynamicRequests === undefined
      ? ""
      : `, dynamic_requests=${String(dynamicRequests)}`;
    const executable = `${characters.join("")}\nindicator("Lumen Charts library publication validation"${requestPolicy})\n`;
    const compiled = compileSource({
      source: executable,
      compatibility: PINE_COMPATIBILITY.strict,
    });
    const diagnostics = [
      ...compiled.diagnostics,
      ...validatePineLibraryExports(executable, exportList),
    ];
    if (
      !compiled.program &&
      !diagnostics.some((item) => item.severity === "error")
    )
      return fail(
        "SCRIPT2135",
        "The published library did not produce a valid compiled program.",
      );
    return {
      diagnostics,
      exports: diagnostics.some((item) => item.severity === "error")
        ? []
        : exportList.map((item) => item.name),
    };
  } catch (error) {
    if (error instanceof PineSyntaxError)
      return {
        diagnostics: [
          {
            severity: "error",
            code: "SCRIPT1003",
            message: error.message,
            range: error.range,
          },
        ],
        exports: [],
      };
    throw error;
  }
}
