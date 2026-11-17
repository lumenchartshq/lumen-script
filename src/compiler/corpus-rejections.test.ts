import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { compile } from "./index.js";

function diagnostics(body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  return compile({ compatibility, source: `//@version=6\nindicator("Rejections")\n${body}` }).diagnostics.map(({ code, message }) => ({ code, message }));
}

describe("invalid programs the production compiler used to accept", () => {
  it("rejects destructuring a tuple into the wrong number of names", () => {
    const pair = "pair() =>\n    [1, 2]\n";
    expect(diagnostics(`${pair}[a, b, c] = pair()\nplot(a)`)).toEqual([
      { code: "SCRIPT2139", message: "Cannot destructure a 2-value tuple into 3 variables" },
    ]);
    expect(diagnostics(`${pair}[a] = pair()\nplot(a)`)).toEqual([
      { code: "SCRIPT2139", message: "Cannot destructure a 2-value tuple into 1 variables" },
    ]);
    expect(diagnostics(`${pair}[a, b] = pair()\nplot(a + b)`)).toEqual([]);
  });

  it("rejects conditional branches whose primitive types cannot be unified", () => {
    expect(diagnostics('x = close > open ? 1.0 : "down"\nplot(close)')).toEqual([
      { code: "SCRIPT2138", message: "Conditional branches have incompatible types const float and const string" },
    ]);
    expect(diagnostics("x = close > open ? true : 1\nplot(close)")).toEqual([
      { code: "SCRIPT2138", message: "Conditional branches have incompatible types const bool and const int" },
    ]);
    expect(diagnostics("x = close > open ? 1 : 2.5\ny = close > open ? color.red : na\nplot(x, color = y)")).toEqual([]);
  });

  it("rejects declaration keywords on a := reassignment", () => {
    const message = "Declarations require '='; ':=' reassigns an existing variable";
    expect(diagnostics("varip int n = 0\nvarip n := n + 1\nplot(n)")).toEqual([{ code: "SCRIPT1003", message }]);
    expect(diagnostics("var int n = 0\nvar n := n + 1\nplot(n)")).toEqual([{ code: "SCRIPT1003", message }]);
    expect(diagnostics("float n = 0\nfloat n := n + 1\nplot(n)")).toEqual([{ code: "SCRIPT1003", message }]);
    expect(diagnostics("varip int n = 0\nn := n + 1\nplot(n)")).toEqual([]);
  });

  it("leaves the baseline profile unchanged", () => {
    const legacy = PINE_COMPATIBILITY.legacy;
    expect(diagnostics("varip int n = 0\nvarip n := n + 1\nplot(n)", legacy)).toEqual([]);
    expect(diagnostics('x = close > open ? 1.0 : "down"\nplot(close)', legacy)).toEqual([]);
  });
});
