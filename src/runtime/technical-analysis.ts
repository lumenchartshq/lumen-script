import type { PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { integer, number, pineString, taValue } from "./values.js";

export type StateId = number | string;

function childId(id: StateId, child: number): StateId {
  return `${String(id)}:${String(child)}`;
}

interface SmaState {
  readonly values: number[];
  sum: number;
}

interface EmaState {
  readonly seed: number[];
  value: number;
  length: number;
}

interface PresentSampleState {
  values: number[];
  bars: number[];
  observations: number;
}

/** Upper bound on retained present samples; TA lengths are capped at 5000. */
const MAX_PRESENT_SAMPLES = 5_000;

export type PresentWindowStatistic = "sma" | "variance" | "sampleVariance" | "range" | "highest" | "lowest" | "median";

interface WindowState {
  readonly values: number[];
}

interface PercentileSample {
  readonly slot: number;
  readonly value: number;
}

interface PercentileState {
  readonly samples: number[];
  nextSample: number;
  ranked: PercentileSample[];
  nextRankSlot: number;
}

function replacePercentileSample(state: PercentileState, value: number): void {
  const slot = state.nextRankSlot;
  const ranked = state.ranked;
  state.nextRankSlot = (slot + 1) % ranked.length;
  const expiredIndex = ranked.findIndex((entry) => entry.slot === slot);
  const expired = ranked[expiredIndex]!;
  if (value === expired.value) return;
  ranked.splice(expiredIndex, 1);

  // Missing values compare false and can leave the rank order nonmonotonic.
  const movesLeft = value < expired.value;
  let rank = movesLeft ? 0 : expiredIndex;
  const end = movesLeft ? expiredIndex : ranked.length;
  while (rank < end && !(value < ranked[rank]!.value)) rank += 1;
  ranked.splice(rank, 0, { slot, value });
}

function extendPercentileWindow(state: PercentileState, value: number): void {
  const previousLength = state.ranked.length;
  // Growing by one retains every ranked sample. Rebase the old slots so
  // the next replacement still expires the oldest sample.
  const ranked = state.ranked.map((sample) => ({
    slot: (sample.slot - state.nextRankSlot + previousLength) % previousLength,
    value: sample.value,
  }));
  const rank = ranked.findIndex((sample) => value < sample.value);
  ranked.splice(rank < 0 ? previousLength : rank, 0, { slot: previousLength, value });
  state.ranked = ranked;
  state.nextRankSlot = 0;
}

interface BooleanWindowState {
  readonly values: boolean[];
}

interface RmaState {
  readonly seed: number[];
  value: number;
  length: number;
}

interface PairState {
  left: number;
  right: number;
}

interface BarCountState {
  count: number;
}

interface SupertrendState {
  lower: number;
  upper: number;
  trend: number;
  direction: number;
  atrReady?: boolean;
}

interface SarState {
  result: number;
  extreme: number;
  acceleration: number;
  below: boolean;
}

interface StrictSarState extends SarState {
  recentHighs: number[];
  recentLows: number[];
  previousClose: number;
}

interface StrictSarSeedState {
  readonly recentHighs: number[];
  readonly recentLows: number[];
  previousClose: number;
}

interface VwapState {
  tradingDay: number;
  priceVolume: number;
  volume: number;
}

interface VwapBandsState extends VwapState {
  origin: number;
  shiftedPriceVolume: number;
  shiftedPriceSquaredVolume: number;
}

interface PivotPeriod {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PivotPointState {
  current: PivotPeriod | undefined;
  completed: PivotPeriod | undefined;
}

export abstract class TechnicalAnalysisRuntime {
  public abstract barIndex: number;
  protected readonly callState = new Map<StateId, unknown>();

  public abstract data(name: string, offset?: number): PineValue;
  public abstract truthy(value: PineValue): boolean;

  protected sma(id: StateId, args: readonly PineValue[]): PineValue {
    const value = number(args[0]);
    const length = Math.max(1, integer(args[1] ?? 1));
    let state = this.callState.get(id) as SmaState | undefined;
    if (state === undefined) {
      state = { values: [], sum: 0 };
      this.callState.set(id, state);
    }
    state.values.push(value);
    const values = state.values.slice(-length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    return values.reduce((sum, entry) => sum + entry, 0) / length;
  }

  protected ema(id: StateId, args: readonly PineValue[], ignoreMissing = false): PineValue {
    const source = number(args[0]);
    const length = Math.max(1, integer(args[1] ?? 1));
    let state = this.callState.get(id) as EmaState | undefined;
    if (state === undefined || state.length !== length) {
      state = { seed: [], value: Number.NaN, length };
      this.callState.set(id, state);
    }
    if (ignoreMissing && Number.isNaN(source)) return state.value;
    if (Number.isNaN(state.value)) {
      if (Number.isNaN(source)) return Number.NaN;
      state.seed.push(source);
      if (state.seed.length < length) return Number.NaN;
      state.value = state.seed.reduce((sum, value) => sum + value, 0) / length;
      return state.value;
    }
    state.value = (source - state.value) * (2 / (length + 1)) + state.value;
    return state.value;
  }

  protected window(id: StateId, value: number, length: number): readonly number[] {
    let state = this.callState.get(id) as WindowState | undefined;
    if (state === undefined) {
      state = { values: [] };
      this.callState.set(id, state);
    }
    state.values.push(value);
    return state.values.slice(-length);
  }

  /**
   * The last `length` non-na samples and the bars they came from. Production
   * window functions such as ta.sma, ta.stdev and ta.highest skip na samples
   * and evaluate over the last `length` values that exist, as the reference platform does.
   */
  protected presentSamples(id: StateId, value: number, length: number): { readonly values: readonly number[]; readonly bars: readonly number[]; readonly observations: number } {
    let state = this.callState.get(id) as PresentSampleState | undefined;
    if (state === undefined) {
      state = { values: [], bars: [], observations: 0 };
      this.callState.set(id, state);
    }
    state.observations = Math.min(state.observations + 1, MAX_PRESENT_SAMPLES);
    if (!Number.isNaN(value)) {
      state.values.push(value);
      state.bars.push(this.barIndex);
      const excess = state.values.length - MAX_PRESENT_SAMPLES;
      if (excess > 0) {
        state.values.splice(0, excess);
        state.bars.splice(0, excess);
      }
    }
    return { values: state.values.slice(-length), bars: state.bars.slice(-length), observations: state.observations };
  }

  /** Production ta.sma, ta.variance/stdev, ta.range, ta.highest/lowest and ta.median over present samples. */
  protected presentWindowStatistic(id: StateId, args: readonly PineValue[], statistic: PresentWindowStatistic): PineValue {
    const implicitSource = args.length === 1 && (statistic === "highest" || statistic === "lowest");
    const source = implicitSource ? number(this.data(statistic === "highest" ? "high" : "low")) : number(args[0]);
    const length = Math.max(1, integer(implicitSource ? args[0]! : args[1] ?? 1));
    const { values, observations } = this.presentSamples(id, source, length);
    const extreme = statistic === "highest" || statistic === "lowest";
    if (extreme ? observations < length || values.length === 0 : values.length < length) return Number.NaN;
    switch (statistic) {
      case "sma": return values.reduce((sum, value) => sum + value, 0) / length;
      case "highest": return Math.max(...values);
      case "lowest": return Math.min(...values);
      case "range": return Math.max(...values) - Math.min(...values);
      case "median": {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(length / 2);
        return length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
      }
      case "variance":
      case "sampleVariance": {
        const average = values.reduce((sum, value) => sum + value, 0) / length;
        const squares = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
        if (statistic === "variance") return squares / length;
        return length < 2 ? Number.NaN : squares / (length - 1);
      }
    }
  }

  /** Production ta.highestbars/ta.lowestbars: bar offset of the extreme among the last present samples. */
  protected presentExtremeOffset(id: StateId, args: readonly PineValue[], highest: boolean): PineValue {
    const length = Math.max(1, integer(args[1] ?? args[0] ?? 1));
    const source = args.length === 1 ? number(this.data(highest ? "high" : "low")) : number(args[0]);
    const { values, bars, observations } = this.presentSamples(id, source, length);
    if (observations < length || values.length === 0) return Number.NaN;
    // Scan newest first so the most recent sample wins a tie.
    let selected = values.length - 1;
    for (let index = values.length - 2; index >= 0; index -= 1) {
      if (highest ? values[index]! > values[selected]! : values[index]! < values[selected]!) selected = index;
    }
    return bars[selected]! - this.barIndex;
  }

  protected rma(id: StateId, args: readonly PineValue[]): PineValue {
    return this.rmaValue(id, number(args[0]), Math.max(1, integer(args[1] ?? 1)));
  }

  protected rmaValue(id: StateId, source: number, length: number): PineValue {
    let state = this.callState.get(id) as RmaState | undefined;
    if (state === undefined || state.length !== length) {
      state = { seed: [], value: Number.NaN, length };
      this.callState.set(id, state);
    }
    if (Number.isNaN(source)) return state.value;
    if (Number.isNaN(state.value)) {
      state.seed.push(source);
      if (state.seed.length < length) return Number.NaN;
      state.value = state.seed.reduce((sum, value) => sum + value, 0) / length;
    } else {
      state.value = (source + (length - 1) * state.value) / length;
    }
    return state.value;
  }

  protected wma(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const source = number(args[0]);
    let values: readonly number[];
    if (strict) {
      const inputId = childId(id, 1_000_000);
      let input = this.callState.get(inputId) as { previous: number; count: number } | undefined;
      if (input === undefined) {
        input = { previous: Number.NaN, count: 0 };
        this.callState.set(inputId, input);
      }
      if (!Number.isNaN(source)) {
        input.previous = source;
        input.count = Math.min(input.count + 1, MAX_PRESENT_SAMPLES);
      }
      // Carry the last input through a gap for weighting, but count only present inputs for readiness.
      values = this.presentSamples(id, input.previous, length).values;
      if (input.count < length) return Number.NaN;
    } else {
      values = this.window(id, source, length);
    }
    if (Number.isNaN(source) || values.length < length || values.some(Number.isNaN)) return Number.NaN;
    let numerator = 0;
    let denominator = 0;
    for (const [index, value] of values.entries()) {
      const weight = index + 1;
      numerator += value * weight;
      denominator += weight;
    }
    return numerator / denominator;
  }

  protected vwma(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const source = number(args[0]);
    const volume = number(this.data("volume"));
    const product = source * volume;
    // The reference platform counts price-volume products and chart volume independently.
    const values = strict ? this.presentSamples(id, product, length).values : this.window(id, product, length);
    const volumes = this.window(childId(id, 1_000_000), volume, length);
    if (values.length < length || volumes.length < length) return Number.NaN;
    const denominator = volumes.reduce((sum, value) => sum + value, 0);
    if (strict && denominator === 0) return Number.NaN;
    return values.reduce((sum, value) => sum + value, 0) / denominator;
  }

  protected alma(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const offset = number(args[2] ?? 0.85);
    const sigma = number(args[3] ?? 6);
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const exactCenter = offset * (length - 1);
    const center = strict && args[4] === true ? Math.floor(exactCenter) : exactCenter;
    const width = length / sigma;
    let weighted = 0;
    let weightSum = 0;
    for (const [index, value] of values.entries()) {
      const weight = Math.exp(-((index - center) ** 2) / (2 * width ** 2));
      weighted += value * weight;
      weightSum += weight;
    }
    return weighted / weightSum;
  }

  protected hma(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const half = Math.max(1, Math.floor(length / 2));
    const root = Math.max(1, Math.floor(Math.sqrt(length)));
    const fast = this.wma(childId(id, 1), [args[0] ?? Number.NaN, half], strict);
    const slow = this.wma(childId(id, 2), [args[0] ?? Number.NaN, length], strict);
    const raw = strict ? 2 * number(fast) - number(slow) : 2 * number(taValue(fast)) - number(taValue(slow));
    return this.wma(childId(id, 3), [raw, root], strict);
  }

  protected swma(id: StateId, args: readonly PineValue[]): PineValue {
    const values = this.window(id, number(args[0]), 4);
    if (values.length < 4 || values.some(Number.isNaN)) return Number.NaN;
    return (values[0]! + 2 * values[1]! + 2 * values[2]! + values[3]!) / 6;
  }

  protected linearRegression(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const offset = number(args[2] ?? 0);
    const values = this.window(id, number(args[0]), length);
    if (length === 1 || values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const sumX = length * (length - 1) / 2;
    const sumY = values.reduce((sum, value) => sum + value, 0);
    const sumXY = values.reduce((sum, value, index) => sum + index * value, 0);
    const sumXX = (length - 1) * length * (2 * length - 1) / 6;
    const slope = (length * sumXY - sumX * sumY) / (length * sumXX - sumX ** 2);
    const intercept = (sumY - slope * sumX) / length;
    return intercept + slope * (length - 1 - offset);
  }

  protected change(id: StateId, args: readonly PineValue[], preserveBooleanKind = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    if (preserveBooleanKind && typeof args[0] === "boolean") {
      let state = this.callState.get(id) as BooleanWindowState | undefined;
      if (state === undefined) {
        state = { values: [] };
        this.callState.set(id, state);
      }
      state.values.push(args[0]);
      const values = state.values.slice(-(length + 1));
      return values.length <= length ? false : values[values.length - 1] !== values[0];
    }
    const values = this.window(id, number(args[0]), length + 1);
    return values.length <= length ? Number.NaN : values[values.length - 1]! - values[0]!;
  }

  protected roc(id: StateId, args: readonly PineValue[], rejectZeroDenominator = false): PineValue {
    const source = number(args[0]);
    const changed = number(this.change(id, args));
    const previous = source - changed;
    return Number.isNaN(changed) || (rejectZeroDenominator && previous === 0)
      ? Number.NaN
      : 100 * changed / previous;
  }

  protected extreme(
    id: StateId,
    args: readonly PineValue[],
    reducer: (...values: number[]) => number,
    implicitSource: "high" | "low",
  ): PineValue {
    const sourceAtZero = args.length === 1 ? number(this.data(implicitSource)) : number(args[0]);
    const length = Math.max(1, integer(args.length === 1 ? args[0]! : args[1] ?? 1));
    const values = this.window(id, sourceAtZero, length).filter((value) => !Number.isNaN(value));
    return values.length < length ? Number.NaN : reducer(...values);
  }

  protected extremeOffset(
    id: StateId,
    args: readonly PineValue[],
    highest: boolean,
    normalizeCurrentOffset = false,
  ): PineValue {
    const length = Math.max(1, integer(args[1] ?? args[0] ?? 1));
    const source = args.length === 1 ? number(this.data(highest ? "high" : "low")) : number(args[0]);
    const values = this.window(id, source, length);
    if (values.length < length) return Number.NaN;
    let selected = highest ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    let offset = Number.NaN;
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const value = values[index]!;
      if (Number.isNaN(value)) continue;
      if (Number.isNaN(offset) || (highest ? value > selected : value < selected)) {
        selected = value;
        const distance = values.length - 1 - index;
        offset = normalizeCurrentOffset && distance === 0 ? 0 : -distance;
      }
    }
    return offset;
  }

  protected variance(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const average = values.reduce((sum, value) => sum + value, 0) / length;
    return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / length;
  }

  protected deviation(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const average = values.reduce((sum, value) => sum + value, 0) / length;
    return values.reduce((sum, value) => sum + Math.abs(value - average), 0) / length;
  }

  protected median(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = [...this.window(id, number(args[0]), length)];
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    values.sort((left, right) => left - right);
    const middle = Math.floor(length / 2);
    return length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
  }

  protected mode(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const source = number(args[0]);
    const values = strict ? this.presentSamples(id, source, length).values : this.window(id, source, length);
    if (values.length < length) return Number.NaN;
    const counts = new Map<number, number>();
    for (const value of values) if (!Number.isNaN(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    let selected = Number.NaN;
    let frequency = -1;
    for (const [value, count] of counts) {
      if (count > frequency || (count === frequency && value < selected)) {
        selected = value;
        frequency = count;
      }
    }
    return selected;
  }

  protected cci(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const average = values.reduce((sum, value) => sum + value, 0) / length;
    const deviation = values.reduce((sum, value) => sum + Math.abs(value - average), 0) / length;
    return deviation === 0 ? 0 : (values.at(-1)! - average) / (0.015 * deviation);
  }

  protected cmo(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const source = number(args[0]);
    if (strict) {
      const previous = (this.callState.get(id) as number | undefined) ?? Number.NaN;
      this.callState.set(id, source);
      const change = source - previous;
      // A missing change contributes zero to the gain sum and na to the loss
      // sum. The two sums advance independently over present samples.
      const gains = number(this.movingSum(childId(id, 1), [change >= 0 ? change : 0, length], MAX_PRESENT_SAMPLES));
      const losses = number(this.movingSum(childId(id, 2), [change >= 0 ? 0 : -change, length], MAX_PRESENT_SAMPLES));
      return 100 * (gains - losses) / (gains + losses);
    }
    const values = this.window(id, source, length + 1);
    if (values.length < length + 1 || values.some(Number.isNaN)) return Number.NaN;
    let gains = 0;
    let losses = 0;
    for (let index = 1; index < values.length; index += 1) {
      const change = values[index]! - values[index - 1]!;
      if (change >= 0) gains += change;
      else losses -= change;
    }
    const denominator = gains + losses;
    return denominator === 0 ? 0 : 100 * (gains - losses) / denominator;
  }

  protected cog(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    const sum = values.reduce((total, value) => total + value, 0);
    if (sum === 0) return Number.NaN;
    let numerator = 0;
    for (let offset = 0; offset < length; offset += 1) numerator += values[length - 1 - offset]! * (offset + 1);
    return -numerator / sum;
  }

  protected correlation(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[2] ?? 1));
    if (strict) {
      const x = number(args[0]);
      const y = number(args[1]);
      const left = this.presentSamples(childId(id, 1), x, length).values;
      const right = this.presentSamples(childId(id, 2), y, length).values;
      const products = this.presentSamples(childId(id, 3), x * y, length).values;
      if (left.length < length || right.length < length || products.length < length) return Number.NaN;
      const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / length;
      const xMean = mean(left);
      const yMean = mean(right);
      const variance = (values: readonly number[], average: number) =>
        values.reduce((sum, value) => sum + value * value, 0) / length - average * average;
      const denominator = Math.sqrt(variance(left, xMean) * variance(right, yMean));
      const covariance = mean(products) - xMean * yMean;
      if (covariance === 0) return 0;
      return denominator === 0 ? Number.NaN : covariance / denominator;
    }
    const left = this.window(childId(id, 1), number(args[0]), length);
    const right = this.window(childId(id, 2), number(args[1]), length);
    if (left.length < length || right.length < length) return Number.NaN;
    const pairs = left.map((value, index) => [value, right[index]!] as const).filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));
    if (pairs.length < 2) return Number.NaN;
    const count = pairs.length;
    const sumX = pairs.reduce((sum, [x]) => sum + x, 0);
    const sumY = pairs.reduce((sum, [, y]) => sum + y, 0);
    const sumXY = pairs.reduce((sum, [x, y]) => sum + x * y, 0);
    const sumX2 = pairs.reduce((sum, [x]) => sum + x * x, 0);
    const sumY2 = pairs.reduce((sum, [, y]) => sum + y * y, 0);
    const xVariance = count * sumX2 - sumX ** 2;
    const yVariance = count * sumY2 - sumY ** 2;
    return xVariance <= 0 || yVariance <= 0 ? 0 : (count * sumXY - sumX * sumY) / Math.sqrt(xVariance * yVariance);
  }

  protected rankCorrelationIndex(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(2, integer(args[1] ?? 2));
    const source = number(args[0]);
    const values = this.window(id, source, length);
    const resultId = childId(id, 1);
    if (strict && Number.isNaN(source)) return (this.callState.get(resultId) as number | undefined) ?? Number.NaN;
    if (values.length < length || (!strict && values.some(Number.isNaN))) return Number.NaN;
    const priceRanks = averageRanks(strict ? values.map((value) => Number.isNaN(value) ? 0 : value) : values);
    const timeMean = (length - 1) / 2;
    const priceMean = priceRanks.reduce((sum, value) => sum + value, 0) / length;
    let covariance = 0;
    let timeVariance = 0;
    let priceVariance = 0;
    for (let index = 0; index < length; index += 1) {
      const timeDelta = index - timeMean;
      const priceDelta = priceRanks[index]! - priceMean;
      covariance += timeDelta * priceDelta;
      timeVariance += timeDelta ** 2;
      priceVariance += priceDelta ** 2;
    }
    const denominator = Math.sqrt(timeVariance * priceVariance);
    const result = denominator === 0 ? 0 : 100 * covariance / denominator;
    if (strict) this.callState.set(resultId, result);
    return result;
  }

  protected runningExtreme(id: StateId, args: readonly PineValue[], highest: boolean): PineValue {
    const source = number(args[0]);
    const previous = this.callState.get(id) as number | undefined;
    if (Number.isNaN(source)) return previous ?? Number.NaN;
    const value = previous === undefined ? source : highest ? Math.max(previous, source) : Math.min(previous, source);
    this.callState.set(id, value);
    return value;
  }

  protected pivotPointLevels(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const type = normalizePivotType(pineString(args[0] ?? ""));
    const anchor = this.truthy(args[1] ?? false);
    const developing = this.truthy(args[2] ?? false);
    if (developing && type === "woodie") {
      throw new PineRuntimeError("Developing Woodie pivot points are not supported", "ta.pivot_point_levels");
    }
    const bar = pivotPeriodFromData(this);
    let state = this.callState.get(id) as PivotPointState | undefined;
    if (state === undefined) state = { current: undefined, completed: undefined };
    if (anchor && state.current !== undefined) {
      state.completed = state.current;
      state.current = bar;
    } else if (state.current === undefined) {
      state.current = bar;
    } else {
      state.current.high = Math.max(state.current.high, bar.high);
      state.current.low = Math.min(state.current.low, bar.low);
      state.current.close = bar.close;
    }
    this.callState.set(id, state);
    if (developing) return calculatePivotLevels(type, state.current, state.current.open, strict);
    if (state.completed === undefined) return Array.from({ length: 11 }, () => Number.NaN);
    return calculatePivotLevels(type, state.completed, state.current.open, strict);
  }

  protected stochastic(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[3] ?? 1));
    const highs = this.window(childId(id, 1), number(args[1]), length);
    const lows = this.window(childId(id, 2), number(args[2]), length);
    const source = number(args[0]);
    if (strict && Number.isNaN(source)) return (this.callState.get(id) as number | undefined) ?? Number.NaN;
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const result = highs.length < length || lows.length < length || high === low
      ? Number.NaN : 100 * (source - low) / (high - low);
    if (strict) this.callState.set(id, result);
    return result;
  }

  protected williamsPercentRange(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[0] ?? 1));
    const highs = this.window(childId(id, 1), number(this.data("high")), length);
    const lows = this.window(childId(id, 2), number(this.data("low")), length);
    if (highs.length < length || lows.length < length) return Number.NaN;
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    return high === low ? 0 : -100 * (high - number(this.data("close"))) / (high - low);
  }

  protected percentRank(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length + 1);
    const current = values.at(-1)!;
    if (strict) {
      return values.length < length + 1
        ? Number.NaN : 100 * values.slice(0, -1).filter((value) => value <= current).length / length;
    }
    if (values.length < length + 1 || Number.isNaN(current)) return Number.NaN;
    const history = values.slice(0, -1).filter((value) => !Number.isNaN(value));
    return history.length === 0 ? Number.NaN : 100 * history.filter((value) => value <= current).length / history.length;
  }

  protected percentile(id: StateId, args: readonly PineValue[], interpolate: boolean): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const percentage = number(args[2] ?? 50);
    const values = [...this.window(id, number(args[0]), length)];
    if (values.length < length || (interpolate && values.some(Number.isNaN))) return Number.NaN;
    const valid = values.filter((value) => !Number.isNaN(value)).sort((left, right) => left - right);
    if (valid.length === 0) return Number.NaN;
    if (!interpolate) {
      const index = Math.max(0, Math.min(valid.length - 1, Math.ceil(percentage / 100 * valid.length) - 1));
      return valid[index]!;
    }
    const position = Math.max(0, Math.min(valid.length - 1, percentage / 100 * valid.length - 0.5));
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return valid[lower]! + (position - lower) * (valid[upper]! - valid[lower]!);
  }

  protected strictPercentile(id: StateId, args: readonly PineValue[], interpolate: boolean): number {
    const value = number(args[0]);
    const length = integer(args[1] ?? 1);
    const percentage = number(args[2] ?? 50);
    let state = this.callState.get(id) as PercentileState | undefined;
    if (state === undefined) {
      state = { samples: [], nextSample: 0, ranked: [], nextRankSlot: 0 };
      this.callState.set(id, state);
    }
    const history = state.samples;
    history[state.nextSample] = value;
    state.nextSample = (state.nextSample + 1) % MAX_PRESENT_SAMPLES;

    if (state.ranked.length === length) {
      replacePercentileSample(state, value);
    } else if (state.ranked.length > 0 && state.ranked.length + 1 === length && history.length >= length) {
      extendPercentileWindow(state, value);
    } else {
      const oldest = state.nextSample + MAX_PRESENT_SAMPLES - length;
      const samples = Array.from({ length }, (_, slot): PercentileSample => ({
        slot, value: history[(oldest + slot) % MAX_PRESENT_SAMPLES] ?? Number.NaN,
      }));
      state.nextRankSlot = 0;
      if (samples.every((sample) => !Number.isNaN(sample.value))) {
        state.ranked = samples.sort((left, right) => left.value - right.value);
      } else {
        state.ranked = samples.map(({ slot }) => ({ slot, value: Number.NaN }));
        for (const sample of samples) replacePercentileSample(state, sample.value);
      }
    }

    if (history.length < length) return Number.NaN;
    const ranked = state.ranked;
    if (!interpolate) return ranked[Math.max(0, Math.ceil(percentage / 100 * length) - 1)]!.value;
    const position = Math.max(0, percentage / 100 * length - 0.5);
    const lower = Math.floor(position);
    const first = ranked[lower]!.value;
    if (lower === length - 1) return first;
    const second = ranked[lower + 1]!.value;
    return first + (position - lower) * (second - first);
  }

  protected valueWhen(id: StateId, args: readonly PineValue[]): PineValue {
    let values = this.callState.get(id) as PineValue[] | undefined;
    if (values === undefined) {
      values = [];
      this.callState.set(id, values);
    }
    if (this.truthy(args[0] ?? false)) values.push(args[1] ?? Number.NaN);
    const occurrence = Math.trunc(number(args[2] ?? 0));
    if (!Number.isFinite(occurrence) || occurrence < 0) return Number.NaN;
    return values[values.length - 1 - occurrence] ?? Number.NaN;
  }

  protected moneyFlowIndex(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const source = number(args[0]);
    const length = Math.max(1, integer(args[1] ?? 1));
    const previousKey = childId(id, 1);
    const previous = this.callState.get(previousKey) as number | undefined;
    this.callState.set(previousKey, source);
    const change = previous === undefined ? Number.NaN : source - previous;
    const volume = number(this.data("volume"));
    const upper = volume * (change <= 0 ? 0 : source);
    const lower = volume * (change >= 0 ? 0 : source);
    const historyLimit = strict ? MAX_PRESENT_SAMPLES : undefined;
    const upperSum = number(this.movingSum(childId(id, 2), [upper, length], historyLimit));
    const lowerSum = number(this.movingSum(childId(id, 3), [lower, length], historyLimit));
    if (Number.isNaN(upperSum) || Number.isNaN(lowerSum)) return Number.NaN;
    if (lowerSum === 0) return 100;
    if (upperSum === 0) return 0;
    return 100 - 100 / (1 + upperSum / lowerSum);
  }

  protected pivot(id: StateId, args: readonly PineValue[], high: boolean, strict = false): PineValue {
    const implicitSource = strict && args.length === 2;
    const source = implicitSource ? number(this.data(high ? "high" : "low")) : number(args[0]);
    const left = Math.max(0, integer(args[implicitSource ? 0 : 1] ?? 0));
    const right = Math.max(0, integer(args[implicitSource ? 1 : 2] ?? 0));
    const values = this.window(id, source, left + right + 1);
    if (values.length < left + right + 1) return Number.NaN;
    const pivotIndex = values.length - 1 - right;
    const candidate = values[pivotIndex]!;
    if (Number.isNaN(candidate)) return Number.NaN;
    for (const [index, value] of values.entries()) {
      if (index === pivotIndex) continue;
      if (Number.isNaN(value)) {
        if (!strict) return Number.NaN;
        continue;
      }
      if ((high ? value > candidate : value < candidate)
        || (value === candidate && (!strict || index > pivotIndex))) return Number.NaN;
    }
    return candidate;
  }

  protected trueStrengthIndex(id: StateId, args: readonly PineValue[]): PineValue {
    const source = number(args[0]);
    const shortLength = Math.max(1, integer(args[1] ?? 1));
    const longLength = Math.max(1, integer(args[2] ?? 1));
    const previousKey = childId(id, 1);
    const previous = this.callState.get(previousKey) as number | undefined;
    this.callState.set(previousKey, source);
    if (previous === undefined || Number.isNaN(source) || Number.isNaN(previous)) return Number.NaN;
    const change = source - previous;
    const firstChange = number(this.ema(childId(id, 2), [change, longLength]));
    const firstAbsolute = number(this.ema(childId(id, 3), [Math.abs(change), longLength]));
    if (Number.isNaN(firstChange) || Number.isNaN(firstAbsolute)) return Number.NaN;
    const secondChange = number(this.ema(childId(id, 4), [firstChange, shortLength]));
    const secondAbsolute = number(this.ema(childId(id, 5), [firstAbsolute, shortLength]));
    if (Number.isNaN(secondChange) || Number.isNaN(secondAbsolute)) return Number.NaN;
    return secondAbsolute === 0 ? 0 : secondChange / secondAbsolute;
  }

  protected dmi(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[0] ?? 1));
    const smoothing = Math.max(1, integer(args[1] ?? 1));
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const previousHigh = number(this.data("high", 1));
    const previousLow = number(this.data("low", 1));
    const previousClose = number(this.data("close", 1));
    if ([high, low, previousHigh, previousLow, previousClose].some(Number.isNaN)) return [Number.NaN, Number.NaN, Number.NaN];
    const up = high - previousHigh;
    const down = previousLow - low;
    const plusMovement = up > down && up > 0 ? up : 0;
    const minusMovement = down > up && down > 0 ? down : 0;
    const trueRange = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
    const smoothedRange = number(this.rmaValue(childId(id, 1), trueRange, length));
    const smoothedPlus = number(this.rmaValue(childId(id, 2), plusMovement, length));
    const smoothedMinus = number(this.rmaValue(childId(id, 3), minusMovement, length));
    if ([smoothedRange, smoothedPlus, smoothedMinus].some(Number.isNaN)) return [Number.NaN, Number.NaN, Number.NaN];
    const plus = smoothedRange === 0 ? 0 : 100 * smoothedPlus / smoothedRange;
    const minus = smoothedRange === 0 ? 0 : 100 * smoothedMinus / smoothedRange;
    const total = plus + minus;
    const dx = total === 0 ? 0 : 100 * Math.abs(plus - minus) / total;
    const adx = this.rmaValue(childId(id, 4), dx, smoothing);
    return [taValue(plus), taValue(minus), taValue(adx)];
  }

  protected supertrend(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const factor = number(args[0]);
    const period = Math.max(1, integer(args[1] ?? 1));
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const close = number(this.data("close"));
    const previousClose = number(this.data("close", 1));
    const atr = number(this.rmaValue(childId(id, 1), number(this.trueRange()), period));
    if ([high, low, close].some(Number.isNaN) || (!strict && (Number.isNaN(factor) || Number.isNaN(atr)))) {
      return [Number.NaN, Number.NaN];
    }
    const previous = this.callState.get(id) as SupertrendState | undefined;
    let upper = (high + low) / 2 + factor * atr;
    let lower = (high + low) / 2 - factor * atr;
    let previousLower = previous?.lower ?? 0;
    let previousUpper = previous?.upper ?? 0;
    if (strict) {
      if (Number.isNaN(previousLower)) previousLower = 0;
      if (Number.isNaN(previousUpper)) previousUpper = 0;
    }
    if (strict || previous !== undefined) {
      if (!(lower > previousLower || previousClose < previousLower)) lower = previousLower;
      if (!(upper < previousUpper || previousClose > previousUpper)) upper = previousUpper;
    }
    let direction = 1;
    if (previous !== undefined && previous.atrReady !== false) {
      direction = previous.trend === previousUpper ? (close > upper ? -1 : 1) : (close < lower ? 1 : -1);
    }
    const trend = direction === -1 ? lower : upper;
    this.callState.set(id, { lower, upper, trend, direction, ...(strict ? { atrReady: !Number.isNaN(atr) } : {}) });
    return [taValue(trend), direction];
  }

  protected sar(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    if (strict) return this.strictSar(id, args);
    if (this.barIndex === 0) return Number.NaN;
    const start = number(args[0]);
    const increment = number(args[1]);
    const maximum = number(args[2]);
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const close = number(this.data("close"));
    const previousClose = number(this.data("close", 1));
    const previousHigh = number(this.data("high", 1));
    const previousLow = number(this.data("low", 1));
    let state = this.callState.get(id) as SarState | undefined;
    let firstTrendBar = false;
    if (state === undefined) {
      const below = close > previousClose;
      state = { result: below ? previousLow : previousHigh, extreme: below ? high : low, acceleration: start, below };
      firstTrendBar = true;
    }
    let { result, extreme, acceleration, below } = state;
    result += acceleration * (extreme - result);
    if (below && result > low) {
      firstTrendBar = true;
      below = false;
      result = Math.max(high, extreme);
      extreme = low;
      acceleration = start;
    } else if (!below && result < high) {
      firstTrendBar = true;
      below = true;
      result = Math.min(low, extreme);
      extreme = high;
      acceleration = start;
    }
    if (!firstTrendBar) {
      if (below && high > extreme) {
        extreme = high;
        acceleration = Math.min(acceleration + increment, maximum);
      } else if (!below && low < extreme) {
        extreme = low;
        acceleration = Math.min(acceleration + increment, maximum);
      }
    }
    if (below) {
      result = Math.min(result, previousLow);
      if (this.barIndex > 1) result = Math.min(result, number(this.data("low", 2)));
    } else {
      result = Math.max(result, previousHigh);
      if (this.barIndex > 1) result = Math.max(result, number(this.data("high", 2)));
    }
    this.callState.set(id, { result, extreme, acceleration, below });
    return result;
  }

  private strictSar(id: StateId, args: readonly PineValue[]): PineValue {
    const start = number(args[0]);
    const increment = number(args[1]);
    const maximum = number(args[2]);
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const close = number(this.data("close"));
    if ([high, low, close].some(Number.isNaN)) return Number.NaN;

    const previous = this.callState.get(id) as StrictSarState | StrictSarSeedState | undefined;
    if (previous === undefined || !("result" in previous)) {
      if (previous === undefined) {
        this.callState.set(id, { recentHighs: [high], recentLows: [low], previousClose: close } satisfies StrictSarSeedState);
        return Number.NaN;
      }
      const below = close > previous.previousClose;
      const previousHigh = previous.recentHighs.at(-1)!;
      const previousLow = previous.recentLows.at(-1)!;
      const state: StrictSarState = {
        result: below ? previousLow : previousHigh,
        extreme: below ? high : low,
        acceleration: start,
        below,
        recentHighs: previous.recentHighs,
        recentLows: previous.recentLows,
        previousClose: close,
      };
      const result = this.advanceStrictSar(state, high, low, start, increment, maximum, true);
      this.pushSarPrice(state, high, low);
      this.callState.set(id, state);
      return result;
    }

    const result = this.advanceStrictSar(previous, high, low, start, increment, maximum, false);
    previous.previousClose = close;
    this.pushSarPrice(previous, high, low);
    this.callState.set(id, previous);
    return result;
  }

  private advanceStrictSar(
    state: StrictSarState,
    high: number,
    low: number,
    start: number,
    increment: number,
    maximum: number,
    firstTrendBar: boolean,
  ): number {
    state.result += state.acceleration * (state.extreme - state.result);
    if (state.below && state.result > low) {
      firstTrendBar = true;
      state.below = false;
      state.result = Math.max(high, state.extreme);
      state.extreme = low;
      state.acceleration = start;
    } else if (!state.below && state.result < high) {
      firstTrendBar = true;
      state.below = true;
      state.result = Math.min(low, state.extreme);
      state.extreme = high;
      state.acceleration = start;
    }
    if (!firstTrendBar) {
      if (state.below && high > state.extreme) {
        state.extreme = high;
        state.acceleration = Math.min(state.acceleration + increment, maximum);
      } else if (!state.below && low < state.extreme) {
        state.extreme = low;
        state.acceleration = Math.min(state.acceleration + increment, maximum);
      }
    }
    const constraints = state.below ? state.recentLows : state.recentHighs;
    state.result = state.below
      ? Math.min(state.result, ...constraints)
      : Math.max(state.result, ...constraints);
    return state.result;
  }

  private pushSarPrice(state: StrictSarState, high: number, low: number): void {
    state.recentHighs = [...state.recentHighs, high].slice(-2);
    state.recentLows = [...state.recentLows, low].slice(-2);
  }

  protected vwap(id: StateId, args: readonly PineValue[]): PineValue {
    const price = args[0] === undefined ? number(this.data("hlc3")) : number(args[0]);
    const volume = number(this.data("volume"));
    const tradingDay = number(this.data("time_tradingday"));
    if ([price, volume, tradingDay].some(Number.isNaN)) return Number.NaN;
    let state = this.callState.get(id) as VwapState | undefined;
    if (state === undefined || state.tradingDay !== tradingDay) state = { tradingDay, priceVolume: 0, volume: 0 };
    state.priceVolume += price * volume;
    state.volume += volume;
    this.callState.set(id, state);
    return state.volume === 0 ? Number.NaN : state.priceVolume / state.volume;
  }

  protected strictVwap(id: StateId, args: readonly PineValue[], tradingDay: number): PineValue {
    const price = number(args[0] === undefined ? this.data("hlc3") : args[0]);
    const volume = number(this.data("volume"));
    const anchored = args.length >= 2;
    const bands = args.length === 3;
    let state = this.callState.get(id) as VwapBandsState | undefined;
    const reset = anchored ? this.truthy(args[1] ?? false) : state?.tradingDay !== tradingDay;
    if (reset) {
      state = { tradingDay, priceVolume: 0, volume: 0, origin: price, shiftedPriceVolume: 0, shiftedPriceSquaredVolume: 0 };
      this.callState.set(id, state);
    }
    if (state === undefined || (!anchored && Number.isNaN(tradingDay))) {
      return bands ? [Number.NaN, Number.NaN, Number.NaN] : Number.NaN;
    }
    state.priceVolume += price * volume;
    state.volume += volume;
    const center = state.volume === 0 ? Number.NaN : state.priceVolume / state.volume;
    if (!bands) return taValue(center);

    // Center the moments around the anchor price to preserve small deviations
    // on instruments with large prices and avoid rounding noise on the anchor.
    const shifted = price - state.origin;
    state.shiftedPriceVolume += shifted * volume;
    state.shiftedPriceSquaredVolume += shifted * shifted * volume;
    const meanShift = state.shiftedPriceVolume / state.volume;
    const variance = state.shiftedPriceSquaredVolume / state.volume - meanShift * meanShift;
    const deviation = Math.sqrt(Math.max(0, variance)) * number(args[2]);
    return [taValue(center), taValue(center + deviation), taValue(center - deviation)];
  }

  protected cross(id: StateId, args: readonly PineValue[], direction: "over" | "under" | "either", strict = false): PineValue {
    const left = number(args[0]);
    const right = number(args[1]);
    const previous = this.callState.get(id) as PairState | undefined;
    const missing = Number.isNaN(left) || Number.isNaN(right);
    if (strict && missing) return false;
    this.callState.set(id, { left, right });
    if (missing || previous === undefined || Number.isNaN(previous.left) || Number.isNaN(previous.right)) return false;
    return (direction !== "under" && left > right && previous.left <= previous.right)
      || (direction !== "over" && left < right && previous.left >= previous.right);
  }

  protected rsi(id: StateId, args: readonly PineValue[]): PineValue {
    const source = number(args[0]);
    const length = Math.max(1, integer(args[1] ?? 1));
    const previousKey = childId(id, 2_000_000);
    const previous = this.callState.get(previousKey) as number | undefined;
    this.callState.set(previousKey, source);
    if (previous === undefined || Number.isNaN(source) || Number.isNaN(previous)) return Number.NaN;
    const change = source - previous;
    const gain = number(this.rmaValue(childId(id, 3_000_000), Math.max(change, 0), length));
    const loss = number(this.rmaValue(childId(id, 4_000_000), Math.max(-change, 0), length));
    if (Number.isNaN(gain) || Number.isNaN(loss)) return Number.NaN;
    if (loss === 0) return 100;
    if (gain === 0) return 0;
    return 100 - 100 / (1 + gain / loss);
  }

  protected trueRange(handleNa = true): PineValue {
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const previousClose = number(this.data("close", 1));
    return Number.isNaN(previousClose) ? (handleNa ? high - low : Number.NaN) : Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  }

  protected atr(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[0] ?? 1));
    return this.rmaValue(id, number(this.trueRange()), length);
  }

  protected macd(id: StateId, args: readonly PineValue[], ignoreMissing = false): PineValue {
    const source = args[0] ?? Number.NaN;
    const fastLength = args[1] ?? 12;
    const slowLength = args[2] ?? 26;
    const signalLength = args[3] ?? 9;
    const fast = number(this.ema(childId(id, 1), [source, fastLength], ignoreMissing));
    const slow = number(this.ema(childId(id, 2), [source, slowLength], ignoreMissing));
    const line = fast - slow;
    const signal = number(this.ema(childId(id, 3), [line, signalLength], ignoreMissing));
    return [taValue(line), taValue(signal), taValue(line - signal)];
  }

  protected bb(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const [middle, deviation] = this.bollingerParts(id, args, strict);
    return [taValue(middle), taValue(middle + deviation), taValue(middle - deviation)];
  }

  protected bbw(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const [middle, deviation] = this.bollingerParts(id, args, strict);
    if (middle === 0) return strict ? Number.NaN : 0;
    return ((2 * deviation) / middle) * 100;
  }

  private bollingerParts(id: StateId, args: readonly PineValue[], strict: boolean): readonly [number, number] {
    const window = [args[0] ?? Number.NaN, args[1] ?? 20];
    const multiplier = number(args[2] ?? 2);
    const basisId = childId(id, 1);
    const varianceId = childId(id, 2);
    const middle = strict ? this.presentWindowStatistic(basisId, window, "sma") : this.sma(basisId, window);
    const variance = strict ? this.presentWindowStatistic(varianceId, window, "variance") : this.variance(varianceId, window);
    return [number(middle), Math.sqrt(number(variance)) * multiplier];
  }

  protected kc(id: StateId, args: readonly PineValue[], ignoreMissing = false): PineValue {
    const source = args[0] ?? Number.NaN;
    const length = args[1] ?? 20;
    const multiplier = number(args[2] ?? 2);
    const useTrueRange = args[3] === undefined ? true : this.truthy(args[3]);
    const basis = number(this.ema(childId(id, 1), [source, length], ignoreMissing));
    const span = useTrueRange ? number(this.trueRange(false)) : number(this.data("high")) - number(this.data("low"));
    const rangeEma = number(this.ema(childId(id, 2), [span, length], ignoreMissing));
    if (!ignoreMissing && (Number.isNaN(basis) || Number.isNaN(rangeEma))) return [Number.NaN, Number.NaN, Number.NaN];
    return [taValue(basis), taValue(basis + rangeEma * multiplier), taValue(basis - rangeEma * multiplier)];
  }

  protected kcw(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const channels = this.kc(id, args, strict);
    if (!Array.isArray(channels)) return Number.NaN;
    const tuple = channels as readonly PineValue[];
    const basis = number(tuple[0]);
    if (strict && basis === 0) return Number.NaN;
    return (number(tuple[1]) - number(tuple[2])) / basis;
  }

  protected cumulative(id: StateId, args: readonly PineValue[], strict = false): PineValue {
    const source = number(args[0]);
    const previous = this.callState.get(id) as number | undefined;
    if (strict && Number.isNaN(source)) return Number.NaN;
    const value = (previous ?? 0) + (Number.isNaN(source) ? 0 : source);
    this.callState.set(id, value);
    return value;
  }

  protected movingSum(id: StateId, args: readonly PineValue[], nonMissingHistoryLimit?: number): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const source = number(args[0]);
    if (nonMissingHistoryLimit === undefined) {
      const values = this.window(id, source, length);
      if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
      return values.reduce((sum, value) => sum + value, 0);
    }
    let state = this.callState.get(id) as WindowState | undefined;
    if (state === undefined) {
      state = { values: [] };
      this.callState.set(id, state);
    }
    if (!Number.isNaN(source)) state.values.push(source);
    if (state.values.length > nonMissingHistoryLimit) {
      state = { values: state.values.slice(-nonMissingHistoryLimit) };
      this.callState.set(id, state);
    }
    const values = state.values.slice(-length);
    if (values.length < length) return Number.NaN;
    return values.reduce((sum, value) => sum + value, 0);
  }

  protected range(id: StateId, args: readonly PineValue[]): PineValue {
    const length = Math.max(1, integer(args[1] ?? 1));
    const values = this.window(id, number(args[0]), length);
    if (values.length < length || values.some(Number.isNaN)) return Number.NaN;
    return Math.max(...values) - Math.min(...values);
  }

  protected directionalWindow(id: StateId, args: readonly PineValue[], rising: boolean, strict = false): PineValue {
    const source = number(args[0]);
    const length = Math.max(1, integer(args[1] ?? 1));
    if (strict) {
      const previousId = childId(id, 1);
      const previous = (this.callState.get(previousId) as number | undefined) ?? Number.NaN;
      this.callState.set(previousId, source);
      const changes = this.presentSamples(id, source - previous, length).values;
      return changes.length === length && changes.every((change) => rising ? change > 0 : change < 0);
    }
    const values = this.window(id, source, length + 1);
    if (values.length <= length || values.some(Number.isNaN)) return false;
    const history = values.slice(0, -1);
    return rising ? history.every((value) => source > value) : history.every((value) => source < value);
  }

  protected barsSince(id: StateId, args: readonly PineValue[]): PineValue {
    let state = this.callState.get(id) as BarCountState | undefined;
    if (state === undefined) {
      state = { count: -1 };
      this.callState.set(id, state);
    }
    if (this.truthy(args[0] ?? false)) {
      state.count = 0;
      return 0;
    }
    if (state.count < 0) return Number.NaN;
    state.count += 1;
    return state.count;
  }

  protected accumulationDistribution(id: StateId): PineValue {
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const close = number(this.data("close"));
    const volume = number(this.data("volume"));
    const range = high - low;
    const term = [high, low, close, volume].some(Number.isNaN) || range === 0 ? 0 : ((close - low) - (high - close)) / range * volume;
    return this.accumulate(id, term, 0);
  }

  protected onBalanceVolume(id: StateId, strict = false): PineValue {
    if (strict && this.barIndex === 0) return Number.NaN;
    const close = number(this.data("close"));
    const previousClose = number(this.data("close", 1));
    const volume = number(this.data("volume"));
    let delta = 0;
    if (strict) {
      if (!Number.isNaN(previousClose) && ![close, volume].some(Number.isNaN)) {
        delta = close > previousClose ? volume : close < previousClose ? -volume : 0;
      }
    } else if (!Number.isNaN(previousClose)) {
      delta = close > previousClose ? volume : close < previousClose ? -volume : 0;
    }
    return this.accumulate(id, delta, 0);
  }

  protected priceVolumeTrend(id: StateId, strict = false): PineValue {
    if (strict && this.barIndex === 0) return Number.NaN;
    const close = number(this.data("close"));
    const previousClose = number(this.data("close", 1));
    const volume = number(this.data("volume"));
    const delta = [close, previousClose, volume].some(Number.isNaN) || previousClose === 0 ? 0 : (close - previousClose) / previousClose * volume;
    return this.accumulate(id, delta, 0);
  }

  protected williamsAccumulation(id: StateId): PineValue {
    const close = number(this.data("close"));
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const previousClose = number(this.data("close", 1));
    let gain = 0;
    if (![close, high, low, previousClose].some(Number.isNaN)) {
      if (close > previousClose) gain = close - Math.min(low, previousClose);
      else if (close < previousClose) gain = close - Math.max(high, previousClose);
    }
    return this.accumulate(id, gain, 0);
  }

  protected williamsVariableAccumulation(strict = false): PineValue {
    const close = number(this.data("close"));
    const open = number(this.data("open"));
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const volume = number(this.data("volume"));
    if ([close, open, high, low, volume].some(Number.isNaN)) return Number.NaN;
    return high === low ? (strict ? Number.NaN : 0) : (close - open) / (high - low) * volume;
  }

  protected intradayIntensity(strict = false): PineValue {
    const close = number(this.data("close"));
    const high = number(this.data("high"));
    const low = number(this.data("low"));
    const volume = number(this.data("volume"));
    if ([close, high, low, volume].some(Number.isNaN)) return Number.NaN;
    const range = high - low;
    // The reference platform computes (2 * close - high - low) / (high - low) * volume,
    // as a recorded observation showed.
    if (strict) return range === 0 ? Number.NaN : (2 * close - high - low) / range * volume;
    const denominator = range * volume;
    return denominator === 0 ? 0 : (2 * close - high - low) / denominator;
  }

  protected volumeIndex(id: StateId, positive: boolean): PineValue {
    const close = number(this.data("close"));
    const previousClose = number(this.data("close", 1));
    const volume = number(this.data("volume"));
    const previousVolume = number(this.data("volume", 1));
    const previous = (this.callState.get(id) as number | undefined) ?? 1;
    let value = previous;
    if (![close, previousClose, volume, previousVolume].some(Number.isNaN) && close !== 0 && previousClose !== 0 && (positive ? volume > previousVolume : volume < previousVolume)) {
      value += (close - previousClose) / previousClose * value;
    }
    this.callState.set(id, value);
    return value;
  }

  protected accumulate(id: StateId, delta: number, initial: number): number {
    const value = ((this.callState.get(id) as number | undefined) ?? initial) + delta;
    this.callState.set(id, value);
    return value;
  }

}

