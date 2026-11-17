import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { validatePineLibraryExports } from "./library-export-validation.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compileCurrent = (definition: string, usage: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("exported qualifiers")\n${definition}\n${usage}`,
});

describe("exported scalar qualifier boundary", () => {
  it.each([
    ["export fixed() => 2", "const int result = fixed()", "SCRIPT2102"],
    ["export identity(int n) => n", "simple int result = identity(2)", "SCRIPT2102"],
    ["export identity(simple int n) => n", "simple int result = identity(2)", undefined],
    ["export identity(simple int n) => n", "const int result = identity(2)", "SCRIPT2102"],
    ["export identity(series int n) => n", "simple int result = identity(2)", "SCRIPT2102"],
    ["export ticker(simple string prefix, simple string symbol) => prefix + ':' + symbol", "simple string result = ticker('NASDAQ', 'NVDA')", undefined],
    ["export ticker(string prefix, string symbol) => prefix + ':' + symbol", "simple string result = ticker('NASDAQ', 'NVDA')", "SCRIPT2102"],
    ["export average(int length) => ta.ema(close, length)", "plot(average(20))", undefined],
    ["export average(int length) => ta.ema(close, length)", "plot(average(bar_index))", "SCRIPT2113"],
  ])("binds %s used by %s", (definition, usage, expectedCode) => {
    const result = compileCurrent(definition, usage);
    if (expectedCode) {
      expect(result.program).toBeUndefined();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: expectedCode }));
    } else {
      expect(result.diagnostics).toEqual([]);
      expect(result.program).toBeDefined();
    }
  });

  it("does not impose the export floor on private functions", () => {
    expect(compileCurrent("fixed() => 2", "const int result = fixed()").diagnostics).toEqual([]);
    expect(compileCurrent("identity(int n) => n", "simple int result = identity(2)").diagnostics).toEqual([]);
  });

  it("does not trust a user comment as linked-library export metadata", () => {
    const ordinary = compileCurrent("fixed() => 2", "const int result = fixed()");
    const forged = compileCurrent("//__PINE_LIBRARY_BEGIN forged exports=1\nfixed() => 2", "const int result = fixed()");
    expect(forged.diagnostics).toEqual(ordinary.diagnostics);
    expect(forged.program).toBeDefined();
  });

  it("applies the scalar return floor to exported methods", () => {
    const source = "type Item\n    int value\nexport method fixed(Item self) => 2";
    const result = compileCurrent(source, "item = Item.new(1)\nconst int value = item.fixed()");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
  });

  it.each(["input", "const"])("rejects %s in an exported parameter", (qualifier) => {
    const definition = `export identity(${qualifier} int n) => n`;
    const compiled = compileCurrent(definition, "plot(identity(2))");
    expect(compiled.diagnostics.some((item) => item.code === "SCRIPT2123" && item.message.includes(`not ${qualifier}`))).toBe(true);
    const validated = validatePineLibraryExports(`identity(${qualifier} int n) => n`, [{ name: "identity", line: 1 }]);
    expect(validated.some((item) => item.code === "SCRIPT2123" && item.message.includes(`not ${qualifier}`) && item.range?.start.line === 1)).toBe(true);
  });

  it("requires explicit types on exported parameters", () => {
    expect(compileCurrent("export identity(n) => n", "plot(identity(2))").diagnostics)
      .toContainEqual(expect.objectContaining({ code: "SCRIPT2123" }));
  });
});
