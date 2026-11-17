import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY, type ExecutionResult, type MarketBar } from "../contracts/index.js";
import { PineEngine, compile } from "./index.js";

const DAY = 86_400_000;

function bars(closes: readonly number[]): MarketBar[] {
  return closes.map((close, index) => ({
    openTime: index * DAY,
    closeTime: (index + 1) * DAY,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100 + index,
  }));
}

async function run(source: string, input: readonly MarketBar[], timeframe?: string): Promise<ExecutionResult> {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
  expect(compiled.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compiled.program!, {
    symbolInfo: { currency: "USD" },
    ...(timeframe === undefined ? {} : { timeframe, mainTimeframe: timeframe }),
  });
  try {
    return await session.runBatch(input);
  } finally {
    await session.close();
  }
}

describe("strategy.close immediately", () => {
  it("fills strategy.close(immediately=true) at the signal bar close", async () => {
    const source = `//@version=6
strategy("Close now", margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 2
    strategy.close("L", immediately=true)`;
    const result = await run(source, bars([10, 12, 14, 16]));
    expect(result.strategy?.closedTradeRecords).toEqual([expect.objectContaining({
      entryId: "L", entryBarIndex: 1, entryPrice: 11, exitBarIndex: 2, exitPrice: 14, exitId: "close_L",
    })]);
  });

  it("keeps strategy.close without immediately filling at the next open", async () => {
    const source = `//@version=6
strategy("Close later", margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 2
    strategy.close("L")`;
    const result = await run(source, bars([10, 12, 14, 16]));
    expect(result.strategy?.closedTradeRecords).toEqual([expect.objectContaining({ exitBarIndex: 3, exitPrice: 15 })]);
  });
});

describe("pending entries", () => {
  it("replaces a pending entry when the same id is sent again", async () => {
    const source = `//@version=6
strategy("Chase", margin_long=0)
if bar_index == 1 or bar_index == 2
    strategy.entry("L", strategy.long, qty=1, limit=bar_index == 1 ? 5 : 15)`;
    const result = await run(source, bars([10, 12, 14, 16]));
    expect(result.strategy?.orders.map(({ id, status, limit, fillBarIndex }) => ({ id, status, limit, fillBarIndex }))).toEqual([
      { id: "L", status: "filled", limit: 15, fillBarIndex: 3 },
    ]);
    expect(result.strategy?.positionSize).toBe(1);
  });

  it.each([false, true])("keeps same-tick price entries eligible with process_orders_on_close=%s", async (onClose) => {
    const result = await run(`//@version=6
strategy("Price entries", margin_long=0, pyramiding=1, process_orders_on_close=${String(onClose)})
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1, limit=13)
    strategy.entry("B", strategy.long, qty=1, limit=14)`, bars([10, 12, 14]));
    expect(result.strategy?.orders.map(({ id, status, fillBarIndex }) => ({ id, status, fillBarIndex }))).toEqual([
      { id: "A", status: "filled", fillBarIndex: onClose ? 0 : 1 },
      { id: "B", status: "filled", fillBarIndex: onClose ? 0 : 1 },
    ]);
    expect(result.strategy?.positionSize).toBe(2);
  });

  it("enforces pyramiding when several pending entries fill on one bar", async () => {
    const source = `//@version=6
strategy("Pyramiding at fill", margin_long=0, pyramiding=1)
if bar_index == 1
    strategy.entry("A", strategy.long, qty=1)
    strategy.entry("B", strategy.long, qty=1)`;
    const result = await run(source, bars([10, 12, 14, 16]));
    expect(result.strategy?.orders.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "A", status: "filled" },
      { id: "B", status: "cancelled" },
    ]);
    expect(result.strategy?.positionSize).toBe(1);
  });
});

