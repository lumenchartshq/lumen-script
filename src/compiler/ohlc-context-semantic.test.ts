import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const strictCompile = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("OHLC context types")\n${body}`,
});

const floatFields = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "hlcc4", "ohlc4"] as const;
const integerFields = ["bar_index", "time", "time_close", "last_bar_index", "last_bar_time"] as const;

describe("OHLC and dataset-context variable types", () => {
  it("binds every assigned data variable to its exact series scalar type", () => {
    const body = [
      ...floatFields.map((name) => `series float typed_${name} = ${name}`),
      ...integerFields.map((name) => `series int typed_${name} = ${name}`),
    ].join("\n");
    const result = strictCompile(body);

    expect(result.diagnostics).toEqual([]);
    for (const name of floatFields) expect(result.program?.generatedSource).toContain(`r.data("${name}")`);
    expect(result.program?.generatedSource).toContain("r.barIndex");
    expect(result.program?.generatedSource).toContain('r.constant("last_bar_index")');
    expect(result.program?.generatedSource).toContain('r.constant("last_bar_time")');
  });

  it("rejects the wrong scalar kind for every assigned data variable", () => {
    for (const name of floatFields) {
      const result = strictCompile(`series int invalid = ${name}`);
      const diagnostic = result.diagnostics.find(({ code }) => code === "SCRIPT2102");
      expect(diagnostic?.message, name).toContain("Cannot assign series float");
      expect(result.program, name).toBeUndefined();
    }
    for (const name of integerFields) {
      const result = strictCompile(`series string invalid = ${name}`);
      const diagnostic = result.diagnostics.find(({ code }) => code === "SCRIPT2102");
      expect(diagnostic?.message, name).toContain("Cannot assign series int");
      expect(result.program, name).toBeUndefined();
    }
  });

  it("rejects assigning every series data variable to a simple binding", () => {
    for (const name of floatFields) {
      const result = strictCompile(`simple float invalid = ${name}`);
      expect(result.diagnostics, name).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, name).toBeUndefined();
    }
    for (const name of integerFields) {
      const result = strictCompile(`simple int invalid = ${name}`);
      expect(result.diagnostics, name).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, name).toBeUndefined();
    }
  });

  it("keeps the sealed profile's untyped dataset-tail bindings unchanged", () => {
    const sealed = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed dataset-tail types")
series string legacyIndex = last_bar_index
series string legacyTime = last_bar_time`,
    });
    const strict = strictCompile(`series string invalidIndex = last_bar_index
series string invalidTime = last_bar_time`);

    expect(sealed.diagnostics).toEqual([]);
    expect(strict.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(2);
  });
});
