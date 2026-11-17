import type { MarketBar, SessionOptions } from "../contracts/index.js";
import { compile, PineEngine } from "./index.js";
import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const utc = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour, minute);
const opens = [utc(2025, 3, 9, 1), utc(2025, 3, 9, 6), utc(2025, 3, 9, 7), utc(2025, 3, 9, 20), utc(2025, 3, 9, 21)];
const bars: MarketBar[] = opens.map((openTime, index) => ({
  openTime, closeTime: openTime + 3_600_000,
  open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index, volume: 100,
}));
const clock = utc(2030, 6, 15, 12, 34);
const options: SessionOptions = {
  timeframe: "60", timezone: "America/New_York", now: () => clock,
  sessionSchedule: { activeSession: "1700-1600:1234567", regularSession: "1700-1600:1234567", timezone: "America/New_York" },
};
const source = `//@version=6
indicator("H4 time contract")
series int openTime = time("60")
series int closeTime = time_close("60")
series int prior = time("", bars_back = 1)
series int future = time("", bars_back = -1)
series int active = time("60", "1700-1600:1234567", "America/New_York")
series int activeClose = time_close("60", "1700-1600:1234567", "America/New_York")
series int tradingDay = time_tradingday
series int observedClock = timenow
const int dateString = timestamp("2025-03-09 01:30")
simple int namedZone = timestamp(timezone = "America/New_York", year = 2025, month = 3, day = 9, hour = 3, minute = 30)
simple int offsetZone = timestamp("UTC+05:45", 2025, 3, 9, 3, 30)
series int barDate = timestamp("UTC", year, month, dayofmonth)
plot(openTime)
plot(closeTime)
plot(tradingDay)
plot(observedClock)`;

function program(text: string) {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: text });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