describe("percent-of-equity exits", () => {
  it("closes every trade without leaving a sub-step remainder", async () => {
    const source = `//@version=6
strategy("No dust", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=25,
    pyramiding=3, commission_type=strategy.commission.percent, commission_value=0.05)
if bar_index == 2
    strategy.entry("A", strategy.long)
    strategy.entry("B", strategy.long)
    strategy.entry("C", strategy.long)
if strategy.position_size > 0
    strategy.exit("X", limit=strategy.position_avg_price + 7)`;
    // Before the fix, the third exit reserved 24.752474999999993 and left 0.000001 open.
    const result = await run(source, bars([100, 103, 101, 106, 104, 110, 107, 112, 109]));
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.openTradeRecords).toEqual([]);
    expect(result.strategy?.closedTradeRecords.map(({ entryId, quantity }) => ({ entryId, quantity }))).toEqual([
      { entryId: "A", quantity: 24.752475 },
      { entryId: "B", quantity: 24.752475 },
      { entryId: "C", quantity: 24.752475 },
    ]);
  });
});

describe("history inside conditionally called functions", () => {
  const source = `//@version=6
indicator("Conditional history")
previousArgument(float src) =>
    src[1]
previousLocal(float src) =>
    float doubled = src * 2
    doubled[1]
argumentChange(float src) =>
    ta.change(src)
bool even = bar_index % 2 == 0
a = even ? previousArgument(bar_index) : na
b = even ? previousLocal(bar_index) : na
c = even ? argumentChange(bar_index) : na
d = previousArgument(bar_index)`;
  const input = bars([10, 11, 12, 13, 14, 15, 16]);

  it("reads the previous execution of the function, not the previous bar", async () => {
    const result = await run(source, input);
    const na = Number.NaN;
    expect(result.returned.a).toEqual([na, na, 0, na, 2, na, 4]);
    expect(result.returned.b).toEqual([na, na, 0, na, 4, na, 8]);
    expect(result.returned.c).toEqual([na, na, 2, na, 2, na, 2]);
    expect(result.returned.d).toEqual([na, 0, 1, 2, 3, 4, 5]);
  });

  it("retains sparse argument, local and expression samples across tail replay and portable restore", async () => {
    const source = `//@version=6
indicator("Sparse history")
previous(float src) =>
    float local = src * 2
    [src[1], local[1], (src * 3)[1]]
[a, b, c] = if bar_index == 0 or bar_index >= 6000
    previous(close)
else
    [float(na), float(na), float(na)]`;
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiled.diagnostics).toEqual([]);
    const program = compiled.program!;
    const input = bars(Array.from({ length: 6002 }, (_, index) => 10 + index));
    const session = new PineEngine().createSession(program);
    const restored = new PineEngine().createSession(program);
    const expectedTail = (result: Pick<ExecutionResult, "returned">, expected: number) => {
      expect([result.returned.a?.at(-1), result.returned.b?.at(-1), result.returned.c?.at(-1)])
        .toEqual([expected, expected * 2, expected * 3]);
    };
    try {
      expectedTail(await session.runBatch(input.slice(0, -1)), 10);
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as ReturnType<typeof session.checkpoint>;
      expectedTail(await session.replaceTail([{ ...input[6000]!, close: 6009 }]), 10);
      expectedTail(await session.appendBars(input.slice(-1)), 6009);
      await restored.restore(checkpoint);
      expectedTail(await restored.appendBars(input.slice(-1)), 6010);
    } finally {
      await session.close();
      await restored.close();
    }
  });

  it("keeps the baseline profile's per-bar history", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(compiled.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compiled.program!);
    try {
      const result = await session.runBatch(input);
      expect(result.returned.a!.every((value) => Number.isNaN(value))).toBe(true);
    } finally {
      await session.close();
    }
  });
});

describe("timeframe.period", () => {
  it.each([
    [6, "D", "1D"],
    [6, "W", "1W"],
    [6, "M", "1M"],
    [6, "60", "60"],
    [5, "D", "D"],
  ] as const)("reports a v%i %s chart as %s", async (version, timeframe, expected) => {
    const result = await run(`//@version=${String(version)}\nindicator("Period")\nperiod = timeframe.period`, bars([10]), timeframe);
    expect(result.returned.period).toEqual([expected]);
  });
});

