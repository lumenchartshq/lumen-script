import { describe, expect, it } from "vitest";

import { calendarComponent } from "./calendar-components.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

describe("calendar component runtime helper", () => {
  it("resolves UTC, fractional-offset and DST-fold/gap instants without local-timezone dependence", () => {
    expect(calendarComponent("year", -1_755_000, "UTC", true)).toBe(1969);
    expect(calendarComponent("dayofmonth", -1_755_000, "UTC+05:45", true)).toBe(1);
    expect(calendarComponent("hour", Date.parse("2024-03-10T06:59:59Z"), "America/New_York", true)).toBe(1);
    expect(calendarComponent("hour", Date.parse("2024-03-10T07:00:00Z"), "America/New_York", true)).toBe(3);
    expect(calendarComponent("hour", Date.parse("2024-11-03T05:30:00Z"), "America/New_York", true)).toBe(1);
    expect(calendarComponent("hour", Date.parse("2024-11-03T06:30:00Z"), "America/New_York", true)).toBe(1);
  });

  it("uses the documented week number range with the locally bounded ISO week-year policy", () => {
    expect(calendarComponent("weekofyear", Date.parse("2020-12-31T23:30:45Z"), "UTC", true)).toBe(53);
    expect(calendarComponent("weekofyear", Date.parse("2021-01-01T00:30:45Z"), "UTC", true)).toBe(53);
    expect(calendarComponent("weekofyear", Date.parse("2021-01-04T00:00:00Z"), "UTC", true)).toBe(1);
    expect(calendarComponent("weekofyear", Date.parse("2024-12-30T00:00:00Z"), "UTC", true)).toBe(1);
  });

  it("returns missing for nonfinite timestamps and rejects invalid strict timezones precisely", () => {
    for (const timestamp of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(calendarComponent("second", timestamp, "UTC", true)).toBeNaN();
    }
    for (const timezone of ["", "UTC+5:5", "UTC+14:01", "UTC-12:01", "Mars/Olympus_Mons"]) {
      expect(() => calendarComponent("hour", 0, timezone, true), timezone).toThrow(PineRuntimeError);
      expect(() => calendarComponent("hour", 0, timezone, true), timezone).toThrow(`Invalid timezone: "${timezone}"`);
    }
  });

  it("preserves the sealed invalid-timezone fallback boundary", () => {
    expect(calendarComponent("year", 0, "Mars/Olympus_Mons", false)).toBe(1970);
  });
});
