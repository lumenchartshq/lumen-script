import { parsePineDateString, timezoneOffsetMinutes, type PineSessionCorrection, type PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { number, pineString } from "./values.js";

export { timezoneOffsetMinutes };

export function normalizeTimeframe(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  // Uppercase calendar units must win over the lower-case minute aliases
  // below: `3M` is a three-month frame, never three minutes.
  const calendar = trimmed.match(/^(\d+)([DWM])$/);
  if (calendar !== null) return calendar[1] === "1" ? calendar[2]! : trimmed;
  const direct: Readonly<Record<string, string>> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "45m": "45",
    "1h": "60", "2h": "120", "3h": "180", "4h": "240", "1d": "D", "1w": "W", "1M": "M",
  };
  if (direct[trimmed] !== undefined) return direct[trimmed];
  const mapped = direct[trimmed.toLowerCase()];
  if (mapped !== undefined) return mapped;
  const normalized = trimmed.toUpperCase();
  if (normalized === "1D" || normalized === "1W" || normalized === "1M") return normalized.slice(1);
  return normalized;
}

/**
 * @param explicitMultiplier Pine v6 reports periods with their multiplier,
 * e.g. `1D` where v5 reports `D`.
 */
export function timeframeProperty(name: string, timeframe: string, explicitMultiplier = false): PineValue {
  const normalized = normalizeTimeframe(timeframe);
  const unit = normalized.slice(-1);
  if (name === "period" || name === "main_period") return explicitMultiplier && !/^\d/.test(normalized) ? `1${normalized}` : normalized;
  if (name === "multiplier") return Number.parseInt(normalized, 10) || 1;
  if (name === "isdwm") return ["D", "W", "M"].includes(unit);
  if (name === "isticks") return unit === "T";
  if (name === "isdaily") return unit === "D";
  if (name === "isweekly") return unit === "W";
  if (name === "ismonthly") return unit === "M";
  if (name === "isseconds") return unit === "S";
  if (name === "isminutes") return /^\d+$/.test(normalized);
  if (name === "isintraday") return !["D", "W", "M"].includes(unit);
  return `timeframe.${name}`;
}

export function timeframeSeconds(timeframe: string): number {
  const normalized = normalizeTimeframe(timeframe);
  const unit = normalized.slice(-1);
  const parsed = Number.parseInt(normalized, 10);
  const multiplier = Number.isNaN(parsed) ? 1 : parsed;
  if (unit === "S") return multiplier;
  if (unit === "D") return multiplier * 86_400;
  if (unit === "W") return multiplier * 604_800;
  if (unit === "M") return multiplier * 2_592_000;
  return Number.isNaN(parsed) ? 0 : parsed * 60;
}

export function timeframeFromSeconds(seconds: number, strictCompatibility = false): PineValue {
  if (!strictCompatibility) {
    if (seconds < 60) return `${Math.ceil(seconds / 5) * 5}S`;
    if (seconds < 86_400) return Math.ceil(seconds / 60);
    if (seconds <= 31_449_600) {
      if (seconds % 604_800 === 0) return `${Math.ceil(seconds / 604_800)}W`;
      return `${Math.ceil(seconds / 86_400)}D`;
    }
    return "12M";
  }

  const roundedSeconds = Math.ceil(seconds);
  if (roundedSeconds <= 1) return "1S";
  for (const supportedSeconds of [5, 10, 15, 30]) {
    if (roundedSeconds <= supportedSeconds) return `${supportedSeconds}S`;
  }
  if (roundedSeconds < 86_400) return String(Math.ceil(roundedSeconds / 60));
  if (seconds <= 31_449_600) {
    if (roundedSeconds % 604_800 === 0) return `${Math.ceil(roundedSeconds / 604_800)}W`;
    return `${Math.ceil(roundedSeconds / 86_400)}D`;
  }
  return "12M";
}

/**
 * Returns the calendar boundary containing `timestamp`. Calendar frames use
 * the exchange timezone so DST and composite months (for example `3M`) do
 * not inherit the old fixed-30-day approximation. Exchange sessions and
 * holidays remain data-provider concerns; callers with authoritative bars
 * should prefer their supplied open/close timestamps.
 */