describe("box text wrap", () => {
  it("reports the default wrap with the same value as text.wrap_none", async () => {
    const result = await run(`//@version=6
indicator("Wrap", overlay=true)
if barstate.islast
    box.new(bar_index, high, bar_index + 1, low, text="default")
    explicit = box.new(bar_index, high, bar_index + 1, low, text="explicit", text_wrap=text.wrap_auto)
    box.set_text_wrap(explicit, text.wrap_none)`, bars([10, 11]));
    expect(result.drawings.filter((drawing) => drawing.kind === "box").map((drawing) => "textWrap" in drawing ? drawing.textWrap : undefined))
      .toEqual(["none", "none"]);
  });
});

describe("plot marker defaults", () => {
  it.each([5, 6] as const)("matches the default marker styles in Pine v%s", async (version) => {
    const result = await run(`//@version=${version}
indicator("Arrows")
plotarrow(bar_index == 1 ? 1 : bar_index == 2 ? -1 : 0)
plotarrow(bar_index == 1 ? 1 : 0, colorup = color.blue)
plotshape(bar_index == 1)
plotchar(bar_index == 1)`, bars([10, 11, 12]));
    expect(result.plots[0]!.points.map((point) => point.options?.color)).toEqual([undefined, "#00FF00", "#FF0000"]);
    expect(result.plots[1]!.points[1]!.options?.color).toBe("#2962FF");
    expect(result.plots[2]!.points[1]!.options).toMatchObject({ color: "#2962FF", shape: "shape_xcross" });
    expect(result.plots[3]!.points[1]!.options).toMatchObject({ color: "#2962FF", char: "★" });
  });
});

describe("stop-limit entries", () => {
  it("fills at the stop when the trigger price is already inside the limit", async () => {
    // Bar 2 opens at 13 and trades up through the 14.5 stop; the 15 limit is above it.
    const result = await run(`//@version=6
strategy("Stop-limit", margin_long=0)
if bar_index == 0
    strategy.entry("SL", strategy.long, qty=1, stop=14.5, limit=15)`, bars([10, 11, 14]));
    expect(result.strategy?.orders[0]).toMatchObject({ status: "filled", fillBarIndex: 2, fillPrice: 14.5 });
  });

  it("does not use an extreme reached before stop activation to fill the limit", async () => {
    const input = bars([10, 13, 11]);
    input[1] = { ...input[1]!, open: 10, low: 9, high: 14 };
    const result = await run(`//@version=6
strategy("Stop-limit price path", margin_long=0)
if bar_index == 0
    strategy.entry("SL", strategy.long, qty=1, stop=12, limit=11)`, input);
    expect(result.strategy?.orders[0]).toMatchObject({ status: "filled", fillBarIndex: 2, fillPrice: 10 });
  });

  it("fills at the limit when the trigger price is beyond it", async () => {
    // The 15.5 stop triggers above the 15 limit, so the order waits for price to return to 15.
    const result = await run(`//@version=6
strategy("Stop-limit", margin_long=0)
if bar_index == 0
    strategy.entry("SL", strategy.long, qty=1, stop=15.5, limit=15)`, bars([10, 11, 14]));
    expect(result.strategy?.orders[0]).toMatchObject({ status: "filled", fillBarIndex: 2, fillPrice: 15 });
  });
});

describe("ta.stdev and ta.variance biased", () => {
  it("divides by n - 1 when biased is false", async () => {
    const result = await run(`//@version=6
indicator("Dispersion")
population = ta.variance(close, 4)
sample = ta.variance(close, 4, false)
sampleNamed = ta.stdev(close, 4, biased = false)
populationExplicit = ta.stdev(close, 4, true)`, bars([2, 4, 4, 6]));
    // Mean 4, squared deviations 4 + 0 + 0 + 4 = 8.
    expect(result.returned.population!.at(-1)).toBe(2);
    expect(result.returned.sample!.at(-1)).toBeCloseTo(8 / 3, 9);
    expect(result.returned.sampleNamed!.at(-1)).toBeCloseTo(Math.sqrt(8 / 3), 9);
    expect(result.returned.populationExplicit!.at(-1)).toBeCloseTo(Math.sqrt(2), 9);
  });
});

