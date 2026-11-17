import type { PINE_TIME_COMPONENT_FIELDS } from "../contracts/index.js";

import { PineRuntimeError } from "./pine-runtime-error.js";
import { dateParts, isValidTimezone, isoWeek } from "./time.js";

export type CalendarComponentName = typeof PINE_TIME_COMPONENT_FIELDS[number];

/**
 * Resolves one Pine calendar component from an absolute millisecond timestamp.
 * The strict profile validates both explicit and host-default timezones; the
 * sealed profile keeps its accepted fallback behavior.
 */
export function calendarComponent(
  name: CalendarComponentName,
  timestamp: number,
  timezone: string,
  strict: boolean,
): number {
  if (!Number.isFinite(timestamp)) return Number.NaN;
  if (strict && !isValidTimezone(timezone)) {
    throw new PineRuntimeError(`Invalid timezone: "${timezone}"`, name);
  }

  const parts = dateParts(timestamp, timezone);
  switch (name) {
    case "dayofmonth": return parts.day;
    case "dayofweek": return parts.dayOfWeek === 0 ? 1 : parts.dayOfWeek + 1;
    case "hour": return parts.hour;
    case "minute": return parts.minute;
    case "month": return parts.month;
    case "second": return parts.second;
    case "weekofyear": return isoWeek(parts.year, parts.month, parts.day);
    case "year": return parts.year;
  }
}
