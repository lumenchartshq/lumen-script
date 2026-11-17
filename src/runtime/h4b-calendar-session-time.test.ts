import { describe, expect, it } from "vitest";

import { PineRuntimeError } from "./pine-runtime-error.js";
import { calendarSessionBarAt, parseSessionSpec } from "./time.js";

const timezone = "America/New_York";
const instant = (iso: string): number => Date.parse(iso);

function observed(iso: string, timeframe: string, sessionText: string, offset = 0) {
  const parsed = parseSessionSpec(sessionText);
  if (!parsed.ok) throw new Error(parsed.reason);
  const open = instant(iso);
  return calendarSessionBarAt(open, open + 60_000, timeframe, offset, parsed.value, timezone);
}

describe("requested calendar session bars", () => {
  it("holds one weekly and monthly boundary across supplied chart bars and changes at the next period", () => {
    const session = "0930-1600:23456";
    const marchWeek = { open: instant("2025-03-10T13:30:00Z"), close: instant("2025-03-14T20:00:00Z") };
    expect(observed("2025-03-10T13:30:00Z", "W", session)).toEqual(marchWeek);
    expect(observed("2025-03-11T13:30:00Z", "W", session)).toEqual(marchWeek);
    expect(observed("2025-03-17T13:30:00Z", "W", session)).toEqual({
      open: instant("2025-03-17T13:30:00Z"), close: instant("2025-03-21T20:00:00Z"),
    });
    const marchMonth = { open: instant("2025-03-03T14:30:00Z"), close: instant("2025-03-31T20:00:00Z") };
    expect(observed("2025-03-10T13:30:00Z", "M", session)).toEqual(marchMonth);
    expect(observed("2025-03-11T13:30:00Z", "M", session)).toEqual(marchMonth);
    expect(observed("2025-04-01T13:30:00Z", "M", session)).toEqual({
      open: instant("2025-04-01T13:30:00Z"), close: instant("2025-04-30T20:00:00Z"),
    });
    expect(observed("2025-03-14T20:00:00Z", "W", session)).toBeUndefined();
  });

  it("moves calendar periods over DST without fixed-second offsets", () => {
    const session = "0930-1600:23456";
    expect(observed("2025-03-10T13:30:00Z", "W", session, 1)).toEqual({
      open: instant("2025-03-03T14:30:00Z"), close: instant("2025-03-07T21:00:00Z"),
    });
    expect(observed("2025-03-10T13:30:00Z", "W", session, -1)).toEqual({
      open: instant("2025-03-17T13:30:00Z"), close: instant("2025-03-21T20:00:00Z"),
    });
    expect(observed("2025-03-10T13:30:00Z", "M", session, 1)).toEqual({
      open: instant("2025-02-03T14:30:00Z"), close: instant("2025-02-28T21:00:00Z"),
    });
    expect(observed("2025-03-10T13:30:00Z", "M", session, -1)).toEqual({
      open: instant("2025-04-01T13:30:00Z"), close: instant("2025-04-30T20:00:00Z"),
    });
  });

  it("uses first and last masked windows for multiplied periods, overnight dates and skipped days", () => {
    expect(observed("2025-03-11T13:30:00Z", "2W", "0930-1130,1300-1600:23456"))
      .toEqual({ open: instant("2025-03-03T14:30:00Z"), close: instant("2025-03-14T20:00:00Z") });
    expect(observed("2025-03-11T13:30:00Z", "3M", "0930-1600:23456"))
      .toEqual({ open: instant("2025-01-01T14:30:00Z"), close: instant("2025-03-31T20:00:00Z") });
    expect(observed("2025-03-09T21:00:00Z", "W", "1700-1600:23456"))
      .toEqual({ open: instant("2025-03-09T21:00:00Z"), close: instant("2025-03-14T20:00:00Z") });
    expect(observed("2025-03-07T14:30:00Z", "D", "0930-1600:23456", -1))
      .toEqual({ open: instant("2025-03-10T13:30:00Z"), close: instant("2025-03-10T20:00:00Z") });
  });

  it("resolves session edges through spring gaps and fall folds", () => {
    expect(observed("2025-03-09T06:00:00Z", "D", "0100-0400:1"))
      .toEqual({ open: instant("2025-03-09T06:00:00Z"), close: instant("2025-03-09T08:00:00Z") });
    expect(observed("2025-11-02T05:00:00Z", "D", "0100-0400:1"))
      .toEqual({ open: instant("2025-11-02T05:00:00Z"), close: instant("2025-11-02T09:00:00Z") });
  });

  it("keeps month and year rollover on local trading dates, including partial holiday-free periods", () => {
    const session = "0930-1600:23456";
    expect(observed("2024-12-31T14:30:00Z", "M", session, -1)).toEqual({
      open: instant("2025-01-01T14:30:00Z"), close: instant("2025-01-31T21:00:00Z"),
    });
    expect(observed("2025-01-02T14:30:00Z", "M", session, 1)).toEqual({
      open: instant("2024-12-02T14:30:00Z"), close: instant("2024-12-31T21:00:00Z"),
    });
    expect(observed("2025-01-02T14:30:00Z", "12M", session)).toEqual({
      open: instant("2025-01-01T14:30:00Z"), close: instant("2025-12-31T21:00:00Z"),
    });
  });

  it("jumps admitted maximum offsets without scanning intervening session windows", () => {
    const sparse = parseSessionSpec("0930-1600:2");
    const weekdays = parseSessionSpec("0930-1600:23456");
    if (!sparse.ok || !weekdays.ok) throw new Error("Expected valid sessions");
    const monday = Date.UTC(2025, 2, 10, 9, 30);
    for (const offset of [1, 100, 5_000, -1, -100, -500]) {
      const expected = Date.UTC(2025, 2, 10 - offset * 7, 9, 30);
      expect(calendarSessionBarAt(monday, monday + 60_000, "D", offset, sparse.value, "UTC"))
        .toEqual({ open: expected, close: expected + 6.5 * 3_600_000 });
      expect(calendarSessionBarAt(monday, monday + 60_000, "W", offset, weekdays.value, "UTC")?.open)
        .toBe(expected);
    }
    expect(calendarSessionBarAt(monday, monday + 60_000, "M", 5_000, weekdays.value, "UTC")?.open)
      .toBe(Date.UTC(1608, 6, 1, 9, 30));
  });

  it("keeps long supplied-bar overlap while rejecting a short bar outside the mask", () => {
    const parsed = parseSessionSpec("0930-1600:2");
    if (!parsed.ok) throw new Error(parsed.reason);
    const tuesday = instant("2025-03-11T00:00:00Z");
    expect(calendarSessionBarAt(tuesday, tuesday + 60_000, "W", 0, parsed.value, "UTC"))
      .toBeUndefined();
    expect(calendarSessionBarAt(tuesday, instant("2025-03-17T10:00:00Z"), "W", 0, parsed.value, "UTC"))
      .toEqual({ open: instant("2025-03-17T09:30:00Z"), close: instant("2025-03-17T16:00:00Z") });
  });

  it("fails with a typed error when a multiplier has no representable calendar end", () => {
    const parsed = parseSessionSpec("0930-1600:23456");
    if (!parsed.ok) throw new Error(parsed.reason);
    const monday = instant("2025-03-10T13:30:00Z");
    try {
      calendarSessionBarAt(monday, monday + 60_000, "999999999999999M", 0,
        parsed.value, timezone, "time_close");
      throw new Error("Expected an out-of-range calendar failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PineRuntimeError);
      expect(error).toMatchObject({ method: "time_close", message: "Calendar session period is outside supported dates" });
    }
  });
});
