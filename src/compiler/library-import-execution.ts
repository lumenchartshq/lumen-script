import { PINE_PRODUCTION_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import type { ExpressionNode, FunctionDeclarationNode, MethodDeclarationNode, StatementNode } from "./ast.js";
import { collectCallNodes, walkPineAst } from "./ast-walk.js";
import { staticCallableName } from "./call-analysis.js";
import { libraryGlobalReferences } from "./library-global-references.js";
import { parse } from "./parser.js";
import { bindProgram } from "./semantic-binder.js";

type Callable = FunctionDeclarationNode | MethodDeclarationNode;

const collectionMutators: Readonly<Record<string, ReadonlySet<string>>> = {
  array: new Set(["push", "pop", "unshift", "shift", "set", "clear", "concat", "reverse", "insert", "remove", "fill", "sort"]),
  map: new Set(["clear", "put", "remove", "put_all"]),
  matrix: new Set(["set", "fill", "add_row", "add_col", "remove_row", "remove_col", "concat", "reshape", "reverse", "swap_rows", "swap_columns", "sort"]),
};

/** Blank imported library demonstration statements while retaining initializers used by exports. */
export function stripPineLibraryDemonstration(source: string, exports: readonly { name: string; line: number }[]): string {
  const program = parse(source, /^\s*\/\/@version\s*=\s*5\s*$/mu.test(source) ? 5 : 6, PINE_COMPATIBILITY.strict);
  const semantic = bindProgram(program, PINE_COMPATIBILITY.strict);
  const callables = program.statements.filter((node): node is Callable => node.kind === "function" || node.kind === "method");
  const globals = new Map<string, StatementNode>();
  for (const node of program.statements) {
    if (node.kind === "declaration") globals.set(node.name, node);
    if (node.kind === "tuple_declaration") for (const name of node.names) if (name !== "_") globals.set(name, node);
  }
  const globalNames = new Set(globals.keys());
  const retained = new Set<StatementNode>();
  const visited = new Set<Callable>();
  const visitIdentifiers = (value: ExpressionNode): void => {
    walkPineAst({ ...program, statements: [{ kind: "expression", expression: value, range: value.range }] }, (node) => {
      if (node.kind === "identifier") retainGlobal(node.name);
      if (node.kind === "call") visitCall(node);
    });
  };
  const retainGlobal = (name: string): void => {
    const declaration = globals.get(name);
    if (!declaration || retained.has(declaration)) return;
    retained.add(declaration);
    if (declaration.kind === "declaration" || declaration.kind === "tuple_declaration") visitIdentifiers(declaration.value);
  };
  const visitCall = (call: ReturnType<typeof collectCallNodes>[number]): void => {
    if (call.callee.kind === "identifier") {
      const name = staticCallableName(call.callee);
      for (const callable of callables) if (callable.kind === "function" && callable.name === name) visitCallable(callable);
    }
    for (const method of semantic.methodCandidates.get(call) ?? []) if (method) visitCallable(method);
  };
  const visitCallable = (callable: Callable): void => {
    if (visited.has(callable)) return;
    visited.add(callable);
    for (const reference of libraryGlobalReferences(callable, globalNames)) retainGlobal(reference.name);
    for (const call of collectCallNodes({ ...program, statements: [callable] })) visitCall(call);
  };
  for (const node of program.statements) {
    if (!exports.some((item) => item.name === ("name" in node ? node.name : undefined) && item.line === node.range.start.line)) continue;
    if (node.kind === "function" || node.kind === "method") visitCallable(node);
    if (node.kind === "type") for (const field of node.fields) if (field.defaultValue) visitIdentifiers(field.defaultValue);
  }
  const rootName = (node: ExpressionNode): string | undefined => {
    if (node.kind === "identifier") return node.name;
    if (node.kind === "member") return rootName(node.object);
    return undefined;
  };
  const writesRequired = (statement: StatementNode): boolean => {
    let writes = false;
    const checking = new Set<Callable>();
    const inspect = (node: StatementNode): void => {
      walkPineAst({ ...program, statements: [node] }, (item) => {
        if (item.kind === "assignment" && retained.has(globals.get(item.name)!)) writes = true;
        if (item.kind === "member_assignment" && retained.has(globals.get(rootName(item.object) ?? "")!)) writes = true;
        if (item.kind !== "call") return;
        if (item.callee.kind === "member") {
          if (retained.has(globals.get(rootName(item.callee.object) ?? "")!)) writes = true;
          const callable = item.callee.object.kind === "identifier"
            ? `${item.callee.object.name}.${item.callee.property}` : "";
          const collectionParameter = PINE_PRODUCTION_CALLABLE_METADATA[callable]?.parameters[0];
          const collectionArgument = item.arguments.find((argument) => argument.name === collectionParameter)?.value
            ?? item.arguments.find((argument) => argument.name === undefined)?.value;
          const target = collectionArgument ? globals.get(rootName(collectionArgument) ?? "") : undefined;
          if (item.callee.object.kind === "identifier" && !globals.has(item.callee.object.name)
            && collectionMutators[item.callee.object.name]?.has(item.callee.property)
            && target && retained.has(target)) writes = true;
        }
        if (item.callee.kind !== "identifier") return;
        const name = staticCallableName(item.callee);
        for (const callable of callables) {
          if (callable.kind !== "function" || callable.name !== name || checking.has(callable)) continue;
          checking.add(callable);
          for (const child of callable.body) inspect(child);
        }
      });
    };
    inspect(statement);
    return writes;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of program.statements) {
      if (retained.has(node) || node.kind === "declaration" || node.kind === "tuple_declaration" || node.kind === "function" || node.kind === "method" || node.kind === "type" || node.kind === "enum") continue;
      if (!writesRequired(node)) continue;
      retained.add(node);
      walkPineAst({ ...program, statements: [node] }, (item) => {
        if (item.kind === "identifier") retainGlobal(item.name);
        if (item.kind === "call") visitCall(item);
      });
      changed = true;
    }
  }
  const characters = source.split("");
  const blank = (node: StatementNode): void => {
    for (let offset = node.range.start.offset; offset < node.range.end.offset; offset += 1) if (characters[offset] !== "\n" && characters[offset] !== "\r") characters[offset] = " ";
  };
  const pruneBody = (body: readonly StatementNode[]): void => {
    if (!body.length) return;
    const needed = new Set(body.filter(writesRequired));
    const definitions = new Map<string, StatementNode[]>();
    for (const node of body) {
      const names = node.kind === "declaration" || node.kind === "assignment" ? [node.name] : node.kind === "tuple_declaration" ? node.names : [];
      for (const name of names) definitions.set(name, [...(definitions.get(name) ?? []), node]);
    }
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const node of [...needed]) walkPineAst({ ...program, statements: [node] }, (item) => {
        if (item.kind !== "identifier") return;
        for (const definition of definitions.get(item.name) ?? []) {
          if (needed.has(definition)) continue;
          needed.add(definition);
          expanded = true;
        }
      });
    }
    if (!needed.size) {
      for (const node of body) blank(node);
      characters[body[0]!.range.start.offset] = "0";
      return;
    }
    for (const node of body) {
      if (!needed.has(node)) { blank(node); continue; }
      if (node.kind === "if") { pruneBody(node.consequent); pruneBody(node.alternate); }
      if (node.kind === "for" || node.kind === "for_in" || node.kind === "while") pruneBody(node.body);
    }
  };
  for (const node of program.statements) {
    if (node.kind === "function" || node.kind === "method" || node.kind === "type" || node.kind === "enum") continue;
    if (!retained.has(node)) { blank(node); continue; }
    if (node.kind === "if") { pruneBody(node.consequent); pruneBody(node.alternate); }
    if (node.kind === "for" || node.kind === "for_in" || node.kind === "while") pruneBody(node.body);
  }
  return characters.join("");
}
