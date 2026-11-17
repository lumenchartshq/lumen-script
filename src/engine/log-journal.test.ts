import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PineLogAttempt, PineLogJournal } from "./log-journal.js";
import type { MarketBar, PineLogDraft, SessionCheckpoint } from "../contracts/index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function program(body: string) {
  const result = compile({ source: `//@version=6\nindicator("Logs")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

function bar(index: number, close = index + 1): MarketBar {
  return { openTime: index * 60_000, closeTime: (index + 1) * 60_000, open: close, high: close, low: close, close, volume: 1 };
}

describe("Pine log journal", () => {
  it("rejects void log calls in value declarations while admitting statement calls", () => {
    for (const level of ["info", "warning", "error"] as const) {
      const statement = compile({
        source: `//@version=6\nindicator("Logs")\nlog.${level}("message")`,
        compatibility: PINE_COMPATIBILITY.strict,
      });
      expect(statement.diagnostics).toEqual([]);
      expect(statement.program).toBeDefined();

      const value = compile({
        source: `//@version=6\nindicator("Logs")\nvalue = log.${level}("message")`,
        compatibility: PINE_COMPATIBILITY.strict,
      });
      expect(value.diagnostics).toContainEqual(expect.objectContaining({
        code: "SCRIPT2137",
        message: "Void expression cannot initialize variable 'value'",
      }));
      expect(value.program).toBeUndefined();
    }
  });

  it("admits direct and formatted calls with level, source and historical bar provenance", async () => {
    const compiled = program('log.info("hello")\nlog.warning("bar {0} close {1,number,#.00}", bar_index, close)\nlog.error("bad")\nplot(close)');
    const session = new PineEngine().createSession(compiled, { now: () => 1_000_000 });
    await session.runBatch([bar(1, 2)]);
    const events = session.logs().events;
    expect(events.map((event) => [event.level, event.message, event.callSite.line]))
      .toEqual([["info", "hello", 3], ["warning", "bar 0 close 2.00", 4], ["error", "bad", 5]]);
    expect(events.map((event) => [event.sequence, event.barIndex, event.barOpenTimeMs, event.emittedAtMs, event.phase]))
      .toEqual([[0, 0, 60_000, 60_000, "historical"], [1, 0, 60_000, 60_000, "historical"], [2, 0, 60_000, 60_000, "historical"]]);
    await session.close();
  });

  it("binds the documented direct and formatted named signatures", async () => {
    const compiled = program('log.info(message="named")\nlog.warning(formatString="value {0}", arg0=close)');
    const session = new PineEngine().createSession(compiled);
    await session.runBatch([bar(0, 4)]);
    expect(session.logs().events.map((event) => event.message)).toEqual(["named", "value 4"]);
    await session.close();
  });

  it("keeps real tick logs through rollback and resets on a historical correction", async () => {
    const compiled = program('log.info("close {0}", close)\nplot(close)');
    const session = new PineEngine().createSession(compiled, { now: () => 90_000 });
    await session.runBatch([bar(0), bar(1)]);
    const before = session.logs();
    expect(before.events.map((event) => event.phase)).toEqual(["historical", "realtime"]);
    await session.replaceTail([bar(1, 3)], { logCause: "realtime-tick" });
    const tick = session.logs();
    expect(tick.logEpoch).toBe(before.logEpoch);
    expect(tick.events.map((event) => [event.sequence, event.message, event.emittedAtMs]))
      .toEqual([[0, "close 1", 0], [1, "close 2", 90_000], [2, "close 3", 90_000]]);
    await session.replaceTail([bar(1, 4)], { logCause: "historical-correction" });
    expect(session.logs().logEpoch).not.toBe(before.logEpoch);
    expect(session.logs().events.map((event) => event.message)).toEqual(["close 1", "close 4"]);
    await session.close();
  });

  it("drops speculative root attempts and preserves a portable journal", async () => {
    const compiled = program('log.info("before")\nsymbol = bar_index >= 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))\nlog.warning("after")');
    expect(compiled.requestPlans.some((plan) => plan.dynamic)).toBe(true);
    const options = { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" }, now: () => 1_000_000 };
    const engine = new PineEngine();
    const session = engine.createSession(compiled, options);
    await session.runBatch([bar(0)]);
    expect(session.logs().events.map((event) => event.message)).toEqual(["before", "after"]);
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const restored = engine.createSession(compiled, options);
    await restored.restore(checkpoint);
    expect(restored.logs()).toEqual(session.logs());
    await expect(restored.restore({ ...checkpoint, logState: "{}" })).rejects.toThrow();
    expect(restored.logs()).toEqual(session.logs());
    await session.close();
    await restored.close();
  });

  it("keeps checkpoint sequence continuity through a static append", async () => {
    const compiled = program('log.info("bar {0}", bar_index)\nplot(close)');
    const engine = new PineEngine();
    const session = engine.createSession(compiled);
    await session.runBatch([bar(0)]);
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const restored = engine.createSession(compiled);
    await restored.restore(checkpoint);
    await restored.appendBars([bar(1)]);
    expect(restored.logs().events.map((event) => [event.sequence, event.message])).toEqual([[0, "bar 0"], [1, "bar 1"]]);
    expect(restored.logs().logEpoch).toBe(session.logs().logEpoch);
    await session.close();
    await restored.close();
  });

  it("retains child request messages with request context and no duplicate cached replay", async () => {
    const compiled = program('f() =>\n    log.warning("child")\n    close\nplot(request.security("A", "1", f()))');
    const session = new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" }, now: () => 1_000_000 });
    await session.runBatch([bar(0)]);
    expect(session.logs().events.map((event) => [event.message, event.context.kind])).toEqual([["child", "request"]]);
    expect(typeof session.logs().events[0]?.context.requestId).toBe("string");
    expect(session.logs().events[0]?.callSite.line).toBe(4);
    await session.appendBars([bar(1)]);
    expect(session.logs().events).toHaveLength(2);
    await session.close();
  });

  it("commits child and root logs once after dynamic request discovery", async () => {
    const compiled = program('f() =>\n    log.warning("child")\n    close\nlog.info("root")\nsymbol = bar_index >= 0 ? "A" : "B"\nplot(request.security(symbol, "1", f()))');
    const session = new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" }, now: () => 1_000_000 });
    await session.runBatch([bar(0)]);
    expect(session.logs().events.map((event) => [event.message, event.context.kind])).toEqual([["child", "request"], ["root", "root"]]);
    await session.close();
  });

  it("keeps only the new child request log on a real tail tick", async () => {
    const compiled = program('f() =>\n    log.warning("child {0}", close)\n    close\nplot(request.security("A", "1", f()))');
    const session = new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" }, now: () => 90_000 });
    await session.runBatch([bar(0), bar(1)]);
    expect(session.logs().events.map((event) => event.message)).toEqual(["child 1", "child 2"]);
    await session.replaceTail([bar(1, 3)], { logCause: "realtime-tick" });
    expect(session.logs().events.map((event) => event.message)).toEqual(["child 1", "child 2", "child 3"]);
    await session.close();
  });

  it("keeps child clock logs on an unchanged realtime tail", async () => {
    const compiled = program('f() =>\n    log.info("clock {0}", timenow)\n    close\nplot(request.security("A", "1", f()))');
    let now = 90_000;
    const session = new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { ticker: "A", tickerid: "A", timezone: "Etc/UTC" }, now: () => now });
    await session.runBatch([bar(0), bar(1)]);
    now = 91_000;
    await session.replaceTail([bar(1)], { logCause: "realtime-tick" });
    expect(session.logs().events.map((event) => event.message)).toEqual(["clock 90000", "clock 90000", "clock 91000"]);
    expect(session.logs().events.at(-1)?.emittedAtMs).toBe(91_000);
    await session.close();
  });

  it("bounds messages and retained event count", async () => {
    const compiled = program('log.info(str.repeat("x", 10000))');
    const session = new PineEngine().createSession(compiled);
    await session.runBatch([bar(0)]);
    expect(new TextEncoder().encode(session.logs().events[0]!.message)).toHaveLength(8192);
    expect(session.logs().events[0]!.truncated).toBe(true);
    await session.close();

    const expanded = new PineEngine().createSession(program('log.warning(str.repeat("{0}", 3000), str.repeat("y", 8000))'));
    await expanded.runBatch([bar(0)]);
    expect(new TextEncoder().encode(expanded.logs().events[0]!.message).length).toBeLessThanOrEqual(8192);
    expect(expanded.logs().events[0]!.truncated).toBe(true);
    await expanded.close();

    const journal = new PineLogJournal();
    const attempt = new PineLogAttempt();
    const draft: PineLogDraft = { level: "info", message: "x", barIndex: 0, barOpenTimeMs: 0, emittedAtMs: 0, phase: "historical", callSite: { line: 1, column: 1, endLine: 1, endColumn: 2 } };
    for (let index = 0; index < 10_001; index += 1) attempt.add(draft);
    journal.commit([attempt]);
    expect(journal.snapshot().events).toHaveLength(10_000);
    expect(journal.snapshot().droppedCount).toBe(1);

    const byteJournal = new PineLogJournal();
    const byteAttempt = new PineLogAttempt();
    for (let index = 0; index < 1100; index += 1) byteAttempt.add({ ...draft, message: "z".repeat(8000) });
    byteJournal.commit([byteAttempt]);
    const retainedBytes = byteJournal.snapshot().events.reduce((sum, event) => sum + new TextEncoder().encode(JSON.stringify(event)).length, 0);
    expect(retainedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(byteJournal.snapshot().droppedCount).toBeGreaterThan(0);
  });

  it("does not commit logs from a failed evaluation", async () => {
    const compiled = program('log.info("before failure")\nruntime.error("failed")');
    const session = new PineEngine().createSession(compiled);
    await expect(session.runBatch([bar(0)])).rejects.toThrow("failed");
    expect(session.logs().events).toEqual([]);
    await session.close();

    const conditional = program('log.info("committed")\nif close > 2\n    runtime.error("failed")');
    const incremental = new PineEngine().createSession(conditional);
    await incremental.runBatch([bar(0)]);
    const before = incremental.logs();
    await expect(incremental.replaceTail([bar(0, 3)], { logCause: "realtime-tick" })).rejects.toThrow("failed");
    expect(incremental.logs()).toEqual(before);
    await incremental.close();
  });

  it("discards staged logs when an evaluation is cancelled", async () => {
    const controller = new AbortController();
    const session = new PineEngine().createSession(program('log.info("bar")\nplot(close)'), { signal: controller.signal });
    await expect(session.runBatch([bar(0), bar(1)], { onProgress: () => controller.abort() })).rejects.toThrow();
    expect(session.logs().events).toEqual([]);
    await session.close();
  });

  it("preserves the sealed compatibility lane's existing log no-op", async () => {
    const result = compile({ source: '//@version=5\nindicator("Frozen")\nlog.info("hello")', compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!);
    await session.runBatch([bar(0)]);
    expect(session.logs().events).toEqual([]);
    await session.close();
  });
});