export function alignToTimeframe(timestamp: number, timeframe: string, timezone = "UTC"): number {
  const normalized = normalizeTimeframe(timeframe);
  const calendar = calendarTimeframe(normalized);
  if (calendar === undefined) {
    const seconds = timeframeSeconds(normalized);
    const duration = seconds * 1000;
    const local = dateParts(timestamp, timezone);
    const dayStart = timestampFromComponents(timezone, local.year, local.month, local.day, 0, 0, 0);
    return duration <= 0 ? timestamp : dayStart + Math.floor((timestamp - dayStart) / duration) * duration;
  }

  const parts = dateParts(timestamp, timezone);
  if (calendar.unit === "M") {
    const month = Math.floor((parts.month - 1) / calendar.multiplier) * calendar.multiplier + 1;
    return timestampFromComponents(timezone, parts.year, month, 1, 0, 0, 0);
  }

  const dayStart = timestampFromComponents(timezone, parts.year, parts.month, parts.day, 0, 0, 0);
  if (calendar.unit === "D") return addCalendarDays(dayStart, timezone, -modulo(calendarDayOrdinal(parts.year, parts.month, parts.day), calendar.multiplier));

  const daysToMonday = parts.dayOfWeek === 0 ? 6 : parts.dayOfWeek - 1;
  const monday = addCalendarDays(dayStart, timezone, -daysToMonday);
  const mondayParts = dateParts(monday, timezone);
  return addCalendarDays(monday, timezone, -modulo(Math.floor(calendarDayOrdinal(mondayParts.year, mondayParts.month, mondayParts.day) / 7), calendar.multiplier) * 7);
}

/** Returns the first calendar boundary after the frame containing `timestamp`. */
export function timeframeEnd(timestamp: number, timeframe: string, timezone = "UTC"): number {
  const normalized = normalizeTimeframe(timeframe);
  const calendar = calendarTimeframe(normalized);
  if (calendar === undefined) {
    const seconds = timeframeSeconds(normalized);
    return seconds <= 0 ? timestamp : alignToTimeframe(timestamp, normalized, timezone) + seconds * 1000;
  }

  const start = alignToTimeframe(timestamp, normalized, timezone);
  const parts = dateParts(start, timezone);
  if (calendar.unit === "M") return timestampFromComponents(timezone, parts.year, parts.month + calendar.multiplier, 1, 0, 0, 0);
  return addCalendarDays(start, timezone, calendar.unit === "W" ? calendar.multiplier * 7 : calendar.multiplier);
}

/** Moves a timestamp by whole bars in the requested timeframe. */
export function offsetTimeframe(timestamp: number, timeframe: string, barsBack: number, timezone = "UTC"): number {
  const normalized = normalizeTimeframe(timeframe);
  const start = alignToTimeframe(timestamp, normalized, timezone);
  if (barsBack === 0) return start;
  const calendar = calendarTimeframe(normalized);
  if (calendar === undefined) {
    const seconds = timeframeSeconds(normalized);
    return seconds <= 0 ? start : start - barsBack * seconds * 1000;
  }

  const parts = dateParts(start, timezone);
  if (calendar.unit === "M") {
    return timestampFromComponents(timezone, parts.year, parts.month - barsBack * calendar.multiplier, 1, 0, 0, 0);
  }
  const days = calendar.multiplier * (calendar.unit === "W" ? 7 : 1);
  return addCalendarDays(start, timezone, -barsBack * days);
}

interface CalendarTimeframe {
  readonly unit: "D" | "W" | "M";
  readonly multiplier: number;
}

function calendarTimeframe(timeframe: string): CalendarTimeframe | undefined {
  const match = timeframe.match(/^(\d+)?([DWM])$/);
  if (match === null) return undefined;
  const multiplier = Number.parseInt(match[1] ?? "1", 10);
  return Number.isInteger(multiplier) && multiplier > 0
    ? { unit: match[2]! as CalendarTimeframe["unit"], multiplier }
    : undefined;
}

function calendarDayOrdinal(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function modulo(value: number, divisor: number): number {
  const remainder = value % divisor;
  return remainder < 0 ? remainder + divisor : remainder;
}

function addCalendarDays(timestamp: number, timezone: string, days: number): number {
  const parts = dateParts(timestamp, timezone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return timestampFromComponents(timezone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 0, 0, 0);
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly dayOfWeek: number;
}

export function dateParts(timestamp: number, timezone: string): DateParts {
  const normalized = timezone.trim();
  const offsetMinutes = timezoneOffsetMinutes(normalized);
  if (offsetMinutes !== undefined) {
    const shifted = timestamp + offsetMinutes * 60_000;
    return utcDateParts(shifted);
  }
  if (normalized === "UTC" || normalized === "GMT" || normalized === "Etc/UTC" || normalized.length === 0) return utcDateParts(timestamp);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: normalized,
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hour12: false,
    });
    const formatted = formatter.formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number.parseInt(formatted.find((part) => part.type === type)?.value ?? "0", 10);
    const weekdays: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const hour = value("hour");
    return { year: value("year"), month: value("month"), day: value("day"), hour: hour === 24 ? 0 : hour, minute: value("minute"), second: value("second"), dayOfWeek: weekdays[formatted.find((part) => part.type === "weekday")?.value ?? "Sun"] ?? 0 };
  } catch {
    return utcDateParts(timestamp);
  }
}

