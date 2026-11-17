import { expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PineRuntimeError } from "../runtime/index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";
const bars = [{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];

it.each([
  ['runtime.error("the text 99:88 is not a location")', 3],
  ['if close > 0\n    runtime.error("nested")', 4],
  ['a = array.new_float(0)\nx = a.get(0)', 4],
  ['x = request.security("", "", array.get(array.new_float(0), 0))', 3],
])("attributes runtime failures to source ranges: %s", async (body, line) => {
  const compilation = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Diagnostics")\n${body}` });
  expect(compilation.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compilation.program!, { timeframe: "1" });
  try {
    const error: unknown = await session.runBatch(bars).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PineRuntimeError);
    expect((error as PineRuntimeError).range?.start.line).toBe(line);
    expect((error as PineRuntimeError).code).toBe("SCRIPT_RUNTIME_ERROR");
  } finally { await session.close(); }
});

it("reports budget failures with a stable code", async () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Budget")\nfor i = 0 to 100\n    x = close' }).program!;
  const session = new PineEngine().createSession(program, { limits: { maxOperationsPerBar: 3 } });
  try { await expect(session.runBatch(bars)).rejects.toMatchObject({ code: "SCRIPT_LOOP_LIMIT" }); }
  finally { await session.close(); }
});

it.each(["missing", "load", "metadata", "timeframe"] as const)("attributes request preparation failures: %s", async (failure) => {
  const body = failure === "timeframe" ? 'x = request.security_lower_tf("ALT", "D", close)' : 'x = request.security("ALT", "D", close)';
  const compilation = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Request diagnostics")\n${body}` });
  expect(compilation.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compilation.program!, {
    timeframe: "1",
    ...(failure === "missing" ? {} : { marketDataGateway: {
      load: async () => {
        if (failure === "load") throw new Error("[SCRIPT_DATAFEED_ERROR] unavailable");
        return { bars };
      },
      getSymbolInfo: async () => { throw new Error("metadata unavailable"); },
    } }),
  });
  try {
    await expect(session.runBatch(bars)).rejects.toMatchObject({ name: "PineRuntimeError", code: "SCRIPT_RUNTIME_ERROR", range: { start: { line: 3 } } });
  } finally { await session.close(); }
});

it("preserves request cancellation reasons without wrapping them as diagnostics", async () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Cancel")\nx = request.security("ALT", "D", close)' }).program!;
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  const session = new PineEngine().createSession(program, {
    timeframe: "1", signal: controller.signal,
    marketDataGateway: { load: async () => { controller.abort(reason); throw reason; } },
  });
  try { await expect(session.runBatch(bars)).rejects.toBe(reason); }
  finally { await session.close(); }
});
