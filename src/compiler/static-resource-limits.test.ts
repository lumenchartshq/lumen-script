import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compatibility = PINE_COMPATIBILITY.strict;

describe("static resource limits", () => {
  it("reports a source-located error for a 65th plot count", () => {
    const source = ["//@version=6", 'indicator("Plot limit")', ...Array.from({ length: 65 }, () => "plot(close)")].join("\n");
    const result = compile({ source, compatibility });
    const diagnostic = result.diagnostics.find((entry) => entry.code === "SCRIPT3020");

    expect(diagnostic).toMatchObject({ severity: "error", code: "SCRIPT3020" });
    expect(diagnostic?.range).toBeDefined();
    expect(result.program).toBeUndefined();
  });

  it("counts only series-valued visual options toward the 64-count plot budget", () => {
    const source = [
      "//@version=6",
      'indicator("Variable candle colors")',
      "up = close > open",
      "shade = up ? color.green : color.red",
      ...Array.from({ length: 10 }, () => "plotcandle(open, high, low, close, color=shade, wickcolor=shade, bordercolor=shade)"),
    ].join("\n");
    const result = compile({ source, compatibility });
    const diagnostic = result.diagnostics.find((entry) => entry.code === "SCRIPT3020");

    expect(diagnostic).toMatchObject({ message: "Script uses 70 plot counts; Lumen Script supports at most 64" });
  });

  it("counts input colors but does not count plot histbase as another series", () => {
    const inputColors = compile({
      compatibility,
      source: [
        "//@version=6",
        'indicator("Input colors")',
        "shade = input.color(color.blue)",
        ...Array.from({ length: 33 }, () => "plot(close, color=shade)"),
      ].join("\n"),
    });
    const histogramBases = compile({
      compatibility,
      source: [
        "//@version=6",
        'indicator("Histogram bases")',
        ...Array.from({ length: 64 }, () => "plot(close, histbase=close)"),
      ].join("\n"),
    });

    expect(inputColors.diagnostics.find((entry) => entry.code === "SCRIPT3020")).toMatchObject({
      message: "Script uses 66 plot counts; Lumen Script supports at most 64",
    });
    expect(histogramBases.diagnostics.find((entry) => entry.code === "SCRIPT3020")).toBeUndefined();
    expect(histogramBases.program).toBeDefined();
  });

  it("charges bgcolor and barcolor one plot count each even for constant colors", () => {
    const source = [
      "//@version=6",
      'indicator("Bar colors")',
      ...Array.from({ length: 32 }, () => "bgcolor(color.red)\nbarcolor(color.blue)"),
      "plot(close)",
    ].join("\n");
    const result = compile({ source, compatibility });

    expect(result.diagnostics.find((entry) => entry.code === "SCRIPT3020")).toMatchObject({
      message: "Script uses 65 plot counts; Lumen Script supports at most 64",
    });
  });

  it("keeps the frozen profile's historical plot behavior", () => {
    const source = ["//@version=6", 'indicator("Frozen plot limit")', ...Array.from({ length: 65 }, () => "plot(close)")].join("\n");
    const result = compile({ source, compatibility: PINE_COMPATIBILITY.legacy });

    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("reports a source-located error for a 41st unique request context", () => {
    const source = [
      "//@version=6",
      'indicator("Request limit")',
      ...Array.from({ length: 41 }, (_, index) => `value${String(index)} = request.security("TEST:${String(index)}", "D", close)`),
    ].join("\n");
    const result = compile({ source, compatibility });
    const diagnostic = result.diagnostics.find((entry) => entry.code === "SCRIPT3022");

    expect(diagnostic).toMatchObject({ severity: "error", code: "SCRIPT3022" });
    expect(diagnostic?.range).toBeDefined();
    expect(result.program).toBeUndefined();
  });

  it("compiles exactly 40 distinct static request contexts without recursive recompilation", () => {
    const source = [
      "//@version=6",
      'indicator("Request boundary")',
      ...Array.from({ length: 40 }, (_, index) => `value${String(index)} = request.security("TEST:${String(index)}", "D", close)`),
    ].join("\n");
    const result = compile({ source, compatibility });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(40);
  });

  it("reuses an identical static request context", () => {
    const source = [
      "//@version=6",
      'indicator("Repeated request")',
      ...Array.from({ length: 50 }, (_, index) => `value${String(index)} = request.security("TEST:DAILY", "D", close)`),
    ].join("\n");
    const result = compile({ source, compatibility });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(1);
  });

  it("reuses semantically identical request contexts with reordered named arguments", () => {
    const source = [
      "//@version=6",
      'indicator("Equivalent requests")',
      ...Array.from({ length: 21 }, (_, index) => [
        `first${String(index)} = request.security(symbol="TEST:${String(index)}", timeframe="D", expression=close)`,
        `second${String(index)} = request.security(expression=close, timeframe="D", symbol="TEST:${String(index)}")`,
      ]).flat(),
    ].join("\n");
    const result = compile({ source, compatibility });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(21);
  });

  it("reports source-located literal table dimensions that cannot be allocated", () => {
    const result = compile({
      compatibility,
      source: `//@version=6
indicator("Invalid table")
var table display = table.new(position.top_right, 0, 1)`,
    });
    const diagnostic = result.diagnostics.find((entry) => entry.code === "SCRIPT3023");

    expect(diagnostic).toMatchObject({ severity: "error", message: "Table columns must be a positive integer" });
    expect(diagnostic?.range).toBeDefined();
  });
});
