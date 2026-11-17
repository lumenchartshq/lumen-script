import type { Diagnostic, PineQualifiedType, SourceRange } from "../contracts/index.js";
import type { FunctionDeclarationNode, MethodDeclarationNode, StatementNode } from "./ast.js";
import { collectCallNodes } from "./ast-walk.js";
import { staticCallableName } from "./call-analysis.js";
import { lex } from "./lexer.js";
import { libraryGlobalReferences } from "./library-global-references.js";
import { validateLibraryRequestExpressions } from "./library-request-expression.js";
import { parse } from "./parser.js";
import { bindProgram } from "./semantic-binder.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

type Callable = FunctionDeclarationNode | MethodDeclarationNode;

/** Validate stripped module source; the host owns import resolution and provenance. */
export function validatePineLibraryExports(source: string, exports: readonly { name: string; line: number }[]): readonly Diagnostic[] {
  const program = parse(source, /^\s*\/\/@version\s*=\s*5\s*$/mu.test(source) ? 5 : 6, PINE_COMPATIBILITY.strict);
  const callables = program.statements.filter((node): node is Callable => node.kind === "function" || node.kind === "method");
  const semantic = bindProgram(program, PINE_COMPATIBILITY.strict);
  const diagnostics: Diagnostic[] = [];
  const globals = new Set(program.statements.flatMap((node) => node.kind === "declaration" ? [node.name] : node.kind === "tuple_declaration" ? node.names.filter((name) => name !== "_") : []));
  const captured = new Set<string>();
  const privateTypes = new Set(program.statements.filter((node) => (node.kind === "type" || node.kind === "enum") && !exports.some((item) => item.name === node.name && item.line === node.range.start.line)).map((node) => "name" in node ? node.name : ""));
  const reportedTypes = new Set<string>();
  const checkName = (name: string, range: SourceRange) => {
    const key = `${name}:${String(range.start.offset)}`;
    if (!privateTypes.has(name) || reportedTypes.has(key)) return;
    reportedTypes.add(key);
    diagnostics.push({ severity: "error", code: "SCRIPT2123", message: `Type '${name}' must be exported because it appears in the library's public interface`, range });
  };
  const checkAnnotation = (annotation: string | undefined, range: SourceRange) => {
    if (!annotation) return;
    const tokens = lex(annotation, PINE_COMPATIBILITY.strict);
    for (const [index, token] of tokens.entries()) if (token.kind === "identifier" && tokens[index - 1]?.value !== "." && tokens[index + 1]?.value !== ".") checkName(token.value, range);
  };
  const checkType = (type: PineQualifiedType, range: SourceRange): void => {
    if (type.name) checkName(type.name, range);
    for (const argument of type.arguments ?? []) checkType(argument, range);
  };
  const checkReturn = (body: readonly StatementNode[]): void => {
    const last = body.at(-1);
    if (!last) return;
    if (last.kind === "expression") checkType(semantic.typeOf(last.expression), last.range);
    else if (last.kind === "declaration" || last.kind === "assignment" || last.kind === "tuple_declaration") checkType(semantic.typeOf(last.value), last.range);
    else if (last.kind === "if") { checkReturn(last.consequent); checkReturn(last.alternate); }
    else if (last.kind === "for" || last.kind === "for_in" || last.kind === "while") checkReturn(last.body);
  };
  for (const node of program.statements) {
    if (node.kind !== "type" || !exports.some((item) => item.name === node.name && item.line === node.range.start.line)) continue;
    for (const field of node.fields) checkAnnotation(field.dataType, field.range);
  }
  const visit = (callable: Callable, root: Callable, path: readonly string[], visited: Set<Callable>) => {
    if (visited.has(callable)) return;
    visited.add(callable);
    for (const reference of libraryGlobalReferences(callable, globals)) {
      if (semantic.symbolTypes.get(reference.name)?.qualifier === "const") continue;
      const key = `${String(root.range.start.offset)}:${String(reference.range.start.offset)}:${reference.name}`;
      if (captured.has(key)) continue;
      captured.add(key);
      const via = path.length > 1 ? ` via ${path.join(" -> ")}` : "";
      diagnostics.push({ severity: "error", code: "SCRIPT2123", message: `Exported ${root.kind} '${root.name}' cannot use non-const global '${reference.name}'${via}`, range: reference.range });
    }
    for (const call of collectCallNodes({ ...program, statements: [callable] })) {
      const name = staticCallableName(call.callee);
      if (name === "input" || name.startsWith("input.")) diagnostics.push({ severity: "error", code: "SCRIPT2123", message: "Exported library functions and methods cannot call input functions", range: call.range });
      if (call.callee.kind === "identifier") {
        const target = callables.find((node) => node.kind === "function" && node.name === name);
        if (target) visit(target, root, [...path, target.name], visited);
      }
      for (const method of semantic.methodCandidates.get(call) ?? []) if (method) visit(method, root, [...path, method.name], visited);
    }
  };
  for (const callable of callables) {
    if (!exports.some((item) => item.name === callable.name && item.line === callable.range.start.line)) continue;
    for (const parameter of callable.parameters) {
      if (parameter.dataType === undefined) diagnostics.push({ severity: "error", code: "SCRIPT2123", message: `Exported parameter '${parameter.name}' requires an explicit type`, range: parameter.range });
      if (parameter.qualifier === "const" || parameter.qualifier === "input") diagnostics.push({ severity: "error", code: "SCRIPT2123", message: `Exported parameter '${parameter.name}' must use simple or series, not ${parameter.qualifier}`, range: parameter.range });
    }
    for (const parameter of callable.parameters) checkAnnotation(parameter.dataType, parameter.range);
    checkReturn(callable.body);
    visit(callable, callable, [callable.name], new Set());
  }
  diagnostics.push(...validateLibraryRequestExpressions(program, callables.filter((callable) =>
    exports.some((item) => item.name === callable.name && item.line === callable.range.start.line)), semantic));
  return diagnostics;
}