describe("H4 strict time API candidate", () => {
  it("binds exact time and timestamp results while rejecting wrong argument and result types", () => {
    const compiled = program(source);
    expect(compiled.generatedSource).toContain('r.call(');
    expect(compiled.generatedSource).toContain('"timestamp"');
    expect(compiled.generatedSource).toContain('r.constant("time_tradingday")');
    expect(compiled.generatedSource).toContain('r.constant("timenow")');
    for (const [snippet, code] of [
      ['value = time(60)', "SCRIPT2117"],
      ['value = time_close("60", 4)', "SCRIPT2117"],
      ['value = timestamp("UTC", 2025, "March", 9)', "SCRIPT2117"],
      ['simple int value = time("60")', "SCRIPT2102"],
      ['simple int value = time_close("60")', "SCRIPT2102"],
      ['simple int value = time_tradingday', "SCRIPT2102"],
      ['simple int value = timenow', "SCRIPT2102"],
      ['const int value = timestamp("UTC", 2025, 3, 9)', "SCRIPT2102"],
      ['string value = timestamp("2025-03-09")', "SCRIPT2102"],
    ] as const) {
      const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("negative")\n${snippet}` });
      expect(result.program, snippet).toBeUndefined();
      expect(result.diagnostics.some(({ code: observed }) => observed === code), snippet).toBe(true);
    }
  });

  it("uses supplied opens/closes, an overnight trading-day key, UTC string dates and one injected clock", async () => {
    const session = new PineEngine().createSession(program(source), options);
    try {
      const result = await session.runBatch(bars);
      expect(result.returned.openTime).toEqual(opens);
      expect(result.returned.closeTime).toEqual(opens.map((open) => open + 3_600_000));
      expect(result.returned.prior).toEqual([Number.NaN, ...opens.slice(0, -1)]);
      expect(result.returned.future).toEqual(opens.map((open) => open + 3_600_000));
      expect(result.returned.active).toEqual([opens[0], opens[1], opens[2], Number.NaN, opens[4]]);
      expect(result.returned.activeClose).toEqual([opens[0]! + 3_600_000, opens[1]! + 3_600_000, opens[2]! + 3_600_000, Number.NaN, opens[4]! + 3_600_000]);
      expect(result.returned.tradingDay).toEqual([
        utc(2025, 3, 9), utc(2025, 3, 9), utc(2025, 3, 9), Number.NaN, utc(2025, 3, 10),
      ]);
      expect(result.returned.observedClock).toEqual(Array(5).fill(clock));
      expect(result.returned.dateString).toEqual(Array(5).fill(utc(2025, 3, 9, 1, 30)));
      expect(result.returned.namedZone).toEqual(Array(5).fill(utc(2025, 3, 9, 7, 30)));
      expect(result.returned.offsetZone).toEqual(Array(5).fill(utc(2025, 3, 8, 21, 45)));
    } finally { await session.close(); }
  });

  it("keeps history reads of session fields lazy and resolves the requested bar", async () => {
    const compiled = program(`//@version=6
indicator("Session history")
previousMarket = bar_index % 2 == 0 and session.ismarket[1]
previousDay = bar_index % 2 == 0 ? time_tradingday[1] : na`);
    const invalidSchedule = new PineEngine().createSession(compiled, {
      sessionSchedule: { regularSession: "invalid", activeSession: "invalid" },
    });
    const scheduled = new PineEngine().createSession(compiled, options);
    try {
      const first = await invalidSchedule.runBatch(bars.slice(0, 2));
      expect(first.returned.previousMarket).toEqual([false, false]);
      expect(first.returned.previousDay).toEqual([Number.NaN, Number.NaN]);
      await expect(invalidSchedule.appendBars(bars.slice(2, 3))).rejects.toThrow("Invalid host session specification");

      const result = await scheduled.runBatch(bars);
      expect(result.returned.previousMarket).toEqual([false, false, true, false, false]);
      expect(result.returned.previousDay).toEqual([Number.NaN, Number.NaN, utc(2025, 3, 9), Number.NaN, Number.NaN]);
    } finally {
      await invalidSchedule.close();
      await scheduled.close();
    }
  });

  it("rejects invalid zones and offset bounds with typed runtime errors", async () => {
    for (const [expression, message] of [
      ['timestamp("Mars/Olympus", 2025, 3, 9)', "Invalid timezone"],
      ['timestamp("2025-02-30")', "Invalid date string"],
      ['timestamp("2025-02-29T12:00:00Z")', "Invalid date string"],
      ['timestamp("2025-02-29T12:00:00+05:45")', "Invalid date string"],
      ['timestamp("2025-02-30T12:00:00Z")', "Invalid date string"],
      ['timestamp("2025-02-30T12:00:00+05:45")', "Invalid date string"],
      ['timestamp("30 Feb 2025 12:00:00 UTC+0")', "Invalid date string"],
      ['timestamp("30 Feb 2025 12:00:00 +05:45")', "Invalid date string"],
      ['timestamp("Feb 30 2025 12:00:00Z")', "Unsupported date string format"],
      ['timestamp("Feb 28 2025")', "Unsupported date string format"],
      ['time("60", bars_back = -501)', "bars_back"],
      ['time_close("60", timeframe_bars_back = 5001)', "timeframe_bars_back"],
    ] as const) {
      const script = program(`//@version=6\nindicator("invalid")\nvalue = ${expression}`);
      const session = new PineEngine().createSession(script, options);
      try { await expect(session.runBatch(bars.slice(0, 1))).rejects.toThrow(message); }
      finally { await session.close(); }
    }
  });

  it("resolves date-string UTC, named-zone fold and non-time-based future/close limits", async () => {
    const timestamps = program(`//@version=6
indicator("Timestamp folds")
utcText = timestamp("20 Aug 2024 00:00:00 UTC+0")
isoText = timestamp("2024-08-20T00:00")
leapUtc = timestamp("2024-02-29T12:00:00Z")
leapOffset = timestamp("2024-02-29T12:00:00+05:45")
leapNamed = timestamp("29 Feb 2024 12:00:00 UTC+0")
leapNamedOffset = timestamp("29 Feb 2024 12:00:00 +05:45")
fold = timestamp("America/New_York", 2025, 11, 2, 1, 30)`);
    const session = new PineEngine().createSession(timestamps, options);
    try {
      const returned = (await session.runBatch(bars.slice(0, 1))).returned;
      expect(returned.utcText).toEqual([utc(2024, 8, 20)]);
      expect(returned.isoText).toEqual([utc(2024, 8, 20)]);
      expect(returned.leapUtc).toEqual([utc(2024, 2, 29, 12)]);
      expect(returned.leapOffset).toEqual([utc(2024, 2, 29, 6, 15)]);
      expect(returned.leapNamed).toEqual([utc(2024, 2, 29, 12)]);
      expect(returned.leapNamedOffset).toEqual([utc(2024, 2, 29, 6, 15)]);
      expect(returned.fold).toEqual([utc(2025, 11, 2, 6, 30)]);
    } finally { await session.close(); }

    const nonTimeSource = program(`//@version=6
indicator("Irregular chart")
knownOpen = time("60")
futureOpen = time("60", bars_back=-1)
unknownClose = time_close("60")`);
    const irregular = new PineEngine().createSession(nonTimeSource, {
      ...options, chartType: "range", now: () => bars[0]!.openTime + 1,
    });
    try {
      const returned = (await irregular.runBatch(bars.slice(0, 1))).returned;
      expect(returned.knownOpen).toEqual([bars[0]!.openTime]);
      expect(returned.futureOpen).toEqual([Number.NaN]);
      expect(returned.unknownClose).toEqual([Number.NaN]);
    } finally { await irregular.close(); }
  });

  it("honors a supplied non-default five-minute main timeframe", async () => {
    const openTime = utc(2025, 3, 9, 7);
    const fiveMinute = { ...bars[0]!, openTime, closeTime: openTime + 300_000 };
    const script = program(`//@version=6
indicator("Five-minute context")
currentOpen = time("")
currentClose = time_close("")
nextOpen = time("", bars_back=-1)`);
    const session = new PineEngine().createSession(script, { ...options, timeframe: "5" });
    try {
      const returned = (await session.runBatch([fiveMinute])).returned;
      expect(returned.currentOpen).toEqual([openTime]);
      expect(returned.currentClose).toEqual([openTime + 300_000]);
      expect(returned.nextOpen).toEqual([openTime + 300_000]);
    } finally { await session.close(); }
  });

  it("aligns a requested intraday frame to a fractional-offset local midnight", async () => {
    const openTime = utc(2025, 3, 9, 6, 43);
    const script = program(`//@version=6
indicator("Fractional-offset frame")
hourOpen = time("60", "", "UTC+05:45")
hourClose = time_close("60", "", "UTC+05:45")`);
    const session = new PineEngine().createSession(script, { ...options, timeframe: "1" });
    try {
      const returned = (await session.runBatch([{ ...bars[0]!, openTime, closeTime: openTime + 60_000 }])).returned;
      expect(returned.hourOpen).toEqual([utc(2025, 3, 9, 6, 15)]);
      expect(returned.hourClose).toEqual([utc(2025, 3, 9, 7, 15)]);
    } finally { await session.close(); }
  });

  it("builds explicit-session bars from the session start and clips the final close", async () => {
    const sessionStart = utc(2025, 3, 10, 13, 30); // 09:30 New York after the DST change.
    const samples = [
      { openTime: sessionStart - 30 * 60_000, closeTime: sessionStart + 30 * 60_000 },
      { openTime: sessionStart + 90 * 60_000, closeTime: sessionStart + 91 * 60_000 },
      { openTime: sessionStart + 120 * 60_000, closeTime: sessionStart + 121 * 60_000 },
    ].map((times) => ({ ...bars[0]!, ...times }));
    const script = program(`//@version=6
indicator("Session frame")
sessionOpen = time("60", "0930-1115:23456", "America/New_York")
sessionClose = time_close("60", "0930-1115:23456", "America/New_York")
previousOpen = time("60", "0930-1115:23456", "America/New_York", timeframe_bars_back=1)
nextClose = time_close("60", "0930-1115:23456", "America/New_York", timeframe_bars_back=-1)`);
    const session = new PineEngine().createSession(script, { ...options, timeframe: "1" });
    try {
      const returned = (await session.runBatch(samples)).returned;
      expect(returned.sessionOpen).toEqual([sessionStart, sessionStart + 60 * 60_000, Number.NaN]);
      expect(returned.sessionClose).toEqual([sessionStart + 60 * 60_000, sessionStart + 105 * 60_000, Number.NaN]);
      expect(returned.previousOpen).toEqual([utc(2025, 3, 7, 15, 30), sessionStart, Number.NaN]);
      expect(returned.nextClose).toEqual([sessionStart + 105 * 60_000, utc(2025, 3, 11, 14, 30), Number.NaN]);
    } finally { await session.close(); }
  });

  it("requires same-frame chart opens to be inside a custom session", async () => {
    // Recorded probe time-session-crypto.txt shows the 00:00 bar outside the
    // 01:00 session despite its overlap. The 04:00 bar maps to 01:00–05:00.
    const start = utc(2026, 11, 10);
    const hour = 60 * 60_000;
    const compiled = program(`//@version=6
indicator("Crypto session open")
sessionOpen = time("", "0100-0530:1234567", "UTC")
sessionClose = time_close("240", "0100-0530:1234567", "UTC")`);
    const session = new PineEngine().createSession(compiled, { ...options, timeframe: "240", timezone: "Etc/UTC" });
    try {
      const result = await session.runBatch([start, start + 4 * hour].map((openTime) => ({
        ...bars[0]!, openTime, closeTime: openTime + 4 * hour,
      })));
      expect(result.returned.sessionOpen).toEqual([Number.NaN, start + hour]);
      expect(result.returned.sessionClose).toEqual([Number.NaN, start + 5 * hour]);
    } finally {
      await session.close();
    }
  });

  it("groups explicit-session chart bars into one requested weekly period", async () => {
    const monday = utc(2025, 3, 10, 13, 30);
    const tuesday = utc(2025, 3, 11, 13, 30);
    const script = program(`//@version=6
indicator("Weekly session blocker")
weeklyOpen = time("W", "0930-1600:23456", "America/New_York")
weeklyClose = time_close("W", "0930-1600:23456", "America/New_York")`);
    const session = new PineEngine().createSession(script, { ...options, timeframe: "1" });
    try {
      const returned = (await session.runBatch([monday, tuesday].map((openTime) => ({
        ...bars[0]!, openTime, closeTime: openTime + 60_000,
      })))).returned;
      expect(returned.weeklyOpen).toEqual([monday, monday]);
      expect(returned.weeklyClose).toEqual([utc(2025, 3, 14, 20), utc(2025, 3, 14, 20)]);
    } finally { await session.close(); }
  });
});
