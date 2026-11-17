/**
 * Supplied, synthetic-capable FX observations for the local UTC daily policy.
 * This is market data supplied by a host, not an exchange calendar or feed.
 */
export interface FxRateBookV1 {
  readonly version: 1;
  readonly provenance: string;
  readonly calendar: {
    /** Inclusive UTC dates in YYYY-MM-DD form. */
    readonly firstDate: string;
    readonly lastDate: string;
    /** ISO weekdays, Monday=1 through Sunday=7. */
    readonly weekdays: readonly number[];
    /** Full-day closures, within coverage and on scheduled weekdays. */
    readonly closures: readonly string[];
  };
  readonly pairs: readonly FxRatePairV1[];
}

export interface FxRatePairV1 {
  readonly symbolCurrency: string;
  readonly accountCurrency: string;
  /** Exactly one slot for each eligible date in declared coverage. */
  readonly slots: readonly FxRateSlotV1[];
}

export type FxRateSlotV1 =
  | { readonly date: string; readonly observedAt: number; readonly symbolToAccount: number }
  | { readonly date: string; readonly unavailable: true };

export interface NormalizedFxRateBookV1 {
  readonly version: 1;
  readonly provenance: string;
  readonly calendar: FxRateBookV1["calendar"];
  readonly pairs: readonly FxRatePairV1[];
  /** Collision-free canonical content identity, including observations and calendar. */
  readonly fingerprint: string;
  /** Internal indexed projection; callers must not construct this shape themselves. */
  readonly lookup: Readonly<Record<string, readonly (FxRateSlotV1 | undefined)[]>>;
  readonly precedingEligibleIndex: readonly number[];
}

export type FxRateSelection =
  | { readonly mode: "historical"; readonly timeframe: "intraday" | "daily" | "higher"; readonly barOpen: number; readonly barEndExclusive: number }
  | { readonly mode: "realtime"; readonly evaluatedAt: number };

export type FxRateSelectionResult =
  | { readonly kind: "identity"; readonly rate: 1 }
  | { readonly kind: "rate"; readonly rate: number; readonly date: string; readonly observedAt: number }
  | { readonly kind: "unavailable"; readonly reason: "before-coverage" | "outside-coverage" | "explicit-unavailable" | "no-previous-session" }
  | { readonly kind: "missing-pair" }
  | { readonly kind: "missing-currency" };

export const FX_RATE_BOOK_LIMITS = Object.freeze({
  pairs: 8,
  calendarDays: 4_096,
  closures: 256,
  slots: 32_768,
  canonicalBytes: 1_048_576,
  provenanceLength: 128,
} as const);

const DAY_MS = 86_400_000;
// Currency constants include USDT; hosts may also supply other bounded quote tokens.
const CURRENCY = /^[A-Z][A-Z0-9]{1,7}$/u;
const PROVENANCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;