describe("array.max and array.min nth", () => {
  it("returns the nth element from the extreme, counting duplicates", async () => {
    const result = await run(`//@version=6
indicator("Nth extremum")
values = array.from(3, 9, 1, 7, 9)
secondLargest = array.max(values, 1)
thirdLargest = values.max(nth = 2)
secondSmallest = array.min(values, 1)
largest = array.max(values)`, bars([10]));
    expect(result.returned).toMatchObject({ secondLargest: [9], thirdLargest: [7], secondSmallest: [3], largest: [9] });
  });

  it("errors when nth is past the end, as the reference platform does", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Nth out of range")
value = array.max(array.from(3, 9, 1, 7, 9), 9)` });
    const session = new PineEngine().createSession(compiled.program!);
    try {
      await expect(session.runBatch(bars([10]))).rejects.toThrow("Index 9 is out of bounds, array size is 5");
    } finally {
      await session.close();
    }
  });
});

describe("map.put result", () => {
  it("returns the previous value, or na for a new key", async () => {
    const result = await run(`//@version=6
indicator("map.put")
m = map.new<string, int>()
first = m.put("a", 1)
replaced = m.put("a", 2)
added = map.put(m, "b", 3)
m.put("c", 4)
size = m.size()`, bars([10]));
    expect(result.returned).toMatchObject({ first: [Number.NaN], replaced: [1], added: [Number.NaN], size: [3] });
  });
});

describe("array.new<chart.point>", () => {
  it("constructs a typed array of chart points", async () => {
    const result = await run(`//@version=6
indicator("Points", overlay=true)
var array<chart.point> points = array.new<chart.point>()
points.push(chart.point.from_index(bar_index, close))
count = points.size()
lastPrice = points.last().price
sized = array.new<chart.point>(2).size()`, bars([10, 11, 12]));
    expect(result.returned).toMatchObject({ count: [1, 2, 3], lastPrice: [10, 11, 12], sized: [2, 2, 2] });
  });
});

describe("builtin history in conditional branches", () => {
  it("reads bar_index and calendar history from the previous bar", async () => {
    const result = await run(`//@version=6
indicator("Builtin history")
bool even = bar_index % 2 == 0
previousIndex = even ? bar_index[1] : na
previousDay = even ? dayofmonth[1] : na
twoBack = bar_index[2]`, bars([10, 11, 12, 13, 14]));
    const na = Number.NaN;
    expect(result.returned.previousIndex).toEqual([na, na, 1, na, 3]);
    // Bars start on 1 January 1970, one per UTC day.
    expect(result.returned.previousDay).toEqual([na, na, 2, na, 4]);
    expect(result.returned.twoBack).toEqual([na, na, 0, 1, 2]);
  });
});

describe("builtin variables read inside branches", () => {
  it("advances TA variables every bar and keeps builtin history", async () => {
    const result = await run(`//@version=6
strategy("Builtins in branches", margin_long=0)
if bar_index == 1
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 3
    strategy.close("L")
bool even = bar_index % 2 == 0
everyBar = ta.obv
branchObv = even ? ta.obv : na
previousSize = even ? strategy.position_size[1] : na
previousLast = even ? last_bar_index[1] : na
previousRange = even ? ta.tr[1] : na`, bars([10, 12, 11, 13, 12, 14]));
    const na = Number.NaN;
    const everyBar = result.returned.everyBar!;
    expect(result.returned.branchObv).toEqual(everyBar.map((value, index) => index % 2 === 0 ? value : na));
    // Entry fills on bar 2 and the close on bar 4.
    expect(result.returned.previousSize).toEqual([na, na, 0, na, 1, na]);
    expect(result.returned.previousLast).toEqual([na, na, 5, na, 5, na]);
    // Bars are close ± 2, so after the first bar the true range is at least 4.
    expect(result.returned.previousRange!.filter((_, index) => index > 0 && index % 2 === 0).every((value) => typeof value === "number" && value >= 4)).toBe(true);
  });
});

describe("re-sent strategy.exit with pyramiding", () => {
  const source = (resend: string) => `//@version=6
strategy("Pyramided exit", margin_long=0, pyramiding=2)
if bar_index == 0 or bar_index == 2
    strategy.entry("A", strategy.long, qty=1)
if ${resend}
    strategy.exit("X", "A", limit=17)`;
  const input = bars([10, 11, 12, 13, 14, 15, 16]);

  it("covers same-id entries placed after the exit was first sent", async () => {
    const result = await run(source("strategy.position_size > 0"), input);
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.closedTradeRecords.map(({ entryBarIndex, exitId }) => ({ entryBarIndex, exitId }))).toEqual([
      { entryBarIndex: 1, exitId: "X" },
      { entryBarIndex: 3, exitId: "X" },
    ]);
  });

  it("leaves a later entry uncovered when the exit is sent only once", async () => {
    const result = await run(source("bar_index == 1"), input);
    expect(result.strategy?.closedTradeRecords.map(({ entryBarIndex }) => entryBarIndex)).toEqual([1]);
    expect(result.strategy?.openTradeRecords.map(({ entryBarIndex }) => entryBarIndex)).toEqual([3]);
  });
});

// Expected values below were observed on the reference platform (EURUSD daily, FXCM)
// with recorded probes.
describe("behaviour observed on the reference platform", () => {
  it("does not replay skipped bars for a TA call inside a branch", async () => {
    const result = await run(`//@version=6
indicator("No backfill")
bool even = bar_index % 2 == 0
float branchSma = na
if even
    branchSma := ta.sma(close, 3)`, bars([10, 11, 12, 13, 14, 15, 16]));
    // Samples come only from even bars: 10, 12, 14, then 12, 14, 16. The
    // variable is not var, so odd bars read na.
    expect(result.returned.branchSma).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, 12, Number.NaN, 14]);
  });

  it("skips na samples in window statistics", async () => {
    const result = await run(`//@version=6
indicator("Present samples")
x = bar_index == 3 ? na : close
average = ta.sma(x, 3)
highest = ta.highest(x, 3)
lowestOffset = ta.lowestbars(x, 3)
deviation = ta.stdev(x, 3)
exponential = ta.ema(x, 2)`, bars([10, 14, 12, 99, 13, 15]));
    const na = Number.NaN;
    // Present samples: 10, 14, 12, (bar 3 missing), 13, 15.
    expect(result.returned.average).toEqual([na, na, 12, 12, 13, 40 / 3]);
    expect(result.returned.highest).toEqual([na, na, 14, 14, 14, 15]);
    // On bar 5 the window is bars 2, 4 and 5; the lowest, 12, is three bars back.
    expect(result.returned.lowestOffset).toEqual([na, na, -2, -3, -2, -3]);
    expect(result.returned.deviation![3]).toBeCloseTo(Math.sqrt(8 / 3), 9);
    // ta.ema returns na on the na bar and resumes from its state.
    expect(Number.isNaN(result.returned.exponential![3] as number)).toBe(true);
    // Seeded at 12 from (10 + 14) / 2, unchanged by 12, then 12 + (13 - 12) * 2 / 3.
    expect(result.returned.exponential![4]).toBeCloseTo(12 + (13 - 12) * 2 / 3, 9);
  });

  it("keeps ta.iii as (2 * close - high - low) / (high - low) * volume", async () => {
    const result = await run(`//@version=6
indicator("iii")
value = ta.iii`, bars([10]));
    // close 10, high 12, low 8, volume 100.
    expect(result.returned.value).toEqual([0]);
    const skewed = await run(`//@version=6
indicator("iii skewed")
value = ta.iii`, [{ openTime: 0, closeTime: DAY, open: 9, high: 12, low: 8, close: 11, volume: 100 }]);
    expect(skewed.returned.value).toEqual([(22 - 12 - 8) / 4 * 100]);
  });

  it("formats colors, rounding, percent and timestamps as the reference platform does", async () => {
    const result = await run(`//@version=6
indicator("Scalars")
transparency = str.tostring(color.t(color.new(color.blue, 33.7))) + "/" + str.tostring(color.t(color.new(color.blue, 0.6))) + "/" + str.tostring(color.t(color.rgb(1, 2, 3, 25)))
gradient = color.from_gradient(na, 0, 1, color.red, color.blue)
gradientParts = str.tostring(color.r(gradient)) + "/" + str.tostring(color.t(gradient))
rounded = str.tostring(math.round(1.005, 2)) + "/" + str.tostring(math.round(2.675, 2)) + "/" + str.tostring(math.round(-2.5))
percent = str.tostring(0.1234, format.percent) + "/" + str.tostring(12.3456, format.percent)
rolled = str.format_time(timestamp("UTC", 2024, 2, 30, 0, 0), "yyyy-MM-dd", "UTC") + "/" + str.format_time(timestamp("UTC", 2024, 13, 1, 0, 0), "yyyy-MM-dd", "UTC") + "/" + str.format_time(timestamp("UTC", 2024, 1, 0, 0, 0), "yyyy-MM-dd", "UTC")`, bars([10]));
    expect(result.returned).toMatchObject({
      transparency: ["33/0/25"],
      gradientParts: ["0/100"],
      rounded: ["1.01/2.68/-3"],
      percent: ["0.12%/12.35%"],
      rolled: ["2024-03-01/2025-01-01/2023-12-31"],
    });
  });
});

describe("scalar normalization boundaries", () => {
  it("rounds finite decimals without overflowing during rescaling", async () => {
    const result = await run(`//@version=6
indicator("Decimal boundaries")
large = math.round(1e308, 2) == 1e308
precise = math.round(1.125, 400) == 1.125
left = math.round(-15, -1)
underflow = math.round(-1, -400)`, bars([10]));
    expect(result.returned).toMatchObject({ large: [true], precise: [true], left: [-20], underflow: [-0] });
  });

  it("normalizes sub-day overflow across years below 100", async () => {
    const result = await run(`//@version=6
indicator("Early calendar rollover")
yearBoundary = timestamp("UTC", 99, 12, 31, 24)
monthBoundary = timestamp("UTC", 96, 2, 28, 48)`, bars([10]));
    expect(result.returned).toMatchObject({
      yearBoundary: [Date.parse("0100-01-01T00:00:00Z")],
      monthBoundary: [Date.parse("0096-03-01T00:00:00Z")],
    });
  });
});

// Observed on the reference platform with a recorded probe.
describe("expression history in ternary branches and if blocks", () => {
  it("keeps per-bar history for a top-level ternary expression but counts executions elsewhere", async () => {
    const result = await run(`//@version=6
indicator("Ternary history")
bool executes = bar_index % 2 == 0
prevArg(float src) =>
    src[1]
ternExpr = executes ? (bar_index * 10)[1] : na
ternFn = executes ? prevArg(bar_index) : na
ternSma = executes ? ta.sma(bar_index, 3) : na
var float ifExpr = na
if executes
    ifExpr := (bar_index * 10)[1]`, bars([10, 11, 12, 13, 14, 15, 16]));
    const last = 6;
    // The reference platform: -10, -2, -2 and -20 relative to the current bar.
    expect(result.returned.ternExpr![last]).toBe(last * 10 - 10);
    expect(result.returned.ternFn![last]).toBe(last - 2);
    expect(result.returned.ternSma![last]).toBe(last - 2);
    expect(result.returned.ifExpr![last]).toBe(last * 10 - 20);
  });

  it("samples at the source expression before later assignments, including object mutations", async () => {
    const result = await run(`//@version=6
indicator("History evaluation order")
bool executes = bar_index % 2 == 0
int x = bar_index
int early = executes ? (x * 10)[1] : na
int current = executes ? (x * 10)[0] : na
int two = executes ? (x * 10)[2] : na
int direct = executes ? x[1] : na
x := x + 1000
int late = executes ? (x * 10)[1] : na
varip int ip = 0
ip := bar_index
int persistent = executes ? (ip * 10)[1] : na
ip := ip + 1000
type Box
    int n
bump(Box obj, int n) =>
    obj.n := n
    0
var Box obj = Box.new(0)
obj.n := bar_index
int field = executes ? (obj.n * 10)[1] : na
obj.n := obj.n + 1000
obj.n := -1
int combined = bump(obj, bar_index) + (executes ? (obj.n * 10)[1] : 0)
obj.n := -1
int plain = bump(obj, bar_index) + obj.n * 10
obj.n := -1
int combinedZero = bump(obj, bar_index) + (obj.n * 10)[0]
obj.n := -1
int offset = barstate.islast ? 0 : 1
int dynamicZero = bump(obj, bar_index) + (obj.n * 10)[offset]`, bars([10, 11, 12, 13, 14, 15, 16]));
    const atLast = (name: string) => result.returned[name]?.at(-1);
    expect(atLast("early")).toBe(50);
    expect(atLast("current")).toBe(60);
    expect(atLast("two")).toBe(40);
    expect(atLast("direct")).toBe(1005);
    expect(atLast("late")).toBe(10050);
    expect(atLast("persistent")).toBe(50);
    expect(atLast("field")).toBe(50);
    expect(atLast("combined")).toBe(-10);
    expect(atLast("plain")).toBe(60);
    expect(atLast("combinedZero")).toBe(-10);
    expect(atLast("dynamicZero")).toBe(-10);
  });

  it("samples on the enclosing block's executions even when its ternary skips the operand", async () => {
    const result = await run(`//@version=6
indicator("Scoped ternary history")
bool executes = bar_index % 2 == 0
bool selected = bar_index % 4 == 2
int sparseLoop = for i = 0 to (executes ? 0 : na)
    (bar_index * 10)[1]
int nested = na
if executes
    nested := selected ? (bar_index * 10)[1] : na
int fromFor = na
for i = 0 to 0
    fromFor := executes ? (bar_index * 10)[1] : na
int fromForIn = na
for i in array.from(0)
    fromForIn := executes ? (bar_index * 10)[1] : na
int fromWhile = na
int i = 0
while i < 1
    fromWhile := executes ? (bar_index * 10)[1] : na
    i += 1
int fromSwitch = switch
    executes => (bar_index * 10)[1]
    => na
type Box
    int n
method prior(Box obj, bool take) =>
    take ? (obj.n * 10)[1] : na
var Box obj = Box.new(0)
obj.n := bar_index
int fromMethod = executes ? obj.prior(selected) : na`, bars([10, 11, 12, 13, 14, 15, 16]));
    const atLast = (name: string) => result.returned[name]?.at(-1);
    for (const name of ["sparseLoop", "nested", "fromSwitch", "fromMethod"]) expect(atLast(name), name).toBe(40);
    for (const name of ["fromFor", "fromForIn", "fromWhile"]) expect(atLast(name), name).toBe(50);
  });

  it("retains nested history, typed values, and the request child's global scope", async () => {
    const result = await run(`//@version=6
indicator("Nested history values")
bool executes = bar_index % 2 == 0
int nestedHistory = executes ? ((bar_index * 10)[1] + 5)[1] : na
string priorString = executes ? (executes ? "now" : "skip")[1] : "unused"
color priorColor = executes ? (executes ? color.lime : color.orange)[1] : na
bool priorBool = executes ? (bar_index % 2 == 0)[1] : false
int priorNa = executes ? (executes ? 42 : na)[1] : na
int fromRequest = request.security("", "", bar_index % 2 == 0 ? (bar_index * 10)[1] : na)`,
    bars([10, 11, 12, 13, 14, 15, 16]), "D");
    const atLast = (name: string) => result.returned[name]?.at(-1);
    expect(atLast("nestedHistory")).toBe(45);
    expect(atLast("priorString")).toBe("skip");
    expect(atLast("priorColor")).toBe("#FF9800");
    expect(atLast("priorBool")).toBe(false);
    expect(atLast("priorNa")).toBeNaN();
    expect(atLast("fromRequest")).toBe(50);
  });

  it("keeps the per-bar record across tail replacement and checkpoint restore", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Ternary history replay")
value = bar_index % 2 == 0 ? (close * 10)[1] : na` });
    const input = bars([10, 11, 12, 13, 14]);
    const session = new PineEngine().createSession(compiled.program!);
    const restored = new PineEngine().createSession(compiled.program!);
    try {
      await session.runBatch(input.slice(0, 4));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as ReturnType<typeof session.checkpoint>;
      await session.replaceTail([{ ...input[3]!, close: 99 }]);
      expect((await session.appendBars(input.slice(4))).returned.value!.at(-1)).toBe(990);
      await restored.restore(checkpoint);
      expect((await restored.appendBars(input.slice(4))).returned.value!.at(-1)).toBe(130);
    } finally {
      await session.close();
      await restored.close();
    }
  });
});

