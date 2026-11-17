import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compileStrict = (body: string, version: 5 | 6 = 6) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=${String(version)}\nindicator("Scalar missing semantics")\n${body}`,
});

describe("scalar casts and missing-value semantic contracts", () => {
  it("preserves cast qualifiers, typed missing constants and scalar-missing result qualifiers", () => {
    const result = compileStrict(`
const bool constBool = bool(1)
input bool inputBool = bool(input.int(1))
simple int simpleBoolSource = 1
simple bool simpleBool = bool(simpleBoolSource)
series bool seriesBool = bool(close)
const int constInt = int(-3.75)
input int inputInt = int(input.float(2.75))
simple float simpleIntSource = 3.75
simple int simpleInt = int(simpleIntSource)
series int seriesInt = int(close)
const float constFloat = float(-3)
input float inputFloat = float(input.int(2))
simple int simpleFloatSource = 3
simple float simpleFloat = float(simpleFloatSource)
series float seriesFloat = float(close)
const color constColor = color(#123456)
input color inputColor = color(input.color(#234567))
simple color simpleColor = color(chart.bg_color)
series color seriesColor = color(close > open ? color.red : color.blue)
const string constString = string("pulse")
const string numericString = string(42)
input string inputString = string(input.string("input"))
simple string simpleString = string(syminfo.tickerid)
series string seriesString = string(close > open ? "up" : "down")
const bool missingBool = bool(na)
const int missingInt = int(na)
const float missingFloat = float(na)
const color missingColor = color(na)
const string missingString = string(na)
simple bool simpleNa = na(constInt)
series bool seriesNa = na(seriesFloat)
simple int simpleNz = nz(constInt)
simple float widenedNz = nz(constFloat, constInt)
series float seriesNz = nz(seriesFloat, inputFloat)
simple int literalMissingInt = nz(int(na), na)
simple float literalMissingFloat = nz(source=float(na), replacement=na)
simple color literalMissingColor = nz(color(na), na)
simple int contextualInt = nz(na, 1)
series float contextualFloat = nz(source=na, replacement=close)
series int fixedInt = fixnan(constInt)
series float fixedFloat = fixnan(seriesFloat)
series color fixedColor = fixnan(seriesColor)
plot((constBool and inputBool and simpleBool and seriesBool and not simpleNa and not seriesNa) ? seriesNz + fixedInt + fixedFloat : na, color=fixedColor)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
    expect(result.program?.generatedSource).toContain('"nz",[r.get(');
    expect(result.program?.generatedSource).toContain(',"float"]');
    expect(result.program?.generatedSource).toContain('"fixnan"');
  });

  it("preserves input.color and generic input inference through color casts", () => {
    const result = compileStrict(`
input color explicitColor = input.color(#123456)
input color genericColor = input(#234567)
plot(close, color=explicitColor)
plot(close, color=genericColor)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs).toEqual([
      { id: "explicitColor", type: "color", title: "", defaultValue: "#123456" },
      { id: "genericColor", type: "color", title: "", defaultValue: "#234567" },
    ]);
  });

  it("contextualizes positional and named literal na replacements from the source overload", () => {
    const result = compileStrict(`
series float positional = nz(close, na)
series float named = nz(source=close, replacement=na)
simple int integer = nz(int(na), na)
simple color colored = nz(source=color(na), replacement=na)
simple int contextualInt = nz(na, 1)
series float contextualFloat = nz(source=na, replacement=close)
plot(positional)
plot(named)
plot(integer)
plot(close, color=colored)
plot(contextualInt + contextualFloat)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("rejects wrong arity, argument kinds, replacement types and result qualifiers", () => {
    const cases = [
      ["bool()", "SCRIPT2014", "Missing required argument 'value'"],
      ["int(1, 2)", "SCRIPT2014", "accepts at most 1 argument"],
      ['bool("true")', "SCRIPT2117", "requires na, bool, int, float"],
      ['int("3")', "SCRIPT2117", "requires na, int, float"],
      ["float(true)", "SCRIPT2117", "requires na, int, float"],
      ['color("#123456")', "SCRIPT2117", "requires na, color"],
      ["string(true)", "SCRIPT2117", "requires na, int, float, string"],
      ['nz("", "fallback")', "SCRIPT2117", "requires color, float, int"],
      ["fixnan(false)", "SCRIPT2117", "requires color, float, int"],
      ["na(false)", "SCRIPT2117", "does not accept bool in version 6 scripts"],
      ["nz(1, 2.5)", "SCRIPT2117", "must match const int"],
      ["nz(na)", "SCRIPT2117", "Cannot determine the 'nz' source type"],
      ["nz(na, na)", "SCRIPT2117", "Cannot determine the 'nz' source type"],
      ['nz(na, "fallback")', "SCRIPT2117", "requires color, float, int"],
    ] as const;

    for (const [expression, code, message] of cases) {
      const result = compileStrict(`value = ${expression}`);
      const diagnostic = result.diagnostics.find((candidate) => candidate.code === code);
      expect(diagnostic?.message, expression).toContain(message);
      expect(result.program, expression).toBeUndefined();
    }

    const qualifierResult = compileStrict(`
const int wrongNz = nz(1)
simple float wrongFixnan = fixnan(1.0)
simple bool wrongNa = na(close)`);
    expect(qualifierResult.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(3);
    expect(qualifierResult.program).toBeUndefined();
  });

  it("keeps Pine v5 bool missing overloads while Pine v6 rejects them", () => {
    const body = `
const bool missing = bool(na)
simple bool replaced = nz(missing)
simple bool explicitMissing = nz(source=missing, replacement=na)
series bool carried = fixnan(missing)
simple bool missingPredicate = na(missing)
plot((nz(missing, false) or carried or missingPredicate) ? 1 : 0)`;
    const v5 = compileStrict(body, 5);
    const v6 = compileStrict(body, 6);

    expect(v5.diagnostics).toEqual([]);
    expect(v5.program).toBeDefined();
    expect(v6.diagnostics.filter(({ code }) => code === "SCRIPT2117")).toHaveLength(5);
    expect(v6.program).toBeUndefined();
  });

  it("does not change the sealed compiler's accepted-base admission", () => {
    const source = `//@version=6
indicator("Sealed scalar base")
legacyBool = bool("truthy")
legacyInt = int("3")
legacyColor = color("#123456")
legacyString = string(true)
legacyNz = nz("", "fallback")
plot(legacyInt)`;
    const strict = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });

    expect(strict.diagnostics.some(({ code }) => code === "SCRIPT2117")).toBe(true);
    expect(strict.program).toBeUndefined();
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
