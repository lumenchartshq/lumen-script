import { describe, expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";
const bars = [{ openTime: 0, closeTime: 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }];

describe("production named and positional call contracts", () => {
  it.each([
    ['array.get(array.from(7, 11), 1)', 'array.get(index = 1, id = array.from(7, 11))', 11],
    ['array.avg(array.from(4, 8))', 'array.avg(id = array.from(4, 8))', 6],
    ['matrix.get(matrix.new<int>(2, 2, 9), 1, 0)', 'matrix.get(column = 0, row = 1, id = matrix.new<int>(2, 2, 9))', 9],
    ['str.repeat("ab", 2, "-")', 'str.repeat(separator = "-", source = "ab", repeat = 2)', "ab-ab"],
    ['hour(0, "UTC")', 'hour(timezone = "UTC", time = 0)', 0],
    ['math.pow(3, 2)', 'math.pow(exponent = 2, base = 3)', 9],
  ])("executes %s with the same named argument contract", async (positional, named, expected) => {
    const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Contracts")\na = ${positional}\nb = ${named}` });
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!, { symbolInfo: { currency: "USD" } });
    try {
      const output = await session.runBatch(bars);
      expect(output.returned.a).toEqual([expected]);
      expect(output.returned.b).toEqual([expected]);
    } finally { await session.close(); }
  });
  it.each([
    ['indicator("Box")\nb = box.new(0, 1, 1, 0)\nbox.set_text_color(text_color = color.red, id = b)', 'box.set_text_color(color = color.red, id = b)'],
    ['indicator("Table")\nt = table.new(position.top_right, 1, 1)\ntable.delete(table_id = t)', 'table.delete(id = t)'],
    ['strategy("Cancel")\nstrategy.cancel(id = "entry")', 'strategy.cancel(id = "entry", immediately = true)'],
  ])("executes the published drawing/strategy signature", async (source, rejected) => {
    const request = { compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\n${source}` };
    const result = compile(request);
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!, { symbolInfo: { currency: "USD" } });
    try { await expect(session.runBatch(bars)).resolves.toBeDefined(); }
    finally { await session.close(); }
    expect(compile({ ...request, source: `${request.source}\n${rejected}` }).diagnostics.some((entry) => entry.severity === "error")).toBe(true);
  });
});