export function isValidTimezone(timezone: string): boolean {
  const normalized = timezone.trim();
  if (normalized.length === 0) return false;
  if (timezoneOffsetMinutes(normalized) !== undefined) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
    return true;
  } catch {
    return false;
  }
}

function utcDateParts(timestamp: number): DateParts {
  const date = new Date(timestamp);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(), dayOfWeek: date.getUTCDay() };
}

export function isoWeek(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export interface SessionWindow {
  readonly start: number;
  readonly end: number;
  readonly overnight: boolean;
}

export interface SessionSpec {
  readonly windows: readonly SessionWindow[];
  readonly days: ReadonlySet<number>;
}

export interface SessionBarBoundary {
  readonly open: number;
  readonly close: number;
}

interface ZonedSessionWindow {
  readonly start: number;
  readonly end: number;
  /** UTC midnight encoding the local trading date, not a market timestamp. */
  readonly tradingDate: number;
}

/** Builds bounded, session-relative time bars from supplied chart-bar coverage. */
export function sessionBarAt(
  chartOpen: number,
  chartClose: number,
  timeframe: string,
  session: SessionSpec,
  timezone: string,
  allowOverlap: boolean,
): SessionBarBoundary | undefined {
  const duration = timeframeSeconds(timeframe) * 1000;
  if (!Number.isSafeInteger(duration) || duration <= 0) return undefined;
  const windows = sessionWindowsAround(chartOpen, session, timezone);
  const containing = windows.find(({ start, end }) => chartOpen >= start && chartOpen < end);
  const window = containing ?? (allowOverlap ? windows.find(({ start }) => chartOpen < start && chartClose > start) : undefined);
  if (window === undefined) return undefined;
  const effective = Math.max(chartOpen, window.start);
  const open = window.start + Math.floor((effective - window.start) / duration) * duration;
  return open >= window.end ? undefined : { open, close: Math.min(open + duration, window.end) };
}

/** Offsets virtual bars across session gaps without loading future history. */
export function offsetSessionBar(
  bar: SessionBarBoundary,
  timeframe: string,
  barsBack: number,
  session: SessionSpec,
  timezone: string,
): SessionBarBoundary | undefined {
  if (barsBack === 0) return bar;
  const duration = timeframeSeconds(timeframe) * 1000;
  if (!Number.isSafeInteger(duration) || duration <= 0) return undefined;
  let remaining = Math.abs(barsBack);
  let current = bar;
  while (remaining > 0) {
    const windows = sessionWindowsAround(current.open, session, timezone);
    const index = windows.findIndex(({ start, end }) => current.open >= start && current.open < end);
    if (index < 0) return undefined;
    const window = windows[index]!;
    if (barsBack > 0) {
      const inWindow = Math.floor((current.open - window.start) / duration);
      if (remaining <= inWindow) {
        const open = current.open - remaining * duration;
        return { open, close: Math.min(open + duration, window.end) };
      }
      remaining -= inWindow + 1;
      const previous = windows[index - 1];
      if (!previous) return undefined;
      const open = previous.start + Math.floor((previous.end - previous.start - 1) / duration) * duration;
      current = { open, close: previous.end };
    } else {
      const inWindow = Math.floor((window.end - 1 - current.open) / duration);
      if (remaining <= inWindow) {
        const open = current.open + remaining * duration;
        return { open, close: Math.min(open + duration, window.end) };
      }
      remaining -= inWindow + 1;
      const next = windows[index + 1];
      if (!next) return undefined;
      current = { open: next.start, close: Math.min(next.start + duration, next.end) };
    }
  }
  return current;
}

/**
 * A calendar session bar spans the first opening and last closing window whose
 * trading dates belong to the requested D/W/M period. No market bars are
 * synthesized: the supplied chart bar only establishes period membership.
 */
export function calendarSessionBarAt(
  chartOpen: number,
  chartClose: number,
  timeframe: string,
  barsBack: number,
  session: SessionSpec,
  timezone: string,
  callName: "time" | "time_close" = "time",
): SessionBarBoundary | undefined {
  const calendar = calendarTimeframe(timeframe);
  if (calendar === undefined) return undefined;
  const matched = calendarSessionWindowAt(chartOpen, chartClose, session, timezone);
  if (matched === undefined) return undefined;

  const currentStart = alignToTimeframe(matched.tradingDate, timeframe, "UTC");
  assertCalendarSessionPeriodRange(currentStart, timeframe, callName);
  const periodStart = calendar.unit === "D" && calendar.multiplier < 7
    ? offsetSparseDayPeriods(currentStart, calendar.multiplier, barsBack, session, callName)
    : offsetTimeframe(currentStart, timeframe, barsBack, "UTC");
  assertCalendarSessionPeriodRange(periodStart, timeframe, callName);
  return calendarSessionPeriod(periodStart, timeframe, session, timezone);
}

function calendarSessionWindowAt(
  chartOpen: number,
  chartClose: number,
  session: SessionSpec,
  timezone: string,
): ZonedSessionWindow | undefined {
  const local = dateParts(chartOpen, timezone);
  const closeLocal = dateParts(Math.max(chartOpen, chartClose - 1), timezone);
  const localDay = Date.UTC(local.year, local.month - 1, local.day);
  const closeDay = Date.UTC(closeLocal.year, closeLocal.month - 1, closeLocal.day);
  const lastTradingOffset = Math.min(8, Math.max(1, Math.floor((closeDay - localDay) / 86_400_000) + 1));
  let containing: ZonedSessionWindow | undefined;
  let overlapping: ZonedSessionWindow | undefined;
  let firstOverlapDate: number | undefined;
  const earlier = (candidate: ZonedSessionWindow, prior: ZonedSessionWindow | undefined): boolean =>
    prior === undefined || candidate.start < prior.start || candidate.start === prior.start && candidate.end < prior.end;

  // A window on the next trading date can open on the preceding calendar
  // day. Inspect one following date before accepting the first overlap.
  for (let offset = -1; offset <= lastTradingOffset; offset += 1) {
    const tradingDate = Date.UTC(local.year, local.month - 1, local.day + offset);
    for (const window of sessionWindowsForTradingDate(tradingDate, session, timezone)) {
      if (chartOpen >= window.start && chartOpen < window.end && earlier(window, containing)) containing = window;
      if (chartOpen < window.start && chartClose > window.start && chartOpen < window.end && earlier(window, overlapping)) {
        overlapping = window;
        firstOverlapDate ??= offset;
      }
    }
    if (offset >= 1 && containing !== undefined) return containing;
    if (offset >= 1 && firstOverlapDate !== undefined && offset > firstOverlapDate) return overlapping;
  }
  return containing ?? overlapping;
}

/** A short D period can have no scheduled day; its seven-period mask repeats. */
function offsetSparseDayPeriods(
  start: number,
  daysPerPeriod: number,
  barsBack: number,
  session: SessionSpec,
  callName: "time" | "time_close",
): number {
  if (barsBack === 0) return start;
  const direction = barsBack > 0 ? -1 : 1;
  const periodMs = daysPerPeriod * 86_400_000;
  const occupied = (period: number): boolean => {
    for (let day = 0; day < daysPerPeriod; day += 1) {
      if (session.days.has(pineDay(new Date(period + day * 86_400_000).getUTCDay()))) return true;
    }
    return false;
  };
  let occupiedPerCycle = 0;
  for (let step = 1; step <= 7; step += 1) {
    if (occupied(start + direction * step * periodMs)) occupiedPerCycle += 1;
  }
  // Parsing guarantees a nonempty day mask. Seven D periods contain every
  // weekday even when each period contains fewer than seven days.
  if (occupiedPerCycle === 0) throw new PineRuntimeError("Calendar session contains no scheduled days", callName);
  const cycles = Math.floor((Math.abs(barsBack) - 1) / occupiedPerCycle);
  let period = start + direction * cycles * 7 * periodMs;
  let remaining = Math.abs(barsBack) - cycles * occupiedPerCycle;
  for (let step = 0; step < 7 && remaining > 0; step += 1) {
    period += direction * periodMs;
    if (occupied(period)) remaining -= 1;
  }
  return period;
}

function assertCalendarSessionPeriodRange(start: number, timeframe: string, callName: "time" | "time_close"): void {
  const end = timeframeEnd(start, timeframe, "UTC");
  const valid = (value: number): boolean => {
    if (!Number.isSafeInteger(value)) return false;
    const year = new Date(value).getUTCFullYear();
    return year >= 0 && year <= 9999;
  };
  if (!valid(start) || !valid(end) || end <= start) {
    throw new PineRuntimeError("Calendar session period is outside supported dates", callName);
  }
}

function calendarSessionPeriod(
  periodStart: number,
  timeframe: string,
  session: SessionSpec,
  timezone: string,
): SessionBarBoundary | undefined {
  const periodEnd = timeframeEnd(periodStart, timeframe, "UTC");
  let first: number | undefined;
  let last: number | undefined;
  // The session's windows repeat on every admitted trading date. Therefore
  // the first and last admitted dates own the period extremes; other dates
  // need no timezone conversion. A nonempty day mask occurs in each week.
  for (let day = periodStart; day < Math.min(periodEnd, periodStart + 7 * 86_400_000); day += 86_400_000) {
    if (!session.days.has(pineDay(new Date(day).getUTCDay()))) continue;
    const windows = sessionWindowsForTradingDate(day, session, timezone);
    if (windows.length === 0) continue;
    first = windows.reduce((earliest, window) => Math.min(earliest, window.start), Number.POSITIVE_INFINITY);
    break;
  }
  if (first === undefined) return undefined;
  for (let day = periodEnd - 86_400_000; day >= Math.max(periodStart, periodEnd - 7 * 86_400_000); day -= 86_400_000) {
    if (!session.days.has(pineDay(new Date(day).getUTCDay()))) continue;
    const windows = sessionWindowsForTradingDate(day, session, timezone);
    if (windows.length === 0) continue;
    last = windows.reduce((latest, window) => Math.max(latest, window.end), Number.NEGATIVE_INFINITY);
    break;
  }
  return last === undefined ? undefined : { open: first, close: last };
}

function sessionWindowsAround(timestamp: number, session: SessionSpec, timezone: string): ZonedSessionWindow[] {
  const local = dateParts(timestamp, timezone);
  const windows: ZonedSessionWindow[] = [];
  for (let offset = -8; offset <= 8; offset += 1) {
    windows.push(...sessionWindowsForTradingDate(Date.UTC(local.year, local.month - 1, local.day + offset), session, timezone));
  }
  return windows.sort((left, right) => left.start - right.start || left.end - right.end);
}

function sessionWindowsForTradingDate(tradingDateMs: number, session: SessionSpec, timezone: string): ZonedSessionWindow[] {
  const tradingDate = new Date(tradingDateMs);
  if (!session.days.has(pineDay(tradingDate.getUTCDay()))) return [];
  const windows: ZonedSessionWindow[] = [];
  for (const window of session.windows) {
    const start = zonedSessionBoundary(tradingDate, window.overnight ? -1 : 0, window.start, timezone);
    const end = zonedSessionBoundary(tradingDate, window.overnight ? 0 : window.end === 1_440 ? 1 : 0,
      window.end === 1_440 ? 0 : window.end, timezone);
    if (end > start) windows.push({ start, end, tradingDate: tradingDateMs });
  }
  return windows;
}

function zonedSessionBoundary(tradingDate: Date, dayOffset: number, minute: number, timezone: string): number {
  const date = new Date(Date.UTC(tradingDate.getUTCFullYear(), tradingDate.getUTCMonth(), tradingDate.getUTCDate() + dayOffset));
  // A local boundary can land in a DST spring gap. Use the first valid minute
  // after the gap; a fall fold uses the earlier occurrence.
  for (let advance = 0; advance <= 180; advance += 1) {
    const adjusted = new Date(date.getTime() + (minute + advance) * 60_000);
    try {
      return Number(strictPineTimestamp([timezone, adjusted.getUTCFullYear(), adjusted.getUTCMonth() + 1,
        adjusted.getUTCDate(), adjusted.getUTCHours(), adjusted.getUTCMinutes()], timezone));
    } catch (error) {
      if (!(error instanceof PineRuntimeError) || !error.message.includes("Local time does not exist")) throw error;
    }
  }
  throw new PineRuntimeError("Session boundary is unavailable in timezone", "time");
}

interface CompiledCorrectionWindow {
  readonly start: number;
  readonly end: number;
}

interface CompiledSessionCorrection {
  readonly key: string;
  readonly windows: readonly CompiledCorrectionWindow[];
}

export interface CompiledSessionCorrections {
  readonly byTradingDay: ReadonlyMap<string, CompiledSessionCorrection>;
}

export type SessionCorrectionCompileResult =
  | { readonly ok: true; readonly value: CompiledSessionCorrections }
  | { readonly ok: false; readonly reason: string };

export type SessionParseResult =
  | { readonly ok: true; readonly value: SessionSpec }
  | { readonly ok: false; readonly reason: string };

export function parseSessionSpec(session: string): SessionParseResult {
  const source = session.trim();
  if (source.length === 0) return { ok: false, reason: "session is empty" };
  if (source === "24x7") {
    return {
      ok: true,
      value: {
        windows: Object.freeze([{ start: 0, end: 1_440, overnight: false }]),
        days: new Set([1, 2, 3, 4, 5, 6, 7]),
      },
    };
  }

  const colon = source.indexOf(":");
  if (colon !== source.lastIndexOf(":")) return { ok: false, reason: "session has more than one day suffix" };
  const periodsSource = colon < 0 ? source : source.slice(0, colon);
  const daysSource = colon < 0 ? "1234567" : source.slice(colon + 1);
  if (!/^[1-7]+$/u.test(daysSource)) return { ok: false, reason: "session days must contain only digits 1 through 7" };

  const windows: SessionWindow[] = [];
  for (const period of periodsSource.split(",")) {
    const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/u.exec(period);
    if (match === null) return { ok: false, reason: `invalid session window '${period}'` };
    const startHour = Number.parseInt(match[1]!, 10);
    const startMinute = Number.parseInt(match[2]!, 10);
    const endHour = Number.parseInt(match[3]!, 10);
    const endMinute = Number.parseInt(match[4]!, 10);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
      return { ok: false, reason: `session window '${period}' is outside 00:00-23:59` };
    }
    const start = startHour * 60 + startMinute;
    const endsAtMidnight = endHour === 0 && endMinute === 0;
    const end = endsAtMidnight ? 1_440 : endHour * 60 + endMinute;
    windows.push(Object.freeze({
      start,
      end,
      overnight: start !== 0 && endsAtMidnight || start >= end,
    }));
  }
  if (windows.length === 0) return { ok: false, reason: "session contains no windows" };
  return {
    ok: true,
    value: {
      windows: Object.freeze(windows),
      days: new Set(Array.from(daysSource, (day) => Number.parseInt(day, 10))),
    },
  };
}