it("uses the latest present samples for changing Bollinger windows", async () => {
  const result = await run(`//@version=6
indicator("Dynamic Bollinger warm-up")
int length = bar_index % 3 + 2
float source = switch bar_index
    0 => 2
    1 => 5
    2 => 5
    3 => na
    4 => 3
    => 1
[basis, upper, lower] = ta.bb(source, length, 2)
float width = ta.bbw(source, length, 2)
float zeroWidth = ta.bbw(0.0, 3, 2)
plot(basis)`, bars([10, 11, 12, 13, 14, 15]));
  expect(result.returned.basis?.slice(0, 4)).toEqual([NaN, NaN, NaN, 5]);
  expect(result.returned.upper?.[3]).toBe(5);
  expect(result.returned.lower?.[3]).toBe(5);
  expect(result.returned.width?.[3]).toBe(0);
  expect(result.returned.basis?.[4]).toBeCloseTo(4.3333333333, 10);
  expect(result.returned.upper?.[4]).toBeCloseTo(6.2189514165, 10);
  expect(result.returned.lower?.[4]).toBeCloseTo(2.4477152502, 10);
  expect(result.returned.width?.[4]).toBeCloseTo(87.0285269153, 10);
  expect(result.returned.basis?.[5]).toBe(3.5);
  expect(result.returned.zeroWidth).toEqual([NaN, NaN, NaN, NaN, NaN, NaN]);
});

