import type { MarketBar, PineSessionSchedule, SessionCheckpoint, SymbolInfo } from "../contracts/index.js";
import { PineRuntimeError } from "../runtime/index.js";
import { describe, expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function program(source: string) {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

function bar(openTime: number, closeTime = openTime + 60_000): MarketBar {
  return { openTime, closeTime, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

function requestState(session: unknown): { readonly requests: { readonly size: number } } {
  return session as { readonly requests: { readonly size: number } };
}

describe("Lumen Script runtime compatibility", () => {
  it("preserves sealed array.join separator coercion", async () => {
    const source = `//@version=6
indicator("Sealed array join")
numeric = array.join(array.from(1, 2), 7)
boolean = array.join(array.from(1, 2), true)
missing = array.join(array.from(1, 2), na)
omitted = array.join(array.from(1, 2))`;
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const result = await new PineEngine().createSession(sealed.program!).runBatch([bar(0)]);
    expect(result.returned.numeric).toEqual(["172"]);
    expect(result.returned.boolean).toEqual(["1true2"]);
    expect(result.returned.missing).toEqual(["1NaN2"]);
    expect(result.returned.omitted).toEqual(["1,2"]);
  });

  it("isolates strict missing-value nearest ranks from the sealed raw-length contract", async () => {
    const source = `//@version=6
indicator("Array nearest-rank missing values")
values = array.from(1.0, na, 3.0)
middle = array.percentile_nearest_rank(values, 50)
endpoint = array.percentile_nearest_rank(values, 100)`;
    const strict = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(strict.diagnostics).toEqual([]);
    expect(sealed.diagnostics).toEqual([]);
    expect(strict.program).toBeDefined();
    expect(sealed.program).toBeDefined();

    const engine = new PineEngine();
    const strictResult = await engine.createSession(strict.program!).runBatch([bar(0)]);
    const sealedResult = await engine.createSession(sealed.program!).runBatch([bar(0)]);
    expect(strictResult.returned.middle).toEqual([1]);
    expect(strictResult.returned.endpoint).toEqual([3]);
    expect(sealedResult.returned.middle).toEqual([3]);
    expect(sealedResult.returned.endpoint).toEqual([Number.NaN]);
  });

  it("keeps array slices linked through batch execution and portable restore", async () => {
    const compiled = program(`//@version=6
indicator("Linked slice")
var values = array.from(1, 2, 3)
var window = array.slice(values, 1, 3)
if bar_index == 0
    array.set(window, 0, 9)
if bar_index == 1
    array.push(window, 4)
parentValue = array.get(values, 1)
parentSize = array.size(values)`);
    const session = new PineEngine().createSession(compiled);
    const first = await session.runBatch([bar(0)]);
    expect(first.returned.parentValue).toEqual([9]);
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const second = await session.appendBars([bar(60_000)]);
    expect(second.returned.parentSize).toEqual([3, 4]);
    await session.restore(checkpoint);
    const replayed = await session.appendBars([bar(60_000)]);
    expect(replayed.returned.parentSize).toEqual([3, 4]);
  });

  it("refreshes linked slices before non-array calls", async () => {
    const compiled = program(`//@version=6
indicator("Linked slice string")
values = array.from(1, 2, 3)
window = array.slice(values, 1, 3)
array.set(values, 1, 9)
rendered = str.tostring(window)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);
    expect(result.returned.rendered).toEqual(["[9, 3]"]);
  });

  it("exports a linked slice after the parent changes without another slice call", async () => {
    const compiled = program(`//@version=6
indicator("Linked slice export")
var parent = array.from(1, 2, 3)
var window = array.slice(parent, 1, 3)
array.set(parent, 1, 9)
out = window`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);
    expect(result.returned.window).toEqual([[9, 3]]);
    expect(result.returned.out).toEqual([[9, 3]]);
  });

  it("does not evaluate an invalidated slice only because it appears in the public snapshot", async () => {
    const compiled = program(`//@version=6
indicator("Unused invalidated slice")
var parent = array.from(1, 2, 3, 4, 5)
var window = array.slice(parent, 3, 5)
array.remove(parent, 0)
out = 1`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);
    expect(result.returned.out).toEqual([1]);
  });

  it("returns the mutated matrix from matrix.concat in an executable script", async () => {
    const compiled = program(`//@version=6
indicator("Concatenated matrix")
a = matrix.new<int>(1, 1, 1)
b = matrix.new<int>(1, 1, 2)
matrix<int> combined = matrix.concat(a, b)
count = matrix.elements_count(combined)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);
    expect(result.returned.count).toEqual([2]);
  });

  it("rejects invalid explicit time and format-time zones with typed Pine errors", async () => {
    for (const expression of [
      'time("D", "", "Mars/Olympus")',
      'time_close("D", "", "Mars/Olympus")',
      'str.format_time(time, "yyyy", "Mars/Olympus")',
    ]) {
      const compiled = program(`//@version=6\nindicator("Invalid zone")\nvalue = ${expression}`);
      await expect(new PineEngine().createSession(compiled).runBatch([bar(0)]))
        .rejects.toBeInstanceOf(PineRuntimeError);
    }
  });

  it("executes chart presentation context and defaults absent symbol facts by Pine type", async () => {
    const compiled = program(`//@version=6
indicator("Chart presentation contract")
background = chart.bg_color
foreground = chart.fg_color
leftVisible = chart.left_visible_bar_time
rightVisible = chart.right_visible_bar_time
currentContract = syminfo.current_contract
employees = syminfo.employees
industry = syminfo.industry
isin = syminfo.isin
sector = syminfo.sector
shareholders = syminfo.shareholders
minimumContract = syminfo.mincontract`);
    const populated = await new PineEngine().createSession(compiled, {
      chartColors: { background: "#010203", foreground: "#fefdfc" },
      visibleRange: { left: 10, right: 20 },
      symbolInfo: {
        current_contract: "ESZ2026", employees: 164_000, industry: "Consumer Electronics",
        isin: "US0378331005", sector: "Electronic Technology", shareholders: 23_763,
      },
    }).runBatch([bar(0)]);

    expect(populated.returned).toMatchObject({
      background: ["#010203"], foreground: ["#fefdfc"], leftVisible: [10], rightVisible: [20],
      currentContract: ["ESZ2026"], employees: [164_000], industry: ["Consumer Electronics"],
      isin: ["US0378331005"], sector: ["Electronic Technology"], shareholders: [23_763],
      minimumContract: [Number.NaN],
    });

    const absent = await new PineEngine().createSession(compiled).runBatch([bar(100, 200)]);
    expect(absent.returned).toMatchObject({
      leftVisible: [100], rightVisible: [100], currentContract: [""], industry: [""], isin: [""], sector: [""],
      minimumContract: [Number.NaN],
    });
    expect(Number.isNaN(absent.returned.employees?.[0] as number)).toBe(true);
    expect(Number.isNaN(absent.returned.shareholders?.[0] as number)).toBe(true);
  });

  it("executes chart-type flags and the remaining host-backed symbol fields", async () => {
    const compiled = program(`//@version=6
indicator("Chart and symbol contract")
standard = chart.is_standard
heikinAshi = chart.is_heikinashi
kagi = chart.is_kagi
lineBreak = chart.is_linebreak
pointAndFigure = chart.is_pnf
rangeBars = chart.is_range
renko = chart.is_renko
minimumContract = syminfo.mincontract
symbolType = syminfo.type
volumeType = syminfo.volumetype`);
    const symbolInfo: SymbolInfo = { mincontract: 0.001, type: "forex", volumetype: "tick" };
    const chartTypes = ["standard", "heikinashi", "kagi", "linebreak", "pnf", "range", "renko"] as const;

    for (const chartType of chartTypes) {
      const result = await new PineEngine().createSession(compiled, { chartType, symbolInfo }).runBatch([bar(0)]);
      expect(result.returned).toMatchObject({
        standard: [chartType === "standard"],
        heikinAshi: [chartType === "heikinashi"],
        kagi: [chartType === "kagi"],
        lineBreak: [chartType === "linebreak"],
        pointAndFigure: [chartType === "pnf"],
        rangeBars: [chartType === "range"],
        renko: [chartType === "renko"],
        minimumContract: [0.001],
        symbolType: ["forex"],
        volumeType: ["tick"],
      });
    }
  });

  it("does not implicitly inherit chart type in request.security child sessions", async () => {
    const compiled = program(`//@version=6
indicator("Child chart type")
root = chart.is_heikinashi
child = request.security(syminfo.tickerid, timeframe.period, chart.is_heikinashi)`);
    const result = await new PineEngine().createSession(compiled, {
      chartType: "heikinashi",
      timeframe: "D",
      symbolInfo: { tickerid: "NASDAQ:TEST" },
    }).runBatch([bar(0)]);
    expect(result.returned.root).toEqual([true]);
    expect(result.returned.child).toEqual([false]);
  });

  it("executes production timeframe flags and extended symbol information", async () => {
    const compiled = program(`//@version=6
indicator("Chart context contract")
ticks = timeframe.isticks
seconds = timeframe.isseconds
minutes = timeframe.isminutes
dwm = timeframe.isdwm
base = syminfo.basecurrency
country = syminfo.country
mainTicker = syminfo.main_tickerid
minimumMove = syminfo.minmove
pointValue = syminfo.pointvalue
priceScale = syminfo.pricescale`);
    const symbolInfo: SymbolInfo = {
      ticker: "EURUSD",
      tickerid: "OANDA:EURUSD",
      main_tickerid: "OANDA:EURUSD",
      basecurrency: "EUR",
      country: "US",
      minmove: 1,
      pointvalue: 100_000,
      pricescale: 100_000,
    };
    const execute = (timeframe: string) => new PineEngine().createSession(compiled, { timeframe, symbolInfo }).runBatch([bar(0)]);
    const [ticks, seconds, minutes, daily] = await Promise.all([execute("10T"), execute("30S"), execute("60"), execute("D")]);

    expect(ticks.returned).toMatchObject({ ticks: [true], seconds: [false], minutes: [false], dwm: [false] });
    expect(seconds.returned).toMatchObject({ ticks: [false], seconds: [true], minutes: [false], dwm: [false] });
    expect(minutes.returned).toMatchObject({ ticks: [false], seconds: [false], minutes: [true], dwm: [false] });
    expect(daily.returned).toMatchObject({ ticks: [false], seconds: [false], minutes: [false], dwm: [true] });
    for (const result of [ticks, seconds, minutes, daily]) {
      expect(result.returned).toMatchObject({
        base: ["EUR"],
        country: ["US"],
        mainTicker: ["OANDA:EURUSD"],
        minimumMove: [1],
        pointValue: [100_000],
        priceScale: [100_000],
      });
    }
  });

  it("executes the complete OHLC timeframe surface across every timeframe class", async () => {
    const compiled = program(`//@version=6
indicator("Complete timeframe surface")
changed = timeframe.change("D")
fromSeconds = timeframe.from_seconds(3600)
inSeconds = timeframe.in_seconds("D")
daily = timeframe.isdaily
dwm = timeframe.isdwm
intraday = timeframe.isintraday
minutes = timeframe.isminutes
monthly = timeframe.ismonthly
seconds = timeframe.isseconds
ticks = timeframe.isticks
weekly = timeframe.isweekly
mainPeriod = timeframe.main_period
multiplier = timeframe.multiplier
period = timeframe.period`);
    const start = Date.UTC(2025, 0, 1, 23, 30);
    const bars = [bar(start), bar(Date.UTC(2025, 0, 2))];
    const execute = (timeframe: string) => new PineEngine().createSession(compiled, {
      mainTimeframe: "D",
      timeframe,
    }).runBatch(bars);
    const cases = [
      { timeframe: "10T", period: "10T", multiplier: 10, daily: false, dwm: false, minutes: false, monthly: false, seconds: false, ticks: true, weekly: false },
      { timeframe: "30S", period: "30S", multiplier: 30, daily: false, dwm: false, minutes: false, monthly: false, seconds: true, ticks: false, weekly: false },
      { timeframe: "30", period: "30", multiplier: 30, daily: false, dwm: false, minutes: true, monthly: false, seconds: false, ticks: false, weekly: false },
      { timeframe: "D", period: "1D", multiplier: 1, daily: true, dwm: true, minutes: false, monthly: false, seconds: false, ticks: false, weekly: false },
      { timeframe: "W", period: "1W", multiplier: 1, daily: false, dwm: true, minutes: false, monthly: false, seconds: false, ticks: false, weekly: true },
      { timeframe: "M", period: "1M", multiplier: 1, daily: false, dwm: true, minutes: false, monthly: true, seconds: false, ticks: false, weekly: false },
    ] as const;

    for (const item of cases) {
      const result = await execute(item.timeframe);
      expect(result.returned).toMatchObject({
        changed: [false, true],
        fromSeconds: ["60", "60"],
        inSeconds: [86_400, 86_400],
        daily: [item.daily, item.daily],
        dwm: [item.dwm, item.dwm],
        intraday: [!item.dwm, !item.dwm],
        minutes: [item.minutes, item.minutes],
        monthly: [item.monthly, item.monthly],
        seconds: [item.seconds, item.seconds],
        ticks: [item.ticks, item.ticks],
        weekly: [item.weekly, item.weekly],
        // Pine v6 keeps the multiplier on daily, weekly and monthly periods.
        mainPeriod: ["1D", "1D"],
        multiplier: [item.multiplier, item.multiplier],
        period: [item.period, item.period],
      });
    }
  });

  it("executes timeframe conversion, dual offsets, and drawing reference casts", async () => {
    const compiled = program(`//@version=6
indicator("Time and reference callable contract")
chartSeconds = timeframe.in_seconds()
emptySeconds = timeframe.in_seconds("")
daySeconds = timeframe.in_seconds("D")
dayFrame = timeframe.from_seconds(86400)
weekFrame = timeframe.from_seconds(604800)
dayOpen = time("D")
previousDayOpen = time("D", timeframe_bars_back = 1)
previousDayClose = time_close("D", timeframe_bars_back = 1)
previousChartOpen = time("", bars_back = 1)
asBox = box(na)
asLabel = label(na)
asLine = line(na)
asLinefill = linefill(na)
asPolyline = polyline(na)
asTable = table(na)`);
    const firstOpen = Date.UTC(2025, 0, 1, 23);
    const secondOpen = Date.UTC(2025, 0, 2, 0);
    const result = await new PineEngine().createSession(compiled, { timeframe: "60" }).runBatch([
      bar(firstOpen, firstOpen + 3_600_000),
      bar(secondOpen, secondOpen + 3_600_000),
    ]);

    expect(result.returned).toMatchObject({
      chartSeconds: [3_600, 3_600],
      emptySeconds: [3_600, 3_600],
      daySeconds: [86_400, 86_400],
      dayFrame: ["1D", "1D"],
      weekFrame: ["1W", "1W"],
      dayOpen: [Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2)],
      previousDayOpen: [Date.UTC(2024, 11, 31), Date.UTC(2025, 0, 1)],
      previousDayClose: [Date.UTC(2025, 0, 1), Date.UTC(2025, 0, 2)],
      previousChartOpen: [Number.NaN, firstOpen],
      asBox: [Number.NaN, Number.NaN],
      asLabel: [Number.NaN, Number.NaN],
      asLine: [Number.NaN, Number.NaN],
      asLinefill: [Number.NaN, Number.NaN],
      asPolyline: [Number.NaN, Number.NaN],
      asTable: [Number.NaN, Number.NaN],
    });
  });

  it("matches the reference platform's timeframe rounding and bounded random ranges", async () => {
    const compiled = program(`//@version=6
indicator("Timeframe boundary oracle")
zeroSeconds = timeframe.from_seconds(0)
oneSecond = timeframe.from_seconds(1)
twoSeconds = timeframe.from_seconds(2)
sixteenSeconds = timeframe.from_seconds(16)
thirtyOneSeconds = timeframe.from_seconds(31)
sixtySeconds = timeframe.from_seconds(60)
sixtyOneSeconds = timeframe.from_seconds(61)
lastIntraday = timeframe.from_seconds(86399)
firstDaily = timeframe.from_seconds(86400)
afterDaily = timeframe.from_seconds(86401)
exactWeek = timeframe.from_seconds(604800)
afterWeek = timeframe.from_seconds(604801)
boundedRandom = math.random(10, 20)
fixedRandom = math.random(5, 5)
negativeTick = math.round_to_mintick(-1.2345)
negativeTickText = str.tostring(-1.2345, format.mintick)`);
    const result = await new PineEngine().createSession(compiled, {
      randomSeed: 42,
      symbolInfo: { ticker: "XAUUSD", tickerid: "OANDA:XAUUSD", mintick: 0.001 },
    }).runBatch([bar(Date.UTC(2025, 0, 1))]);

    expect(result.returned).toMatchObject({
      zeroSeconds: ["1S"],
      oneSecond: ["1S"],
      twoSeconds: ["5S"],
      sixteenSeconds: ["30S"],
      thirtyOneSeconds: ["1"],
      sixtySeconds: ["1"],
      sixtyOneSeconds: ["2"],
      lastIntraday: ["1440"],
      firstDaily: ["1D"],
      afterDaily: ["2D"],
      exactWeek: ["1W"],
      afterWeek: ["8D"],
      fixedRandom: [5],
      negativeTick: [-1.235],
      negativeTickText: ["-1.235"],
    });
    expect(result.returned.boundedRandom?.[0]).toBeGreaterThanOrEqual(10);
    expect(result.returned.boundedRandom?.[0]).toBeLessThan(20);
  });

  it("executes the advertised core casts, string helpers, and timeframe change", async () => {
    const compiled = program(`//@version=6
indicator("Core callable contract")
asBoolFalse = bool(0)
asBoolTrue = bool(-1)
asColor = color(#112233)
asFloat = float(10)
asInt = int(10.9)
isMissing = na(na)
asString = string(42)
formatted = str.format("Price {0,number,#.##} / {1}", 123.456, "ok")
compact = str.format("{0,number,#.#}B", 1)
padded = str.format("{0,number,0.000}", 1.2)
grouped = str.format("{0,number,#,###.##}", 1234.5)
percent = str.format("{0,number,#.##%}", 0.1234)
unknownPlaceholder = str.format("Keep {2}", 1)
matched = str.match("hello NASDAQ:AAPL!", "[A-Z]+:[A-Z]+")
missing = str.match("abc", "[0-9]+")
repeated = str.repeat("ab", 3, "-")
changed = timeframe.change("D")`);
    const result = await new PineEngine().createSession(compiled, { timeframe: "60" }).runBatch([
      bar(Date.UTC(2025, 0, 1, 23)),
      bar(Date.UTC(2025, 0, 2, 0)),
    ]);

    expect(result.returned).toMatchObject({
      asBoolFalse: [false, false],
      asBoolTrue: [true, true],
      asColor: ["#112233", "#112233"],
      asFloat: [10, 10],
      asInt: [10, 10],
      isMissing: [true, true],
      asString: ["42", "42"],
      formatted: ["Price 123.46 / ok", "Price 123.46 / ok"],
      compact: ["1B", "1B"],
      padded: ["1.200", "1.200"],
      grouped: ["1,234.5", "1,234.5"],
      percent: ["12.34%", "12.34%"],
      unknownPlaceholder: ["Keep {2}", "Keep {2}"],
      matched: ["NASDAQ:AAPL", "NASDAQ:AAPL"],
      missing: ["", ""],
      repeated: ["ab-ab-ab", "ab-ab-ab"],
      changed: [false, true],
    });
  });

  it("keeps strict random call sites isolated while preserving sealed stream ordering", async () => {
    const source = `//@version=6
indicator("Random call-site ownership")
first = math.random()
second = math.random()
missing = bar_index == 2 ? na : close
rolling = math.sum(missing, 2)
rounded = math.round_to_mintick(-1.25)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    const inputBars = Array.from({ length: 5 }, (_, index) => ({
      ...bar(index * 60_000),
      close: index + 1,
    }));
    const engine = new PineEngine();
    const strictResult = await engine.createSession(strict, {
      randomSeed: 42,
      symbolInfo: { mintick: 0.5 },
    }).runBatch(inputBars);
    const sealedResult = await engine.createSession(sealed.program!, {
      randomSeed: 42,
      symbolInfo: { mintick: 0.5 },
    }).runBatch(inputBars);

    const isolatedSequence = [
      0.2523451747838408,
      0.08812504541128874,
      0.5772811982315034,
      0.22255426598712802,
      0.37566019711084664,
    ];
    expect(strictResult.returned.first).toEqual(isolatedSequence);
    expect(strictResult.returned.second).toEqual(isolatedSequence);
    expect(strictResult.returned.rolling).toEqual([Number.NaN, 3, 3, 6, 9]);
    expect(strictResult.returned.rounded).toEqual([-1.5, -1.5, -1.5, -1.5, -1.5]);
    expect(sealedResult.returned.first).toEqual([
      0.2523451747838408,
      0.5772811982315034,
      0.37566019711084664,
      0.4472812858875841,
      0.8738137057516724,
    ]);
    expect(sealedResult.returned.second).toEqual([
      0.08812504541128874,
      0.22255426598712802,
      0.02566390484571457,
      0.1184600037522614,
      0.9946342753246427,
    ]);
    expect(sealedResult.returned.rolling).toEqual([Number.NaN, 3, Number.NaN, Number.NaN, 9]);
    expect(sealedResult.returned.rounded).toEqual([-1.5, -1.5, -1.5, -1.5, -1.5]);
  });

  it("replays explicit random seeds and resets a call site when its seed changes", async () => {
    const compiled = program(`//@version=6
indicator("Explicit random seeds")
int selectedSeed = bar_index < 3 ? 42 : 43
seeded = math.random(seed = selectedSeed)
bounded = math.random(min = -2, max = 3, seed = selectedSeed)
fixed = math.random(5, 5, selectedSeed)`);
    const inputBars = Array.from({ length: 5 }, (_, index) => bar(index * 60_000));
    const result = await new PineEngine().createSession(compiled).runBatch(inputBars);
    const units = [
      0.2523451747838408,
      0.08812504541128874,
      0.5772811982315034,
      0.25273272721096873,
      0.17882881057448685,
    ];
    expect(result.returned.seeded).toEqual(units);
    expect(result.returned.bounded).toEqual(units.map((value) => -2 + 5 * value));
    expect(result.returned.fixed).toEqual([5, 5, 5, 5, 5]);
  });

  it("rounds strict values to default and supplied minticks with half ties away from zero", async () => {
    const compiled = program(`//@version=6
indicator("Mintick rounding")
rounded = math.round_to_mintick(close)
missing = math.round_to_mintick(na)`);
    const values = [1.004, 1.005, 1.006, -1.004, -1.005, -1.006, 0];
    const inputBars = values.map((close, index) => ({ ...bar(index * 60_000), close }));
    const engine = new PineEngine();
    const defaultTick = await engine.createSession(compiled).runBatch(inputBars);
    const nondecimalTick = await engine.createSession(compiled, { symbolInfo: { mintick: 0.25 } }).runBatch(
      [1, 1.124, 1.125, 1.126, -1.124, -1.125, -1.126, 0].map((close, index) => ({
        ...bar(index * 60_000),
        close,
      })),
    );

    expect(defaultTick.returned.rounded).toEqual([1, 1.01, 1.01, -1, -1.01, -1.01, 0]);
    expect(defaultTick.returned.missing).toEqual(values.map(() => Number.NaN));
    expect(nondecimalTick.returned.rounded).toEqual([1, 1, 1.25, 1.25, -1, -1.25, -1.25, 0]);
  });

  it("keeps large exact ticks fixed and distinguishes representable half neighbors", async () => {
    const large = program(`//@version=6
indicator("Large mintick rounding")
positiveExact = math.round_to_mintick(1000000000000000.0)
positiveBelow = math.round_to_mintick(1000000000000000.4)
positiveTie = math.round_to_mintick(1000000000000000.5)
positiveAbove = math.round_to_mintick(1000000000000000.6)
negativeExact = math.round_to_mintick(-1000000000000000.0)
negativeBelow = math.round_to_mintick(-1000000000000000.6)
negativeTie = math.round_to_mintick(-1000000000000000.5)
negativeAbove = math.round_to_mintick(-1000000000000000.4)`);
    const decimal = program(`//@version=6
indicator("Decimal mintick neighbors")
positiveBelow = math.round_to_mintick(1.0049999999999997)
positiveTie = math.round_to_mintick(1.005)
positiveAbove = math.round_to_mintick(1.0050000000000001)
negativeBelow = math.round_to_mintick(-1.0050000000000001)
negativeTie = math.round_to_mintick(-1.005)
negativeAbove = math.round_to_mintick(-1.0049999999999997)`);
    const engine = new PineEngine();
    const largeResult = await engine.createSession(large, { symbolInfo: { mintick: 1 } }).runBatch([bar(0)]);
    const decimalResult = await engine.createSession(decimal).runBatch([bar(0)]);

    expect(largeResult.returned).toMatchObject({
      positiveExact: [1_000_000_000_000_000],
      positiveBelow: [1_000_000_000_000_000],
      positiveTie: [1_000_000_000_000_001],
      positiveAbove: [1_000_000_000_000_001],
      negativeExact: [-1_000_000_000_000_000],
      negativeBelow: [-1_000_000_000_000_001],
      negativeTie: [-1_000_000_000_000_001],
      negativeAbove: [-1_000_000_000_000_000],
    });
    expect(decimalResult.returned).toMatchObject({
      positiveBelow: [1],
      positiveTie: [1.01],
      positiveAbove: [1.01],
      negativeBelow: [-1.01],
      negativeTie: [-1.01],
      negativeAbove: [-1],
    });
  });

  it("preserves finite values when mintick division overflows", async () => {
    const compiled = program(`//@version=6
indicator("Tiny mintick rounding")
rounded = math.round_to_mintick(close)`);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { mintick: Number.MIN_VALUE },
    }).runBatch([{ ...bar(0), close: 1 }]);

    expect(result.returned.rounded).toEqual([1]);
  });

  it("restores bounded non-missing sum history across eviction and tail replacement", async () => {
    const direct = program(`//@version=6
indicator("Bounded sum rollback")
rolling = math.sum(close, 5000)`);
    const missing = program(`//@version=6
indicator("Bounded missing sum rollback")
sample = close == 0 ? na : close
rolling = math.sum(sample, 5000)`);
    const bars = Array.from({ length: 5_001 }, (_, index): MarketBar => ({
      ...bar(index * 60_000),
      close: index + 1,
    }));
    const replacement = { ...bars.at(-1)!, close: 0 };
    const continuation = { ...bar(5_001 * 60_000), close: 5_002 };
    const engine = new PineEngine();

    const directSession = engine.createSession(direct);
    await directSession.runBatch(bars.slice(0, -1));
    const checkpoint = JSON.parse(JSON.stringify(directSession.checkpoint())) as SessionCheckpoint;
    const appended = await directSession.appendBars(bars.slice(-1));
    expect(appended.returned.rolling?.at(-1)).toBe(12_507_500);
    await directSession.restore(checkpoint);
    const replayed = await directSession.appendBars(bars.slice(-1));
    expect(replayed.returned).toEqual(appended.returned);
    const replaced = await directSession.replaceTail([replacement]);
    const repeated = await directSession.replaceTail([replacement]);
    const freshDirect = await engine.createSession(direct).runBatch([...bars.slice(0, -1), replacement]);
    expect(replaced.returned).toEqual(freshDirect.returned);
    expect(repeated.returned).toEqual(freshDirect.returned);
    expect(replaced.returned.rolling?.at(-1)).toBe(12_502_499);

    const missingSession = engine.createSession(missing);
    await missingSession.runBatch(bars);
    const missingReplaced = await missingSession.replaceTail([replacement]);
    const freshMissing = await engine.createSession(missing).runBatch([...bars.slice(0, -1), replacement]);
    expect(missingReplaced.returned).toEqual(freshMissing.returned);
    expect(missingReplaced.returned.rolling?.at(-1)).toBe(12_502_500);
    const continued = await missingSession.appendBars([continuation]);
    const freshContinued = await engine.createSession(missing)
      .runBatch([...bars.slice(0, -1), replacement, continuation]);
    expect(continued.returned).toEqual(freshContinued.returned);
  });

  it("rejects strict invalid math lengths, random bounds and host minticks", async () => {
    const invalidSources = [
      { source: "value = math.sum(close, 0)", message: "integer from 1 to 5000" },
      { source: "value = math.sum(close, 5001)", message: "integer from 1 to 5000" },
      { source: "value = math.random(2, 1, 42)", message: "min not greater than max" },
      { source: "value = math.random(0, math.exp(1000), 42)", message: "bounds must be finite" },
      { source: "value = math.random(seed = -1)", message: "integer from 0 to 4294967295" },
      { source: "value = math.random(seed = 4294967296)", message: "integer from 0 to 4294967295" },
    ];
    for (const invalid of invalidSources) {
      const compiled = program(`//@version=6\nindicator("Invalid remaining math")\n${invalid.source}`);
      await expect(new PineEngine().createSession(compiled).runBatch([bar(0)]), invalid.source)
        .rejects.toThrow(invalid.message);
    }

    const rounding = program(`//@version=6\nindicator("Invalid mintick")\nvalue = math.round_to_mintick(close)`);
    for (const mintick of [0, -0.01]) {
      await expect(new PineEngine().createSession(rounding, { symbolInfo: { mintick } }).runBatch([bar(0)]))
        .rejects.toThrow("finite positive host mintick");
    }
    for (const mintick of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PineEngine().createSession(rounding, { symbolInfo: { mintick } }))
        .toThrow("expected a finite number");
    }
  });

  it("matches Unicode string positions, strict number parsing, and timezone-aware time formatting", async () => {
    const compiled = program(`//@version=6
indicator("String parity")
unicodeLength = str.length("A😀B")
unicodePosition = str.pos("A😀B", "B")
unicodeSubstring = str.substring("A😀B", 1, 2)
unicodeParts = str.split("A😀B", "")
blankNumber = str.tonumber("  ")
infiniteNumber = str.tonumber("Infinity")
whitespaceNumber = str.tonumber(" 12.5 ")
scientificNumber = str.tonumber("1e2")
hexNumber = str.tonumber("0x10")
asciiLower = str.lower("ÄBC")
asciiUpper = str.upper("éab")
asciiTrim = str.trim("\u2002\\t value \\n\u2002")
emptyBoundary = str.replace("A😀B", "", "-", 2)
allBoundaries = str.replace_all("😀", "", "-")
emptySubstring = str.substring("", 0)
emptySubstringRange = str.substring("", 0, 0)
emptySubstringTail = str.substring("", 0, 10)
hugeEmptyRepeat = str.repeat("", 4294967296)
defaultTime = str.format_time(time)
newYorkTime = str.format_time(time, "yyyy-MM-dd HH:mm:ss.SSS Z z", "America/New_York")
epochFromNa = str.format_time(na, "yyyy-MM-dd HH:mm:ss", "UTC0")`);
    const timestamp = Date.UTC(2025, 2, 9, 8, 7, 8, 90);
    const result = await new PineEngine().createSession(compiled, {
      timezone: "UTC",
    }).runBatch([bar(timestamp)]);

    expect(result.returned).toMatchObject({
      unicodeLength: [3],
      unicodePosition: [2],
      unicodeSubstring: ["😀"],
      unicodeParts: [["A", "😀", "B"]],
      asciiLower: ["Äbc"],
      asciiUpper: ["éAB"],
      asciiTrim: ["\u2002\t value \n\u2002"],
      emptyBoundary: ["A😀-B"],
      allBoundaries: ["-😀-"],
      emptySubstring: [""],
      emptySubstringRange: [""],
      emptySubstringTail: [""],
      hugeEmptyRepeat: [""],
      defaultTime: ["2025-03-09T08:07:08+0000"],
      newYorkTime: ["2025-03-09 04:07:08.090 -0400 EDT"],
      epochFromNa: ["1970-01-01 00:00:00"],
    });
    expect(Number.isNaN(result.returned.blankNumber?.[0] as number)).toBe(true);
    expect(Number.isNaN(result.returned.infiniteNumber?.[0] as number)).toBe(true);
    expect(result.returned.whitespaceNumber).toEqual([12.5]);
    expect(Number.isNaN(result.returned.scientificNumber?.[0] as number)).toBe(true);
    expect(Number.isNaN(result.returned.hexNumber?.[0] as number)).toBe(true);
  });

  it("admits empty substring endpoints and rejects invalid literal or series ranges", async () => {
    const declaration = '//@version=6\nindicator("String bounds")\n';
    for (const expression of [
      'str.substring("abc", -1)',
      'str.substring("abc", 2, 1)',
      'str.substring("", 0, -1)',
    ]) {
      const result = compile({ source: `${declaration}value = ${expression}`, compatibility: PINE_COMPATIBILITY.strict });
      expect(result.diagnostics.some(({ code, message }) => code === "SCRIPT2117" && message.includes("begin_pos"))).toBe(true);
    }
    const compiled = program(`${declaration}end = str.substring("abc", 3)
equal = str.substring("abc", 1, 1)
clipped = str.substring("abc", 0, 4)`);
    const session = new PineEngine().createSession(compiled);
    try {
      expect((await session.runBatch([bar(0)])).returned).toMatchObject({ end: [""], equal: [""], clipped: ["abc"] });
    } finally {
      await session.close();
    }
    for (const expression of [
      'str.substring("abc", bar_index >= 0 ? -1 : 0, 2)',
      'str.repeat("x", -1)',
      'str.repeat("x", 40961)',
    ]) {
      const session = new PineEngine().createSession(program(`${declaration}value = ${expression}`));
      try {
        await expect(session.runBatch([bar(0)])).rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
      } finally {
        await session.close();
      }
    }
  });

  it("matches the reference platform's string formatting and Java-style regex semantics", async () => {
    const compiled = program(`//@version=6
indicator("String oracle parity")
optionalDigits = str.tostring(1.2, "#.##")
paddedDigits = str.tostring(1.2, "#.00")
groupedDigits = str.tostring(1234.5, "#,###.00")
tickDigits = str.tostring(4378.385, format.mintick)
abbreviatedVolume = str.tostring(1222333.0, format.volume)
absoluteStart = str.match("abc xyz", "\\\\A\\\\w+")
finalLineEnd = str.match("abc xyz\\n", "\\\\w+\\\\Z")
absoluteEnd = str.match("abc xyz\\n", "\\\\w+\\\\z")
caseInsensitive = str.match("AbC", "(?i)abc")
multiline = str.match("a\\nb", "(?m)^b")
quotedPattern = str.match("a+b", "\\\\Qa+b\\\\E")
formattedDateTime = str.format("{0,date,yyyy-MM-dd}T{0,time,HH:mm:ssZ}", time)
midnightTwelveHour = str.format_time(timestamp("UTC", 2025, 1, 1, 0, 5), "hh h a", "UTC")
noonTwelveHour = str.format_time(timestamp("UTC", 2025, 1, 1, 12, 5), "hh h a", "UTC")`);
    const timestamp = Date.UTC(2025, 2, 9, 8, 7, 8);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "XAUUSD", tickerid: "OANDA:XAUUSD", mintick: 0.001 },
    }).runBatch([bar(timestamp)]);

    expect(result.returned).toMatchObject({
      optionalDigits: ["1.2"],
      paddedDigits: ["1.20"],
      groupedDigits: ["1,234.50"],
      tickDigits: ["4378.385"],
      abbreviatedVolume: ["1.222M"],
      absoluteStart: ["abc"],
      finalLineEnd: ["xyz"],
      absoluteEnd: [""],
      caseInsensitive: ["AbC"],
      multiline: ["b"],
      quotedPattern: ["a+b"],
      formattedDateTime: ["2025-03-09T08:07:08+0000"],
      midnightTwelveHour: ["12 12 AM"],
      noonTwelveHour: ["12 12 PM"],
    });
  });

  it("executes the bounded advanced-string profile with exact scalar outputs", async () => {
    const compiled = program(`//@version=6
indicator("Advanced string profile")
reordered = str.format("{1}/{0}/{1}", bar_index, "x")
quoted = str.format("'{'{0}'}' ''{1}''", "x", "y")
numeric = str.format("{0,number,#,###.00}|{1,number,#.##%}", -1234.5, 0.125)
missingArgument = str.format("keep {2}", 1)
defaultTime = str.format_time(time)
newYorkTime = str.format_time(time, "yyyy-MM-dd HH:mm:ss S SS SSS Z z", "America/New_York")
fixedOffset = str.format_time(time, timezone = "UTC+5:45", format = "yyyy-MM-dd HH:mm Z")
firstMatch = str.match("xx 123 yy 456", "\\\\d+")
unicodeMatch = str.match("123-éclair", "\\\\p{L}+")
caseMatch = str.match("AbC", "(?i)^abc$")
quotedMatch = str.match("a+b", "\\\\Qa+b\\\\E")
noMatch = str.match("abc", "^z+$")
emptyMatch = str.match("", "")
defaultInt = str.tostring(42)
defaultFloat = str.tostring(1.25)
defaultBool = str.tostring(true)
defaultString = str.tostring("text")
arrayText = str.tostring(array.from(1, 2))
missingText = str.tostring(na)
positiveInfinity = str.tostring(1.0 / 0.0)
optionalDigits = str.tostring(1.2, "#.##")
mandatoryDigits = str.tostring(1.2, "#.00")
groupedDigits = str.tostring(-1234.5, "#,###.00")
tickText = str.tostring(1.375, format.mintick)
priceText = str.tostring(-1.375, format.price)
percentText = str.tostring(0.1234, format.percent)
volumeText = str.tostring(1222333.0, format.volume)`);
    const result = await new PineEngine().createSession(compiled, {
      timezone: "UTC+5:45",
      symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.25 },
    }).runBatch([
      bar(Date.UTC(2025, 2, 9, 6, 30, 0, 90)),
      bar(Date.UTC(2025, 2, 9, 7, 30, 0, 90)),
    ]);

    expect(result.returned).toMatchObject({
      reordered: ["x/0/x", "x/1/x"],
      quoted: ["{x} 'y'", "{x} 'y'"],
      numeric: ["-1,234.50|12.5%", "-1,234.50|12.5%"],
      missingArgument: ["keep {2}", "keep {2}"],
      defaultTime: ["2025-03-09T12:15:00+0545", "2025-03-09T13:15:00+0545"],
      newYorkTime: [
        "2025-03-09 01:30:00 0 09 090 -0500 EST",
        "2025-03-09 03:30:00 0 09 090 -0400 EDT",
      ],
      fixedOffset: ["2025-03-09 12:15 +0545", "2025-03-09 13:15 +0545"],
      firstMatch: ["123", "123"],
      unicodeMatch: ["éclair", "éclair"],
      caseMatch: ["AbC", "AbC"],
      quotedMatch: ["a+b", "a+b"],
      noMatch: ["", ""],
      emptyMatch: ["", ""],
      defaultInt: ["42", "42"],
      defaultFloat: ["1.25", "1.25"],
      defaultBool: ["true", "true"],
      defaultString: ["text", "text"],
      arrayText: ["[1, 2]", "[1, 2]"],
      missingText: ["NaN", "NaN"],
      positiveInfinity: ["NaN", "NaN"],
      optionalDigits: ["1.2", "1.2"],
      mandatoryDigits: ["1.20", "1.20"],
      groupedDigits: ["-1,234.50", "-1,234.50"],
      tickText: ["1.50", "1.50"],
      priceText: ["-price1", "-price1"],
      percentText: ["0.12%", "0.12%"],
      volumeText: ["1.222M", "1.222M"],
    });
  });

  it("counts Unicode formatter literals and placeholders by code point at the exact limit", async () => {
    const belowLimit = "😀".repeat(40_959);
    const exactLimit = "😀".repeat(40_960);
    const compiled = program(`//@version=6
indicator("Advanced Unicode string limits")
literalExact = str.format("${exactLimit}")
placeholderBelow = str.format("{0}", "${belowLimit}")
timeExact = str.format_time(0, "${exactLimit}", "UTC")
limitsValid = str.length(literalExact) == 40960 and str.length(placeholderBelow) == 40959 and str.length(timeExact) == 40960`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);

    expect(result.returned.limitsValid).toEqual([true]);
  });

  it("supports balanced quoted numeric affixes and escaped apostrophes", async () => {
    const compiled = program(`//@version=6
indicator("Quoted numeric patterns")
quotedPrefix = str.tostring(1.2, "'USD '0.00")
quotedSuffix = str.tostring(1.2, "0.00' kg'")
escapedApostrophe = str.tostring(1, "'it''s '0")
literalApostrophe = str.tostring(1, "''0")`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);

    expect(result.returned).toMatchObject({
      quotedPrefix: ["USD 1.20"],
      quotedSuffix: ["1.20 kg"],
      escapedApostrophe: ["it's 1"],
      literalApostrophe: ["'1"],
    });
  });

  it("rejects malformed or unbounded advanced string work with Pine runtime errors", async () => {
    const oversized = "x".repeat(40_961);
    const oversizedEmoji = "😀".repeat(40_961);
    for (const source of [
      'value = str.format("unclosed {0", 1)',
      'value = str.format("unterminated \'quote", 1)',
      `value = str.format("{0}", "${oversized}")`,
      `value = str.format("${oversizedEmoji}")`,
      'value = str.format_time(time, "yyyy-\'open", "UTC")',
      `value = str.format_time(time, "${oversizedEmoji}", "UTC")`,
      'value = str.format_time(time, "yyyy", "Mars/Olympus")',
      'value = str.match("abc", "[")',
      `value = str.match("abc", "${oversized}")`,
      'value = str.tostring(1.25, "#.000000000000000000000")',
      'value = str.tostring(1, "\'foo0")',
    ]) {
      const compiled = program(`//@version=6\nindicator("Advanced string bounds")\n${source}`);
      await expect(new PineEngine().createSession(compiled).runBatch([bar(0)]), source)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
    }
  });

  it("isolates strict TA boolean change and zero-denominator ROC from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated TA history")