export function isInSession(timestamp: number, session: string, timezone: string, version?: 5 | 6): boolean {
  if (version === undefined) return legacySessionMatch(timestamp, session, timezone);
  const parsed = parseSessionSpec(session);
  return parsed.ok && isInSessionSpec(timestamp, parsed.value, timezone);
}

export function isInSessionSpec(timestamp: number, session: SessionSpec, timezone: string): boolean {
  return sessionTradingDayKey(timestamp, session, timezone) !== undefined;
}

export function sessionTradingDayKey(timestamp: number, session: SessionSpec, timezone: string): string | undefined {
  const parts = dateParts(timestamp, timezone);
  const minutes = parts.hour * 60 + parts.minute;
  const today = pineDay(parts.dayOfWeek);
  const tomorrow = today === 7 ? 1 : today + 1;
  for (const window of session.windows) {
    if (!window.overnight) {
      if (minutes >= window.start && minutes < window.end && session.days.has(today)) return calendarDayKey(parts);
      continue;
    }
    if (minutes >= window.start && session.days.has(tomorrow)) return calendarDayKey(parts, 1);
    const overnightEnd = window.end === 1_440 ? 0 : window.end;
    if (minutes < overnightEnd && session.days.has(today)) return calendarDayKey(parts);
  }
  return undefined;
}

