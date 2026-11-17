import type { MarketBar, PineSessionSchedule, LumenChartsTickerIdentityV1, LumenChartsTickerTransform } from "../contracts/index.js";
import { compileSessionCorrections, correctedSessionTradingDayKey, parseSessionSpec } from "../runtime/index.js";

export interface AppliedTickerDataset {
  readonly bars: readonly MarketBar[];
  readonly sessionSchedule: PineSessionSchedule;
}

/** Applies only transformations derivable from the admitted OHLCV/session dataset. */
export function applyLumenChartsTickerIdentity(
  bars: readonly MarketBar[],
  identity: LumenChartsTickerIdentityV1,
  schedule: PineSessionSchedule,
): AppliedTickerDataset {
  assertProviderIndependentModifiers(identity);
  const selected = selectSession(bars, identity.session, schedule);
  return {
    bars: identity.transform === undefined ? selected.bars : transformBars(selected.bars, identity.transform),
    sessionSchedule: selected.sessionSchedule,
  };
}

export function lumenChartsTickerWarmup(identity: LumenChartsTickerIdentityV1 | undefined): number {
  const transform = identity?.transform;
  if (transform === undefined || transform.kind === "heikinashi" || transform.kind === "kagi") return 1;
  if (transform.kind === "linebreak") return transform.lines;
  if (transform.style === "atr") return Math.trunc(transform.param) + 1;
  return 1;
}

function assertProviderIndependentModifiers(identity: LumenChartsTickerIdentityV1): void {
  if (identity.adjustment === "splits" || identity.adjustment === "dividends") {
    throw new Error(`ticker adjustment '${identity.adjustment}' requires an authorized corporate-actions provider`);
  }
  if (identity.backadjustment === "on") {
    throw new Error("ticker backadjustment requires an authorized futures-roll provider");
  }
  if (identity.settlementAsClose === "on") {
    throw new Error("ticker settlement_as_close requires settlement prices that are absent from the OHLCV contract");
  }
}

function selectSession(
  bars: readonly MarketBar[],
  requested: string | undefined,
  schedule: PineSessionSchedule,
): AppliedTickerDataset {
  if (requested === undefined) return { bars, sessionSchedule: schedule };
  const normalized = requested.toLowerCase();
  const selection = normalized === "regular"
    ? { spec: schedule.regularSession, corrections: schedule.corrections?.regularSession, subsession: "regular" }
    : normalized === "extended"
      ? schedule.extendedSession === undefined
        ? undefined
        : { spec: schedule.extendedSession, corrections: schedule.corrections?.extendedSession, subsession: "extended" }
      : { spec: requested, corrections: undefined, subsession: requested };
  if (selection === undefined) throw new Error("ticker session 'extended' requires an explicit extended-session schedule");
  const parsed = parseSessionSpec(selection.spec);
  if (!parsed.ok) throw new Error(`Invalid ticker session '${requested}': ${parsed.reason}`);
  const corrections = compileSessionCorrections(selection.corrections);
  if (!corrections.ok) throw new Error(`Invalid ticker session corrections: ${corrections.reason}`);
  const timezone = schedule.timezone ?? "UTC";
  const filtered = Object.freeze(bars.filter((bar) => (
    correctedSessionTradingDayKey(bar.openTime, parsed.value, corrections.value, timezone) !== undefined
  )));
  return {
    bars: filtered,
    sessionSchedule: Object.freeze({
      ...schedule,
      activeSession: selection.spec,
      activeSubsessionId: selection.subsession,
    }),
  };
}

function transformBars(bars: readonly MarketBar[], transform: LumenChartsTickerTransform): readonly MarketBar[] {
  switch (transform.kind) {
    case "heikinashi": return heikinAshi(bars);
    case "renko": return renko(bars, transform);
    case "kagi": return kagi(bars, transform.reversal);
    case "linebreak": return lineBreak(bars, transform.lines);
    case "pointfigure": return pointFigure(bars, transform);
  }
}

function heikinAshi(bars: readonly MarketBar[]): readonly MarketBar[] {
  const output: MarketBar[] = [];
  let previousOpen = Number.NaN;
  let previousClose = Number.NaN;
  for (const bar of bars) {
    if (!finitePrices(bar)) {
      output.push(freezeBar(bar, Number.NaN, Number.NaN, Number.NaN, Number.NaN));
      continue;
    }
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const open = Number.isFinite(previousOpen) && Number.isFinite(previousClose)
      ? (previousOpen + previousClose) / 2
      : (bar.open + bar.close) / 2;
    output.push(freezeBar(bar, open, Math.max(bar.high, open, close), Math.min(bar.low, open, close), close));
    previousOpen = open;
    previousClose = close;
  }
  return Object.freeze(output);
}

function renko(bars: readonly MarketBar[], transform: Extract<LumenChartsTickerTransform, { readonly kind: "renko" }>): readonly MarketBar[] {
  const output: MarketBar[] = [];
  const sizes = boxSizes(bars, transform.style, transform.param);
  let anchor = Number.NaN;
  let direction: -1 | 0 | 1 = 0;
  for (const [index, bar] of bars.entries()) {
    const size = sizes[index]!;
    if (!finitePrices(bar) || !Number.isFinite(size)) continue;
    if (!Number.isFinite(anchor)) {
      anchor = bar.close;
      continue;
    }
    const high = transform.source === "ohlc" ? bar.high : bar.close;
    const low = transform.source === "ohlc" ? bar.low : bar.close;
    const up = Math.floor((high - anchor) / size);
    const down = Math.floor((anchor - low) / size);
    let bricks = 0;
    if (direction >= 0 && up >= 1) bricks = up;
    else if (direction <= 0 && down >= 1) bricks = -down;
    else if (direction === 1 && down >= 2) bricks = -down;
    else if (direction === -1 && up >= 2) bricks = up;
    if (bricks === 0) continue;
    const open = anchor;
    anchor = rounded(anchor + bricks * size);
    direction = bricks > 0 ? 1 : -1;
    const wickHigh = transform.requestWicks ? bar.high : Math.max(open, anchor);
    const wickLow = transform.requestWicks ? bar.low : Math.min(open, anchor);
    output.push(freezeBar(bar, open, Math.max(open, anchor, wickHigh), Math.min(open, anchor, wickLow), anchor));
  }
  return Object.freeze(output);
}

