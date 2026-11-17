import type { MarketBar, PineValue } from "../contracts/index.js";
import { timeframeEnd } from "../runtime/index.js";
import { normalizeEngineTimeframe } from "./request-context-policy.js";

export function alignRequestValues(
  parentBars: readonly MarketBar[],
  parentTimeframe: string,
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  childTimeframe: string,
  lookahead: boolean,
  gaps: boolean,
  strictCompatibility: boolean,
  now: number,
  parentTimezone: string,
  childTimezone: string,
): readonly PineValue[] {
  if (strictCompatibility) return alignSuppliedRequestValues(
    parentBars, parentTimeframe, childBars, values, childTimeframe, lookahead, gaps, now, parentTimezone, childTimezone,
  );
  const result: PineValue[] = [];
  let searchIndex = 0;
  let previousSelected: number | undefined;
  const childDuration = timeframeDurationMs(childTimeframe);
  const parentDuration = timeframeDurationMs(parentTimeframe);
  if (childDuration < parentDuration) return alignLowerRequestValues(
    parentBars,
    parentTimeframe,
    childBars,
    values,
    childTimeframe,
    lookahead,
    gaps,
    parentTimezone,
    childTimezone,
    strictCompatibility,
  );
  for (const [parentIndex, parent] of parentBars.entries()) {
    while (searchIndex < childBars.length) {
      const child = childBars[searchIndex]!;
      const childClose = barCloseTime(child, childTimeframe, childTimezone, strictCompatibility);
      if (parent.openTime < childClose) break;
      searchIndex += 1;
    }
    const child = childBars[searchIndex];
    if (child === undefined || parent.openTime < child.openTime) { result.push(Number.NaN); continue; }
    const childClose = barCloseTime(child, childTimeframe, childTimezone, strictCompatibility);
    const parentClose = barCloseTime(parent, parentTimeframe, parentTimezone, strictCompatibility);
    const selected = lookahead || (strictCompatibility ? parentClose > now : parentIndex === parentBars.length - 1) || parentClose >= childClose
      ? searchIndex
      : searchIndex - 1;
    if (selected < 0) { result.push(Number.NaN); continue; }
    if (gaps) {
      if (parentIndex === 0 || previousSelected === selected) result.push(Number.NaN);
      else result.push(values[selected] ?? Number.NaN);
      previousSelected = selected;
    } else result.push(values[selected] ?? Number.NaN);
  }
  return Object.freeze(result);
}

function alignSuppliedRequestValues(
  parentBars: readonly MarketBar[],
  parentTimeframe: string,
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  childTimeframe: string,
  lookahead: boolean,
  gaps: boolean,
  now: number,
  parentTimezone: string,
  childTimezone: string,
): readonly PineValue[] {
  const childDuration = timeframeDurationMs(childTimeframe);
  const parentDuration = timeframeDurationMs(parentTimeframe);
  if (childDuration < parentDuration) return alignSuppliedLowerValues(
    parentBars, parentTimeframe, childBars, values, childTimeframe, lookahead, gaps, now, parentTimezone, childTimezone,
  );
  const result: PineValue[] = [];
  let searchIndex = 0;
  let previousSelected: number | undefined;
  for (const parent of parentBars) {
    if (parent.openTime > now) { result.push(Number.NaN); continue; }
    const parentClose = barCloseTime(parent, parentTimeframe, parentTimezone, true);
    while (searchIndex < childBars.length && barCloseTime(childBars[searchIndex]!, childTimeframe, childTimezone, true) <= parent.openTime) {
      searchIndex += 1;
    }
    const current = childBars[searchIndex];
    const currentClose = current === undefined ? Number.NaN : barCloseTime(current, childTimeframe, childTimezone, true);
    const coversParent = current !== undefined && current.openTime <= parent.openTime && current.openTime <= now && parent.openTime < currentClose;
    let selected: number | undefined;
    let freshSelection = false;
    const parentIsForming = parentClose > now;
    const historicalLookahead = lookahead && !parentIsForming;
    if (coversParent && (parentIsForming || currentClose <= parentClose
      || (lookahead && (currentClose <= now || childDuration > parentDuration)))) selected = searchIndex;
    if (selected !== undefined) freshSelection = true;
    if (selected === undefined && searchIndex > 0) {
      const previous = childBars[searchIndex - 1]!;
      const previousClose = barCloseTime(previous, childTimeframe, childTimezone, true);
      if (previousClose <= Math.min(parentClose, now)) selected = searchIndex - 1;
    }
    if (selected === undefined) { result.push(Number.NaN); continue; }
    const selectedClose = barCloseTime(childBars[selected]!, childTimeframe, childTimezone, true);
    result.push(gaps && (!freshSelection || (selectedClose > now && !historicalLookahead) || selected === previousSelected)
      ? Number.NaN : values[selected] ?? Number.NaN);
    previousSelected = selected;
  }
  return Object.freeze(result);
}

