import type { MethodDeclarationNode, StatementNode } from "./ast.js";

export const referenceNames: ReadonlySet<string> = new Set([
  "box", "chart.point", "footprint", "label", "line", "linefill", "polyline", "table", "volume_row",
]);

export function methodReferenceTypeNames(statements: readonly StatementNode[]): ReadonlySet<string> {
  const names = new Set(referenceNames);
  for (const statement of statements) if (statement.kind === "type") names.add(statement.name);
  // User enums shadow built-in reference names in the binder and remain value types.
  for (const statement of statements) if (statement.kind === "enum") names.delete(statement.name);
  return names;
}

/** Names and optional parameters do not distinguish Pine method overloads. */
export function methodRequiredSignature(method: MethodDeclarationNode, referenceTypes: ReadonlySet<string> = referenceNames): string {
  return method.parameters.filter((parameter) => parameter.defaultValue === undefined)
    .map((parameter) => {
      const type = canonicalType(parameter.dataType ?? "unknown");
      const qualifier = /^(?:array|map|matrix)</u.test(type) || referenceTypes.has(type)
        ? "series" : parameter.qualifier ?? "series";
      return `${qualifier} ${type}`;
    }).join("|");
}

function canonicalType(raw: string): string {
  const value = raw.replace(/\s+/gu, "");
  if (value.endsWith("[]")) return `array<${canonicalType(value.slice(0, -2))}>`;
  const generic = /^(array|map|matrix)<(.+)>$/u.exec(value);
  if (!generic) return value;
  return `${generic[1]}<${splitTypeArguments(generic[2]!).map(canonicalType).join(",")}>`;
}

function splitTypeArguments(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "<") depth += 1;
    if (value[index] === ">") depth -= 1;
    if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}