changed = ta.change(close > 0)
rate = ta.roc(close, 1)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [0, 1].map((close, index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    }));
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.changed).toEqual([false, true]);
    expect(strictResult.returned.rate).toEqual([Number.NaN, Number.NaN]);
    expect(sealedResult.returned.changed).toEqual([Number.NaN, 1]);
    expect(sealedResult.returned.rate).toEqual([Number.NaN, Number.POSITIVE_INFINITY]);
  });

  it("keeps strict TA extrema repairs isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated TA extrema")
lowest = ta.lowest(1)
highestOffset = ta.highestbars(close, 1)
lowestOffset = ta.lowestbars(close, 1)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [{ ...bar(0), high: 10, low: -2 }];
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.lowest).toEqual([-2]);
    expect(sealedResult.returned.lowest).toEqual([10]);
    expect(Object.is(strictResult.returned.highestOffset?.[0], -0)).toBe(false);
    expect(Object.is(strictResult.returned.lowestOffset?.[0], -0)).toBe(false);
    expect(Object.is(sealedResult.returned.highestOffset?.[0], -0)).toBe(true);
    expect(Object.is(sealedResult.returned.lowestOffset?.[0], -0)).toBe(true);
  });

  it("keeps strict TA average bounds isolated from sealed length coercion", async () => {
    const source = `//@version=6
indicator("Profile-isolated TA average bounds")
average = ta.sma(close, 0)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();

    await expect(new PineEngine().createSession(strict).runBatch([bar(0)]))
      .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch([bar(0)]);
    expect(sealedResult.returned.average).toEqual([1]);
  });

  it("keeps strict oscillator bounds isolated from sealed length coercion", async () => {
    const statements = [
      "value = ta.atr(0)",
      "value = ta.rsi(close, 0)",
      "value = ta.cci(close, 0)",
      "value = ta.cmo(close, 0)",
      "value = ta.cog(close, 0)",
      "value = ta.stoch(close, high, low, 0)",
      "value = ta.wpr(0)",
      "value = ta.tsi(close, 2, 0)",
      "[line, signal, histogram] = ta.macd(close, 2, 0, 2)",
      "[plus, minus, adx] = ta.dmi(2, 0)",
    ];
    for (const statement of statements) {
      const source = `//@version=6\nindicator("Profile-isolated oscillator bounds")\n${statement}`;
      const strict = program(source);
      const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
      expect(sealed.diagnostics, statement).toEqual([]);
      expect(sealed.program, statement).toBeDefined();

      await expect(new PineEngine().createSession(strict).runBatch([bar(0), bar(60_000)]), statement)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
      await expect(new PineEngine().createSession(sealed.program!).runBatch([bar(0), bar(60_000)]), statement)
        .resolves.toBeDefined();
    }
  });

  it("keeps strict ta.tr handle_na behavior isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated true range")
