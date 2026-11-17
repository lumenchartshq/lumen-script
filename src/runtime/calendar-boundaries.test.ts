import { describe, expect, it } from "vitest";
import { alignToTimeframe, isInSession, timeframeEnd } from "./time.js";
import { compile } from "../compiler/index.js";
import { createExecutor, createRuntime } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const newYork = "America/New_York";

describe("calendar boundaries", () => {
  it("aligns 3M frames to calendar quarters instead of fixed 30-day months", () => {
    const timestamp = Date.parse("2026-05-15T16:00:00.000Z");

    expect(alignToTimeframe(timestamp, "3M", newYork)).toBe(Date.parse("2026-04-01T04:00:00.000Z"));
    expect(timeframeEnd(timestamp, "3M", newYork)).toBe(Date.parse("2026-07-01T04:00:00.000Z"));
  });

  it("uses exchange-local daily boundaries across the New York DST spring change", () => {
    const timestamp = Date.parse("2026-03-08T17:00:00.000Z");

    expect(alignToTimeframe(timestamp, "D", newYork)).toBe(Date.parse("2026-03-08T05:00:00.000Z"));
    expect(timeframeEnd(timestamp, "D", newYork)).toBe(Date.parse("2026-03-09T04:00:00.000Z"));
  });

  it("applies a day mask to every comma-separated session period", () => {
    const session = "0930-1000,1300-1400:2";

    expect(isInSession(Date.parse("2026-03-09T13:30:00.000Z"), session, newYork, 6)).toBe(true);
    expect(isInSession(Date.parse("2026-03-09T17:30:00.000Z"), session, newYork, 6)).toBe(true);
    expect(isInSession(Date.parse("2026-03-08T13:30:00.000Z"), session, newYork, 6)).toBe(false);
  });

  it("keeps the v5/v6 default day mask on weekends", () => {
    const sunday = Date.parse("2026-08-23T14:00:00.000Z");

    expect(isInSession(sunday, "0900-1600", newYork, 5)).toBe(true);
    expect(isInSession(sunday, "0900-1600", newYork, 6)).toBe(true);
  });
});

describe("frozen timeframe compatibility", () => {
  it("keeps the legacy 3M minute alias in frozen runtime calls", () => {
    const compiled = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Frozen timeframe")
seconds = timeframe.in_seconds("3M")`,
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.program).toBeDefined();
    const runtime = createRuntime(compiled.program!, { timeframe: "1" });
    runtime.reset([{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    runtime.beginBar(0);
    createExecutor(compiled.program!)(runtime);
    runtime.endBar();

    expect(runtime.result(compiled.program!.variableNames, 0).returned.seconds).toEqual([180]);
  });
});