export function compileSessionCorrections(
  corrections: readonly PineSessionCorrection[] | undefined,
): SessionCorrectionCompileResult {
  const byTradingDay = new Map<string, CompiledSessionCorrection>();
  for (const correction of corrections ?? []) {
    const tradingDay = correctionTradingDay(correction.tradingDay);
    if (tradingDay === undefined) return { ok: false, reason: `invalid trading day '${correction.tradingDay}'` };
    if (byTradingDay.has(correction.tradingDay)) return { ok: false, reason: `duplicate trading day '${correction.tradingDay}'` };
    const windows = compileCorrectionWindows(correction.session);
    if (!windows.ok) return windows;
    byTradingDay.set(correction.tradingDay, Object.freeze({
      key: tradingDay.key,
      windows: windows.value,
    }));
  }
  return {
    ok: true,
    value: Object.freeze({ byTradingDay }),
  };
}

/** Applies provider corrections before falling back to the recurring session. */
export function correctedSessionTradingDayKey(
  timestamp: number,
  session: SessionSpec,
  corrections: CompiledSessionCorrections,
  timezone: string,
): string | undefined {
  if (corrections.byTradingDay.size === 0) return sessionTradingDayKey(timestamp, session, timezone);
  const parts = dateParts(timestamp, timezone);
  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
  const localMinute = parts.hour * 60 + parts.minute;
  for (let tradingDayOffset = -1; tradingDayOffset <= 6; tradingDayOffset += 1) {
    const correction = corrections.byTradingDay.get(compactSerialDayKey(localDay + tradingDayOffset));
    if (correction === undefined) continue;
    const relativeMinute = -tradingDayOffset * 1_440 + localMinute;
    if (correction.windows.some((window) => relativeMinute >= window.start && relativeMinute < window.end)) return correction.key;
  }
  const defaultKey = sessionTradingDayKey(timestamp, session, timezone);
  if (defaultKey === undefined) return undefined;
  const compactKey = defaultKey.replaceAll("-", "");
  return corrections.byTradingDay.has(compactKey) ? undefined : defaultKey;
}