/** Validates limits before cloning, sorts semantically unordered fields and freezes owned data. */
export function normalizeFxRateBook(source: unknown): NormalizedFxRateBookV1 {
  const book = record(source, "FX book");
  if (book.version !== 1) throw new Error("Unsupported FX book version");
  const provenance = book.provenance;
  if (typeof provenance !== "string" || provenance.length < 1 || provenance.length > FX_RATE_BOOK_LIMITS.provenanceLength
    || !PROVENANCE.test(provenance)) throw new Error("Invalid FX provenance");
  const calendar = record(book.calendar, "FX calendar");
  const firstDay = parseDate(calendar.firstDate, "firstDate");
  const lastDay = parseDate(calendar.lastDate, "lastDate");
  const dayCount = lastDay - firstDay + 1;
  if (dayCount < 1 || dayCount > FX_RATE_BOOK_LIMITS.calendarDays) throw new Error("FX calendar span exceeds limit");
  if (!Array.isArray(calendar.weekdays) || calendar.weekdays.length < 1 || calendar.weekdays.length > 7) {
    throw new Error("FX weekdays must be a nonempty ISO weekday mask");
  }
  const weekdays = calendar.weekdays as unknown[];
  const weekdaySet = new Set<number>();
  for (const weekday of weekdays) {
    if (!Number.isInteger(weekday) || (weekday as number) < 1 || (weekday as number) > 7 || weekdaySet.has(weekday as number)) {
      throw new Error("Invalid or duplicate FX weekday");
    }
    weekdaySet.add(weekday as number);
  }
  if (!Array.isArray(calendar.closures) || calendar.closures.length > FX_RATE_BOOK_LIMITS.closures) {
    throw new Error("FX closures exceed limit");
  }
  const closures = calendar.closures as unknown[];
  const closureSet = new Set<number>();
  for (const value of closures) {
    const day = parseDate(value, "closure");
    if (day < firstDay || day > lastDay || !weekdaySet.has(isoWeekday(day)) || closureSet.has(day)) {
      throw new Error("FX closure is outside coverage, unscheduled or duplicate");
    }
    closureSet.add(day);
  }
  if (!Array.isArray(book.pairs) || book.pairs.length < 1 || book.pairs.length > FX_RATE_BOOK_LIMITS.pairs) {
    throw new Error("FX pair count exceeds limit");
  }
  const pairsInput = book.pairs as unknown[];
  const eligibleDates: string[] = [];
  const precedingEligibleIndex: number[] = [];
  let previous = -1;
  for (let index = 0; index < dayCount; index += 1) {
    precedingEligibleIndex.push(previous);
    const day = firstDay + index;
    if (weekdaySet.has(isoWeekday(day)) && !closureSet.has(day)) {
      eligibleDates.push(formatDate(day));
      previous = index;
    }
  }
  if (eligibleDates.length === 0) throw new Error("FX calendar has no eligible sessions");
  if (eligibleDates.length * pairsInput.length > FX_RATE_BOOK_LIMITS.slots) throw new Error("FX slots exceed limit");
  const normalizedCalendar = Object.freeze({
    firstDate: formatDate(firstDay), lastDate: formatDate(lastDay),
    weekdays: Object.freeze([...weekdaySet].sort((a, b) => a - b)),
    closures: Object.freeze([...closureSet].sort((a, b) => a - b).map(formatDate)),
  });

  // Count the exact compact canonical encoding before any per-pair copies.
  let canonicalBytes = "fx:1:".length + JSON.stringify([provenance, normalizedCalendar, []]).length;
  const pairKeys = new Set<string>();
  for (let pairIndex = 0; pairIndex < pairsInput.length; pairIndex += 1) {
    const candidate = pairsInput[pairIndex];
    const pair = record(candidate, "FX pair");
    const symbolCurrency = currency(pair.symbolCurrency);
    const accountCurrency = currency(pair.accountCurrency);
    if (symbolCurrency === accountCurrency) throw new Error("FX rates cannot be supplied for an identity pair");
    const key = pairKey(symbolCurrency, accountCurrency);
    if (pairKeys.has(key)) throw new Error("Duplicate FX pair");
    pairKeys.add(key);
    if (!Array.isArray(pair.slots) || pair.slots.length !== eligibleDates.length) {
      throw new Error("FX pair must contain every eligible dated slot");
    }
    canonicalBytes += JSON.stringify([symbolCurrency, accountCurrency, []]).length + Number(pairIndex > 0);
    const seen = new Set<string>();
    for (let slotIndex = 0; slotIndex < pair.slots.length; slotIndex += 1) {
      const candidateSlot: unknown = pair.slots[slotIndex];
      const slot = record(candidateSlot, "FX slot");
      const date = slot.date;
      const day = parseDate(date, "slot date");
      if (day < firstDay || day > lastDay || !weekdaySet.has(isoWeekday(day)) || closureSet.has(day)) {
        throw new Error("Misdated FX slot");
      }
      if (seen.has(date as string)) throw new Error("Duplicate FX slot date");
      seen.add(date as string);
      if (slot.unavailable === true) {
        if ("observedAt" in slot || "symbolToAccount" in slot) throw new Error("Unavailable FX slot cannot carry a rate");
        canonicalBytes += JSON.stringify([date, null]).length + Number(slotIndex > 0);
        if (canonicalBytes > FX_RATE_BOOK_LIMITS.canonicalBytes) throw new Error("FX canonical content exceeds byte limit");
        continue;
      }
      if ("unavailable" in slot) throw new Error("Invalid FX unavailable marker");
      if (!Number.isSafeInteger(slot.observedAt) || typeof slot.symbolToAccount !== "number"
        || !Number.isFinite(slot.symbolToAccount) || slot.symbolToAccount <= 0) throw new Error("Invalid FX observation");
      const start = day * DAY_MS;
      const observedAt = slot.observedAt as number;
      if (observedAt < start || observedAt >= start + DAY_MS) throw new Error("FX observation is outside its daily slot or after cutoff");
      canonicalBytes += JSON.stringify([date, observedAt, slot.symbolToAccount]).length + Number(slotIndex > 0);
      if (canonicalBytes > FX_RATE_BOOK_LIMITS.canonicalBytes) throw new Error("FX canonical content exceeds byte limit");
    }
  }

  const normalizedPairs: FxRatePairV1[] = [];
  const lookup = Object.create(null) as Record<string, readonly (FxRateSlotV1 | undefined)[]>;
  for (const candidate of pairsInput) {
    const pair = candidate as FxRatePairV1;
    const symbolCurrency = currency(pair.symbolCurrency);
    const accountCurrency = currency(pair.accountCurrency);
    const slots = pair.slots.map((slot): FxRateSlotV1 => "unavailable" in slot
      ? Object.freeze({ date: slot.date, unavailable: true })
      : Object.freeze({ date: slot.date, observedAt: slot.observedAt, symbolToAccount: slot.symbolToAccount }));
    slots.sort((left, right) => left.date.localeCompare(right.date));
    for (let index = 0; index < slots.length; index += 1) {
      if (slots[index]?.date !== eligibleDates[index]) throw new Error("FX pair must contain every eligible dated slot");
    }
    const normalized = Object.freeze({ symbolCurrency, accountCurrency, slots: Object.freeze(slots) });
    normalizedPairs.push(normalized);
  }
  normalizedPairs.sort((left, right) => pairKey(left.symbolCurrency, left.accountCurrency).localeCompare(pairKey(right.symbolCurrency, right.accountCurrency)));
  for (const pair of normalizedPairs) {
    const indexed: (FxRateSlotV1 | undefined)[] = Array.from({ length: dayCount });
    for (const slot of pair.slots) indexed[parseDate(slot.date, "slot date") - firstDay] = slot;
    lookup[pairKey(pair.symbolCurrency, pair.accountCurrency)] = Object.freeze(indexed);
  }
  const fingerprint = `fx:1:${JSON.stringify([provenance, normalizedCalendar,
    normalizedPairs.map((pair) => [pair.symbolCurrency, pair.accountCurrency,
      pair.slots.map((slot) => "unavailable" in slot
        ? [slot.date, null]
        : [slot.date, slot.observedAt, slot.symbolToAccount])])])}`;
  if (fingerprint.length > FX_RATE_BOOK_LIMITS.canonicalBytes) throw new Error("FX canonical content exceeds byte limit");
  return Object.freeze({
    version: 1, provenance, calendar: normalizedCalendar, pairs: Object.freeze(normalizedPairs), fingerprint,
    lookup: Object.freeze(lookup), precedingEligibleIndex: Object.freeze(precedingEligibleIndex),
  });
}