function averageRanks(values: readonly number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array.from({ length: values.length }, () => 0);
  for (let start = 0; start < indexed.length;) {
    let end = start + 1;
    while (end < indexed.length && indexed[end]!.value === indexed[start]!.value) end += 1;
    const rank = (start + end - 1) / 2;
    for (let cursor = start; cursor < end; cursor += 1) ranks[indexed[cursor]!.index] = rank;
    start = end;
  }
  return ranks;
}

function pivotPeriodFromData(runtime: TechnicalAnalysisRuntime): PivotPeriod {
  const period = {
    open: number(runtime.data("open")),
    high: number(runtime.data("high")),
    low: number(runtime.data("low")),
    close: number(runtime.data("close")),
  };
  if (Object.values(period).some(Number.isNaN)) {
    throw new PineRuntimeError("ta.pivot_point_levels requires finite OHLC values", "ta.pivot_point_levels");
  }
  return period;
}

type PivotType = "traditional" | "fibonacci" | "woodie" | "classic" | "dm" | "camarilla";

function normalizePivotType(value: string): PivotType {
  const normalized = value.trim().toLowerCase();
  if (normalized === "demark") return "dm";
  if (["traditional", "fibonacci", "woodie", "classic", "dm", "camarilla"].includes(normalized)) return normalized as PivotType;
  throw new PineRuntimeError(`Unknown pivot type: "${value}"`, "ta.pivot_point_levels");
}

