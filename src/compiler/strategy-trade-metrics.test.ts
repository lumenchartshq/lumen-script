import { PINE_BUILTIN_CATALOG, PINE_PRODUCTION_BUILTIN_CATALOG, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const closed = ["commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit_percent"] as const;
const open = ["commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit", "profit_percent"] as const;
const calls = [...closed.map((name) => `strategy.closedtrades.${name}`), ...open.map((name) => `strategy.opentrades.${name}`)];

function current(body: string, version: 5 | 6 = 6) {
  return compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${version}\nstrategy("Trade metrics")\n${body}` });
}

describe("S2a trade metric contracts", () => {
  it.each([5, 6] as const)("admits all exact v%s metric results and both binding styles", (version) => {
    const source = [
      ...calls.map((name, index) => `series float metric${index} = ${name}(${index % 2 === 0 ? "trade_num=0" : "0"})`),
      "series int first = strategy.closedtrades.first_index",
      "series float held = strategy.opentrades.capital_held",
    ].join("\n");
    const result = current(source, version);
    expect(result.diagnostics).toEqual([]);
    for (const name of calls) expect(result.program?.generatedSource).toContain(`"${name}"`);
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toEqual(expect.arrayContaining(calls));
    for (const name of calls) expect(PINE_BUILTIN_CATALOG.builtins).not.toContain(name);
  });

  it("rejects every metric's wrong result kind and index", () => {
    for (const name of calls) {
      for (const [body, code] of [
        [`string wrong = ${name}(0)`, "SCRIPT2102"],
        [`simple float wrong = ${name}(0)`, "SCRIPT2102"],
        [`float wrong = ${name}("first")`, "SCRIPT2117"],
        [`float wrong = ${name}(0.5)`, "SCRIPT2117"],
        [`float wrong = ${name}()`, "SCRIPT2014"],
      ] as const) {
        const result = current(body);
        expect(result.diagnostics, `${name}/${body}`).toContainEqual(expect.objectContaining({ code }));
        expect(result.program, `${name}/${body}`).toBeUndefined();
      }
    }
    for (const body of ["string wrong = strategy.closedtrades.first_index", "simple int wrong = strategy.closedtrades.first_index", "int wrong = strategy.opentrades.capital_held", "simple float wrong = strategy.opentrades.capital_held"]) {
      const result = current(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    }
  });
});
