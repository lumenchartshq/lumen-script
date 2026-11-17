import { describe, expect, it } from "vitest";
import { validatePineLibraryRequestPolicy } from "./library-request-policy.js";

const source = (version: 5 | 6, option: string, body: string) =>
  `//@version=${version}\nlibrary("MathKit"${option})\n${body}`;
const codes = (text: string) => validatePineLibraryRequestPolicy(text).map(({ code }) => code);

describe("library request policy independent of export capture compilation", () => {
  it("checks the resolved title and declaration options before cache admission", () => {
    expect(validatePineLibraryRequestPolicy(source(6, "", "export value() => close"), "MathKit")).toEqual([]);
    expect(validatePineLibraryRequestPolicy(source(6, "", "export value() => close"), "Other")[0]?.code).toBe("SCRIPT2133");
    expect(validatePineLibraryRequestPolicy(source(6, ", overlay=close > open", "export value() => close"), "MathKit")[0]?.code).toBe("SCRIPT2136");
    expect(validatePineLibraryRequestPolicy(`${source(6, "", "export value() => close")}\nindicator("Extra")`, "MathKit")[0]?.code).toBe("SCRIPT2132");
  });
  it.each([
    [5, "", ["SCRIPT2012"]],
    [5, ", dynamic_requests=false", ["SCRIPT2012"]],
    [5, ", dynamic_requests=true", []],
    [6, "", []],
    [6, ", dynamic_requests=false", ["SCRIPT2012"]],
    [6, ", dynamic_requests=true", []],
  ] as const)("applies the v%s default and %s literal to a parameter-selected symbol", (version, option, expected) => {
    expect(codes(source(version, option, 'export fetch(string symbol) => request.security(symbol, "D", close)')))
      .toEqual(expected);
  });

  it("keeps static selectors separate from the required-parameter capture limit", () => {
    expect(codes(source(6, ", dynamic_requests=false",
      'export fetch(float value) => request.security("A", "D", value)'))).toEqual([]);
    expect(codes(source(6, ", dynamic_requests=false",
      'export fetch() => request.security("A", "D", close)'))).toEqual([]);
  });

  it("finds dynamic requests in private helper bodies and local blocks", () => {
    const wrapper = source(6, ", dynamic_requests=false", [
      'privateFetch(string symbol) => request.security(symbol, "D", close)',
      'export fetch(string symbol) => privateFetch(symbol)',
    ].join("\n"));
    const wrapperDiagnostic = validatePineLibraryRequestPolicy(wrapper)[0];
    expect(wrapperDiagnostic).toMatchObject({
      code: "SCRIPT2012", range: { start: { line: 3 }, end: { line: 3 } },
    });

    const local = source(6, ", dynamic_requests=false", [
      "export fetch(float value) =>",
      "    if value > 0",
      '        request.security("A", "D", close)',
      "    else",
      "        value",
    ].join("\n"));
    expect(validatePineLibraryRequestPolicy(local)[0]).toMatchObject({
      code: "SCRIPT2012", range: { start: { line: 5 }, end: { line: 5 } },
    });
  });

  it("preserves a nested-import provider source and ignores request-looking text", () => {
    const nested = [
      "//@version=6",
      "import owner/Base/1 as base",
      'library("MathKit", dynamic_requests=false)',
      '// request.security(symbol, "D", close)',
      'export fetch() => request.security("A", "D", close) + base.value()',
    ].join("\n");
    expect(codes(nested)).toEqual([]);
  });

  it("preserves the exact original request range through a masked import", () => {
    const nested = [
      "//@version=6",
      "import owner/Base/1 as base",
      'library("MathKit", dynamic_requests=false)',
      'export fetch(string symbol) => request.security(symbol, "D", close) + base.value()',
    ].join("\n");
    expect(validatePineLibraryRequestPolicy(nested)[0]).toMatchObject({
      code: "SCRIPT2012", range: { start: { line: 4 }, end: { line: 4 } },
    });
  });

  it("keeps generic exported types and enums while checking later request selectors", () => {
    const library = source(6, ", dynamic_requests=false", [
      "export enum Mode",
      "    active",
      "export type Item",
      "    string symbol",
      'export fetch(string symbol) => request.security(symbol, "D", close)',
    ].join("\n"));
    expect(validatePineLibraryRequestPolicy(library)[0]).toMatchObject({
      code: "SCRIPT2012", range: { start: { line: 7 }, end: { line: 7 } },
    });
  });

  it("keeps nested imports with exported types and enums and preserves request ranges", () => {
    const header = [
      "//@version=6",
      "import owner/Base/1 as base",
      'library("MathKit", dynamic_requests=false)',
      "export enum Mode",
      "    active",
      "export type Item",
      "    string symbol",
    ];
    const staticLibrary = [...header,
      'export fetch() => request.security("A", "D", close) + base.value()',
    ].join("\n");
    expect(codes(staticLibrary)).toEqual([]);

    const dynamicLibrary = [...header,
      'export fetch(string symbol) => request.security(symbol, "D", close) + base.value()',
    ].join("\n");
    expect(validatePineLibraryRequestPolicy(dynamicLibrary)[0]).toMatchObject({
      code: "SCRIPT2012", range: { start: { line: 8, column: 32 }, end: { line: 8, column: 68 } },
    });
  });
});
