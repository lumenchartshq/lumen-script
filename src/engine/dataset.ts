import type { MarketBar } from "../contracts/index.js";
import { structurallyEqual } from "./value-equality.js";

/** Copy public market rows once at admission; price NaNs retain Pine na semantics. */
export function admitBars(bars: readonly MarketBar[], maxBars: number): readonly MarketBar[] {
  if (bars.length > maxBars) throw new Error(`Bar budget exceeded: ${bars.length} > ${maxBars}`);
  return Object.freeze(bars.map((bar, index) => {
    if (!Number.isFinite(bar.openTime) || (bar.closeTime !== undefined && !Number.isFinite(bar.closeTime))) {
      throw new Error("Bars must have finite openTime and closeTime values");
    }
    if (index > 0 && bar.openTime <= bars[index - 1]!.openTime) throw new Error("Bars must be strictly ordered by openTime");
    return Object.freeze({ ...bar });
  }));
}

/** Existing rows are already admitted and immutable; only copy new provider rows. */
export function appendBarDataset(previous: readonly MarketBar[], incoming: readonly MarketBar[], maxBars: number): readonly MarketBar[] {
  const length = previous.length + incoming.length;
  if (length > maxBars) throw new Error(`Bar budget exceeded: ${length} > ${maxBars}`);
  const admitted = admitBars(incoming, maxBars);
  const tail = previous.at(-1);
  const first = admitted[0];
  if (tail !== undefined && first !== undefined && first.openTime <= tail.openTime) throw new Error("Bars must be strictly ordered by openTime");
  return Object.freeze([...previous, ...admitted]);
}

export function replaceBarTail(previous: readonly MarketBar[], incoming: readonly MarketBar[], maxBars: number) {
  const firstTime = incoming[0]?.openTime;
  const found = firstTime === undefined ? -1 : previous.findIndex((bar) => bar.openTime >= firstTime);
  const fromIndex = found < 0 ? previous.length : found;
  const bars = appendBarDataset(previous.slice(0, fromIndex), incoming, maxBars);
  return { bars, fromIndex, tailChanged: bars.length !== previous.length || bars.at(-1)?.openTime !== previous.at(-1)?.openTime };
}

export function commonBarPrefix(left: readonly MarketBar[], right: readonly MarketBar[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && structurallyEqual(left[index], right[index])) index += 1;
  return index;
}
