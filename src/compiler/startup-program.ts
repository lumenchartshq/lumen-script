import type { InputDefinition, SourceRange } from "../contracts/index.js";

export type StartupScalar = string | number | boolean;
export type StartupNode =
  | { readonly kind: "literal"; readonly value: StartupScalar }
  | { readonly kind: "slot"; readonly id: number }
  | { readonly kind: "metadata"; readonly namespace: "syminfo" | "timeframe"; readonly field: string }
  | { readonly kind: "input"; readonly id: string; readonly title: string; readonly defaultValue: number; readonly valueType?: "int" | "float" }
  | { readonly kind: "unary"; readonly operator: string; readonly argument: StartupNode }
  | { readonly kind: "binary"; readonly operator: string; readonly left: StartupNode; readonly right: StartupNode }
  | { readonly kind: "conditional"; readonly test: StartupNode; readonly consequent: StartupNode; readonly alternate: StartupNode }
  | { readonly kind: "call"; readonly name: string; readonly arguments: readonly StartupNode[] }
  | { readonly kind: "let"; readonly bindings: readonly { readonly id: number; readonly value: StartupNode }[]; readonly result: StartupNode };

export interface StartupProgramV1 {
  readonly version: 1;
  readonly expression: StartupNode;
  readonly inlineInputs: readonly InputDefinition[];
  readonly range: SourceRange;
}

/** Count the serialized tree, including bindings and untaken branches, before provider admission. */
export function startupProgramWithinBudget(expression: StartupNode): boolean {
  const pending = [{ value: expression, depth: 0 }];
  let remaining = 256;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (--remaining < 0 || depth > 32) return false;
    const add = (child: StartupNode) => pending.push({ value: child, depth: depth + 1 });
    if (value.kind === "let") {
      remaining -= value.bindings.length;
      if (remaining < 0) return false;
      for (const binding of value.bindings) add(binding.value);
      add(value.result);
    } else if (value.kind === "binary") { add(value.left); add(value.right); }
    else if (value.kind === "unary") add(value.argument);
    else if (value.kind === "conditional") { add(value.test); add(value.consequent); add(value.alternate); }
    else if (value.kind === "call") for (const argument of value.arguments) add(argument);
  }
  return true;
}
