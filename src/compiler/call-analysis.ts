import { PINE_CALLABLE_METADATA } from "../contracts/index.js";
import type { CallNode, ExpressionNode } from "./ast.js";
import type { PineSemanticModel } from "./semantic-binder.js";

export function staticCallableName(node: ExpressionNode): string {
  if (node.kind === "identifier") return node.name;
  if (node.kind === "member" && node.object.kind === "identifier") return `${node.object.name}.${node.property}`;
  return "";
}

function orderBuiltinArguments(node: CallNode, signature: readonly string[] | undefined): readonly (ExpressionNode | undefined)[] {
  if (signature === undefined) return node.arguments.map((argument) => argument.value);
  const ordered: (ExpressionNode | undefined)[] = [];
  let positional = 0;
  for (const argument of node.arguments) {
    const index = argument.name === undefined ? positional++ : signature.indexOf(argument.name);
    if (index >= 0) ordered[index] = argument.value;
  }
  return signature.map((_, index) => ordered[index]);
}

export function boundBuiltinArguments(node: CallNode, semantic: PineSemanticModel): readonly (ExpressionNode | undefined)[] {
  return semantic.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered
    ?? orderBuiltinArguments(node, PINE_CALLABLE_METADATA[staticCallableName(node.callee)]?.parameters);
}
