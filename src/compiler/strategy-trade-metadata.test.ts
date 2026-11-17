import { PINE_BUILTIN_CATALOG, PINE_PRODUCTION_BUILTIN_CATALOG, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const selectedAccessors = [
  "strategy.opentrades.entry_bar_index",
  "strategy.opentrades.entry_time",
  "strategy.opentrades.entry_id",
  "strategy.opentrades.entry_comment",
  "strategy.closedtrades.entry_bar_index",
  "strategy.closedtrades.entry_time",
  "strategy.closedtrades.entry_id",
  "strategy.closedtrades.entry_comment",
  "strategy.closedtrades.exit_bar_index",
  "strategy.closedtrades.exit_time",
  "strategy.closedtrades.exit_id",
  "strategy.closedtrades.exit_comment",
  "strategy.closedtrades.size",
] as const;

function compileCurrent(body: string, version: 5 | 6 = 6) {
  return compile({
    compatibility: PINE_COMPATIBILITY.strict,
    source: `//@version=${String(version)}\nstrategy("Trade metadata typing", initial_capital=1000)\n${body}`,
  });
}

describe("strategy trade metadata semantic contracts", () => {
  it.each([5, 6] as const)("types all selected v%s accessors with named and positional binding", (version) => {
    const result = compileCurrent(`series int openEntryBar = strategy.opentrades.entry_bar_index(trade_num=0)
series int openEntryTime = strategy.opentrades.entry_time(0)
series string openEntryId = strategy.opentrades.entry_id(trade_num=0)
series string openEntryComment = strategy.opentrades.entry_comment(0)
series int closedEntryBar = strategy.closedtrades.entry_bar_index(trade_num=0)
series int closedEntryTime = strategy.closedtrades.entry_time(0)
series string closedEntryId = strategy.closedtrades.entry_id(trade_num=0)
series string closedEntryComment = strategy.closedtrades.entry_comment(0)
series int closedExitBar = strategy.closedtrades.exit_bar_index(trade_num=0)
series int closedExitTime = strategy.closedtrades.exit_time(0)
series string closedExitId = strategy.closedtrades.exit_id(trade_num=0)
series string closedExitComment = strategy.closedtrades.exit_comment(0)
series float closedSize = strategy.closedtrades.size(trade_num=0)`, version);

    expect(result.diagnostics).toEqual([]);
    for (const name of selectedAccessors) {
      expect(result.program?.generatedSource, name).toContain(`"${name}"`);
    }
  });

  it("rejects missing, extra, wrongly typed and fractional trade indexes", () => {
    const invalid = [
      ["value = strategy.opentrades.entry_id()", "SCRIPT2014"],
      ["value = strategy.closedtrades.exit_time()", "SCRIPT2014"],
      ["value = strategy.opentrades.entry_comment(0, 1)", "SCRIPT2014"],
      ['value = strategy.closedtrades.exit_id("first")', "SCRIPT2117"],
      ["value = strategy.closedtrades.size(0.5)", "SCRIPT2117"],
    ] as const;

    for (const [body, code] of invalid) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code }));
      expect(result.program, body).toBeUndefined();
    }
  });

  it("rejects wrong result kinds and weaker qualifiers", () => {
    for (const body of [
      "series string invalid = strategy.opentrades.entry_time(0)",
      "series int invalid = strategy.opentrades.entry_id(0)",
      "series bool invalid = strategy.closedtrades.size(0)",
      "simple int invalid = strategy.closedtrades.exit_bar_index(0)",
      "simple string invalid = strategy.closedtrades.exit_comment(0)",
    ]) {
      const result = compileCurrent(body);
      expect(result.diagnostics, body).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, body).toBeUndefined();
    }
  });

  it("admits exactly the selected metadata calls only in the production catalog", () => {
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toEqual(expect.arrayContaining([...selectedAccessors]));
    for (const name of selectedAccessors) expect(PINE_BUILTIN_CATALOG.builtins, name).not.toContain(name);

    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
strategy("Sealed trade metadata")
float permissive = strategy.closedtrades.entry_bar_index("first")`,
    });
    expect(sealed.diagnostics).toEqual([]);
  });
});