function lineBreak(bars: readonly MarketBar[], lines: number): readonly MarketBar[] {
  const output: MarketBar[] = [];
  for (const bar of bars) {
    if (!finitePrices(bar)) continue;
    if (output.length === 0) {
      output.push(freezeBar(bar, bar.open, Math.max(bar.open, bar.close), Math.min(bar.open, bar.close), bar.close));
      continue;
    }
    const window = output.slice(-lines);
    const high = Math.max(...window.map((entry) => entry.high));
    const low = Math.min(...window.map((entry) => entry.low));
    if (bar.close <= high && bar.close >= low) continue;
    const open = output.at(-1)!.close;
    output.push(freezeBar(bar, open, Math.max(open, bar.close), Math.min(open, bar.close), bar.close));
  }
  return Object.freeze(output);
}

function kagi(bars: readonly MarketBar[], reversal: number): readonly MarketBar[] {
  const output: MarketBar[] = [];
  let extreme = Number.NaN;
  let direction: -1 | 0 | 1 = 0;
  for (const bar of bars) {
    if (!finitePrices(bar)) continue;
    if (!Number.isFinite(extreme)) {
      extreme = bar.close;
      output.push(freezeBar(bar, bar.open, Math.max(bar.open, bar.close), Math.min(bar.open, bar.close), bar.close));
      continue;
    }
    const previous = extreme;
    if ((direction >= 0 && bar.close > extreme) || (direction === 0 && bar.close >= extreme + reversal)) {
      extreme = bar.close;
      direction = 1;
    } else if ((direction <= 0 && bar.close < extreme) || (direction === 0 && bar.close <= extreme - reversal)) {
      extreme = bar.close;
      direction = -1;
    } else if (direction === 1 && bar.close <= extreme - reversal) {
      extreme = bar.close;
      direction = -1;
    } else if (direction === -1 && bar.close >= extreme + reversal) {
      extreme = bar.close;
      direction = 1;
    } else continue;
    output.push(freezeBar(bar, previous, Math.max(previous, extreme), Math.min(previous, extreme), extreme));
  }
  return Object.freeze(output);
}

function pointFigure(bars: readonly MarketBar[], transform: Extract<LumenChartsTickerTransform, { readonly kind: "pointfigure" }>): readonly MarketBar[] {
  const output: MarketBar[] = [];
  const sizes = boxSizes(bars, transform.style, transform.param);
  let anchor = Number.NaN;
  let direction: -1 | 0 | 1 = 0;
  for (const [index, bar] of bars.entries()) {
    const size = sizes[index]!;
    if (!finitePrices(bar) || !Number.isFinite(size)) continue;
    if (!Number.isFinite(anchor)) {
      anchor = bar.close;
      continue;
    }
    const high = transform.source === "hl" ? bar.high : bar.close;
    const low = transform.source === "hl" ? bar.low : bar.close;
    const up = Math.floor((high - anchor) / size);
    const down = Math.floor((anchor - low) / size);
    let boxes = 0;
    if (direction >= 0 && up >= 1) boxes = up;
    else if (direction <= 0 && down >= 1) boxes = -down;
    else if (direction === 1 && down >= transform.reversal) boxes = -down;
    else if (direction === -1 && up >= transform.reversal) boxes = up;
    if (boxes === 0) continue;
    const open = anchor;
    anchor = rounded(anchor + boxes * size);
    direction = boxes > 0 ? 1 : -1;
    output.push(freezeBar(bar, open, Math.max(open, anchor), Math.min(open, anchor), anchor));
  }
  return Object.freeze(output);
}

function boxSizes(bars: readonly MarketBar[], style: "atr" | "traditional", param: number): readonly number[] {
  if (style === "traditional") return Object.freeze(bars.map(() => param));
  const length = Math.trunc(param);
  const output: number[] = [];
  const ranges: number[] = [];
  let sum = 0;
  for (const [index, bar] of bars.entries()) {
    if (!finitePrices(bar)) {
      output.push(Number.NaN);
      continue;
    }
    const previousClose = bars[index - 1]?.close;
    const range = previousClose === undefined || !Number.isFinite(previousClose)
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    ranges.push(range);
    sum += range;
    if (ranges.length > length) sum -= ranges.shift()!;
    output.push(ranges.length === length && sum > 0 ? sum / length : Number.NaN);
  }
  return Object.freeze(output);
}

function finitePrices(bar: MarketBar): boolean {
  return Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close);
}

function freezeBar(source: MarketBar, open: number, high: number, low: number, close: number): MarketBar {
  return Object.freeze({ ...source, open: rounded(open), high: rounded(high), low: rounded(low), close: rounded(close) });
}

function rounded(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1_000_000_000_000) / 1_000_000_000_000 : value;
}
