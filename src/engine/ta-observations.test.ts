import { PINE_COMPATIBILITY, type MarketBar, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

async function run(source: string, volumes: readonly number[], compatibility: PineCompatibility) {
  const bars: MarketBar[] = volumes.map((volume, i) => ({
    openTime: 1_000 + i * 60_000, open: 1, high: 1, low: 1, close: 1, volume,
  }));
  return runBars(source, bars, compatibility);
}

async function runBars(source: string, bars: readonly MarketBar[], compatibility: PineCompatibility) {
  const { program, diagnostics } = compile({ source, compatibility });
  if (!program) throw new Error(JSON.stringify(diagnostics));
  const session = new PineEngine().createSession(program);
  try {
    return (await session.runBatch(bars)).returned;
  } finally {
    await session.close();
  }
}

describe("TA observations", () => {
  it("admits a simple ALMA floor only in the production profile", async () => {
    // ta-window-shapes.txt, offsets 11 through 8.
    const source = `//@version=6
indicator("ALMA center")
x = bar_index == 0 ? 2.0 : bar_index == 1 ? 4.0 : bar_index == 2 ? 8.0 : 6.0
standard = ta.alma(x, 4, 0.85, 6)
unfloored = ta.alma(x, 4, 0.85, 6, floor=false)
floored = ta.alma(x, 4, 0.85, 6, floor=true)`;
    const strict = await run(source, [1, 1, 1, 1], PINE_COMPATIBILITY.strict);
    expect(strict.standard?.at(-1)).toBe(6.8165016639);
    expect(strict.unfloored).toEqual(strict.standard);
    expect(strict.floored?.at(-1)).toBe(6.7867068895);
    const legacy = await run(source, [1, 1, 1, 1], PINE_COMPATIBILITY.legacy);
    expect(legacy.floored).toEqual(legacy.standard);
    const series = source.replace("floor=true", "floor=bar_index % 2 == 0");
    const diagnostic = compile({ source: series, compatibility: PINE_COMPATIBILITY.strict }).diagnostics
      .find(({ code }) => code === "SCRIPT2117");
    expect(diagnostic?.message).toContain("requires simple bool");
  });

  it("exposes the Keltner basis before the true-range EMA seeds", async () => {
    // ta-compound-warmup.txt, first three bars of the bounded chart.
    const source = `//@version=6
indicator("Keltner warm-up")
float x = bar_index == 0 ? 1.12031 : 1.11245
if bar_index == 1
    x := 1.11739
[basis, upper, lower] = ta.kc(x, 3, 1.5)
width = ta.kcw(x, 3, 1.5)`;
    const strict = await run(source, [1, 1, 1], PINE_COMPATIBILITY.strict);
    expect(strict.basis?.at(-1)).toBe(1.1167166667);
    expect(strict.upper?.at(-1)).toBeNaN();
    expect(strict.lower?.at(-1)).toBeNaN();
    expect(strict.width?.at(-1)).toBeNaN();
    const legacy = await run(source, [1, 1, 1], PINE_COMPATIBILITY.legacy);
    expect(legacy.basis?.at(-1)).toBeNaN();
  });

  it("uses the previous complete pair for crossings through missing operands", async () => {
    // ta-cross-pairs.txt, including staggered holes and a prior equality.
    const source = `//@version=6
indicator("Crosses through holes")
a = bar_index == 0 ? 2.0 : bar_index == 2 ? 3.0 : bar_index == 3 ? 7.0 : bar_index == 4 ? 8.0 : bar_index == 5 ? 5.0 : bar_index == 7 ? 4.0 : na
b = bar_index == 1 or bar_index == 6 ? 1.0 : bar_index == 3 ? na : 5.0
any = ta.cross(a, b)
above = ta.crossover(a, b)
below = ta.crossunder(a, b)`;
    const volumes = Array<number>(8).fill(1);
    const strict = await run(source, volumes, PINE_COMPATIBILITY.strict);
    expect(strict.any).toEqual([false, false, false, false, true, false, false, true]);
    expect(strict.above).toEqual([false, false, false, false, true, false, false, false]);
    expect(strict.below).toEqual([false, false, false, false, false, false, false, true]);
    const legacy = await run(source, volumes, PINE_COMPATIBILITY.legacy);
    expect(legacy.any).toEqual(Array<boolean>(8).fill(false));
  });

  it("confirms the latest tied pivot through missing neighbors in a full bar window", async () => {
    // ta-pivot-neighbors.txt confirms the second 4 and second 1, two bars later.
    const source = `//@version=6
indicator("Pivot ties")
x = bar_index == 2 or bar_index == 3 ? 4.0 : bar_index == 5 or bar_index == 7 ? 1.0 : bar_index == 8 or bar_index == 9 ? 5.0 : na
peak = ta.pivothigh(x, 2, 2)
trough = ta.pivotlow(x, 2, 2)
immediate = ta.pivotlow(x, 2, 0)`;
    const volumes = Array<number>(10).fill(1);
    const strict = await run(source, volumes, PINE_COMPATIBILITY.strict);
    const na = Number.NaN;
    expect(strict.peak).toEqual([na, na, na, na, na, 4, na, na, na, na]);
    expect(strict.trough).toEqual([na, na, na, na, na, na, na, na, na, 1]);
    expect(strict.immediate?.[3]).toBe(4);
    const legacy = await run(source, volumes, PINE_COMPATIBILITY.legacy);
    expect(legacy.peak?.[5]).toBeNaN();
    expect(legacy.trough?.[9]).toBeNaN();
  });

  it("carries the last WMA input through holes while leaving hole outputs missing", async () => {
    // ta-wma.txt, offsets 11 through 4. WMA(3) at offset 5 uses [4, 4, 9].
    const source = `//@version=6
indicator("Weighted average")
float x = switch bar_index
    0 => 6
    1 => 2
    2 => 11
    3 => 4
    6 => 9
    7 => 3
    => na
w3 = ta.wma(x, 3)
w4 = ta.wma(x, 4)
h4 = ta.hma(x, 4)`;
    const volumes = [1, 1, 1, 1, 1, 1, 1, 1];
    const na = Number.NaN;
    const strict = await run(source, volumes, PINE_COMPATIBILITY.strict);
    expect(strict.w3).toEqual([na, na, 7.1666666667, 6, na, na, 6.5, 5.1666666667]);
    expect(strict.w4).toEqual([na, na, na, 5.9, na, na, 6, 5.1]);
    expect(strict.h4).toEqual([na, na, na, na, na, na, 8.0333333333, 6.1555555556]);
    const legacy = await run(source, volumes, PINE_COMPATIBILITY.legacy);
    expect(legacy.w3?.[6]).toBeNaN();
    expect(legacy.h4?.[6]).toBeNaN();
  });

  it("matches independent volume windows and resumes RMA, EMA and cumulative sum across na", async () => {
    // ta-missing.txt, offsets 8 through 3.
    const source = `//@version=6
indicator("Missing inputs")
float x = switch bar_index
    0 => 4
    1 => 1
    2 => 7
    3 => 2
    5 => 9
    => na
weighted = ta.vwma(x, 3)
smoothed = ta.rma(x, 3)
ema = ta.ema(x, 3)
total = ta.cum(x)
cmo = ta.cmo(x, 3)
mfi = ta.mfi(x, 3)`;
    const volumes = [427192, 220939, 173542, 163303, 301476, 387898];
    const na = Number.NaN;
    const strict = await run(source, volumes, PINE_COMPATIBILITY.strict);
    expect(strict.weighted).toEqual([na, na, 3.8269494069, 3.1595366665, 2.7608977301, 5.9019792958]);
    expect(strict.smoothed).toEqual([na, na, 4, 3.3333333333, na, 5.2222222222]);
    expect(strict.ema).toEqual([na, na, 4, 3, na, 6]);
    expect(strict.total).toEqual([4, 5, 12, 14, na, 23]);
    expect(strict.cmo).toEqual([na, na, na, -14.2857142857, -14.2857142857, -100]);
    expect(strict.mfi).toEqual([na, na, 60.2390265201, 68.9307789251, 68.9307789251, 55.2101914176]);
    const legacy = await run(source, volumes, PINE_COMPATIBILITY.legacy);
    expect(legacy.weighted?.[4]).toBeNaN();
    expect(legacy.smoothed?.[4]).toBe(3.3333333333);
    expect(legacy.total?.[4]).toBe(14);
    expect(legacy.cmo?.[4]).toBeNaN();
    expect(legacy.mfi?.[4]).toBeNaN();
  });

  it("reports missing OBV and PVT at startup before accumulating changes", async () => {
    // ta-volume-series.txt: both variables need a previous close on the first bar.
    const source = `//@version=6
indicator("Volume startup")
balance = ta.obv
trend = ta.pvt`;
    const strict = await run(source, [10, 20, 30], PINE_COMPATIBILITY.strict);
    expect(strict.balance).toEqual([NaN, 0, 0]);
    expect(strict.trend).toEqual([NaN, 0, 0]);
    const legacy = await run(source, [10, 20, 30], PINE_COMPATIBILITY.legacy);
    expect(legacy.balance).toEqual([0, 0, 0]);
    expect(legacy.trend).toEqual([0, 0, 0]);
  });

  it("uses the full rank denominator and independent correlation moments", async () => {
    // ta-rank.txt, offsets 7 through 1, replayed here without the preceding chart bars.
    // Correlation can exceed one when y skips an extra sample.
    const source = `//@version=6
indicator("Rank and correlation")
float x = switch bar_index
    0 => 4
    1 => 4
    2 => 1
    3 => 4
    5 => 7
    6 => 2
    => na
float y = bar_index == 2 ? na : x * x
rank = ta.percentrank(x, 3)
corr = ta.correlation(x, y, 3)`;
    const strict = await run(source, [1, 1, 1, 1, 1, 1, 1], PINE_COMPATIBILITY.strict);
    expect(strict.rank).toEqual([NaN, NaN, NaN, 100, 0, 66.6666666667, 0]);
    expect(strict.corr?.slice(0, 5)).toEqual([NaN, NaN, NaN, NaN, NaN]);
    expect(strict.corr?.[5]).toBeCloseTo(1.2859165086, 10);
    expect(strict.corr?.[6]).toBeCloseTo(0.9890355578, 10);
  });

  it("matches uncentered correlation moments on nearly equal prices", async () => {
    // ta-correlation-precision.txt, including the amplified cancellation after translation.
    const source = `//@version=6
indicator("Correlation precision")
float x = bar_index % 2 == 0 ? 9.0 : 1.0
float y = bar_index % 2 == 0 ? 1.11863 : 1.11908
raw = ta.correlation(x, y, 2)
shifted = ta.correlation(x, y + 1000.0, 2)
dynamic = ta.correlation(x, y, bar_index % 1 + 2)`;
    const strict = await run(source, [1, 1, 1], PINE_COMPATIBILITY.strict);
    expect(strict.raw?.[0]).toBeNaN();
    expect(strict.raw?.[1]).toBeCloseTo(-0.999999998104054, 14);
    expect(strict.shifted?.[1]).toBeCloseTo(-0.999845319900719, 14);
    expect(strict.dynamic).toEqual(strict.raw);
  });

  it("accepts changing CMO lengths while tracking gain and loss readiness separately", async () => {
    // ta-cmo-dynamic.txt, first nine confirmed values with length cycling from 1 to 3.
    const source = `//@version=6
indicator("Changing Chande momentum")
int n = bar_index % 3 + 1
int x = bar_index % 5 == 2 ? na : (bar_index * 3) % 11
dynamic = ta.cmo(x, n)
fixed = ta.cmo(x, 3)`;
    const { dynamic, fixed } = await run(source, Array<number>(9).fill(1), PINE_COMPATIBILITY.strict);
    expect(dynamic).toEqual([NaN, NaN, NaN, NaN, -100, -45.4545454545, 100, 100, -45.4545454545]);
    expect(fixed).toEqual([NaN, NaN, NaN, NaN, NaN, -45.4545454545, -14.2857142857, -14.2857142857, -45.4545454545]);
  });

  it("keeps full precision when volume series are compared with Pine arithmetic", async () => {
    // ta-volume-precision.txt, first row. The market close is one double below the displayed tick.
    const bars: readonly MarketBar[] = [{
      openTime: 1792962000000, closeTime: 1793048400000,
      open: 1.12205, high: 1.12266, low: 1.11733, close: 1.1173899999999999, volume: 135566,
    }];
    const source = `//@version=6
indicator("Volume precision")
adDifference = ta.accdist - ta.cum(((close - low) - (high - close)) / (high - low) * volume)
wvadDifference = ta.wvad - (close - open) / (high - low) * volume`;
    const strict = await runBars(source, bars, PINE_COMPATIBILITY.strict);
    expect(strict.adDifference).toEqual([0]);
    expect(strict.wvadDifference).toEqual([0]);
  });

  it("keeps each window's readiness and missing-input behavior separate", async () => {
    // ta-dynamic-readiness.txt, ta-dynamic-oscillators.txt and ta-direction-gaps.txt.
    const source = `//@version=6
indicator("TA readiness and gaps")
float x = switch bar_index
    0 => -3
    1 => -1
    3 => -2
    4 => -4
    6 => -5
    7 => -6
    => na
int n = bar_index == 4 ? 5 : 3
weighted = ta.wma(x, n)
highest = ta.highest(x, 3)
mode = ta.mode(x, 3)
rci = ta.rci(x, 3)
stoch = ta.stoch(x, 10, -10, 2)
falling = ta.falling(x, 2)`;
    const strict = await run(source, Array<number>(9).fill(1), PINE_COMPATIBILITY.strict);
    expect(strict.weighted?.slice(0, 5)).toEqual([NaN, NaN, NaN, -1.5, NaN]);
    expect(strict.highest?.slice(0, 5)).toEqual([NaN, NaN, -1, -1, -1]);
    expect(strict.mode?.slice(0, 5)).toEqual([NaN, NaN, NaN, -3, -4]);
    expect(strict.rci).toEqual([NaN, NaN, NaN, -50, -100, -100, -50, -100, -100]);
    expect(strict.stoch).toEqual([NaN, 45, 45, 40, 30, 30, 25, 20, 20]);
    expect(strict.falling).toEqual([false, false, false, false, false, false, false, true, true]);

    const dynamicRci = source.replace("ta.rci(x, 3)", "ta.rci(x, n)");
    const diagnostics = compile({ source: dynamicRci, compatibility: PINE_COMPATIBILITY.strict }).diagnostics;
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2117",
      message: "Argument 'length' for 'ta.rci' requires simple int, received series int",
    }));
  });

  it("accepts a changing COG length and retains running extrema through missing samples", async () => {
    const strict = await run(`//@version=6
indicator("Center of gravity")
float source = switch bar_index
    1 => 2
    2 => -2
    3 => 0
    4 => 5
    => na
fixed = ta.cog(source, 3)
dynamic = ta.cog(source, bar_index % 3 + 2)
highValue = ta.max(source)
lowValue = ta.min(source)`, Array<number>(6).fill(1), PINE_COMPATIBILITY.strict);
    expect(strict.fixed).toEqual([NaN, NaN, NaN, NaN, 0.3333333333, NaN]);
    expect(strict.dynamic).toEqual([NaN, NaN, NaN, -2, 0.3333333333, NaN]);
    expect(strict.highValue).toEqual([NaN, 2, 2, 2, 5, 5]);
    expect(strict.lowValue).toEqual([NaN, 2, -2, -2, -2, -2]);
  });

  it.each(["ta.kc", "ta.kcw"])("requires a simple length for %s", (call) => {
    const probe = (length: string) => compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: `//@version=6
indicator("Keltner length")
int n = ${length}
${call}(close, n, 1.5, true)
plot(close)`,
    });
    expect(probe("input.int(3)").diagnostics).toEqual([]);
    expect(probe("bar_index % 3 + 2").diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2117",
      message: `Argument 'length' for '${call}' requires simple int, received series int`,
    }));
  });

  it("preserves percentile rank order across holes and rebuilds when length changes", async () => {
    // percentile-dynamic.txt, offsets 8 through 1 after four missing samples.
    const source = `//@version=6
indicator("Dynamic percentiles")
int period = switch bar_index - 4
    0 => 4
    3 => 4
    4 => 4
    5 => 2
    6 => 4
    => 3
float x = switch bar_index - 4
    0 => 9
    1 => 1
    3 => 2
    4 => 4
    6 => 7
    7 => 5
    => na
lowRank = ta.percentile_linear_interpolation(x, period, 0)
middle = ta.percentile_linear_interpolation(x, period, 50)
highRank = ta.percentile_linear_interpolation(x, period, 100)
nearest = ta.percentile_nearest_rank(x, period, 50)`;
    const strict = await run(source, Array<number>(12).fill(1), PINE_COMPATIBILITY.strict);
    expect(strict.lowRank?.slice(4)).toEqual([NaN, NaN, 1, 1, 1, NaN, 2, NaN]);
    expect(strict.middle?.slice(4)).toEqual([NaN, 1, NaN, 5.5, 3, NaN, NaN, 5]);
    expect(strict.highRank?.slice(4)).toEqual([9, 9, NaN, NaN, NaN, NaN, 7, 7]);
    expect(strict.nearest?.slice(4)).toEqual([NaN, 1, 9, 2, 2, 4, 4, 5]);
    const legacy = await run(source, Array<number>(12).fill(1), PINE_COMPATIBILITY.legacy);
    expect(legacy.middle?.slice(4)).toEqual(Array<number>(8).fill(NaN));
  });
});
