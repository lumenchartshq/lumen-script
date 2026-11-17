import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY } from "../contracts/index.js";
import { compile } from "./index.js";

const source = (body: string, version = 6) => `//@version=${String(version)}\nindicator("footprint")\n${body}`;

describe("footprint compilation", () => {
  it("emits one stable plan with defaults and typed method access", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: source("footprint fp = request.footprint(ticks_per_row=2)\narray<volume_row> rows = fp.rows()\nvolume_row row = fp.poc()\nplot(row.total_volume())"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.footprintPlan).toMatchObject({
      id: "footprint-0",
      ticksPerRow: { kind: "constant", value: 2 },
      vaPercent: { kind: "constant", value: 70 },
      imbalancePercent: { kind: "constant", value: 300 },
    });
  });

  it("captures startup-evaluable int and float inputs", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: source('ticks = input.int(2, "Rows")\nva = input.float(68.5, "VA")\nrequest.footprint(ticks, va, 250)'),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.footprintPlan?.ticksPerRow.kind).toBe("startup");
    expect(result.program?.footprintPlan?.vaPercent.kind).toBe("startup");
  });

  it("binds inline input arguments to the script's own input ids", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: source('request.footprint(input.int(2, "Rows"))\nplot(close)'),
    });
    expect(result.diagnostics).toEqual([]);
    const inputs = result.program!.descriptor.inputs;
    expect(inputs.map(({ id, title }) => [id, title])).toEqual([["input-0", "Rows"]]);
    const ticks = result.program!.footprintPlan!.ticksPerRow;
    expect(ticks.kind === "startup" && ticks.program.inlineInputs).toEqual([]);
    expect(ticks.kind === "startup" && JSON.stringify(ticks.program.expression)).toContain('"id":"input-0"');
  });

  it("lowers typed footprint methods to namespace calls", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: source("footprint fp = request.footprint(1)\nm = matrix.new<float>(1, 1)\nplot(fp.delta() + m.rows())"),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"footprint.delta"');
    expect(result.program?.generatedSource).toContain('"rows"');
  });

  it("rejects extra, local, v5, and nested security contexts", () => {
    const cases = [
      source("request.footprint(1)\nrequest.footprint(2)"),
      source("if close > open\n    request.footprint(1)"),
      source("f() =>\n    request.footprint(1)\nf()"),
      source("request.footprint(1)", 5),
      source('request.security(syminfo.tickerid, "D", request.footprint(1))'),
    ];
    for (const candidate of cases) {
      const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: candidate });
      expect(result.program).toBeUndefined();
      expect(result.diagnostics.some(({ code }) => code === "SCRIPT2031")).toBe(true);
    }
  });

  it("preserves sealed-profile rejection", () => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: source("request.footprint(1)") });
    expect(result.program?.footprintPlan).toBeUndefined();
    expect(result.program?.generatedSource).toContain('"request.footprint"');
  });
});