function calculatePivotLevels(type: PivotType, period: PivotPeriod, currentOpen: number, strict: boolean): PineValue[] {
  const { open, high, low, close } = period;
  const range = high - low;
  const empty = () => Number.NaN;
  if (type === "dm") {
    let x = high + low + 2 * close;
    if (close < open) x = high + 2 * low + close;
    else if (close > open) x = 2 * high + low + close;
    return [x / 4, x / 2 - low, x / 2 - high, empty(), empty(), empty(), empty(), empty(), empty(), empty(), empty()];
  }
  const pivot = type === "woodie" ? (high + low + 2 * currentOpen) / 4 : (high + low + close) / 3;
  if (type === "fibonacci") {
    return [pivot, pivot + 0.382 * range, pivot - 0.382 * range, pivot + 0.618 * range, pivot - 0.618 * range, pivot + range, pivot - range, empty(), empty(), empty(), empty()];
  }
  if (type === "camarilla") {
    const r5 = low === 0 ? Number.NaN : close * high / low;
    return [pivot, close + 1.1 * range / 12, close - 1.1 * range / 12, close + 1.1 * range / 6, close - 1.1 * range / 6, close + 1.1 * range / 4, close - 1.1 * range / 4, close + 1.1 * range / 2, close - 1.1 * range / 2, r5, Number.isNaN(r5) ? Number.NaN : 2 * close - r5];
  }
  if (strict) {
    const r1 = 2 * pivot - low;
    const s1 = 2 * pivot - high;
    const core = [pivot, r1, s1, pivot + range, pivot - range];
    if (type === "traditional") {
      const r3 = r1 + range;
      const s3 = s1 - range;
      const above = pivot - low;
      const below = high - pivot;
      return [...core, r3, s3, r3 + above, s3 - below, r3 + 2 * above, s3 - 2 * below];
    }
    if (type === "woodie") {
      return [...core, r1 + range, s1 - range, r1 + 2 * range, s1 - 2 * range, empty(), empty()];
    }
    return [...core, pivot + 2 * range, pivot - 2 * range, pivot + 3 * range, pivot - 3 * range, empty(), empty()];
  }
  const thirdResistance = type === "classic" || type === "woodie" ? high + 2 * (pivot - low) : pivot + 2 * range;
  const thirdSupport = type === "classic" || type === "woodie" ? low - 2 * (high - pivot) : pivot - 2 * range;
  const fourthResistance = type === "traditional" ? pivot + 3 * range : Number.NaN;
  const fourthSupport = type === "traditional" ? pivot - 3 * range : Number.NaN;
  const fifthResistance = type === "traditional" ? pivot + 4 * range : Number.NaN;
  const fifthSupport = type === "traditional" ? pivot - 4 * range : Number.NaN;
  return [pivot, 2 * pivot - low, 2 * pivot - high, pivot + range, pivot - range, thirdResistance, thirdSupport, fourthResistance, fourthSupport, fifthResistance, fifthSupport];
}
