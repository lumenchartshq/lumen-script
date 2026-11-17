import { PINE_DRAWING_CALL_SIGNATURES, type Diagnostic } from "../contracts/index.js";
import type { ExpressionNode, ProgramNode } from "./ast.js";
import type { PineSemanticModel } from "./semantic-binder.js";
import { collectCallNodes } from "./ast-walk.js";
import { staticCallableName, boundBuiltinArguments } from "./call-analysis.js";

const TABLE_POSITIONS = new Set([
  "top_left", "top_center", "top_right",
  "middle_left", "middle_center", "middle_right",
  "bottom_left", "bottom_center", "bottom_right",
]);

export function validateStaticTableLimits(program: ProgramNode, semantic: PineSemanticModel): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of collectCallNodes(program)) {
    const name = staticCallableName(node.callee);
    if (name !== "table.new" && name !== "table.set_position") continue;
    const ordered = boundBuiltinArguments(node, semantic);
    const positionIndex = name === "table.new" ? 0 : 1;
    const position = staticTablePosition(ordered[positionIndex]);
    if (position !== undefined && !TABLE_POSITIONS.has(position)) {
      diagnostics.push({
        severity: "error",
        code: "SCRIPT3023",
        message: `Invalid table position '${position}'`,
        range: ordered[positionIndex]!.range,
      });
    }
    if (name !== "table.new") continue;
    for (const [index, label] of [[1, "columns"], [2, "rows"]] as const) {
      const value = staticNumber(ordered[index]);
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        diagnostics.push({
          severity: "error",
          code: "SCRIPT3023",
          message: `Table ${label} must be a positive integer`,
          range: ordered[index]!.range,
        });
      }
    }
  }
  return diagnostics;
}

export function validateMainTimeframeSideEffects(program: ProgramNode): Diagnostic[] {
  const drawingCalls = new Set(Object.keys(PINE_DRAWING_CALL_SIGNATURES));
  return collectCallNodes(program).flatMap((node): Diagnostic[] => {
    const name = staticCallableName(node.callee);
    if (name !== "alert" && !drawingCalls.has(name)) return [];
    return [{
      severity: "error",
      code: "SCRIPT2020",
      message: `indicator() timeframe cannot be used with ${name}() because declaration-timeframe scripts cannot create drawings or alerts`,
      range: node.range,
    }];
  });
}

function staticTablePosition(node: ExpressionNode | undefined): string | undefined {
  if (node?.kind === "member" && node.object.kind === "identifier" && node.object.name === "position") return node.property;
  return node?.kind === "literal" && typeof node.value === "string" ? node.value : undefined;
}

function staticNumber(node: ExpressionNode | undefined): number | undefined {
  if (node?.kind === "literal" && typeof node.value === "number") return node.value;
  if (node?.kind === "unary" && node.operator === "-" && node.argument.kind === "literal" && typeof node.argument.value === "number") return -node.argument.value;
  return undefined;
}
