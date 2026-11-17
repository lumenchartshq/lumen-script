import { describe, expect, it } from "vitest";
import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { deserializeRuntimeSnapshot } from "../runtime/index.js";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const now = 1_000_000;
const bars: readonly MarketBar[] = Array.from({ length: 5 }, (_, index) => ({
  openTime: index * 60_000,
  closeTime: index === 4 ? now + 60_000 : now - 60_000,
  open: index + 1,
  high: index + 11,
  low: index - 1,
  close: index + 2,
  volume: index + 101,
}));

function program(kind: "indicator" | "strategy", declaration: string, body: string) {
  const compiled = compile({
    compatibility: PINE_COMPATIBILITY.strict,
    source: `//@version=6\n${kind}("B1B history"${declaration})\n${body}`,
  });
  expect(compiled.diagnostics).toEqual([]);
  return compiled.program!;
}

describe("B1B declaration history floor (unregistered)", () => {
  it.each(["indicator", "strategy"] as const)("uses a positive declaration for %s realtime history", async (kind) => {
    const body = "offset = barstate.isrealtime ? 3 : 1\nplot(close[offset])";
    const engine = new PineEngine();
    const options = { now: () => now, symbolInfo: { ticker: "A", tickerid: "A", currency: "USD", timezone: "Etc/UTC" } };
    const withDeclaration = engine.createSession(program(kind, ", max_bars_back=3", body), options);
    const withoutDeclaration = engine.createSession(program(kind, "", body), options);
    try {
      expect((await withDeclaration.runBatch(bars)).plots[0]?.points.at(-1)?.value).toBe(3);
      await expect(withoutDeclaration.runBatch(bars)).rejects.toMatchObject({
        name: "PineRuntimeError",
        message: "History offset exceeds inferred buffer of 1 bars for this series",
      });
    } finally {
      await withDeclaration.close();
      await withoutDeclaration.close();
    }
  });

  it.each([
    ["open", 2], ["high", 12], ["low", 0], ["close", 3],
    ["volume", 102], ["time", 60_000],
  ] as const)("applies the floor to builtin %s", async (source, expected) => {
    const body = `plot(${source}[barstate.isrealtime ? 3 : 1])`;
    const result = await new PineEngine().createSession(program("indicator", ", max_bars_back=3", body), { now: () => now }).runBatch(bars);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(expected);
  });

  it.each([
    ["global", "custom = close * 2\nplot(custom[barstate.isrealtime ? 3 : 1])"],
    ["local", "f() =>\n    local = close * 2\n    local[barstate.isrealtime ? 3 : 1]\nplot(f())"],
  ] as const)("applies the floor to a %s series", async (_identity, body) => {
    const result = await new PineEngine().createSession(program("indicator", ", max_bars_back=3", body), { now: () => now }).runBatch(bars);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(6);
  });

  it("lets targeted and observed historical depth grow above a smaller declaration", async () => {
    const engine = new PineEngine();
    const targeted = program("indicator", ", max_bars_back=2", "max_bars_back(close, 3)\nplot(close[barstate.isrealtime ? 3 : 1])");
    expect((await engine.createSession(targeted, { now: () => now }).runBatch(bars)).plots[0]?.points.at(-1)?.value).toBe(3);
    const inferred = program("indicator", ", max_bars_back=1", "offset = bar_index == 3 ? 4 : barstate.isrealtime ? 4 : 1\nplot(close[offset])");
    expect((await engine.createSession(inferred, { now: () => now }).runBatch(bars)).plots[0]?.points.at(-1)?.value).toBe(2);
    const insufficient = program("indicator", ", max_bars_back=2", "max_bars_back(close, 1)\nplot(close[barstate.isrealtime ? 3 : 1])");
    await expect(engine.createSession(insufficient, { now: () => now }).runBatch(bars)).rejects.toMatchObject({
      name: "PineRuntimeError", message: "History offset exceeds inferred buffer of 2 bars for this series",
    });
  });

  it("preserves the descriptor floor across append, revised/repeated tail and JSON restore", async () => {
    const compiled = program("indicator", ", max_bars_back=3", "plot(close[barstate.isrealtime ? 3 : 1] + close)");
    const engine = new PineEngine();
    const session = engine.createSession(compiled, { now: () => now });
    try {
      await session.runBatch(bars.slice(0, 4));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      expect((await session.appendBars(bars.slice(4))).plots[0]?.points.at(-1)?.value).toBe(9);
      const revised = { ...bars[4]!, close: 99 };
      expect((await session.replaceTail([revised])).plots[0]?.points.at(-1)?.value).toBe(102);
      expect((await session.replaceTail([revised])).plots[0]?.points.at(-1)?.value).toBe(102);
      expect((await engine.createSession(compiled, { now: () => now }).runBatch([...bars.slice(0, 4), revised])).plots[0]?.points.at(-1)?.value).toBe(102);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(4))).plots[0]?.points.at(-1)?.value).toBe(9);
    } finally { await session.close(); }
  });

  it("keeps the ordinary retained window bounded at the admitted 5000-bar floor", async () => {
    const fixture = Array.from({ length: 5010 }, (_, index): MarketBar => ({
      openTime: index * 60_000, closeTime: (index + 1) * 60_000,
      open: index + 1, high: index + 1, low: index + 1, close: index + 1, volume: 1,
    }));
    const realtimeNow = fixture.at(-1)!.openTime + 30_000;
    const compiled = program("indicator", ", max_bars_back=5000", "custom = close * 2\nplot(custom[barstate.isrealtime ? 5000 : 1])");
    const session = new PineEngine().createSession(compiled, { now: () => realtimeNow });
    try {
      expect((await session.runBatch(fixture)).plots[0]?.points.at(-1)?.value).toBe(20);
      const snapshot = deserializeRuntimeSnapshot(session.checkpoint().runtimeState!);
      expect(snapshot.variableHistory[0]?.origin).toBe(9);
      expect(snapshot.variableHistory[0]?.values).toHaveLength(5001);
    } finally { await session.close(); }
  });

  it("retains typed wrong-offset and source-class ceilings under a positive declaration", async () => {
    const engine = new PineEngine();
    for (const [body, message] of [
      ["plot(close[-1])", "History offset must be a non-negative integer"],
      ["plot(close[bar_index == 4 ? -1 : 1])", "History offset must be a non-negative integer"],
      ["custom = close * 2\nplot(custom[5001])", "History offset exceeds 5000 bars for this series"],
      ["plot(close[10001])", "History offset exceeds 10000 bars for this series"],
    ] as const) {
      await expect(engine.createSession(program("indicator", ", max_bars_back=3", body)).runBatch(bars))
        .rejects.toMatchObject({ name: "PineRuntimeError", message });
    }
    const fractional = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Wrong", max_bars_back=3)\nplot(close[1.5])' });
    expect(fractional.program).toBeUndefined();
    expect(fractional.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2107", message: "History offset must be an int" })]);
  });

  it("propagates a folded declaration floor into static and callable request children", async () => {
    const source = `//@version=6\nconst int floor = 1 + 2\nindicator("B1B child", max_bars_back=floor)\nfetch() => request.security("A", "1", close[barstate.isrealtime ? 3 : 1])\nplot(fetch())`;
    const compiled = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compiled.diagnostics).toEqual([]);
    const child = compiled.program?.requestPlans[0]?.program;
    expect(child?.source).toContain('indicator("request-0", max_bars_back=3)');
    expect(child?.source).toContain("__request_capture");
    expect(child?.descriptor.maxBarsBack).toBe(3);
    const options = { now: () => now, timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" } };
    const result = await new PineEngine().createSession(compiled.program!, options).runBatch(bars);
    expect(result.plots[0]?.points.at(-1)?.value).toBe(3);
    const noFloor = compile({ source: source.replace(', max_bars_back=floor', ''), compatibility: PINE_COMPATIBILITY.strict });
    expect(noFloor.diagnostics).toEqual([]);
    expect(noFloor.program?.requestPlans[0]?.program.descriptor.maxBarsBack).toBeUndefined();
    await expect(new PineEngine().createSession(noFloor.program!, options).runBatch(bars)).rejects.toMatchObject({
      name: "PineRuntimeError", message: "History offset exceeds inferred buffer of 1 bars for this series",
    });
  });

  it("uses the same floor for direct and dynamic request children", async () => {
    const options = { now: () => now, timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" } };
    for (const [body, dynamic] of [
      ['plot(request.security("A", "1", close[barstate.isrealtime ? 3 : 1]))', false],
      ['if bar_index >= 0\n    request.security("A", "1", close[barstate.isrealtime ? 3 : 1])\nplot(close)', true],
    ] as const) {
      const compiled = program("indicator", ", max_bars_back=3", body);
      expect(compiled.requestPlans[0]?.dynamic === true).toBe(dynamic);
      expect(compiled.requestPlans[0]?.program.descriptor.maxBarsBack).toBe(3);
      const result = await new PineEngine().createSession(compiled, options).runBatch(bars);
      expect(result.plots[0]?.points.at(-1)?.value).toBe(dynamic ? 6 : 3);
    }
  });

  it("retains the positive floor in recursively compiled request children", () => {
    const compiled = program("indicator", ", max_bars_back=3", 'plot(request.security("A", "1", request.security("A", "1", close[barstate.isrealtime ? 3 : 1])))');
    const child = compiled.requestPlans.find((plan) => plan.program.requestPlans.length > 0)?.program;
    expect(child?.descriptor.maxBarsBack).toBe(3);
    expect(child?.requestPlans[0]?.program.descriptor.maxBarsBack).toBe(3);
    expect(child?.requestPlans[0]?.program.source).toContain('max_bars_back=3');
  });

  it("propagates v5 constant integer division into the request child", () => {
    const compiled = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: '//@version=5\nindicator("V5 floor", max_bars_back=5 / 2)\nplot(request.security("A", "1", close[barstate.isrealtime ? 2 : 1]))',
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.descriptor?.maxBarsBack).toBe(2);
    expect(compiled.program?.requestPlans[0]?.program.descriptor.maxBarsBack).toBe(2);
  });

  it("preserves omitted/zero and sealed behavior in root and request programs", async () => {
    const body = 'plot(request.security("A", "1", close[barstate.isrealtime ? 3 : 1]))';
    const zero = program("indicator", ", max_bars_back=0", body);
    const omitted = program("indicator", "", body);
    expect(zero.requestPlans[0]?.program.descriptor.maxBarsBack).toBeUndefined();
    expect(omitted.requestPlans[0]?.program.descriptor.maxBarsBack).toBeUndefined();
    const options = { now: () => now, timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" } };
    for (const candidate of [zero, omitted]) {
      await expect(new PineEngine().createSession(candidate, options).runBatch(bars)).rejects.toMatchObject({
        name: "PineRuntimeError", message: "History offset exceeds inferred buffer of 1 bars for this series",
      });
    }
    const sealed = compile({ source: `//@version=6\nindicator("Sealed", max_bars_back=3)\n${body}`, compatibility: PINE_COMPATIBILITY.legacy });
    const sealedWithout = compile({ source: `//@version=6\nindicator("Sealed")\n${body}`, compatibility: PINE_COMPATIBILITY.legacy });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealedWithout.diagnostics).toEqual([]);
    expect(sealed.program?.requestPlans[0]?.program.source).toContain('indicator("request-0")');
    const withDeclaration = await new PineEngine().createSession(sealed.program!, options).runBatch(bars);
    const withoutDeclaration = await new PineEngine().createSession(sealedWithout.program!, options).runBatch(bars);
    expect(withDeclaration.plots).toEqual(withoutDeclaration.plots);
  });

  it.each(["-1", "5001", "1.5", "input.int(3)"])("rejects invalid declaration floor %s before child admission", (floor) => {
    const compiled = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: `//@version=6\nindicator("Invalid", max_bars_back=${floor})\nplot(request.security("A", "1", close))`,
    });
    expect(compiled.program).toBeUndefined();
    expect(compiled.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2018" && diagnostic.message.includes("max_bars_back"))).toBe(true);
  });
});