function legacySessionMatch(timestamp: number, session: string, timezone: string): boolean {
  const match = session.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (match === null) return true;
  const parts = dateParts(timestamp, timezone);
  const barTime = parts.hour * 60 + parts.minute;
  const start = Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
  const end = Number.parseInt(match[3]!, 10) * 60 + Number.parseInt(match[4]!, 10);
  return start <= end ? barTime >= start && barTime < end : barTime >= start || barTime < end;
}

function pineDay(dayOfWeek: number): number {
  return dayOfWeek === 0 ? 1 : dayOfWeek + 1;
}

function calendarDayKey(parts: DateParts, dayOffset = 0): string {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function correctionTradingDay(value: string): { readonly key: string } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (match === null) return undefined;
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return {
    key: `${match[1]}-${match[2]}-${match[3]}`,
  };
}

function compileCorrectionWindows(session: string): { readonly ok: true; readonly value: readonly CompiledCorrectionWindow[] } | { readonly ok: false; readonly reason: string } {
  if (session.trim().toLowerCase() === "24x7") return { ok: true, value: Object.freeze([{ start: 0, end: 1_440 }]) };
  const windows: CompiledCorrectionWindow[] = [];
  for (const period of session.split(",")) {
    const match = /^(\d{2})(\d{2})(?:F([1-6]))?-(\d{2})(\d{2})(?:F([1-6]))?$/u.exec(period.trim());
    if (match === null) return { ok: false, reason: `invalid correction window '${period.trim()}'` };
    const startHour = Number.parseInt(match[1]!, 10);
    const startMinute = Number.parseInt(match[2]!, 10);
    const endHour = Number.parseInt(match[4]!, 10);
    const endMinute = Number.parseInt(match[5]!, 10);
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
      return { ok: false, reason: `correction window '${period.trim()}' is outside 00:00-23:59` };
    }
    const startDayOffset = Number.parseInt(match[3] ?? "0", 10);
    const endDayOffset = Number.parseInt(match[6] ?? "0", 10);
    if (endDayOffset > startDayOffset) {
      return { ok: false, reason: `correction window '${period.trim()}' ends before its start day` };
    }
    const start = -(startDayOffset * 1_440) + startHour * 60 + startMinute;
    let end = -(endDayOffset * 1_440) + endHour * 60 + endMinute;
    if (endDayOffset === startDayOffset && end <= start) end += 1_440;
    windows.push(Object.freeze({ start, end }));
  }
  if (windows.length === 0) return { ok: false, reason: "correction contains no windows" };
  return { ok: true, value: Object.freeze(windows) };
}