withoutFallback = ta.tr(false)
withFallback = ta.tr(true)
variableForm = ta.tr`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [{ ...bar(0), high: 4, low: 1, close: 2 }];
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.withoutFallback).toEqual([Number.NaN]);
    expect(strictResult.returned.withFallback).toEqual([3]);
    expect(strictResult.returned.variableForm).toEqual([3]);
    expect(sealedResult.returned.withoutFallback).toEqual([3]);
    expect(sealedResult.returned.withFallback).toEqual([3]);
    expect(sealedResult.returned.variableForm).toEqual([3]);
  });

  it("keeps strict composed MACD missing-value recovery isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated MACD recovery")
float source = bar_index == 3 ? na : close
[line, signal, histogram] = ta.macd(source, 2, 3, 2)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [1, 2, 3, 4, 5, 6, 7].map((close, index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1,
    }));
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.line).toEqual([Number.NaN, Number.NaN, 0.5, 0.5, 0.6666666667, 0.6388888889, 0.587962963]);
    expect(strictResult.returned.signal).toEqual([Number.NaN, Number.NaN, Number.NaN, 0.5, 0.6111111111, 0.6296296296, 0.6018518519]);
    expect(strictResult.returned.histogram).toEqual([Number.NaN, Number.NaN, Number.NaN, 0, 0.0555555556, 0.0092592593, -0.0138888889]);
    expect(sealedResult.returned.line).toEqual([Number.NaN, Number.NaN, 0.5, Number.NaN, 0.3333333333, 0.5, 0.5277777778]);
    expect(sealedResult.returned.signal).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, 0.4166666667, 0.4722222222, 0.5092592593]);
    expect(sealedResult.returned.histogram).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, -0.0833333333, 0.0277777778, 0.0185185185]);
  });

  it("keeps strict EMA missing-value recovery isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated EMA recovery")
float source = bar_index == 3 ? na : close
average = ta.ema(source, 3)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [1, 2, 3, 4, 5, 6].map((close, index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
    }));
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    // The reference platform returns na on the na bar, then resumes from the held state.
    expect(strictResult.returned.average).toEqual([Number.NaN, Number.NaN, 2, Number.NaN, 3.5, 4.75]);
    expect(sealedResult.returned.average).toEqual([Number.NaN, Number.NaN, 2, Number.NaN, 3.6666666667, 4.8333333333]);
  });

  it("keeps strict ALMA and linear-regression parameter bounds isolated from the sealed profile", async () => {
    for (const expression of ["ta.alma(close, 2, -0.1, 6)", "ta.alma(close, 2, 0.5, 0)", "ta.linreg(close, 2, 5001)"]) {
      const source = `//@version=6\nindicator("Profile-isolated TA parameter bounds")\nvalue = ${expression}`;
      const strict = program(source);
      const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
      expect(sealed.diagnostics, expression).toEqual([]);
      expect(sealed.program, expression).toBeDefined();

      await expect(new PineEngine().createSession(strict).runBatch([bar(0), bar(60_000)]), expression)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
      await expect(new PineEngine().createSession(sealed.program!).runBatch([bar(0), bar(60_000)]), expression)
        .resolves.toBeDefined();
    }
  });

  it("keeps strict TA band and ranked-window bounds isolated from sealed coercion", async () => {
    const statements = [
      "value = ta.bb(close, 0, 2.0)",
      "value = ta.bbw(close, 5001, 2.0)",
      "value = ta.kc(close, 0, 1.5)",
      "value = ta.kcw(close, 5001, 1.5, false)",
      "value = ta.correlation(close, high, 0)",
      "value = ta.median(close, 5001)",
      "value = ta.mode(close, 0)",
      "value = ta.percentile_linear_interpolation(close, 2, -0.1)",
      "value = ta.percentile_nearest_rank(close, 2, 100.1)",
      "value = ta.percentrank(close, 0)",
      "value = ta.bbw(close, 2, 1 / 0)",
    ];
    for (const statement of statements) {
      const source = `//@version=6\nindicator("Profile-isolated TA band/rank bounds")\n${statement}`;
      const strict = program(source);
      const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
      expect(sealed.diagnostics, statement).toEqual([]);
      expect(sealed.program, statement).toBeDefined();

      await expect(new PineEngine().createSession(strict).runBatch([bar(0), bar(60_000)]), statement)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
      await expect(new PineEngine().createSession(sealed.program!).runBatch([bar(0), bar(60_000)]), statement)
        .resolves.toBeDefined();
    }
  });

  it("keeps strict composed Keltner recovery and finite width isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated Keltner recovery")