it("waits for percentile history and retains ordered slots when the window grows by one", async () => {
  const result = await run(`//@version=6
indicator("Dynamic percentile startup")
int length = bar_index % 3 + 2
float source = switch bar_index
    0 => 2
    1 => 5
    2 => 5
    3 => na
    4 => 3
    => 1
float nearest = ta.percentile_nearest_rank(source, length, 65)
float fixed = ta.percentile_nearest_rank(source, 3, 100)
float linear = ta.percentile_linear_interpolation(source, length, 35)
plot(nearest)`, bars([10, 11, 12, 13, 14, 15]));
  expect(result.returned.nearest).toEqual([NaN, NaN, NaN, NaN, 5, 5]);
  expect(result.returned.fixed).toEqual([NaN, NaN, 5, NaN, NaN, NaN]);
  expect(result.returned.linear?.slice(0, 4)).toEqual([NaN, NaN, NaN, NaN]);
  expect(result.returned.linear?.[4]).toBeCloseTo(4.1);
  expect(result.returned.linear?.[5]).toBeCloseTo(2.8);
});

it("searches mature percentile ranks through missing slots in order", async () => {
  const result = await run(`//@version=6
indicator("Mature percentile order")
float source = switch bar_index
    0 => 7
    1 => 4
    2 => na
    3 => 10
    4 => na
    5 => 1
    6 => 3
    => 4
float medianRank = ta.percentile_nearest_rank(source, 4, 50)
float upperRank = ta.percentile_nearest_rank(source, 4, 75)
plot(medianRank)`, bars([10, 11, 12, 13, 14, 15, 16, 17]));
  expect(result.returned.medianRank).toEqual([NaN, NaN, NaN, 7, NaN, NaN, 3, 3]);
  expect(result.returned.upperRank).toEqual([NaN, NaN, NaN, NaN, 10, 10, 10, 4]);
});

it.each([
  ['array<int> values = array.from(10, 20, 30)\nvalues.insert(4, 40)', "In 'array.insert()' function. Index 4 is out of bounds, array size is 3."],
  ['array<int> values = array.from(10, 20, 30)\nplot(values.remove(3))', "In 'array.remove()' function. Index 3 is out of bounds, array size is 3."],
  ['array<int> values = na\nvalues.sort()', "Cannot call array methods when id of array is na."],
  ['array<int> values = na\nplot(values.size())', "Cannot call array methods when id of array is na."],
  ['array<int> values = na\nplot(array.size(values))', "Cannot call array methods when id of array is na."],
  ['array<int> values = na\nplot(values.get(0))', "Cannot call array methods when id of array is na."],
])("reports the observed reference array error for %s", async (body, message) => {
  await expect(run(`//@version=6
indicator("Array errors")
${body}`, bars([10]))).rejects.toThrow(message);
});
