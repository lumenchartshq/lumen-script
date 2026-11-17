import type { SymbolInfo } from "../contracts/index.js";

const CORE_STRING_FIELDS = [
  "ticker",
  "tickerid",
  "prefix",
  "root",
  "main_tickerid",
  "currency",
  "basecurrency",
  "timezone",
  "session",
  "type",
  "volumetype",
  "country",
  "current_contract",
  "description",
  "industry",
  "isin",
  "sector",
] as const;

const CORE_FLOAT_FIELDS = [
  "mintick", "pointvalue", "mincontract",
  "dividends_future_amount", "earnings_future_eps", "earnings_future_revenue",
] as const;
const CORE_INTEGER_FIELDS = ["minmove", "pricescale", "employees", "shareholders"] as const;
const FUTURE_TIME_FIELDS = [
  "dividends_future_ex_date", "dividends_future_pay_date",
  "earnings_future_period_end_time", "earnings_future_time",
] as const;

export function admitSessionSymbolInfo(
  value: SymbolInfo | undefined,
  strict: boolean,
): SymbolInfo | undefined {
  if (!strict || value === undefined) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid main symbol metadata: expected an object");
  }

  const source = value as Readonly<Record<string, unknown>>;
  for (const field of CORE_STRING_FIELDS) {
    const entry = source[field];
    if (entry !== undefined && typeof entry !== "string") {
      throw new Error(`Invalid main symbol metadata '${field}': expected a string`);
    }
  }
  for (const field of CORE_FLOAT_FIELDS) {
    const entry = source[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
      throw new Error(`Invalid main symbol metadata '${field}': expected a finite number`);
    }
  }
  for (const field of CORE_INTEGER_FIELDS) {
    const entry = source[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry))) {
      throw new Error(`Invalid main symbol metadata '${field}': expected a finite integer`);
    }
    if (entry !== undefined && (field === "employees" || field === "shareholders")
      && (entry < 0 || !Number.isSafeInteger(entry))) {
      throw new Error(`Invalid main symbol metadata '${field}': expected a nonnegative safe integer count`);
    }
  }
  for (const field of FUTURE_TIME_FIELDS) {
    const entry = source[field];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) {
      throw new Error(`Invalid main symbol metadata '${field}': expected a nonnegative safe integer Unix millisecond timestamp`);
    }
  }

  return Object.freeze({ ...value });
}