float source = bar_index == 4 ? na : close
[basis, upper, lower] = ta.kc(source, 2, 1.5, false)
width = ta.kcw(source, 2, 1.5, false)
zeroBasisWidth = ta.kcw(0.0, 2, 1.5, false)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const bars = [1, 2, 3, 4, 5, 6, 7, 8].map((close, index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open: close,
      high: close + 2,
      low: close - 1,
      close,
      volume: 1,
    }));
    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.basis).toEqual([Number.NaN, 1.5, 2.5, 3.5, 3.5, 5.1666666667, 6.3888888889, 7.462962963]);
    expect(strictResult.returned.width).toEqual([Number.NaN, 6, 3.6, 2.5714285714, 2.5714285714, 1.7419354839, 1.4086956522, 1.205955335]);
    expect(strictResult.returned.zeroBasisWidth).toEqual(Array.from({ length: 8 }, () => Number.NaN));
    expect(sealedResult.returned.basis).toEqual([Number.NaN, 1.5, 2.5, 3.5, Number.NaN, 4.5, 6.1666666667, 7.3888888889]);
    expect(sealedResult.returned.width).toEqual([Number.NaN, 6, 3.6, 2.5714285714, Number.NaN, 2, 1.4594594595, 1.2180451128]);
    expect(sealedResult.returned.zeroBasisWidth?.slice(1).every((value) => value === Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("keeps strict volume bounds and corrected indicator formulas isolated from the sealed profile", async () => {
    const formulaSource = `//@version=6
indicator("Profile-isolated volume formulas")
intensity = ta.iii
variableAccumulation = ta.wvad`;
    const strict = program(formulaSource);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: formulaSource });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const formulaBars = [
      { ...bar(0), open: 2, high: 5, low: 1, close: 4, volume: 8 },
      { ...bar(60_000), open: 2, high: 5, low: 1, close: 4, volume: 0 },
      { ...bar(120_000), open: 3, high: 3, low: 3, close: 3, volume: 5 },
    ];

    const strictResult = await new PineEngine().createSession(strict).runBatch(formulaBars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(formulaBars);

    expect(strictResult.returned.intensity).toEqual([4, 0, Number.NaN]);
    expect(strictResult.returned.variableAccumulation).toEqual([4, 0, Number.NaN]);
    expect(sealedResult.returned.intensity).toEqual([0.0625, 0, 0]);
    expect(sealedResult.returned.variableAccumulation).toEqual([4, 0, 0]);

    const invalidLength = `//@version=6\nindicator("MFI bounds")\nvalue = ta.mfi(hlc3, 0)`;
    const strictInvalid = program(invalidLength);
    const sealedInvalid = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: invalidLength });
    await expect(new PineEngine().createSession(strictInvalid).runBatch([bar(0)]))
      .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
    await expect(new PineEngine().createSession(sealedInvalid.program!).runBatch([bar(0)]))
      .resolves.toBeDefined();
  });

  it("keeps strict OBV recovery isolated from every sealed missing-value boundary", async () => {
    const source = `//@version=6
indicator("Profile-isolated OBV recovery")
firstRead = ta.obv
secondRead = ta.obv`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const cases = [
      {
        name: "missing close",
        bars: [
          { ...bar(0), close: 1, volume: 10 },
          { ...bar(60_000), close: Number.NaN, volume: 10 },
          { ...bar(120_000), close: 2, volume: 5 },
          { ...bar(180_000), close: 3, volume: 7 },
        ],
        strict: [Number.NaN, 0, 0, 7],
        sealed: [0, 0, 0, 7],
      },
      {
        name: "flat close with missing volume",
        bars: [
          { ...bar(0), close: 1, volume: 10 },
          { ...bar(60_000), close: 1, volume: Number.NaN },
          { ...bar(120_000), close: 2, volume: 5 },
        ],
        strict: [Number.NaN, 0, 5],
        sealed: [0, 0, 5],
      },
      {
        name: "directional close with missing volume",
        bars: [
          { ...bar(0), close: 1, volume: 10 },
          { ...bar(60_000), close: 2, volume: Number.NaN },
          { ...bar(120_000), close: 3, volume: 5 },
        ],
        strict: [Number.NaN, 0, 5],
        sealed: [0, Number.NaN, Number.NaN],
      },
    ] as const;

    for (const boundary of cases) {
      const strictResult = await new PineEngine().createSession(strict).runBatch(boundary.bars);
      const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(boundary.bars);

      expect(strictResult.returned.firstRead, boundary.name).toEqual(boundary.strict);
      expect(strictResult.returned.secondRead, boundary.name).toEqual(boundary.strict);
      expect(sealedResult.returned.firstRead, boundary.name).toEqual(boundary.sealed);
      expect(sealedResult.returned.secondRead, boundary.name).toEqual(boundary.sealed);
    }
  });

  it("keeps strict implicit pivots and SAR missing recovery isolated from the sealed profile", async () => {
    const source = `//@version=6
indicator("Profile-isolated pivots and SAR")
implicitHigh = ta.pivothigh(1, 1)
implicitLow = ta.pivotlow(1, 1)
sarValue = ta.sar(0.02, 0.02, 0.2)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const values = [
      [1, 2, 0, 1],
      [2, 5, 1, 4],
      [4, 3, 2, 2],
      [2, Number.NaN, Number.NaN, Number.NaN],
      [2, 4, 1, 3],
      [3, 6, 2, 5],
    ] as const;
    const bars = values.map(([open, high, low, close], index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume: 1,
    }));

    const strictResult = await new PineEngine().createSession(strict).runBatch(bars);
    const sealedResult = await new PineEngine().createSession(sealed.program!).runBatch(bars);

    expect(strictResult.returned.implicitHigh).toEqual([Number.NaN, Number.NaN, 5, Number.NaN, Number.NaN, Number.NaN]);
    expect(strictResult.returned.implicitLow).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, 1]);
    expect(strictResult.returned.sarValue).toEqual([Number.NaN, 0, 0, Number.NaN, 0.1, 0.198]);
    expect(sealedResult.returned.implicitHigh).toEqual(Array.from({ length: bars.length }, () => Number.NaN));
    expect(sealedResult.returned.implicitLow).toEqual(Array.from({ length: bars.length }, () => Number.NaN));
    expect(sealedResult.returned.sarValue).toEqual([Number.NaN, 0, 0, 0.1, Number.NaN, Number.NaN]);
  });

  it("preserves Supertrend ATR, bands and reversal across a missing OHLC observation", async () => {
    const source = `//@version=6
indicator("Profile-paired Supertrend missing recovery")
[line, direction] = ta.supertrend(1.5, 3)`;
    const strict = program(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
    const values = [
      [10, 12, 9, 11],
      [11, 13, 10, 12],
      [12, 15, 11, 14],
      [14, 15, 10, 11],
      [11, 12, 8, 9],
      [9, 11, 7, 8],
      [8, 10, 6, 9],
      [9, Number.NaN, Number.NaN, Number.NaN],
      [9, 13, 8, 12],
      [12, 16, 11, 15],
    ] as const;
    const bars = values.map(([open, high, low, close], index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume: 1,
    }));
    const expectedLine = [
      Number.NaN, Number.NaN, 18, 18, 15.8888888889, 14.9259259259,
      13.950617284, Number.NaN, 13.950617284, 8,
    ];
    const expectedDirection = [Number.NaN, Number.NaN, 1, 1, 1, 1, 1, Number.NaN, 1, -1];

    for (const compiled of [strict, sealed.program!]) {
      const result = await new PineEngine().createSession(compiled).runBatch(bars);
      expect(result.returned.line).toEqual(compiled === strict ? [0, ...expectedLine.slice(1)] : expectedLine);
      expect(result.returned.direction).toEqual(compiled === strict ? [1, 1, ...expectedDirection.slice(2)] : expectedDirection);
    }
  });

  it("keeps strict pivot and trend bounds isolated from sealed coercion", async () => {
    for (const expression of [
      "ta.pivothigh(close, -1, 1)",
      "ta.pivotlow(close, 1, 5001)",
      "ta.sar(-0.01, 0.02, 0.2)",
      "ta.sar(0.3, 0.02, 0.2)",
      "ta.sar(0.02, 0.3, 0.2)",
      "ta.supertrend(-1, 2)",
      "ta.supertrend(2, 0)",
      "ta.supertrend(2, 5001)",
    ]) {
      const source = `//@version=6\nindicator("Profile-isolated pivot and trend bounds")\nvalue = ${expression}`;
      const strict = program(source);
      const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
      expect(sealed.diagnostics, expression).toEqual([]);
      expect(sealed.program, expression).toBeDefined();

      await expect(new PineEngine().createSession(strict).runBatch([bar(0), bar(60_000)]), expression)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
      await expect(new PineEngine().createSession(sealed.program!).runBatch([bar(0), bar(60_000)]), expression)
        .resolves.toBeDefined();
    }
  });

  it("restores strict SAR constraint bars before replacing the tail", async () => {
    const compiled = program(`//@version=6
indicator("SAR tail rollback")
value = ta.sar(0.05, 0.05, 0.15)`);
    const values = [
      [10, 11, 9, 10], [10, 12, 10, 11], [11, 13, 11, 12], [12, 14, 12, 13],
      [13, 15, 13, 14], [14, 16, 14, 15], [15, 16, 7, 8], [8, 9, 6, 7],
      [7, 8, 5, 6], [6, 7, 4, 5], [5, 6, 3, 4], [4, 13, 4, 12],
      [12, 14, 11, 13], [13, 15, 12, 14], [14, 16, 13, 15],
    ] as const;
    const bars = values.map(([open, high, low, close], index): MarketBar => ({
      openTime: index * 60_000,
      closeTime: (index + 1) * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume: 1,
    }));
    const replacement = { ...bars.at(-1)!, high: 15, low: 2, close: 3 };
    const engine = new PineEngine();
    const incremental = engine.createSession(compiled);
    await incremental.runBatch(bars);

    const replaced = await incremental.replaceTail([replacement]);
    const fresh = await engine.createSession(compiled).runBatch([...bars.slice(0, -1), replacement]);

    const replacedValues = replaced.returned.value!;
    expect(replacedValues).toEqual(fresh.returned.value);
    expect(replacedValues.at(-1)).toBe(15);
  });

  it("uses low for the implicit ta.lowest overload", async () => {
    const compiled = program(`//@version=6
indicator("Implicit low")
float lowest = ta.lowest(2)`);
    const bars = [
      { ...bar(0), high: 10, low: 3 },
      { ...bar(60_000), high: 8, low: -2 },
    ];
    const result = await new PineEngine().createSession(compiled).runBatch(bars);

    expect(result.returned.lowest).toEqual([Number.NaN, -2]);
  });

  it("returns positive zero for a current-bar extrema offset", async () => {
    const compiled = program(`//@version=6
indicator("Current extrema offset")
int highestOffset = ta.highestbars(close, 1)
int lowestOffset = ta.lowestbars(close, 1)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0)]);

    expect(result.returned.highestOffset).toEqual([0]);
    expect(result.returned.lowestOffset).toEqual([0]);
    expect(Object.is(result.returned.highestOffset?.[0], -0)).toBe(false);
    expect(Object.is(result.returned.lowestOffset?.[0], -0)).toBe(false);
  });

  it("rejects nonpositive and oversized TA history arguments without clamping", async () => {
    for (const expression of [
      "ta.change(close, 0)",
      "ta.mom(close, 5001)",
      "ta.roc(close, -1)",
      "ta.rising(close, 0)",
      "ta.falling(close, 5001)",
      "ta.highest(0)",
      "ta.lowest(close, 5001)",
      "ta.highestbars(close, 0)",
      "ta.lowestbars(5001)",
      "ta.range(close, 0)",
      "ta.valuewhen(true, close, -1)",
      "ta.valuewhen(true, close, 5001)",
    ]) {
      const compiled = program(`//@version=6\nindicator("TA argument bounds")\nvalue = ${expression}`);
      await expect(new PineEngine().createSession(compiled).runBatch([bar(0)]), expression)
        .rejects.toMatchObject({ code: "SCRIPT_RUNTIME_ERROR" });
    }
  });

  it("preserves sealed TA argument coercion", async () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6\nindicator("Sealed TA")\nvalue = ta.highest(close, 0)`,
    });
    expect(result.diagnostics).toEqual([]);
    const executed = await new PineEngine().createSession(result.program!).runBatch([bar(0)]);
    expect(executed.returned.value).toEqual([1]);
  });

  it("evaluates all calendar callable forms in explicit IANA and compact GMT timezones", async () => {
    const compiled = program(`//@version=6
indicator("Calendar callables")
plot(year(time, "America/New_York"), "Year")
plot(month(time, "America/New_York"), "Month")
plot(weekofyear(time, "America/New_York"), "Week")
plot(dayofmonth(time, "America/New_York"), "Day")
plot(dayofweek(time, "America/New_York"), "Weekday")
plot(hour(time, "America/New_York"), "Hour")
plot(minute(time, "America/New_York"), "Minute")
plot(second(time, "America/New_York"), "Second")
plot(hour(time, "GMT+0100"), "Compact offset")`);
    const timestamp = Date.UTC(2025, 0, 1, 0, 30, 45);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", timezone: "UTC" },
    }).runBatch([bar(timestamp)]);

    expect(Object.fromEntries(result.plots.map((plot) => [plot.title, plot.points[0]?.value]))).toEqual({
      Year: 2024,
      Month: 12,
      Week: 1,
      Day: 31,
      Weekday: 3,
      Hour: 19,
      Minute: 30,
      Second: 45,
      "Compact offset": 1,
    });
  });

  it("fails closed for an invalid explicit calendar timezone", async () => {
    const compiled = program(`//@version=6
indicator("Invalid timezone")
plot(hour(time, "Mars/Olympus_Mons"))`);

    await expect(new PineEngine().createSession(compiled).runBatch([bar(0)])).rejects.toMatchObject({
      name: "PineRuntimeError",
      code: "SCRIPT_RUNTIME_ERROR",
      method: "hour",
      message: 'Invalid timezone: "Mars/Olympus_Mons"',
    });
  });

  it("throws a typed Pine runtime error with stable identity", async () => {
    const compiled = program(`//@version=6
indicator("Runtime error")
runtime.error("deliberate")`);

    try {
      await new PineEngine().createSession(compiled).runBatch([bar(0)]);
      throw new Error("Expected runtime.error() to stop execution");
    } catch (error) {
      expect(error).toBeInstanceOf(PineRuntimeError);
      expect(error).toMatchObject({
        name: "PineRuntimeError",
        code: "SCRIPT_RUNTIME_ERROR",
        method: "runtime.error",
        message: "deliberate",
      });
    }
  });

  it("preserves the sealed runtime.error identity", async () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed runtime error")
runtime.error("legacy")`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();

    try {
      await new PineEngine().createSession(result.program!).runBatch([bar(0)]);
      throw new Error("Expected runtime.error() to stop execution");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(PineRuntimeError);
      expect(error).toMatchObject({ name: "Error", message: "legacy" });
    }
  });

  it("preserves the sealed runtime.error default message", async () => {
    const compiled = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Legacy runtime error")
runtime.error()`,
    });
    expect(compiled.diagnostics).toEqual([]);
    await expect(new PineEngine().createSession(compiled.program!).runBatch([bar(0)]))
      .rejects.toThrow("Runtime error");
  });

  it("keeps dataset-tail replay requirements and incremental output out of the sealed profile", async () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed dataset tail")
tailIndex = last_bar_index
tailTime = last_bar_time`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.runtimeRequirements).toEqual({
      usesDatasetTail: false,
      usesExecutionClock: false,
      usesChartType: false,
      usesVisibleRange: false,
    });

    const session = new PineEngine().createSession(result.program!);
    const initial = await session.runBatch([bar(0), bar(60_000)]);
    const appended = await session.appendBars([bar(120_000)]);

    expect(initial.returned.tailIndex).toEqual([0, 1]);
    expect(initial.returned.tailTime).toEqual([60_000, 60_000]);
    expect(appended.returned.tailIndex).toEqual([0, 1, 2]);
    expect(appended.returned.tailTime).toEqual([60_000, 120_000, 120_000]);
    expect(appended.stats.processedBars).toBe(2);

    const paginatedSession = new PineEngine().createSession(result.program!);
    let paginated;
    for await (const page of paginatedSession.runPaginated([bar(0), bar(60_000), bar(120_000)], 2)) paginated = page;
    expect(paginated?.returned.tailIndex).toEqual(appended.returned.tailIndex);
    expect(paginated?.returned.tailTime).toEqual(appended.returned.tailTime);

    const checkpointSession = new PineEngine().createSession(result.program!);
    const checkpointPrefix = await checkpointSession.runBatch([bar(0), bar(60_000)]);
    const checkpoint = checkpointSession.checkpoint();
    await checkpointSession.appendBars([bar(120_000)]);
    const restored = await checkpointSession.restore(checkpoint);
    expect(restored.returned).toEqual(checkpointPrefix.returned);
    const checkpointAppend = await checkpointSession.appendBars([bar(120_000)]);
    expect(checkpointAppend.returned).toEqual(appended.returned);
  });

  it("keeps host-clock sampling lazy and per-read in the sealed profile", async () => {
    const unused = compile({
      compatibility: PINE_COMPATIBILITY.legacy,
      source: `//@version=6
indicator("Sealed unused clock")
value = close`,
    });
    let unusedClockReads = 0;
    await new PineEngine().createSession(unused.program!, {
      now: () => { unusedClockReads += 1; return 0; },
    }).runBatch([bar(0)]);
    expect(unusedClockReads).toBe(0);

    const source = `//@version=6
indicator("Clock reads")
first = barstate.isconfirmed
second = barstate.isconfirmed`;
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    const production = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    const readings = [0, 120_000];
    let sealedClockReads = 0;
    const sealedResult = await new PineEngine().createSession(sealed.program!, {
      now: () => readings[sealedClockReads++] ?? 120_000,
    }).runBatch([bar(0)]);
    let productionClockReads = 0;
    const productionResult = await new PineEngine().createSession(production.program!, {
      now: () => readings[productionClockReads++] ?? 120_000,
    }).runBatch([bar(0)]);

    expect(sealedResult.returned.first).toEqual([false]);
    expect(sealedResult.returned.second).toEqual([true]);
    expect(sealedClockReads).toBe(2);
    expect(productionResult.returned.first).toEqual([false]);
    expect(productionResult.returned.second).toEqual([false]);
    expect(productionClockReads).toBe(1);
  });

  it("uses one injected evaluation clock value for timenow across a batch", async () => {
    const compiled = program(`//@version=6
indicator("Clock")
observed = timenow`);
    const result = await new PineEngine().createSession(compiled, {
      now: () => 1_787_650_123_456,
    }).runBatch([bar(0), bar(60_000), bar(120_000)]);

    expect(compiled.runtimeRequirements).toMatchObject({ usesDatasetTail: false, usesExecutionClock: true });
    expect(result.returned.observed).toEqual([
      1_787_650_123_456,
      1_787_650_123_456,
      1_787_650_123_456,
    ]);
  });

  it("shares the production evaluation clock with request children", async () => {
    const compiled = program(`//@version=6
indicator("Child clock")
parentClock = timenow
childClock = request.security(syminfo.tickerid, timeframe.period, timenow)`);
    let clockReads = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      now: () => 120_000 + clockReads++ * 1_000,
    });
    const first = await session.runBatch([bar(0), bar(60_000)]);
    const second = await session.runBatch([bar(0), bar(60_000)]);

    expect(clockReads).toBe(2);
    expect(first.returned.parentClock).toEqual([120_000, 120_000]);
    expect(first.returned.childClock).toEqual([120_000, 120_000]);
    expect(second.returned.parentClock).toEqual([121_000, 121_000]);
    expect(second.returned.childClock).toEqual([121_000, 121_000]);
  });

  it("refreshes the production clock across child append and checkpoint replay", async () => {
    const compiled = program(`//@version=6
indicator("Child incremental clock")
parentClock = timenow
childClock = request.security(syminfo.tickerid, timeframe.period, timenow)`);
    let clockReads = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      now: () => 120_000 + clockReads++ * 1_000,
    });
    const first = await session.runBatch([bar(0)]);
    const checkpoint = session.checkpoint();
    const appended = await session.appendBars([bar(60_000)]);
    const restored = await session.restore(checkpoint);
    const replayed = await session.appendBars([bar(60_000)]);

    expect(clockReads).toBe(3);
    expect(first.returned.parentClock).toEqual([120_000]);
    expect(first.returned.childClock).toEqual([120_000]);
    expect(appended.returned.parentClock).toEqual([121_000, 121_000]);
    expect(appended.returned.childClock).toEqual([121_000, 121_000]);
    expect(restored.returned.parentClock).toEqual([120_000]);
    expect(restored.returned.childClock).toEqual([120_000]);
    expect(replayed.returned.parentClock).toEqual([122_000, 122_000]);
    expect(replayed.returned.childClock).toEqual([122_000, 122_000]);
  });

  it("replays growing datasets when last_bar_index changes prior history", async () => {
    const compiled = program(`//@version=6
indicator("Dataset tail")
tail = last_bar_index`);
    const session = new PineEngine().createSession(compiled);
    const initial = await session.runBatch([bar(0), bar(60_000), bar(120_000)]);
    const appended = await session.appendBars([bar(180_000)]);
    const replacement = { ...bar(180_000), close: 2 };
    const replaced = await session.replaceTail([replacement]);

    expect(compiled.runtimeRequirements).toMatchObject({ usesDatasetTail: true, usesExecutionClock: false });
    expect(initial.returned.tail).toEqual([2, 2, 2]);
    expect(appended.returned.tail).toEqual([3, 3, 3, 3]);
    expect(appended.stats.processedBars).toBe(4);
    expect(replaced.returned.tail).toEqual([3, 3, 3, 3]);
    expect(replaced.stats.processedBars).toBe(1);
  });

  it("parses split, full-day, and overnight sessions with end-day ownership", async () => {
    const compiled = program(`//@version=6
indicator("Session strings")
split = time("", "0930-1130,1300-1600:2", "America/New_York")
overnight = time("", "1700-1600:3", "America/New_York")
always = time("", "0000-0000:1234567", "America/New_York")`);
    const mondayTen = Date.parse("2025-01-06T15:00:00Z");
    const mondayLunch = Date.parse("2025-01-06T17:00:00Z");
    const mondaySix = Date.parse("2025-01-06T23:00:00Z");
    const tuesdayTwo = Date.parse("2025-01-07T07:00:00Z");
    const wednesdayTwo = Date.parse("2025-01-08T07:00:00Z");
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "1",
      timezone: "America/New_York",
    }).runBatch([mondayTen, mondayLunch, mondaySix, tuesdayTwo, wednesdayTwo].map((time) => bar(time)));

    expect(result.returned.split!.map(Number.isNaN)).toEqual([false, true, true, true, true]);
    expect(result.returned.overnight!.map(Number.isNaN)).toEqual([true, true, false, false, true]);
    expect(result.returned.always!.map(Number.isNaN)).toEqual([false, false, false, false, false]);
  });

  it("throws a typed error for malformed Pine session strings", async () => {
    const compiled = program(`//@version=6
indicator("Invalid session")
value = time("", "2500-2600", "UTC")`);

    await expect(new PineEngine().createSession(compiled).runBatch([bar(0)]))
      .rejects.toMatchObject({
        name: "PineRuntimeError",
        code: "SCRIPT_RUNTIME_ERROR",
        method: "time",
      });
  });

  it("classifies active, regular, premarket, and postmarket session bars", async () => {
    const compiled = program(`//@version=6
indicator("Session namespace")
kindRegular = session.regular
kindExtended = session.extended
firstActive = session.isfirstbar
lastActive = session.islastbar
firstRegular = session.isfirstbar_regular
lastRegular = session.islastbar_regular
market = session.ismarket
pre = session.ispremarket
post = session.ispostmarket`);
    const schedule: PineSessionSchedule = {
      activeSession: "0400-2000:23456",
      activeSubsessionId: "extended",
      regularSession: "0930-1600:23456",
      extendedSession: "0400-2000:23456",
      premarketSession: "0400-0930:23456",
      postmarketSession: "1600-2000:23456",
      timezone: "America/New_York",
    };
    const times = [
      "2026-08-31T08:00:00Z",
      "2026-08-31T13:30:00Z",
      "2026-08-31T19:59:00Z",
      "2026-08-31T20:00:00Z",
      "2026-08-31T23:59:00Z",
      "2026-09-01T08:00:00Z",
    ].map(Date.parse);
    const result = await new PineEngine().createSession(compiled, { sessionSchedule: schedule })
      .runBatch(times.map((time) => bar(time)));

    expect(result.returned.kindRegular).toEqual(Array(6).fill("regular"));
    expect(result.returned.kindExtended).toEqual(Array(6).fill("extended"));
    expect(result.returned.firstActive).toEqual([true, false, false, false, false, true]);
    expect(result.returned.lastActive).toEqual([false, false, false, false, true, true]);
    expect(result.returned.firstRegular).toEqual([false, true, false, false, false, false]);
    expect(result.returned.lastRegular).toEqual([false, false, true, false, false, false]);
    expect(result.returned.market).toEqual([false, true, true, false, false, false]);
    expect(result.returned.pre).toEqual([true, false, false, false, false, true]);
    expect(result.returned.post).toEqual([false, false, false, true, true, false]);
  });

  it("applies dated and prior-day session corrections", async () => {
    const compiled = program(`//@version=6
indicator("Corrected sessions")
market = session.ismarket`);
    const schedule: PineSessionSchedule = {
      activeSession: "0930-1600:23456",
      regularSession: "0930-1600:23456",
      timezone: "UTC",
      corrections: {
        regularSession: [
          { tradingDay: "20181113", session: "1900F4-2350F4,1000-1845" },
          { tradingDay: "20181115", session: "1700-0200" },
        ],
      },
    };
    const times = [
      "2018-11-09T20:00:00Z",
      "2018-11-13T10:00:00Z",
      "2018-11-13T19:00:00Z",
      "2018-11-14T15:00:00Z",
      "2018-11-16T01:00:00Z",
      "2018-11-16T03:00:00Z",
    ].map(Date.parse);
    const result = await new PineEngine().createSession(compiled, { sessionSchedule: schedule })
      .runBatch(times.map((time) => bar(time)));

    expect(result.returned.market).toEqual([true, true, false, true, true, false]);
  });

  it("validates host session corrections once and fails only when consumed", async () => {
    const schedule: PineSessionSchedule = {
      activeSession: "0930-1600:23456",
      regularSession: "0930-1600:23456",
      timezone: "UTC",
      corrections: {
        regularSession: [{ tradingDay: "20261340", session: "bad" }],
      },
    };
    const unrelated = program(`//@version=6
indicator("Unused invalid correction")
value = close`);
    const consuming = program(`//@version=6
indicator("Invalid correction")
market = session.ismarket`);

    await expect(new PineEngine().createSession(unrelated, { sessionSchedule: schedule }).runBatch([bar(0)]))
      .resolves.toMatchObject({ returned: { value: [1] } });
    await expect(new PineEngine().createSession(consuming, { sessionSchedule: schedule }).runBatch([bar(0)]))
      .rejects.toThrow("Invalid host session correction: invalid trading day '20261340'");
    await expect(new PineEngine().createSession(consuming, {
      sessionSchedule: {
        ...schedule,
        corrections: {
          regularSession: [{ tradingDay: "20260831", session: "1000-1200F1" }],
        },
      },
    }).runBatch([bar(Date.parse("2026-08-31T11:00:00Z"))]))
      .rejects.toThrow("Invalid host session correction: correction window '1000-1200F1' ends before its start day");
    await expect(new PineEngine().createSession(consuming, {
      sessionSchedule: {
        ...schedule,
        corrections: {
          regularSession: [
            { tradingDay: "20260902", session: "bad-two" },
            { tradingDay: "20260901", session: "bad-one" },
          ],
        },
      },
    }).runBatch([bar(0)]))
      .rejects.toThrow("Invalid host session correction: invalid correction window 'bad-two'");
    await expect(new PineEngine().createSession(consuming, {
      sessionSchedule: {
        ...schedule,
        corrections: {
          regularSession: [
            { tradingDay: "20260901", session: "bad" },
            { tradingDay: "20260901", session: "0930-1600" },
          ],
        },
      },
    }).runBatch([bar(0)]))
      .rejects.toThrow("Invalid host session correction: invalid correction window 'bad'");
  });

  it("rekeys request children when symbol-only session metadata changes", async () => {
    const compiled = program(`//@version=6
indicator("Child schedule")
childMarket = request.security("NASDAQ:MSFT", "1", session.ismarket ? 1 : 0)`);
    const requestedBars = [bar(Date.parse("2026-08-31T14:00:00Z"))];
    let loadCount = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL", timezone: "UTC" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars,
          symbolInfo: {
            ticker: "MSFT",
            tickerid: "NASDAQ:MSFT",
            timezone: "UTC",
            session: loadCount++ === 0 ? "0900-1500:23456" : "1600-2000:23456",
          },
        }),
      },
    });

    const first = await session.runBatch(requestedBars);
    const second = await session.runBatch(requestedBars);
    expect(first.returned.childMarket).toEqual([1]);
    expect(second.returned.childMarket).toEqual([0]);
  });

  it("materializes symbol timezone into explicit child schedule identity", async () => {
    const compiled = program(`//@version=6
indicator("Child schedule timezone")
childMarket = request.security("NASDAQ:MSFT", "1", session.ismarket ? 1 : 0)`);
    const requestedBars = [bar(Date.parse("2026-08-31T09:30:00Z"))];
    let loadCount = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL", timezone: "UTC" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars,
          sessionSchedule: {
            activeSession: "0900-1000:23456",
            regularSession: "0900-1000:23456",
          },
          symbolInfo: {
            ticker: "MSFT",
            tickerid: "NASDAQ:MSFT",
            timezone: loadCount++ === 0 ? "UTC" : "America/New_York",
          },
        }),
      },
    });

    const first = await session.runBatch(requestedBars);
    const second = await session.runBatch(requestedBars);
    expect(first.returned.childMarket).toEqual([1]);
    expect(second.returned.childMarket).toEqual([0]);
  });

  it("inherits the root effective timezone in same-symbol request children", async () => {
    const compiled = program(`//@version=6
indicator("Same-symbol timezone")
rootMarket = session.ismarket
childMarket = request.security(syminfo.tickerid, timeframe.period, session.ismarket)
rootTime = time("", "0930-1600")
childTime = request.security(syminfo.tickerid, timeframe.period, time("", "0930-1600"))`);
    const timestamp = Date.parse("2026-08-31T18:00:00Z");
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "1",
      timezone: "America/New_York",
      symbolInfo: {
        ticker: "AAPL",
        tickerid: "NASDAQ:AAPL",
        session: "0930-1600:23456",
      },
    }).runBatch([bar(timestamp)]);

    expect(result.returned.rootMarket).toEqual([true]);
    expect(result.returned.childMarket).toEqual([true]);
    expect(result.returned.rootTime).toEqual([timestamp]);
    expect(result.returned.childTime).toEqual([timestamp]);
  });

  it("inherits same-symbol metadata across timeframes until the gateway replaces its schedule", async () => {
    const compiled = program(`//@version=6
indicator("Same-symbol alternate timeframe")
childMarket = request.security("NASDAQ:AAPL", "5", session.ismarket)
childTick = request.security("NASDAQ:AAPL", "5", syminfo.mintick)`);
    const requestedBars = [bar(Date.parse("2026-08-31T18:00:00Z"))];
    let replaceSchedule = false;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      timezone: "America/New_York",
      symbolInfo: {
        ticker: "AAPL",
        tickerid: "NASDAQ:AAPL",
        session: "0930-1600:23456",
        mintick: 0.25,
      },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars,
          ...(replaceSchedule ? {
            sessionSchedule: {
              activeSession: "0930-1600:23456",
              regularSession: "0930-1600:23456",
              timezone: "UTC",
            },
          } : {}),
        }),
      },
    });

    const inherited = await session.runBatch(requestedBars);
    replaceSchedule = true;
    const replaced = await session.runBatch(requestedBars);

    expect(inherited.returned.childMarket).toEqual([true]);
    expect(inherited.returned.childTick).toEqual([0.25]);
    expect(replaced.returned.childMarket).toEqual([false]);
    expect(replaced.returned.childTick).toEqual([0.25]);
  });

  it("rekeys request children when Pine-visible symbol metadata changes", async () => {
    const compiled = program(`//@version=6
indicator("Child symbol identity")
childTick = request.security("NASDAQ:MSFT", "1", syminfo.mintick)`);
    const requestedBars = [bar(Date.parse("2026-08-31T09:30:00Z"))];
    let loadCount = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars,
          symbolInfo: {
            ticker: "MSFT",
            tickerid: "NASDAQ:MSFT",
            mintick: loadCount++ === 0 ? 0.25 : 0.5,
          },
        }),
      },
    });

    const first = await session.runBatch(requestedBars);
    const second = await session.runBatch(requestedBars);
    expect(first.returned.childTick).toEqual([0.25]);
    expect(second.returned.childTick).toEqual([0.5]);
  });

  it("projects child metadata before request identity and checkpoint handling", async () => {
    const compiled = program(`//@version=6
indicator("Bounded child symbol identity")
childTick = request.security("NASDAQ:MSFT", "1", syminfo.mintick)`);
    const requestedBars = [bar(0), bar(60_000)];
    const providerExtension: { self?: unknown } = {};
    providerExtension.self = providerExtension;
    const scheduleExtension: { self?: unknown } = {};
    scheduleExtension.self = scheduleExtension;
    let availableBars = 1;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars.slice(0, availableBars),
          symbolInfo: {
            ticker: "MSFT",
            tickerid: "NASDAQ:MSFT",
            mintick: 0.25,
            providerExtension,
          } as unknown as SymbolInfo,
          sessionSchedule: {
            activeSession: "24x7",
            regularSession: "24x7",
            scheduleExtension,
          } as unknown as PineSessionSchedule,
        }),
      },
    });

    const initial = await session.runBatch([requestedBars[0]!]);
    const checkpoint = session.checkpoint();
    expect(() => JSON.stringify(checkpoint)).not.toThrow();
    availableBars = 2;
    const appended = await session.appendBars([requestedBars[1]!]);
    const restored = await session.restore(checkpoint);
    const replayed = await session.appendBars([requestedBars[1]!]);

    expect(initial.returned.childTick).toEqual([0.25]);
    expect(appended.returned.childTick).toEqual([0.25, 0.25]);
    expect(restored.returned.childTick).toEqual([0.25]);
    expect(replayed.returned.childTick).toEqual([0.25, 0.25]);
  });

  it("rejects malformed Pine-visible child metadata", async () => {
    const compiled = program(`//@version=6
indicator("Invalid child symbol identity")
childTick = request.security("NASDAQ:MSFT", "1", syminfo.mintick)`);
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: [bar(0)],
          symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT", mintick: "0.25" } as unknown as SymbolInfo,
        }),
      },
    });

    await expect(session.runBatch([bar(0)]))
      .rejects.toThrow("Invalid child symbol metadata 'mintick': expected a finite number");
  });

  it("distinguishes signed zero in child metadata across append and checkpoint replay", async () => {
    const compiled = program(`//@version=6
indicator("Signed zero child identity")
inverseTick = request.security("NASDAQ:MSFT", "1", 1 / syminfo.mintick)`);
    const requestedBars = [bar(0), bar(60_000), bar(120_000)];
    let availableBars = 1;
    let mintick = 0;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars.slice(0, availableBars),
          symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT", mintick },
        }),
      },
    });

    const initial = await session.runBatch([requestedBars[0]!]);
    const checkpoint = session.checkpoint();
    mintick = -0;
    availableBars = 2;
    const appended = await session.appendBars([requestedBars[1]!]);
    const restored = await session.restore(checkpoint);
    availableBars = 3;
    const replayed = await session.appendBars([requestedBars[1]!, requestedBars[2]!]);

    expect(initial.returned.inverseTick).toEqual([Number.POSITIVE_INFINITY]);
    expect(appended.returned.inverseTick).toEqual([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    expect(restored.returned.inverseTick).toEqual([Number.POSITIVE_INFINITY]);
    expect(replayed.returned.inverseTick).toEqual([
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]);
  });

  it("keeps request children stable when correction order changes", async () => {
    const compiled = program(`//@version=6
indicator("Canonical child corrections")
child = request.security("NASDAQ:MSFT", "1", request.security("NASDAQ:GOOG", "1", close))`);
    const requestedBars = [bar(0), bar(60_000), bar(120_000)];
    const corrections = [
      { tradingDay: "20260901", session: "0930-1300" },
      { tradingDay: "20260902", session: "0930-1600" },
    ] as const;
    let availableBars = 1;
    let reversed = false;
    let rootSignal: AbortSignal | undefined;
    const nestedSignals: AbortSignal[] = [];
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async (request, signal) => {
          if (request.symbol === "NASDAQ:MSFT") {
            rootSignal = signal;
            return {
              bars: requestedBars.slice(0, availableBars),
              sessionSchedule: {
                activeSession: "0930-1600:23456",
                regularSession: "0930-1600:23456",
                timezone: "UTC",
                corrections: { regularSession: reversed ? [...corrections].reverse() : corrections },
              },
              symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" },
            };
          }
          if (signal !== rootSignal) nestedSignals.push(signal);
          return {
            bars: requestedBars.slice(0, availableBars),
            symbolInfo: { ticker: "GOOG", tickerid: "NASDAQ:GOOG" },
          };
        },
      },
    });

    await session.runBatch([requestedBars[0]!]);
    const checkpoint = session.checkpoint();
    reversed = true;
    availableBars = 2;
    await session.appendBars([requestedBars[1]!]);
    await session.restore(checkpoint);
    reversed = false;
    availableBars = 3;
    await session.appendBars([requestedBars[1]!, requestedBars[2]!]);

    expect(nestedSignals).toHaveLength(3);
    expect(nestedSignals[1]).toBe(nestedSignals[0]);
    expect(nestedSignals[2]).toBe(nestedSignals[0]);
  });

  it("rekeys delayed invalid corrections so current provider precedence wins", async () => {
    const compiled = program(`//@version=6
indicator("Delayed invalid child corrections")
child = request.security("NASDAQ:MSFT", "1", bar_index == 0 ? 0 : (session.ismarket ? 1 : 0))`);
    const requestedBars = [bar(0), bar(60_000)];
    const cases = [
      {
        initial: [
          { tradingDay: "20260902", session: "bad-two" },
          { tradingDay: "20260901", session: "bad-one" },
        ],
        current: [
          { tradingDay: "20260901", session: "bad-one" },
          { tradingDay: "20260902", session: "bad-two" },
        ],
        expected: "invalid correction window 'bad-one'",
        restore: false,
      },
      {
        initial: [
          { tradingDay: "20260901", session: "bad" },
          { tradingDay: "20260901", session: "0930-1600" },
        ],
        current: [
          { tradingDay: "20260901", session: "0930-1600" },
          { tradingDay: "20260901", session: "bad" },
        ],
        expected: "duplicate trading day '20260901'",
        restore: true,
      },
    ] as const;

    for (const testCase of cases) {
      let corrections: readonly { readonly tradingDay: string; readonly session: string }[] = testCase.initial;
      let availableBars = 1;
      const session = new PineEngine().createSession(compiled, {
        timeframe: "1",
        symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
        marketDataGateway: {
          load: async () => ({
            bars: requestedBars.slice(0, availableBars),
            sessionSchedule: {
              activeSession: "0930-1600:23456",
              regularSession: "0930-1600:23456",
              timezone: "UTC",
              corrections: { regularSession: corrections },
            },
            symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" },
          }),
        },
      });

      const initial = await session.runBatch([requestedBars[0]!]);
      expect(initial.returned.child).toEqual([0]);
      const checkpoint = session.checkpoint();
      if (testCase.restore) await session.restore(checkpoint);
      corrections = testCase.current;
      availableBars = 2;
      await expect(session.appendBars([requestedBars[1]!])).rejects.toThrow(testCase.expected);
    }
  });

  it("evicts request children after repeated initial execution failures", async () => {
    const compiled = program(`//@version=6
indicator("Failing child lifecycle")
child = request.security("NASDAQ:MSFT", "1", session.ismarket ? 1 : 0)`);
    let validSchedule = false;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: [bar(0)],
          sessionSchedule: {
            activeSession: validSchedule ? "0930-1600:23456" : "bad",
            regularSession: validSchedule ? "0930-1600:23456" : "bad",
            timezone: "UTC",
          },
          symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" },
        }),
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(session.runBatch([bar(0)])).rejects.toThrow('Invalid host session specification: "bad"');
      expect(requestState(session).requests.size).toBe(0);
    }

    validSchedule = true;
    await expect(session.runBatch([bar(0)])).resolves.toBeDefined();
    expect(requestState(session).requests.size).toBe(1);
    await session.close();
    expect(requestState(session).requests.size).toBe(0);
  });

  it("evicts partially advanced request children before retry", async () => {
    const compiled = program(`//@version=6
indicator("Incremental child failure")
    child = request.security("NASDAQ:MSFT", "1", bar_index == 0 ? 0 : (session.ismarket ? 1 : 0))`);
    const requestedBars = [bar(0), bar(60_000)];
    let availableBars = 1;
    let validCorrection = false;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({
          bars: requestedBars.slice(0, availableBars),
          sessionSchedule: {
            activeSession: "0930-1600:23456",
            regularSession: "0930-1600:23456",
            timezone: "UTC",
            corrections: {
              regularSession: [{ tradingDay: "20260901", session: validCorrection ? "0930-1600" : "bad" }],
            },
          },
          symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" },
        }),
      },
    });

    await session.runBatch([requestedBars[0]!]);
    expect(requestState(session).requests.size).toBe(1);
    availableBars = 2;
    await expect(session.appendBars([requestedBars[1]!]))
      .rejects.toThrow("Invalid host session correction: invalid correction window 'bad'");
    expect(requestState(session).requests.size).toBe(0);

    validCorrection = true;
    await expect(session.runBatch(requestedBars)).resolves.toBeDefined();
    expect(requestState(session).requests.size).toBe(1);
    await session.close();
    expect(requestState(session).requests.size).toBe(0);
  });

  it("keeps request children stable across absent and empty metadata", async () => {
    const compiled = program(`//@version=6
indicator("Empty child metadata")
child = request.security("NASDAQ:MSFT", "1", request.security("NASDAQ:GOOG", "1", close))`);
    const requestedBars = [bar(0), bar(60_000), bar(120_000)];
    let availableBars = 1;
    let metadataMode: "absent" | "empty" | "ignored" = "absent";
    let rootSignal: AbortSignal | undefined;
    const nestedSignals: AbortSignal[] = [];
    const session = new PineEngine().createSession(compiled, {
      timeframe: "1",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async (request, signal) => {
          if (request.symbol === "NASDAQ:MSFT") {
            rootSignal = signal;
            let symbolInfo: SymbolInfo | undefined;
            if (metadataMode === "empty") symbolInfo = {};
            if (metadataMode === "ignored") symbolInfo = { providerExtension: "ignored" } as unknown as SymbolInfo;
            return {
              bars: requestedBars.slice(0, availableBars),
              ...(symbolInfo === undefined ? {} : { symbolInfo }),
            };
          }
          if (signal !== rootSignal) nestedSignals.push(signal);
          return {
            bars: requestedBars.slice(0, availableBars),
            symbolInfo: { ticker: "GOOG", tickerid: "NASDAQ:GOOG" },
          };
        },
      },
    });

    await session.runBatch([requestedBars[0]!]);
    const checkpoint = session.checkpoint();
    metadataMode = "empty";
    availableBars = 2;
    await session.appendBars([requestedBars[1]!]);
    await session.restore(checkpoint);
    metadataMode = "ignored";
    availableBars = 3;
    await session.appendBars([requestedBars[1]!, requestedBars[2]!]);

    expect(nestedSignals).toHaveLength(3);
    expect(nestedSignals[1]).toBe(nestedSignals[0]);
    expect(nestedSignals[2]).toBe(nestedSignals[0]);
  });

  it("fails closed when extended data lacks pre/post classification metadata", async () => {
    const compiled = program(`//@version=6
indicator("Incomplete extended schedule")
pre = session.ispremarket`);
    const session = new PineEngine().createSession(compiled, {
      sessionSchedule: {
        activeSession: "0400-2000:23456",
        activeSubsessionId: "extended",
        regularSession: "0930-1600:23456",
      },
    });

    await expect(session.runBatch([bar(Date.parse("2026-08-31T08:00:00Z"))]))
      .rejects.toThrow("without explicit extended-session metadata");
  });
});
