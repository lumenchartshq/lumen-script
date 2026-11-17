import { PINE_COMPATIBILITY, pineCallableMetadata } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const namedCalls = [
  'strategy.entry("E", strategy.long, when=false)',
  'strategy.order("O", strategy.long, when=false)',
  'strategy.exit("X", profit=1, when=false)',
  'strategy.close("E", when=false)',
  'strategy.close_all(when=false)',
  'strategy.cancel("E", when=false)',
  'strategy.cancel_all(when=false)',
];

const positionalCalls = [
  'strategy.entry("E", strategy.long, 1, na, na, "", strategy.oca.none, "", "", false, false)',
  'strategy.order("O", strategy.long, 1, na, na, "", strategy.oca.none, "", "", false, false)',
  'strategy.exit("X", "", 1, na, 1, na, na, na, na, na, na, "", "", "", "", "", "", "", "", "", false, false)',
  'strategy.close("E", "", 1, na, "", false, false, false)',
  'strategy.close_all("", "", false, false, false)',
  'strategy.cancel("E", false, false)',
  'strategy.cancel_all(false)',
];

function source(version: 5 | 6, calls: readonly string[]): string {
  return `//@version=${String(version)}\nstrategy("When")\n${calls.join("\n")}`;
}

describe("Pine v5 strategy when binding", () => {
  it.each([["named", namedCalls], ["positional", positionalCalls]] as const)("accepts all seven %s v5 forms", (_kind, calls) => {
    expect(compile({ source: source(5, calls), compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
  });

  it("rejects every removed named argument in v6", () => {
    for (const call of namedCalls) {
      const result = compile({ source: source(6, [call]), compatibility: PINE_COMPATIBILITY.strict });
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2014"), call).toBe(true);
    }
  });

  it("does not widen the sealed compatibility profile", () => {
    expect(pineCallableMetadata(PINE_COMPATIBILITY.legacy)["strategy.entry"]?.parameters).not.toContain("when");
  });
});
