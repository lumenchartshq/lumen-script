import { expect, it } from "vitest";
import { parse } from "./parser.js";
import { collectCallNodes, walkPineAst } from "./ast-walk.js";
import { callableName } from "./expression-names.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

it("discovers calls in type defaults, parameter defaults and member assignments in source order", () => {
  const ast = parse(`//@version=6
indicator("Walk")
type Point
    float value = math.abs(-1)
f(float value = math.abs(-2)) =>
    math.abs(value)
p = Point.new()
p.value := math.abs(-3)`, 6, PINE_COMPATIBILITY.strict);
  expect(collectCallNodes(ast).map((call) => callableName(call.callee))).toEqual([
    "indicator", "math.abs", "math.abs", "math.abs", "Point.new", "math.abs",
  ]);
  const seen: string[] = [];
  walkPineAst(ast, (node) => { seen.push(node.kind); });
  expect(seen).toContain("member_assignment");
  expect(seen).toContain("type");
});

it("visits nested expression blocks, history offsets and tuple elements", () => {
  const ast = parse(`//@version=6
indicator("Walk")
x = if close > math.abs(-1)
    math.abs(close)[int(1)]
else
    math.abs(open)
y = switch
    close > 1 => math.abs(high)
    => math.abs(low)
pair = [math.abs(x), math.abs(y)]`, 6, PINE_COMPATIBILITY.strict);
  expect(collectCallNodes(ast).map((call) => callableName(call.callee))).toEqual([
    "indicator", "math.abs", "math.abs", "int", "math.abs", "math.abs", "math.abs", "math.abs", "math.abs",
  ]);
});