function compactSerialDayKey(serialDay: number): string {
  const date = new Date(serialDay * 86_400_000);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function pineTimestamp(args: readonly PineValue[], defaultTimezone: string, strict = false): PineValue {
  if (strict) return strictPineTimestamp(args, defaultTimezone, true);
  if (args.length === 1 && typeof args[0] === "string") {
    const source = args[0].trim();
    if (/[Zz]$/.test(source) || /[+-]\d{2}:?\d{2}$/.test(source)) return new Date(source).getTime();
    const normalized = (source.includes("T") ? source : source.replace(/\s+/, "T")) + "Z";
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return timestampFromComponents(defaultTimezone, parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate(), parsed.getUTCHours(), parsed.getUTCMinutes(), parsed.getUTCSeconds());
    return new Date(source).getTime();
  }
  const hasTimezone = typeof args[0] === "string";
  const offset = hasTimezone ? 1 : 0;
  if (args[offset] === undefined || args[offset + 1] === undefined || args[offset + 2] === undefined) return Number.NaN;
  return timestampFromComponents(
    hasTimezone ? pineString(args[0]) : defaultTimezone,
    integerSigned(args[offset]),
    integerSigned(args[offset + 1]),
    integerSigned(args[offset + 2]),
    integerSigned(args[offset + 3] ?? 0),
    integerSigned(args[offset + 4] ?? 0),
    integerSigned(args[offset + 5] ?? 0),
  );
}

function strictPineTimestamp(args: readonly PineValue[], defaultTimezone: string, resolveDstTransitions = false): PineValue {
  if (args.length === 1 && typeof args[0] === "string") {
    const parsed = parsePineDateString(args[0]);
    if (!parsed.ok) throw new PineRuntimeError(parsed.message, "timestamp");
    return parsed.value;
  }
  const hasTimezone = typeof args[0] === "string";
  const offset = hasTimezone ? 1 : 0;
  const timezone = hasTimezone ? args[0] as string : defaultTimezone;
  if (!isValidTimezone(timezone)) throw new PineRuntimeError(`Invalid timezone: "${timezone}"`, "timestamp");
  const parts = Array.from({ length: 6 }, (_, index) => {
    const value = args[offset + index];
    if (value === undefined && index >= 3) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new PineRuntimeError(`Invalid ${["year", "month", "day", "hour", "minute", "second"][index]}: expected an integer`, "timestamp");
    }
    return value;
  });
  const [rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = parts as [number, number, number, number, number, number];
  // The reference platform normalizes out-of-range fields: 2024-02-30 is 2024-03-01 and
  // month 13 is January of the next year.
  const local = normalizedUtcDate(rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();
  const second = local.getUTCSeconds();
  if (!Number.isFinite(local.getTime()) || year < 0 || year > 9999) {
    throw new PineRuntimeError("Invalid calendar date or time", "timestamp");
  }
  const localMillis = local.getTime();
  const possibleOffsets = new Set<number>();
  for (const displacement of [-36, -12, 0, 12, 36]) {
    const sample = localMillis + displacement * 3_600_000;
    const sampleParts = dateParts(sample, timezone);
    const sampleDate = normalizedUtcDate(sampleParts.year, sampleParts.month, sampleParts.day,
      sampleParts.hour, sampleParts.minute, sampleParts.second);
    const sampleLocal = sampleDate.getTime();
    possibleOffsets.add(sampleLocal - sample);
  }
  const projections = [...possibleOffsets].map((zoneOffset) => localMillis - zoneOffset);
  const candidates = projections.filter((candidate) => {
      const actual = dateParts(candidate, timezone);
      return actual.year === year && actual.month === month && actual.day === day
        && actual.hour === hour && actual.minute === minute && actual.second === second;
    }).sort((left, right) => left - right);
  const exact = resolveDstTransitions ? candidates.at(-1) : candidates[0];
  if (exact !== undefined) return exact;
  // In a forward offset transition, the projection with the prior offset shifts
  // the nonexistent wall time forward by the gap while preserving its minutes.
  if (resolveDstTransitions && projections.length > 1) return Math.max(...projections);
  throw new PineRuntimeError("Local time does not exist in timezone", "timestamp");
}

function normalizedUtcDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  if (year < 0 || year >= 100) return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC adds 1900 to these years. Set the actual year before applying time overflow.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second);
  return date;
}

function integerSigned(value: PineValue | undefined): number {
  const numeric = number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function timestampFromComponents(timezone: string, year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const estimate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (year >= 0 && year < 100) estimate.setUTCFullYear(year);
  const normalized = timezone.trim();
  if (normalized === "UTC" || normalized === "GMT" || normalized === "Etc/UTC" || normalized.length === 0) return estimate.getTime();
  const offsetMinutes = timezoneOffsetMinutes(normalized);
  if (offsetMinutes !== undefined) {
    return estimate.getTime() - offsetMinutes * 60_000;
  }
  const interpreted = dateParts(estimate.getTime(), normalized);
  const interpretedTime = Date.UTC(interpreted.year, interpreted.month - 1, interpreted.day, interpreted.hour, interpreted.minute, interpreted.second);
  return estimate.getTime() - (interpretedTime - estimate.getTime());
}