/** Selects once per owning primary bar; magnifier fills reuse the returned rate. */
export function selectFxRate(
  book: NormalizedFxRateBookV1 | undefined,
  symbolCurrency: string | undefined,
  accountCurrency: string | undefined,
  selection: FxRateSelection,
): FxRateSelectionResult {
  if (symbolCurrency === undefined || accountCurrency === undefined
    || symbolCurrency.trim().length === 0 || accountCurrency.trim().length === 0
    || symbolCurrency.trim().toUpperCase() === "NONE" || accountCurrency.trim().toUpperCase() === "NONE") {
    return { kind: "missing-currency" };
  }
  const symbol = currency(symbolCurrency);
  const account = currency(accountCurrency);
  if (symbol === account) return { kind: "identity", rate: 1 };
  if (book === undefined || book.version !== 1) return { kind: "missing-pair" };
  const slots = book.lookup[pairKey(symbol, account)];
  if (slots === undefined) return { kind: "missing-pair" };
  const anchor = selection.mode === "realtime"
    ? utcDay(selection.evaluatedAt)
    : utcDay(selection.timeframe === "higher" ? selection.barEndExclusive - 1 : selection.barOpen);
  if (selection.mode === "historical") {
    validTimestamp(selection.barOpen);
    validTimestamp(selection.barEndExclusive);
    if (selection.barEndExclusive <= selection.barOpen) throw new Error("FX bar end must be exclusive and after open");
  }
  const first = parseDate(book.calendar.firstDate, "firstDate");
  const last = parseDate(book.calendar.lastDate, "lastDate");
  if (anchor < first) return { kind: "unavailable", reason: "before-coverage" };
  if (anchor > last) return { kind: "unavailable", reason: "outside-coverage" };
  const previousIndex = book.precedingEligibleIndex[anchor - first];
  if (previousIndex === undefined || previousIndex < 0) return { kind: "unavailable", reason: "no-previous-session" };
  const slot = slots[previousIndex];
  if (slot === undefined || "unavailable" in slot) return { kind: "unavailable", reason: "explicit-unavailable" };
  return { kind: "rate", rate: slot.symbolToAccount, date: slot.date, observedAt: slot.observedAt };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function currency(value: unknown): string {
  if (typeof value !== "string" || value.length > 16) throw new Error("Invalid FX currency");
  const normalized = value.trim().toUpperCase();
  if (!CURRENCY.test(normalized) || normalized === "NONE") throw new Error("Invalid FX currency");
  return normalized;
}

function pairKey(symbol: string, account: string): string {
  return `${symbol}/${account}`;
}

function parseDate(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`Invalid FX ${label}`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error(`Invalid FX ${label}`);
  return time / DAY_MS;
}

function formatDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isoWeekday(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7 + 1;
}

function validTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error("Invalid FX timestamp");
}

function utcDay(value: number): number {
  validTimestamp(value);
  return Math.floor(value / DAY_MS);
}
