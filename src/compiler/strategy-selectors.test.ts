import { PINE_BUILTIN_CATALOG, PINE_PRODUCTION_BUILTIN_CATALOG, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile } from "./index.js";

const names = [
  "strategy.cash", "strategy.commission.cash_per_contract", "strategy.commission.cash_per_order",
  "strategy.commission.percent", "strategy.direction.all", "strategy.direction.long",
  "strategy.direction.short", "strategy.fixed", "strategy.long", "strategy.oca.cancel",
  "strategy.oca.none", "strategy.oca.reduce", "strategy.percent_of_equity", "strategy.short",
] as const;
const strict = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nstrategy("S1 typing")\n${body}`,
});

describe("strategy selector constant typing", () => {
  it.each(names)("admits %s as a const string production variable", (name) => {
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.variables).toContain(name);
    const result = strict(`const string chosen = ${name}\nplot(chosen == "test" ? 1 : 0)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain(`r.constant("${name}")`);
  });

  it("rejects wrong kinds and unknown nested selector members", () => {
    for (const name of names) {
      const result = strict(`const int wrong = ${name}`);
      expect(result.program, name).toBeUndefined();
      expect(result.diagnostics, name).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    }
    for (const name of ["strategy.commission.unknown", "strategy.direction.unknown", "strategy.oca.unknown"]) {
      const result = strict(`const string wrong = ${name}`);
      expect(result.program, name).toBeUndefined();
      expect(result.diagnostics, name).toContainEqual(expect.objectContaining({ code: "SCRIPT2015" }));
    }
  });

  it("keeps the sealed catalog and permissive typing unchanged", () => {
    expect(PINE_BUILTIN_CATALOG.variables).not.toContain("strategy.oca.cancel");
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: "//@version=6\nstrategy(\"Sealed\")\nstring chosen = strategy.cash" });
    expect(sealed.diagnostics).toEqual([]);
  });
});