function alignSuppliedLowerValues(
  parentBars: readonly MarketBar[],
  parentTimeframe: string,
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  childTimeframe: string,
  lookahead: boolean,
  gaps: boolean,
  now: number,
  parentTimezone: string,
  childTimezone: string,
): readonly PineValue[] {
  const result: PineValue[] = [];
  let previousConfirmed: PineValue = Number.NaN;
  for (const parent of parentBars) {
    if (parent.openTime > now) { result.push(Number.NaN); continue; }
    const parentClose = barCloseTime(parent, parentTimeframe, parentTimezone, true);
    const available: number[] = [];
    const start = lowerBoundTime(childBars, parent.openTime);
    const end = lowerBoundTime(childBars, parentClose);
    for (let index = start; index < end; index++) {
      const child = childBars[index]!;
      if (child.openTime <= now && barCloseTime(child, childTimeframe, childTimezone, true) > parent.openTime) available.push(index);
    }
    const selected = lookahead ? available[0] : available.at(-1);
    if (selected === undefined) { result.push(gaps ? Number.NaN : previousConfirmed); continue; }
    const value = values[selected] ?? Number.NaN;
    const confirmed = barCloseTime(childBars[selected]!, childTimeframe, childTimezone, true) <= now;
    if (confirmed) previousConfirmed = value;
    result.push(gaps && !confirmed ? Number.NaN : value);
  }
  return Object.freeze(result);
}

function alignLowerRequestValues(
  parentBars: readonly MarketBar[],
  parentTimeframe: string,
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  childTimeframe: string,
  lookahead: boolean,
  gaps: boolean,
  parentTimezone: string,
  childTimezone: string,
  strictCompatibility: boolean,
): readonly PineValue[] {
  const arrays = alignLowerRequestArrays(
    parentBars,
    parentTimeframe,
    childBars,
    values,
    childTimeframe,
    0,
    parentTimezone,
    childTimezone,
    strictCompatibility,
  );
  return Object.freeze(arrays.map((value, parentIndex) => {
    const entries = value as readonly PineValue[];
    if (entries.length === 0) return Number.NaN;
    if (lookahead && gaps) return entries[0] ?? Number.NaN;
    if (lookahead && parentIndex === parentBars.length - 1) return entries[0] ?? Number.NaN;
    return entries.at(-1) ?? Number.NaN;
  }));
}

export function alignLowerRequestArrays(
  parentBars: readonly MarketBar[],
  parentTimeframe: string,
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  childTimeframe: string,
  tupleArity: number,
  parentTimezone = "UTC",
  childTimezone = "UTC",
  strictCompatibility = false,
  now = Number.POSITIVE_INFINITY,
): readonly PineValue[] {
  const closes = childBars.map((child) => barCloseTime(child, childTimeframe, childTimezone, strictCompatibility));
  return Object.freeze(parentBars.map((parent) => {
    if (strictCompatibility && parent.openTime > now) return transposeLowerRequestTuple([], tupleArity);
    const parentClose = barCloseTime(parent, parentTimeframe, parentTimezone, strictCompatibility);
    const start = lowerBoundTime(childBars, parent.openTime);
    const end = lowerBoundTime(childBars, parentClose);
    const entries: PineValue[] = [];
    for (let index = start; index < end; index++) {
      if (closes[index]! > parent.openTime && (!strictCompatibility || childBars[index]!.openTime <= now)) entries.push(values[index] ?? Number.NaN);
    }
    return transposeLowerRequestTuple(entries, tupleArity);
  }));
}

function barCloseTime(bar: MarketBar, timeframe: string, timezone: string, calendarAware: boolean): number {
  if (bar.closeTime !== undefined) return bar.closeTime;
  return calendarAware
    ? timeframeEnd(bar.openTime, timeframe, timezone)
    : bar.openTime + timeframeDurationMs(timeframe);
}

export function wrapLowerRequestValues(values: readonly PineValue[], tupleArity: number): readonly PineValue[] {
  return Object.freeze(values.map((value) => transposeLowerRequestTuple([value], tupleArity)));
}

/** Direct same-context mapping keeps available primary rows independent of gaps. */
export function alignSameContextRequestValues(
  parentBars: readonly MarketBar[],
  childBars: readonly MarketBar[],
  values: readonly PineValue[],
  tupleArity: number | undefined,
  now: number,
): readonly PineValue[] {
  const childIndexByTime = new Map(childBars.map((bar, index) => [bar.openTime, index]));
  const alignedValues = tupleArity === undefined ? values : wrapLowerRequestValues(values, tupleArity);
  const missing = tupleArity === undefined ? Number.NaN : transposeLowerRequestTuple([], tupleArity);
  return Object.freeze(parentBars.map((parent) => {
    if (parent.openTime > now) return missing;
    const index = childIndexByTime.get(parent.openTime);
    return index === undefined || index >= alignedValues.length ? missing : alignedValues[index]!;
  }));
}

function transposeLowerRequestTuple(entries: readonly PineValue[], tupleArity: number): PineValue {
  if (tupleArity === 0) return Object.freeze([...entries]);
  return Object.freeze(Array.from({ length: tupleArity }, (_, component) => Object.freeze(entries.map((entry) => {
    if (!Array.isArray(entry)) return Number.NaN;
    return (entry as readonly PineValue[])[component] ?? Number.NaN;
  }))));
}

function timeframeDurationMs(timeframe: string): number {
  const normalized = normalizeEngineTimeframe(timeframe);
  if (normalized.endsWith("S")) return (Number.parseInt(normalized, 10) || 1) * 1000;
  if (normalized.endsWith("D")) return (Number.parseInt(normalized, 10) || 1) * 86_400_000;
  if (normalized.endsWith("W")) return (Number.parseInt(normalized, 10) || 1) * 604_800_000;
  if (normalized.endsWith("M")) return (Number.parseInt(normalized, 10) || 1) * 2_592_000_000;
  return (Number.parseInt(normalized, 10) || 1) * 60_000;
}

/** Independent bounds retain semantics for irregular and overlapping parent intervals. */
function lowerBoundTime(bars: readonly MarketBar[], time: number): number {
  let low = 0, high = bars.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle]!.openTime < time) low = middle + 1;
    else high = middle;
  }
  return low;
}
