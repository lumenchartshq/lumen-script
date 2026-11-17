import type { ExpressionNode } from "./ast.js";

export function callableName(node: ExpressionNode): string {
  if (node.kind === "identifier") return node.name;
  if (node.kind === "member") {
    const name = memberName(node);
    const elementType = node.typeArguments?.[0];
    // Namespaced element types such as chart.point have no array.new_<type> alias.
    if (name === "array.new" && elementType !== undefined && !elementType.includes(".")) return `array.new_${elementType}`;
    return name;
  }
  return "<expression>";
}

export function memberName(node: Extract<ExpressionNode, { kind: "member" }>): string {
  const object = node.object.kind === "identifier" ? node.object.name : node.object.kind === "member" ? memberName(node.object) : "<expression>";
  return `${object}.${node.property}`;
}
