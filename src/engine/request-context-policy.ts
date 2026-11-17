import type { PineSessionSchedule, PineValue, SymbolInfo } from "../contracts/index.js";
import { compileSessionCorrections } from "../runtime/index.js";

const SYMBOL_INFO_STRING_FIELDS = [
  "ticker", "tickerid", "main_tickerid", "prefix", "root", "description", "type", "currency",
  "basecurrency", "country", "current_contract", "industry", "isin", "sector", "timezone", "session", "subsession_id", "volumetype",
] as const;
const SYMBOL_INFO_NUMBER_FIELDS = ["employees", "mincontract", "minmove", "mintick", "pointvalue", "pricescale", "shareholders"] as const;
const SESSION_CORRECTION_FIELDS = [
  "activeSession", "regularSession", "extendedSession", "premarketSession", "postmarketSession",
] as const;

export function requestSelectorValue(defaultValue: string, inputId: string | undefined, inputTitle: string | undefined, inputs: Readonly<Record<string, PineValue>>): string {
  const value = inputId !== undefined && Object.hasOwn(inputs, inputId) ? inputs[inputId] : inputTitle === undefined ? undefined : inputs[inputTitle];
  return typeof value === "string" ? value : defaultValue;
}

export function normalizeEngineTimeframe(timeframe: string): string {
  const value = timeframe.trim();
  const calendar = value.match(/^(\d+)([DWM])$/);
  if (calendar !== null) return calendar[1] === "1" ? calendar[2]! : value;
  if (["1", "3", "5", "15", "30", "45", "60", "120", "180", "240", "D", "W", "M"].includes(value)) return value;
  const mapped: Readonly<Record<string, string>> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "45m": "45",
    "1h": "60", "2h": "120", "3h": "180", "4h": "240", "1d": "D", "1w": "W", "1M": "M",
  };
  return mapped[value] ?? mapped[value.toLowerCase()] ?? value.toUpperCase();
}

export function requestTimeframeRank(timeframe: string, strictCompatibility: boolean): number {
  if (strictCompatibility) return validTimeframeSeconds(normalizeEngineTimeframe(timeframe));
  return ["1", "3", "5", "15", "30", "45", "60", "120", "180", "240", "D", "W", "M"].indexOf(normalizeEngineTimeframe(timeframe));
}

function validTimeframeSeconds(timeframe: string): number {
  if (/^\d+$/.test(timeframe)) {
    const minutes = Number.parseInt(timeframe, 10);
    return minutes >= 1 && minutes <= 1_440 ? minutes * 60 : -1;
  }
  const match = timeframe.match(/^(\d+)?([SDWM])$/);
  if (match === null) return -1;
  const multiplier = Number.parseInt(match[1] ?? "1", 10);
  const unit = match[2]!;
  if (unit === "S") return [1, 5, 10, 15, 30, 45].includes(multiplier) ? multiplier : -1;
  if (unit === "D") return multiplier >= 1 && multiplier <= 365 ? multiplier * 86_400 : -1;
  if (unit === "W") return multiplier >= 1 && multiplier <= 52 ? multiplier * 604_800 : -1;
  return multiplier >= 1 && multiplier <= 12 ? multiplier * 2_592_000 : -1;
}

export function sessionTimezone(
  explicitTimezone: string | undefined,
  symbolInfo: SymbolInfo | undefined,
  fallback = "UTC",
): string {
  if (typeof explicitTimezone === "string" && explicitTimezone.length > 0) return explicitTimezone;
  return typeof symbolInfo?.timezone === "string" && symbolInfo.timezone.length > 0 ? symbolInfo.timezone : fallback;
}

export function requestContextIdentity(
  symbol: string,
  timeframe: string,
  symbolInfo: SymbolInfo | undefined,
  sessionSchedule: PineSessionSchedule,
): string {
  const symbolIdentity = symbolInfo === undefined ? null : Object.entries(symbolInfo).map(([field, value]) => [
    field,
    typeof value === "number" && Object.is(value, -0) ? "-0" : value,
  ]);
  return JSON.stringify([
    symbol,
    normalizeEngineTimeframe(timeframe),
    symbolIdentity,
    sessionScheduleIdentity(sessionSchedule),
  ]);
}

function sessionScheduleIdentity(schedule: PineSessionSchedule): readonly unknown[] {
  const correctionEntries = schedule.corrections === undefined ? [] : SESSION_CORRECTION_FIELDS.flatMap((field) => {
    const entries = schedule.corrections?.[field];
    if (entries === undefined || entries.length === 0) return [];
    const identityEntries = entries.map((entry) => [entry.tradingDay, entry.session] as const);
    if (compileSessionCorrections(entries).ok) identityEntries.sort(compareCorrectionIdentity);
    return [[field, identityEntries]];
  });
  return [
    schedule.activeSession,
    schedule.activeSubsessionId ?? null,
    schedule.regularSession,
    schedule.extendedSession ?? null,
    schedule.premarketSession ?? null,
    schedule.postmarketSession ?? null,
    schedule.timezone ?? null,
    correctionEntries.length === 0 ? null : correctionEntries,
  ];
}

function compareCorrectionIdentity(left: readonly [string, string], right: readonly [string, string]): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? -1 : 1;
}

export function normalizeChildSymbolInfo(value: unknown): SymbolInfo | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid child symbol metadata: expected an object");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const normalized: Record<string, string | number> = {};
  for (const field of SYMBOL_INFO_STRING_FIELDS) {
    const entry = source[field];
    if (entry === undefined) continue;
    if (typeof entry !== "string") throw new Error(`Invalid child symbol metadata '${field}': expected a string`);
    normalized[field] = entry;
  }
  for (const field of SYMBOL_INFO_NUMBER_FIELDS) {
    const entry = source[field];
    if (entry === undefined) continue;
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`Invalid child symbol metadata '${field}': expected a finite number`);
    normalized[field] = entry;
  }
  return Object.keys(normalized).length === 0 ? undefined : Object.freeze(normalized);
}
