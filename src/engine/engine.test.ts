import { PINE_CALLABLE_METADATA, PINE_PLOT_CALL_SIGNATURES, type ExecutionDelta, type MarketBar, type SessionCheckpoint, PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";
import { createExecutor } from "../runtime/index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1, open: 9, high: 11, low: 8, close: 10, volume: 100 },
  { openTime: 2, open: 10, high: 12, low: 9, close: 11, volume: 110 },
  { openTime: 3, open: 11, high: 13, low: 10, close: 12, volume: 120 },
  { openTime: 4, open: 12, high: 14, low: 11, close: 13, volume: 130 },
  { openTime: 5, open: 13, high: 15, low: 12, close: 14, volume: 140 },
];

function program(source: string) {
  const result = compile({ source, compatibility: PINE_COMPATIBILITY.legacy });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

function productionProgram(source: string) {
  const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

describe("EngineSession", () => {
  it("reports historical execution progress with the current bar time", async () => {
    const compiled = program('//@version=6\nindicator("Progress")\nplot(close)');
    const progress: Array<{ currentBarTime: number | null; processedBars: number; totalBars: number }> = [];
    await new PineEngine().createSession(compiled).runBatch(bars, {
      onProgress: (value) => progress.push(value),
    });

    expect(progress[0]).toEqual({ currentBarTime: 1, processedBars: 1, totalBars: 5 });
    expect(progress.at(-1)).toEqual({ currentBarTime: 5, processedBars: 5, totalBars: 5 });
  });

  it("supports CSP-safe precompiled executor injection", async () => {
    const compiled = program('//@version=6\nindicator("Precompiled")\nplot(close)');
    let factories = 0;
    const session = new PineEngine().createSession(compiled, {
      codeGeneration: "precompiled",
      executorFactory: (requested) => {
        factories += 1;
        expect(requested).toBe(compiled);
        return createExecutor(requested);
      },
    });
    const result = await session.runBatch(bars.slice(0, 2));
    expect(factories).toBe(1);
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([10, 11]);
    expect(() => new PineEngine().createSession(compiled, { codeGeneration: "precompiled" })).toThrow("executorFactory");
  });
  it("executes comma-separated statements with per-segment persistence", async () => {
    const compiled = program(`//@version=6
indicator("Comma statements")
var persistent = 0, perBar = 0
persistent += 1, perBar += 1
plot(persistent), plot(perBar)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 3));
    expect(result.returned.persistent).toEqual([1, 2, 3]);
    expect(result.returned.perBar).toEqual([1, 1, 1]);
  });

  it("returns values from nested if/else function bodies", async () => {
    const compiled = program(`//@version=6
indicator("Nested conditions")
classify(float value) =>
    if value > 0
        if value > 2
            3
        else
            2
    else
        if value < -1
            -2
        else
            -1
positive = classify(3)
negative = classify(-2)
neutral = classify(0)
plot(positive)
plot(negative)
plot(neutral)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.positive).toEqual([3]);
    expect(result.returned.negative).toEqual([-2]);
    expect(result.returned.neutral).toEqual([-1]);
  });

  it("returns the final value from loop expressions", async () => {
    const compiled = program(`//@version=6
indicator("Loop expressions")
sum = 0
rangeResult = for i = 1 to 5
    sum += i
    sum
index = 0
whileResult = while index < 3
    index += 1
    index
plot(rangeResult, "Range")
plot(whileResult, "While")`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.rangeResult).toEqual([15]);
    expect(result.returned.whileResult).toEqual([3]);
  });

  it("executes multiline operator continuations inside functions", async () => {
    const compiled = program(`//@version=6
indicator("Continuations")
probe(int left, int right) =>
    string summary = "L: " + str.tostring(left) + " " +
                     "R: " + str.tostring(right)
    bool ordered = left <
                   right and
                   not na(summary)
    ordered ? left +
              right : 0
value = probe(10, 30)
plot(value)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.value).toEqual([40]);
  });

  it("executes branch-local declarations in expression blocks", async () => {
    const compiled = program(`//@version=6
indicator("Expression locals")
ifResult = if close > open
    body = close - open
    wick = high - close
    body + wick
else
    body = open - close
    wick = open - low
    body + wick
mode = "calculate"
switchResult = switch mode
    "calculate" =>
        temp = close * 2
        adjusted = temp + 10
        adjusted
    => 0.0
plot(ifResult)
plot(switchResult)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.ifResult).toEqual([2]);
    expect(result.returned.switchResult).toEqual([30]);
  });

  it("executes nested loops with block-local counters", async () => {
    const compiled = program(`//@version=6
indicator("Nested loops")
outer = 0
total = 0
while outer < 3
    int inner = 0
    while inner < 4
        total += 1
        inner += 1
    outer += 1
plot(total)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.total).toEqual([12]);
  });

  it("iterates and destructures a generic UDT array field", async () => {
    const compiled = program(`//@version=6
indicator("Generic field iteration")
type bucket
    array<float> prices = na
var value = bucket.new(array.from(10.0, 20.0, 30.0))
indexSum = 0
valueSum = 0.0
for [index, price] in value.prices
    indexSum += index
    valueSum += price
plot(indexSum)
plot(valueSum)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));
    expect(result.returned.indexSum).toEqual([3]);
    expect(result.returned.valueSum).toEqual([60]);
  });

  it("executes SMA plots with Pine history semantics", async () => {
    const compiled = program('//@version=6\nindicator("Kernel")\nprevious = close[1]\naverage = ta.sma(close, 3)\nplot(average, "SMA")');
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.previous).toEqual([Number.NaN, 10, 11, 12, 13]);
    expect(result.returned.average).toEqual([Number.NaN, Number.NaN, 11, 12, 13]);
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([Number.NaN, Number.NaN, 11, 12, 13]);
  });

  it("returns Bollinger Band width in percentage points", async () => {
    const compiled = program(`//@version=6
indicator("Bollinger Band width")
width = ta.bbw(close, 2, 2.0)
plot(width)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 2));
    expect(result.returned.width?.[0]).toBeNaN();
    expect(result.returned.width?.[1]).toBeCloseTo(19.047619047619, 10);
  });

  it("fills market entries on the next bar through one replayable strategy ledger", async () => {
    const compiled = program(`//@version=6
strategy("Ledger", initial_capital=1000, default_qty_type=strategy.fixed, default_qty_value=2)
if bar_index == 0
    strategy.entry("Long", strategy.long)
size = strategy.position_size
average = strategy.position_avg_price
capital = strategy.equity
plot(size, "Size")`);
    const engine = new PineEngine();
    const batch = await engine.createSession(compiled).runBatch(bars);
    expect(batch.returned.size).toEqual([0, 2, 2, 2, 2]);
    expect(batch.returned.average).toEqual([Number.NaN, 10, 10, 10, 10]);
    expect(batch.returned.capital).toEqual([1000, 1002, 1004, 1006, 1008]);
    expect(batch.strategy).toMatchObject({ positionSize: 2, positionAveragePrice: 10, openProfit: 8, netProfit: 0, equity: 1008 });
    expect(batch.strategy?.orders).toEqual([
      expect.objectContaining({ id: "Long", status: "filled", fillPrice: 10, fillBarIndex: 1 }),
    ]);
    expect(batch.strategy?.timeline).toHaveLength(bars.length);

    const paginated = engine.createSession(compiled);
    let finalPage: ExecutionDelta | undefined;
    for await (const page of paginated.runPaginated(bars, 2)) finalPage = page;
    expect(finalPage?.strategy).toEqual(batch.strategy);
  });

  it("applies strategy.order as a partial-close and reversal quantity delta", async () => {
    const compiled = program(`//@version=6
strategy("Order deltas", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=3)
if bar_index == 1
    strategy.order("Reduce", strategy.short, qty=1)
if bar_index == 2
    strategy.order("Reverse", strategy.short, qty=4)
size = strategy.position_size
average = strategy.position_avg_price
profit = strategy.netprofit
capital = strategy.equity`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.size).toEqual([0, 3, 2, -2, -2]);
    expect(result.returned.average).toEqual([Number.NaN, 10, 10, 12, 12]);
    expect(result.returned.profit).toEqual([0, 0, 1, 5, 5]);
    expect(result.returned.capital).toEqual([1000, 1003, 1005, 1003, 1001]);
    expect(result.strategy?.closedTradeRecords.map((trade) => trade.quantity)).toEqual([1, 2]);
  });

  it("fills conditional entry orders at their trigger prices", async () => {
    const compiled = program(`//@version=6
strategy("Conditional", initial_capital=1000)
if bar_index == 0
    strategy.entry("Limit", strategy.long, qty=1, limit=9.5)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.orders).toEqual([
      expect.objectContaining({ id: "Limit", command: "entry", type: "limit", status: "filled", fillPrice: 9.5, fillBarIndex: 1 }),
    ]);
    expect(result.strategy).toMatchObject({ positionSize: 1, positionAveragePrice: 9.5, openProfit: 4.5, equity: 1004.5 });
  });

  it("activates and fills stop-limit strategy orders", async () => {
    const longProgram = program(`//@version=6
strategy("Long stop limit", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1, stop=11, limit=10.5)`);
    const long = await new PineEngine().createSession(longProgram).runBatch(bars);
    expect(long.strategy?.orders[0]).toEqual(expect.objectContaining({ id: "Long", type: "stop-limit", status: "filled", fillPrice: 10.5, fillBarIndex: 1 }));

    const stagedBars: readonly MarketBar[] = [
      bars[0]!,
      { ...bars[1]!, low: 10.75 },
      bars[2]!,
    ];
    const staged = await new PineEngine().createSession(longProgram).runBatch(stagedBars);
    expect(staged.strategy?.orders[0]).toEqual(expect.objectContaining({ type: "stop-limit", status: "filled", fillBarIndex: 2 }));
    expect(staged.strategy?.orders[0]?.fillPrice).toBe(10.5);
  });

  it("requires configured tick excursions before limit fills", async () => {
    const compiled = program(`//@version=6
strategy("Verified limit", initial_capital=1000, backtest_fill_limits_assumption=2)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1, limit=10)`);
    const verificationBars: readonly MarketBar[] = [
      bars[0]!,
      { ...bars[1]!, low: 9.5 },
      { ...bars[2]!, low: 8.9 },
    ];
    const result = await new PineEngine().createSession(compiled, { symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.5 } }).runBatch(verificationBars);
    expect(result.strategy?.orders[0]).toEqual(expect.objectContaining({ status: "filled", fillBarIndex: 2, fillPrice: 10 }));
  });

  it("closes selected entries, closes the book, and cancels pending entries", async () => {
    const compiled = program(`//@version=6
strategy("Close ledger", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
    strategy.entry("Pending", strategy.long, qty=1, limit=8)
if bar_index == 1
    strategy.close("Long", qty=1)
    strategy.cancel("Pending")
if bar_index == 2
    strategy.close_all()
size = strategy.position_size
profit = strategy.netprofit
closed = strategy.closedtrades`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.size).toEqual([0, 2, 1, 0, 0]);
    expect(result.returned.profit).toEqual([0, 0, 1, 3, 3]);
    expect(result.returned.closed).toEqual([0, 0, 1, 2, 2]);
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Pending", status: "cancelled" }),
      expect.objectContaining({ id: "close_Long", command: "close", status: "filled", fillBarIndex: 2 }),
      expect.objectContaining({ id: "close_all", command: "close_all", status: "filled", fillBarIndex: 3 }),
    ]));
  });

  it("includes the full exit-bar excursion in closed trade peaks", async () => {
    const compiled = program(`//@version=6
strategy("Exit excursion", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
if bar_index == 2
    strategy.close_all()`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.closedTradeRecords[0]).toMatchObject({
      entryId: "Long",
      exitBarIndex: 3,
      maxDrawdown: 2,
      maxRunup: 8,
    });
  });

  it("reports CAGR and buy-and-hold performance from the reference anchors", async () => {
    const day = 86_400_000;
    const performanceBars: readonly MarketBar[] = [
      { openTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { openTime: day, open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { openTime: 364 * day, open: 110, high: 115, low: 105, close: 110, volume: 100 },
      { openTime: 365 * day, open: 120, high: 130, low: 115, close: 130, volume: 100 },
    ];
    const compiled = program(`//@version=6
strategy("Performance", initial_capital=100, margin_long=0)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)
if bar_index == 2
    strategy.close_all()`);
    const result = await new PineEngine().createSession(compiled).runBatch(performanceBars);
    expect(result.strategy).toMatchObject({
      netProfit: 20,
      buyAndHoldProfit: 30,
      buyAndHoldPercent: 30,
      strategyOutperformance: -10,
    });
    expect(result.strategy?.cagr).toBeCloseTo(20, 12);
  });

  it("reports monthly mark-to-market Sharpe and Sortino ratios", async () => {
    const riskBars: readonly MarketBar[] = [
      { openTime: Date.UTC(2025, 0, 1), open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { openTime: Date.UTC(2025, 0, 2), open: 100, high: 200, low: 100, close: 200, volume: 100 },
      { openTime: Date.UTC(2025, 1, 1), open: 200, high: 200, low: 145, close: 145, volume: 100 },
      { openTime: Date.UTC(2025, 2, 1), open: 145, high: 249.5, low: 145, close: 249.5, volume: 100 },
    ];
    const compiled = program(`//@version=6
strategy("Risk adjusted", initial_capital=1000, risk_free_rate=2, margin_long=0)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)`);
    const result = await new PineEngine().createSession(compiled).runBatch(riskBars);
    expect(result.strategy?.sharpeRatio).toBeCloseTo(0.6835366, 6);
    expect(result.strategy?.sortinoRatio).toBeCloseTo(1.6203056, 6);
  });

  it("cancels pending strategy exits by id while cancel-all preserves exits", async () => {
    const targetedProgram = program(`//@version=6
strategy("Cancel exit", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)
    strategy.exit("Target", "Long", limit=20)
if bar_index == 1
    strategy.cancel("Target")`);
    const targeted = await new PineEngine().createSession(targetedProgram).runBatch(bars);
    expect(targeted.strategy?.orders.find((order) => order.id === "Target")).toEqual(expect.objectContaining({ status: "cancelled" }));

    const allProgram = program(`//@version=6
strategy("Cancel all exits", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)
    strategy.exit("Target", "Long", limit=20)
if bar_index == 1
    strategy.cancel_all()`);
    const all = await new PineEngine().createSession(allProgram).runBatch(bars);
    expect(all.strategy?.orders.find((order) => order.id === "Target")).toEqual(expect.objectContaining({ status: "pending" }));
  });

  it("supports immediate closes when orders process on the bar close", async () => {
    const compiled = program(`//@version=6
strategy("Immediate", initial_capital=1000, process_orders_on_close=true)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
if bar_index == 1
    strategy.close_all(immediately=true)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.orders.at(-1)).toEqual(expect.objectContaining({ command: "close_all", fillBarIndex: 1, fillPrice: 11, status: "filled" }));
    expect(result.strategy).toMatchObject({ positionSize: 0, netProfit: 2, equity: 1002 });
  });

  it("fills eligible current-bar orders in the process-on-close phase", async () => {
    const compiled = program(`//@version=6
strategy("Close phase", initial_capital=1000, process_orders_on_close=true)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.orders[0]).toEqual(expect.objectContaining({ id: "Long", fillBarIndex: 0, fillPrice: 10, status: "filled" }));
    expect(result.strategy).toMatchObject({ positionSize: 1, positionAveragePrice: 10 });
  });

  it("accounts for directional slippage, commissions, and aggregate trade metrics", async () => {
    const compiled = program(`//@version=6
strategy("Costs", initial_capital=1000, slippage=1, commission_type=strategy.commission.percent, commission_value=1)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
if bar_index == 1
    strategy.close_all()
losses = strategy.losstrades
averageLoss = strategy.avg_losing_trade
contracts = strategy.max_contracts_held_all`);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.5, pointvalue: 1 },
    }).runBatch(bars);
    expect(result.strategy).toMatchObject({
      positionSize: 0,
      netProfit: -0.42,
      grossProfit: 0,
      grossLoss: 0.42,
      winningTrades: 0,
      losingTrades: 1,
      evenTrades: 0,
      maxContractsHeld: 2,
      equity: 999.58,
    });
    expect(result.strategy?.closedTradeRecords[0]).toMatchObject({ entryPrice: 10.5, exitPrice: 10.5, profit: -0.42, commission: 0.42 });
    expect(result.returned.losses).toEqual([0, 0, 1, 1, 1]);
    expect(result.returned.averageLoss!.slice(2)).toEqual([0.42, 0.42, 0.42]);
    expect(result.returned.contracts).toEqual([0, 2, 2, 2, 2]);
  });

  it("uses the reference mintick default when applying strategy slippage", async () => {
    const compiled = program(`//@version=6
strategy("Default tick", initial_capital=1000, slippage=1)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 2));
    expect(result.strategy?.orders[0]).toMatchObject({ fillPrice: 10.01, status: "filled" });
    expect(result.strategy?.positionAveragePrice).toBe(10.01);
  });

  it("fills entry-scoped tick exits with partial quantities", async () => {
    const compiled = program(`//@version=6
strategy("Bracket", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
    strategy.exit("Take half", "Long", qty_percent=50, profit=2)`);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.5, pointvalue: 1 },
    }).runBatch(bars);
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Take half", command: "exit", targetEntryId: "Long", quantityPercent: 50, profitTicks: 2, status: "filled", fillPrice: 11, fillBarIndex: 1 }),
    ]));
    expect(result.strategy).toMatchObject({ positionSize: 1, positionAveragePrice: 10, netProfit: 1, openProfit: 4, equity: 1005 });
    expect(result.strategy?.closedTradeRecords[0]).toMatchObject({ quantity: 1, entryPrice: 10, exitPrice: 11, profit: 1 });
  });

  it("preserves strategy broker alert metadata on orders and triggered exits", async () => {
    const compiled = program(`//@version=6
strategy("Messages", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1, comment="Entry", alert_message="entry-filled")
    strategy.exit("Bracket", "Long", limit=11, stop=8, alert_profit="take-profit", alert_loss="stop-loss", disable_alert=true)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Long", comment: "Entry", alertMessage: "entry-filled" }),
      expect.objectContaining({ id: "Bracket", alertMessage: "take-profit", disableAlert: true, status: "filled" }),
    ]));
  });

  it("keeps entry-scoped exits independent across pyramided trades", async () => {
    const pyramidBars: readonly MarketBar[] = [
      bars[0]!,
      bars[1]!,
      bars[2]!,
      { ...bars[3]!, high: 12.5 },
      bars[4]!,
    ];
    const compiled = program(`//@version=6
strategy("Pyramid exits", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0 or bar_index == 1
    strategy.entry("Long", strategy.long, qty=1)
if bar_index == 2
    strategy.exit("Target", "Long", profit=2)`);
    const result = await new PineEngine().createSession(compiled, { symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 1 } }).runBatch(pyramidBars);
    expect(result.strategy).toMatchObject({ positionSize: 0, closedTrades: 2, netProfit: 4 });
    expect(result.strategy?.closedTradeRecords.map((trade) => ({ entryPrice: trade.entryPrice, exitPrice: trade.exitPrice, exitBarIndex: trade.exitBarIndex }))).toEqual([
      { entryPrice: 10, exitPrice: 12, exitBarIndex: 3 },
      { entryPrice: 11, exitPrice: 13, exitBarIndex: 4 },
    ]);
  });

  it("orders bracket and margin events along the deterministic intrabar path", async () => {
    const favorableBars: readonly MarketBar[] = [
      { openTime: 1, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: 2, open: 10, high: 12, low: 8, close: 10, volume: 100 },
    ];
    const bracketProgram = program(`//@version=6
strategy("Path", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)
    strategy.exit("Bracket", "Long", limit=11, stop=9)`);
    const favorable = await new PineEngine().createSession(bracketProgram).runBatch(favorableBars);
    expect(favorable.strategy?.closedTradeRecords[0]).toEqual(expect.objectContaining({ exitPrice: 11, profit: 1 }));

    const adverseBars: readonly MarketBar[] = [favorableBars[0]!, { ...favorableBars[1]!, high: 13 }];
    const adverse = await new PineEngine().createSession(bracketProgram).runBatch(adverseBars);
    expect(adverse.strategy?.closedTradeRecords[0]).toEqual(expect.objectContaining({ exitPrice: 9, profit: -1 }));

    const marginProgram = program(`//@version=6
strategy("Margin path", initial_capital=100, margin_long=50)
if bar_index == 0
    strategy.entry("Leveraged", strategy.long, qty=18)
    strategy.exit("Target", "Leveraged", limit=11)`);
    const margin = await new PineEngine().createSession(marginProgram).runBatch(adverseBars);
    expect(margin.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "margin_call", quantity: 8, fillPrice: 8 }),
      expect.objectContaining({ id: "Target", status: "filled", fillPrice: 11 }),
    ]));
    expect(margin.strategy).toMatchObject({ positionSize: 0, netProfit: -6, closedTrades: 2 });
  });

  it("arms and fills trailing exits from persistent peak state", async () => {
    const compiled = program(`//@version=6
strategy("Trailing", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=1)
    strategy.exit("Trail", "Long", trail_points=2, trail_offset=1)`);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.5, pointvalue: 1 },
    }).runBatch(bars);
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Trail", command: "exit", trailPoints: 2, trailOffset: 1, trailArmed: true, trailPeak: 12, status: "filled", fillPrice: 11.5, fillBarIndex: 1 }),
    ]));
    expect(result.strategy).toMatchObject({ positionSize: 0, netProfit: 1.5, equity: 1001.5 });
  });

  it("blocks fills through strategy risk direction and position rules", async () => {
    const compiled = program(`//@version=6
strategy("Risk", initial_capital=1000, pyramiding=3)
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.risk.max_position_size(2)
if bar_index == 0
    strategy.entry("Short", strategy.short, qty=1)
    strategy.entry("Too large", strategy.long, qty=3)
    strategy.entry("Allowed", strategy.long, qty=2)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Short", status: "cancelled" }),
      expect.objectContaining({ id: "Too large", status: "cancelled" }),
      expect.objectContaining({ id: "Allowed", status: "filled" }),
    ]));
    expect(result.strategy).toMatchObject({ positionSize: 2, positionAveragePrice: 10, maxContractsHeld: 2 });
  });

  it("converts strategy currency values and reports default entry quantity", async () => {
    const compiled = program(`//@version=6
strategy("Conversions", initial_capital=1000, currency=currency.USD, default_qty_type=strategy.percent_of_equity, default_qty_value=25)
account = strategy.convert_to_account(50)
symbol = strategy.convert_to_symbol(75)
quantity = strategy.default_entry_qty(20)
accountCurrency = strategy.account_currency
usd = currency.USD`);
    const identity = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "USD" },
    }).runBatch(bars);
    expect(identity.returned.account).toEqual([50, 50, 50, 50, 50]);
    expect(identity.returned.symbol).toEqual([75, 75, 75, 75, 75]);
    expect(identity.returned.quantity).toEqual([12.5, 12.5, 12.5, 12.5, 12.5]);
    expect(identity.returned.accountCurrency).toEqual(Array(5).fill("USD"));
    expect(identity.returned.usd).toEqual(Array(5).fill("USD"));

    const mismatched = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "MYR" },
    }).runBatch(bars);
    expect(mismatched.returned.account).toEqual(Array(5).fill(Number.NaN));
    expect(mismatched.returned.symbol).toEqual(Array(5).fill(Number.NaN));
  });

  it("tracks strategy equity drawdown and runup from intrabar excursions", async () => {
    const compiled = program(`//@version=6
strategy("Excursions", initial_capital=1000)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2)
drawdown = strategy.max_drawdown
drawdownPercent = strategy.max_drawdown_percent
runup = strategy.max_runup
runupPercent = strategy.max_runup_percent`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.drawdown).toEqual([0, 2, 2, 2, 2]);
    expect(result.returned.runup).toEqual([0, 4, 6, 8, 10]);
    expect(result.strategy).toMatchObject({ maxDrawdown: 2, maxDrawdownPercent: 0.2, maxRunup: 10 });
    expect(result.strategy?.maxRunupPercent).toBeCloseTo(10 / 1010 * 100, 12);
  });

  it("cancels and reduces sibling orders in strategy OCA groups", async () => {
    const cancelProgram = program(`//@version=6
strategy("OCA cancel", initial_capital=1000)
if bar_index == 0
    strategy.order("Limit", strategy.long, qty=1, limit=9.5, oca_name="choice", oca_type=strategy.oca.cancel)
    strategy.order("Stop", strategy.long, qty=1, stop=10.5, oca_name="choice", oca_type=strategy.oca.cancel)`);
    const cancelled = await new PineEngine().createSession(cancelProgram).runBatch(bars);
    expect(cancelled.strategy).toMatchObject({ positionSize: 1 });
    expect(cancelled.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Limit", status: "filled", ocaName: "choice", ocaType: "cancel" }),
      expect.objectContaining({ id: "Stop", status: "cancelled", ocaName: "choice", ocaType: "cancel" }),
    ]));

    const reduceProgram = program(`//@version=6
strategy("OCA reduce", initial_capital=1000)
if bar_index == 0
    strategy.order("First", strategy.long, qty=1, limit=9.5, oca_name="scale", oca_type=strategy.oca.reduce)
    strategy.order("Second", strategy.long, qty=2, stop=10.5, oca_name="scale", oca_type=strategy.oca.reduce)`);
    const reduced = await new PineEngine().createSession(reduceProgram).runBatch(bars);
    expect(reduced.strategy).toMatchObject({ positionSize: 2 });
    expect(reduced.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "First", quantity: 1, status: "filled" }),
      expect.objectContaining({ id: "Second", quantity: 1, status: "filled" }),
    ]));
  });

  it("rejects undercollateralized entries and partially liquidates margin breaches", async () => {
    const marginBars: readonly MarketBar[] = [
      { openTime: 1, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: 2, open: 10, high: 11, low: 8, close: 9, volume: 100 },
      { openTime: 3, open: 9, high: 10, low: 9, close: 10, volume: 100 },
    ];
    const compiled = program(`//@version=6
strategy("Margin", initial_capital=100, margin_long=50)
if bar_index == 0
    strategy.entry("Leveraged", strategy.long, qty=18)
size = strategy.position_size
liquidation = strategy.margin_liquidation_price`);
    const result = await new PineEngine().createSession(compiled, { symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.1, pointvalue: 1 } }).runBatch(marginBars);
    expect(result.returned.size).toEqual([0, 10, 10]);
    expect(result.returned.liquidation![1]).toBeCloseTo(3.1, 12);
    expect(result.strategy).toMatchObject({ positionSize: 10, netProfit: -16 });
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Margin call-1", command: "margin_call", quantity: 8, fillPrice: 8, status: "filled" }),
    ]));

    const rejectedProgram = program(`//@version=6
strategy("Rejected", initial_capital=100, margin_long=50)
if bar_index == 0
    strategy.entry("Too large", strategy.long, qty=21)`);
    const rejected = await new PineEngine().createSession(rejectedProgram).runBatch(marginBars);
    expect(rejected.strategy).toMatchObject({ positionSize: 0 });
    expect(rejected.strategy?.orders[0]).toEqual(expect.objectContaining({ id: "Too large", status: "cancelled" }));
  });

  it("checks existing strategy margin at the next bar open", async () => {
    const gapBars: readonly MarketBar[] = [
      { openTime: 1, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: 2, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: 3, open: 5, high: 6, low: 4, close: 5, volume: 100 },
    ];
    const compiled = program(`//@version=6
strategy("Gap margin", initial_capital=100, margin_long=50)
if bar_index == 0
    strategy.entry("Leveraged", strategy.long, qty=18)`);
    const result = await new PineEngine().createSession(compiled).runBatch(gapBars);
    expect(result.strategy).toMatchObject({ positionSize: 0, netProfit: -90 });
    expect(result.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Margin call-open-2", command: "margin_call", quantity: 18, fillPrice: 5, fillBarIndex: 2 }),
    ]));
  });

  it("keeps strategy runup anchored after a losing partial exit", async () => {
    const losingBars: readonly MarketBar[] = [
      { openTime: 1, open: 100, high: 100, low: 100, close: 100, volume: 100 },
      { openTime: 2, open: 100, high: 101, low: 99, close: 100, volume: 100 },
      { openTime: 3, open: 90, high: 95, low: 89, close: 93, volume: 100 },
      { openTime: 4, open: 94, high: 97, low: 93, close: 96, volume: 100 },
    ];
    const compiled = productionProgram(`//@version=6
strategy("Losing partial exit", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.close("L", qty=4)
runup = strategy.max_runup
runupPercent = strategy.max_runup_percent
position = strategy.position_size`);
    const result = await new PineEngine().createSession(compiled, {
      symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "USD", pointvalue: 1 },
    }).runBatch(losingBars);
    expect(result.returned.position).toEqual([0, 10, 6, 6]);
    expect(result.returned.runup).toEqual([0, 10, 10, 10]);
    expect(result.returned.runupPercent).toEqual([0, 1000 / 1010, 1000 / 1010, 1000 / 1010]);
  });

  it("reads indexed open and closed strategy trade records", async () => {
    const compiled = program(`//@version=6
strategy("Trade records", initial_capital=1000, margin_long=50)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=2, comment="Seed")
if bar_index == 1
    strategy.close("Long", qty=1, comment="Partial")
openId = strategy.opentrades.entry_id(0)
openPrice = strategy.opentrades.entry_price(0)
openSize = strategy.opentrades.size(0)
openProfit = strategy.opentrades.profit(0)
openRunup = strategy.opentrades.max_runup(0)
held = strategy.opentrades.capital_held
closedId = strategy.closedtrades.entry_id(0)
closedProfit = strategy.closedtrades.profit(0)
closedSize = strategy.closedtrades.size(0)
closedExit = strategy.closedtrades.exit_id(0)
closedComment = strategy.closedtrades.exit_comment(0)
first = strategy.closedtrades.first_index`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.openId).toEqual(["", "Long", "Long", "Long", "Long"]);
    expect(result.returned.openPrice).toEqual([Number.NaN, 10, 10, 10, 10]);
    expect(result.returned.openSize).toEqual([Number.NaN, 2, 1, 1, 1]);
    expect(result.returned.held).toEqual([Number.NaN, 10, 5, 5, 5]);
    expect(result.returned.closedId).toEqual(["", "", "Long", "Long", "Long"]);
    expect(result.returned.closedProfit).toEqual([Number.NaN, Number.NaN, 1, 1, 1]);
    expect(result.returned.closedSize).toEqual([Number.NaN, Number.NaN, 1, 1, 1]);
    expect(result.returned.closedExit).toEqual(["", "", "close_Long", "close_Long", "close_Long"]);
    expect(result.returned.closedComment).toEqual(["", "", "Partial", "Partial", "Partial"]);
    expect(result.returned.first).toEqual([0, 0, 0, 0, 0]);
    expect(result.returned.openProfit![1]).toBe(2);
    expect(result.returned.openRunup![1]).toBe(4);
  });

  it("halts, cancels, and flattens the ledger on catastrophic strategy risk", async () => {
    const riskBars: readonly MarketBar[] = [
      { openTime: Date.UTC(2026, 0, 1), open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { openTime: Date.UTC(2026, 0, 2), open: 10, high: 11, low: 8, close: 9, volume: 100 },
      { openTime: Date.UTC(2026, 0, 3), open: 9, high: 9, low: 9, close: 9, volume: 100 },
      { openTime: Date.UTC(2026, 0, 4), open: 9, high: 9, low: 9, close: 9, volume: 100 },
    ];
    const drawdownProgram = program(`//@version=6
strategy("Drawdown halt", initial_capital=100, margin_long=0)
strategy.risk.max_drawdown(10, strategy.cash)
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=10)`);
    const drawdown = await new PineEngine().createSession(drawdownProgram).runBatch(riskBars);
    expect(drawdown.strategy).toMatchObject({ positionSize: 0, netProfit: -10 });
    expect(drawdown.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Risk rule-1", command: "close_all", quantity: 10, fillPrice: 9, status: "filled" }),
    ]));

    const lossDaysProgram = program(`//@version=6
strategy("Loss days", initial_capital=100, margin_long=0)
strategy.risk.max_cons_loss_days(1)
if bar_index == 0
    strategy.entry("Loss", strategy.long, qty=1)
if bar_index == 1
    strategy.close_all()
if bar_index == 2
    strategy.entry("Recovery", strategy.long, qty=1)`);
    const lossDays = await new PineEngine().createSession(lossDaysProgram).runBatch(riskBars);
    expect(lossDays.strategy).toMatchObject({ positionSize: 0, losingTrades: 1 });
    expect(lossDays.strategy?.orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Recovery", status: "cancelled" }),
    ]));
  });

  it("replays strategy state identically across append, tail replacement, checkpoints, and inputs", async () => {
    const compiled = program(`//@version=6
strategy("Realtime ledger", initial_capital=1000, margin_long=0)
qty = input.float(2, "Quantity")
if bar_index == 0
    strategy.entry("Long", strategy.long, qty=qty)
if bar_index == 1
    strategy.exit("Target", "Long", limit=13.5)`);
    const engine = new PineEngine();
    const batch = await engine.createSession(compiled).runBatch(bars);

    const realtime = engine.createSession(compiled);
    await realtime.runBatch(bars.slice(0, 3));
    const checkpoint = realtime.checkpoint();
    const appended = await realtime.appendBars(bars.slice(3));
    expect(appended.strategy).toEqual(batch.strategy);
    expect(appended.strategy?.timeline.map(({ pendingOrders, filledOrders, closedTrades }) => ({ pendingOrders, filledOrders, closedTrades }))).toEqual([
      { pendingOrders: 1, filledOrders: 0, closedTrades: 0 },
      { pendingOrders: 1, filledOrders: 1, closedTrades: 0 },
      { pendingOrders: 1, filledOrders: 1, closedTrades: 0 },
      { pendingOrders: 0, filledOrders: 2, closedTrades: 1 },
      { pendingOrders: 0, filledOrders: 2, closedTrades: 1 },
    ]);

    const revised = { ...bars[3]!, high: 12, low: 11, close: 12 };
    const replaced = await realtime.replaceTail([revised, bars[4]!]);
    const expectedReplacement = await engine.createSession(compiled).runBatch([...bars.slice(0, 3), revised, bars[4]!]);
    expect(replaced.strategy).toEqual(expectedReplacement.strategy);
    expect(replaced.strategy?.orders.find((order) => order.id === "Target")?.fillBarIndex).toBe(4);

    await realtime.restore(checkpoint);
    const restored = await realtime.appendBars(bars.slice(3));
    expect(restored.strategy).toEqual(batch.strategy);

    await realtime.updateInputs({ qty: 1 });
    const updated = await realtime.runBatch(bars);
    const expectedInput = await engine.createSession(compiled, { inputs: { qty: 1 } }).runBatch(bars);
    expect(updated.strategy).toEqual(expectedInput.strategy);
  });

  it("retains history for calls and compound expressions", async () => {
    const compiled = program(`//@version=6
indicator("Expression history")
previousAverage = ta.sma(close, 3)[1]
previousSpread = (high - low)[1]
plot(previousAverage)
plot(previousSpread)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.previousAverage).toEqual([Number.NaN, Number.NaN, Number.NaN, 11, 12]);
    expect(result.returned.previousSpread).toEqual([Number.NaN, 3, 3, 3, 3]);
  });

  it("makes batch, append, and tail replacement equivalent", async () => {
    const compiled = program('//@version=5\nindicator("EMA")\ne = ta.ema(close, 3)\nplot(e)');
    const engine = new PineEngine();
    const batch = await engine.createSession(compiled).runBatch(bars);
    const incremental = engine.createSession(compiled);
    await incremental.runBatch(bars.slice(0, 2));
    const appended = await incremental.appendBars(bars.slice(2));
    expect(appended.returned).toEqual(batch.returned);
    expect(appended.stats.processedBars).toBe(4);
    const revised = { ...bars[4]!, close: 20 };
    const replaced = await incremental.replaceTail([revised]);
    const expected = await engine.createSession(compiled).runBatch([...bars.slice(0, 4), revised]);
    expect(replaced.returned).toEqual(expected.returned);
    expect(replaced.fromIndex).toBe(4);
    expect(replaced.stats.processedBars).toBe(1);
  });

  it("supports host inputs and source series without private hooks", async () => {
    const compiled = program('//@version=6\nindicator("Source")\nlength = input.int(2, title="Length")\naverage = ta.sma(close, length)\nplot(average)');
    const session = new PineEngine().createSession(compiled, {
      inputs: { Length: 3 },
      sourceSeries: { close: [1, 2, 3, 4, 5] },
    });
    const result = await session.runBatch(bars);
    expect(result.returned.average).toEqual([Number.NaN, Number.NaN, 2, 3, 4]);
  });

  it("applies scalar input overrides by their public titles", async () => {
    const compiled = program(`//@version=6
indicator("Inputs")
enabled = input.bool(true, "Enabled")
ratio = input.float(1.5, "Ratio")
count = input.int(2, "Count")
value = enabled ? ratio + count : 0
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      inputs: { Enabled: false, Ratio: 3.5, Count: 4 },
    }).runBatch(bars);
    expect(result.returned.value).toEqual([0, 0, 0, 0, 0]);
  });

  it("prefers stable input identifiers and resolves source-name overrides", async () => {
    const compiled = program(`//@version=6
indicator("Input identities")
first = input.int(1, "Duplicate")
second = input.int(2, "Duplicate")
empty = input.bool(true, "")
auto = input(3.5, "Auto")
source = input(close, "Source")
custom = input.source(close, "Custom")`);
    const result = await new PineEngine().createSession(compiled, {
      inputs: { Duplicate: 99, first: 10, second: 20, empty: false, auto: 4.5, source: "hlc3", Custom: "custom-series" },
      sourceSeries: { "custom-series": [21, 22, 23, 24, 25] },
    }).runBatch(bars);
    expect(result.returned.first).toEqual([10, 10, 10, 10, 10]);
    expect(result.returned.second).toEqual([20, 20, 20, 20, 20]);
    expect(result.returned.empty).toEqual([false, false, false, false, false]);
    expect(result.returned.auto).toEqual([4.5, 4.5, 4.5, 4.5, 4.5]);
    expect(result.returned.source).toEqual([29 / 3, 32 / 3, 35 / 3, 38 / 3, 41 / 3]);
    expect(result.returned.custom).toEqual([21, 22, 23, 24, 25]);
  });

  it("applies native enum input overrides as resolved field titles", async () => {
    const compiled = program(`//@version=6
indicator("Enum override")
enum speed
    fast = "Fast"
    slow = "Slow"
speed selected = input.enum(speed.fast, "Speed", options=[speed.fast, speed.slow])`);
    const result = await new PineEngine().createSession(compiled, { inputs: { selected: "Slow" } }).runBatch(bars);
    expect(result.returned.selected).toEqual(["Slow", "Slow", "Slow", "Slow", "Slow"]);
  });

  it("exposes deterministic batch barstate flags", async () => {
    const compiled = program(`//@version=6
indicator("Bar state")
first = barstate.isfirst
last = barstate.islast
history = barstate.ishistory
realtime = barstate.isrealtime
fresh = barstate.isnew`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.first).toEqual([true, false, false, false, false]);
    expect(result.returned.last).toEqual([false, false, false, false, true]);
    expect(result.returned.history).toEqual([true, true, true, true, false]);
    expect(result.returned.realtime).toEqual([false, false, false, false, true]);
    expect(result.returned.fresh).toEqual([true, true, true, true, true]);
  });

  it("identifies confirmed bars and the last confirmed history bar", async () => {
    const compiled = program(`//@version=6
indicator("Confirmed state")
confirmed = barstate.isconfirmed
lastConfirmed = barstate.islastconfirmedhistory`);
    const now = 2_000_000;
    const liveBars = bars.map((bar, index) => ({ ...bar, closeTime: index === bars.length - 1 ? now + 60_000 : now - 60_000 + index }));
    const live = await new PineEngine().createSession(compiled, { now: () => now }).runBatch(liveBars);
    expect(live.returned.confirmed).toEqual([true, true, true, true, false]);
    expect(live.returned.lastConfirmed).toEqual([false, false, false, true, false]);
    const closedBars = liveBars.map((bar) => ({ ...bar, closeTime: now - 1 }));
    const closed = await new PineEngine().createSession(compiled, { now: () => now }).runBatch(closedBars);
    expect(closed.returned.lastConfirmed).toEqual([false, false, false, false, true]);
  });

  it("makes pagination and checkpoint restoration batch-equivalent", async () => {
    const compiled = program('//@version=6\nindicator("State")\nvar float total = 0\ntotal := total + close\nplot(total)');
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled).runBatch(bars);
    const paginated = engine.createSession(compiled);
    let final;
    for await (const page of paginated.runPaginated(bars, 2)) final = page;
    expect(final?.returned).toEqual(expected.returned);
    const checkpoint = paginated.checkpoint();
    await paginated.replaceTail([{ ...bars[4]!, close: 100 }]);
    const restored = await paginated.restore(checkpoint);
    expect(restored.returned).toEqual(expected.returned);
  });

  it("restores a versioned checkpoint after JSON serialization", async () => {
    const compiled = program(`//@version=6
indicator("Portable state")
var values = array.new<float>()
array.push(values, close)
average = ta.ema(close, 3)
plot(average)`);
    const engine = new PineEngine();
    const session = engine.createSession(compiled);
    const prefix = await session.runBatch(bars.slice(0, 3));
    const portable = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    await session.appendBars(bars.slice(3));
    const restored = await session.restore(portable);
    expect(restored.returned).toEqual(prefix.returned);
    const appended = await session.appendBars(bars.slice(3));
    const expected = await engine.createSession(compiled).runBatch(bars);
    expect(appended.returned).toEqual(expected.returned);
    expect(appended.plots).toEqual(expected.plots);
  });

  it("rejects portable checkpoints produced by another program", async () => {
    const first = program('//@version=6\nindicator("First")\nplot(close)');
    const second = program('//@version=6\nindicator("Second")\nplot(open)');
    const firstSession = new PineEngine().createSession(first);
    await firstSession.runBatch(bars.slice(0, 2));
    const checkpoint = JSON.parse(JSON.stringify(firstSession.checkpoint())) as SessionCheckpoint;
    await expect(new PineEngine().createSession(second).restore(checkpoint)).rejects.toThrow("does not belong");
  });

  it("rejects portable checkpoints without the producing executor identity", async () => {
    const compiled = program('//@version=6\nindicator("Identity")\nplot(close)');
    const firstSession = new PineEngine().createSession(compiled);
    await firstSession.runBatch(bars.slice(0, 2));
    const checkpoint = JSON.parse(JSON.stringify(firstSession.checkpoint())) as SessionCheckpoint;
    delete (checkpoint as { executorVersion?: string }).executorVersion;

    await expect(new PineEngine().createSession(compiled).restore(checkpoint)).rejects.toThrow("does not belong");
  });

  it("enforces the per-bar loop operation budget", async () => {
    const compiled = program(`//@version=6
indicator("Budget")
counter = 0
while counter < 100
    counter += 1
plot(counter)`);
    const session = new PineEngine().createSession(compiled, { limits: { maxOperationsPerBar: 20 } });
    await expect(session.runBatch(bars.slice(0, 1))).rejects.toThrow("Operation budget exceeded");
  });

  it("replays seeded random values deterministically", async () => {
    const compiled = program('//@version=6\nindicator("Random")\nvalue = math.random()\nplot(value)');
    const session = new PineEngine().createSession(compiled, { randomSeed: 42 });
    const first = await session.runBatch(bars);
    const replay = await session.runBatch(bars);
    const other = await new PineEngine().createSession(compiled, { randomSeed: 43 }).runBatch(bars);
    expect(replay.returned.value).toEqual(first.returned.value);
    expect(other.returned.value).not.toEqual(first.returned.value);
  });

  it("rejects cross-context security calls without host child data", async () => {
    const compiled = program('//@version=6\nindicator("Request")\nvalue = request.security("NASDAQ:MSFT", "D", close)\nplot(value)');
    const session = new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
    });
    await expect(session.runBatch(bars)).rejects.toThrow("request.security requires a marketDataGateway");
  });

  it("executes cross-symbol request child plans through the host gateway", async () => {
    const compiled = program('//@version=6\nindicator("Request")\nvalue = request.security("NASDAQ:MSFT", "D", close, calc_bars_count=42)\nplot(value)');
    const requestedBars = bars.map((bar, index) => ({ ...bar, closeTime: bar.openTime + 1, close: 100 + index }));
    const requests: { symbol: string; timeframe: string }[] = [];
    const session = new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async (request) => {
          requests.push(request);
          return { bars: requestedBars, symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" } };
        },
      },
    });
    const result = await session.runBatch(bars);
    expect(requests).toEqual([{ symbol: "NASDAQ:MSFT", timeframe: "D", calcBarsCount: 42 }]);
    expect(result.returned.value).toEqual([100, 101, 102, 103, 104]);
  });

  it("validates lower timeframes before loading host data", async () => {
    const ignored = program(`//@version=6
indicator("Ignored timeframe")
value = request.security_lower_tf("NASDAQ:MSFT", "60", close, ignore_invalid_timeframe=true)
plot(value)`);
    const strict = program(`//@version=6
indicator("Strict timeframe")
value = request.security_lower_tf("NASDAQ:MSFT", "60", close)
plot(value)`);
    const options = { timeframe: "30", symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" } } as const;
    const result = await new PineEngine().createSession(ignored, options).runBatch(bars);
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
    await expect(new PineEngine().createSession(strict, options).runBatch(bars)).rejects.toThrow("is not lower than or equal");
  });

  it("deduplicates request loads and preserves incremental replay equivalence", async () => {
    const compiled = program(`//@version=6
indicator("Requests")
first = request.security("NASDAQ:MSFT", "D", close)
second = request.security("NASDAQ:MSFT", "D", high)
plot(first + second)`);
    const requestedBars = bars.map((bar, index) => ({ ...bar, closeTime: bar.openTime + 1, close: 100 + index, high: 200 + index }));
    let loads = 0;
    const options = {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => {
          loads += 1;
          return { bars: requestedBars, symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" } };
        },
      },
    } as const;
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled, options).runBatch(bars);
    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(bars.slice(0, 2));
    const appended = await incremental.appendBars(bars.slice(2));
    expect(appended.returned).toEqual(expected.returned);
    const checkpoint = incremental.checkpoint();
    const revised = { ...bars[4]!, close: 20 };
    const replaced = await incremental.replaceTail([revised]);
    const expectedReplacement = await engine.createSession(compiled, options).runBatch([...bars.slice(0, 4), revised]);
    expect(replaced.returned).toEqual(expectedReplacement.returned);
    const restored = await incremental.restore(checkpoint);
    expect(restored.returned).toEqual(expected.returned);
    expect(restored.stats.processedBars).toBe(0);
    expect(loads).toBe(5);
  });

  it("resolves input-backed symbol and timeframe request selectors", async () => {
    const compiled = program(`//@version=6
indicator("Dynamic request")
requestedSymbol = input.symbol("NASDAQ:MSFT", "Requested symbol")
requestedTimeframe = input.timeframe("D", "Requested timeframe")
value = request.security(requestedSymbol, requestedTimeframe, close)
plot(value)`);
    const requestedBars = bars.map((bar, index) => ({ ...bar, closeTime: bar.openTime + 1, close: 300 + index }));
    const requests: { symbol: string; timeframe: string }[] = [];
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "60",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      inputs: {
        requestedSymbol: "NASDAQ:GOOG",
        requestedTimeframe: "60",
        "Requested symbol": "NASDAQ:IGNORED",
        "Requested timeframe": "D",
      },
      marketDataGateway: {
        load: async (request) => {
          requests.push(request);
          return { bars: requestedBars, symbolInfo: { ticker: "GOOG", tickerid: "NASDAQ:GOOG" } };
        },
      },
    }).runBatch(bars);
    expect(requests).toEqual([{ symbol: "NASDAQ:GOOG", timeframe: "60" }]);
    expect(result.returned.value).toEqual([300, 301, 302, 303, 304]);
  });

  it("resolves syminfo.tickerid and timeframe.period to the chart context", async () => {
    const compiled = program(`//@version=6
indicator("Chart-relative request")
value = request.security(syminfo.tickerid, timeframe.period, close)
plot(value)`);
    let loads = 0;
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => {
          loads += 1;
          return { bars };
        },
      },
    }).runBatch(bars);
    expect(loads).toBe(0);
    expect(result.returned.value).toEqual(bars.map((bar) => bar.close));
  });

  it("keeps timeframe.main_period stable inside request contexts", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Main request timeframe")
value = request.security(syminfo.tickerid, "60", timeframe.period == "60" and timeframe.main_period == "1D" ? 1 : 0)
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      mainTimeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async () => ({ bars }),
      },
    }).runBatch(bars);

    expect(result.returned.value).toEqual(bars.map(() => 1));
  });

  it("executes tuple request results inside user functions", async () => {
    const compiled = program(`//@version=6
indicator("Function request tuple")
getData() =>
    [requestedClose, requestedVolume] = request.security(syminfo.tickerid, timeframe.period, [close, volume])
    requestedClose + requestedVolume
value = getData()
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
    }).runBatch(bars);
    expect(result.returned.value).toEqual(bars.map((bar) => bar.close + bar.volume));
  });

  it("executes parameter-bound requests inside user functions", async () => {
    const compiled = program(`//@version=6
indicator("Function request parameter")
fetch(float source) =>
    request.security(syminfo.tickerid, timeframe.period, source)
value = fetch(open)
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
    }).runBatch(bars);
    expect(result.returned.value).toEqual(bars.map((bar) => bar.open));
  });

  it("keeps a single written request capture equivalent across batch, pagination and append", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Single request capture")
fetch(float source) => request.security(syminfo.tickerid, timeframe.period, source + 1)
plot(fetch(close))`);
    const options = { timeframe: "D", symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" } } as const;
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled, options).runBatch(bars);
    const paginated = engine.createSession(compiled, options);
    let final;
    for await (const page of paginated.runPaginated(bars, 2)) final = page;
    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(bars.slice(0, 2));
    const appended = await incremental.appendBars(bars.slice(2));

    expect(expected.plots[0]?.points.map((point) => point.value)).toEqual([11, 12, 13, 14, 15]);
    expect(final?.plots).toEqual(expected.plots);
    expect(appended.plots).toEqual(expected.plots);
  });

  it("executes receiver state before requests inside methods", async () => {
    const compiled = program(`//@version=6
indicator("Method request")
type Counter
    int n = 0
method tick(Counter this) =>
    this.n += 1
    values = request.security_lower_tf(syminfo.tickerid, timeframe.period, this.n)
    values.first()
var Counter counter = Counter.new()
value = counter.tick()
plot(value)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
    }).runBatch(bars.slice(0, 3));
    expect(result.returned.value).toEqual([1, 2, 3]);
  });

  it("cancels pending request dependencies when the parent session closes", async () => {
    const compiled = program('//@version=6\nindicator("Cancellation")\nvalue = request.security("NASDAQ:MSFT", "D", close)\nplot(value)');
    let activeLoads = 0;
    let dependencySignal: AbortSignal | undefined;
    const session = new PineEngine().createSession(compiled, {
      timeframe: "D",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async (_request, signal) => new Promise<never>((_resolve, reject) => {
          activeLoads += 1;
          dependencySignal = signal;
          const abort = (): void => {
            activeLoads -= 1;
            reject(signal.reason instanceof Error ? signal.reason : new DOMException("Execution aborted", "AbortError"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
      },
    });
    const pending = session.runBatch(bars);
    expect(activeLoads).toBe(1);
    await session.close();
    await expect(pending).rejects.toThrow("Engine session closed");
    expect(dependencySignal?.aborted).toBe(true);
    expect(activeLoads).toBe(0);
  });

  it("keeps the higher/lower request matrix equivalent across session modes", async () => {
    const compiled = program(`//@version=6
indicator("Request matrix")
confirmed = request.security("NASDAQ:MSFT", "60", close)
future = request.security("NASDAQ:MSFT", "60", close, lookahead=barmerge.lookahead_on)
sparse = request.security("NASDAQ:MSFT", "60", close, gaps=barmerge.gaps_on)
selected = request.security("NASDAQ:MSFT", "15", close)
intrabar = request.security_lower_tf("NASDAQ:MSFT", "15", close)
intrabarCount = intrabar.size()
local = close
plot(confirmed)
plot(future)
plot(sparse)
plot(selected)
plot(intrabarCount)
plot(local)`);
    const start = Date.UTC(2025, 0, 2);
    const chartBars = Array.from({ length: 4 }, (_, index): MarketBar => ({
      openTime: start + index * 1_800_000,
      closeTime: start + (index + 1) * 1_800_000,
      open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index, volume: 100 + index,
    }));
    const hourlyBars = Array.from({ length: 2 }, (_, index): MarketBar => ({
      openTime: start + index * 3_600_000,
      closeTime: start + (index + 1) * 3_600_000,
      open: 90 + index, high: 110 + index, low: 80 + index, close: 200 + index, volume: 1000 + index,
    }));
    const quarterHourBars = Array.from({ length: 8 }, (_, index): MarketBar => ({
      openTime: start + index * 900_000,
      closeTime: start + (index + 1) * 900_000,
      open: 40 + index, high: 50 + index, low: 30 + index, close: 100 + index, volume: 500 + index,
    }));
    const options = {
      timeframe: "30",
      symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL" },
      marketDataGateway: {
        load: async (request: { timeframe: string }) => ({
          bars: request.timeframe === "60" ? hourlyBars : quarterHourBars,
          symbolInfo: { ticker: "MSFT", tickerid: "NASDAQ:MSFT" },
        }),
      },
    } as const;
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled, options).runBatch(chartBars);

    const paginated = engine.createSession(compiled, options);
    let paginatedResult: ExecutionDelta | undefined;
    for await (const page of paginated.runPaginated(chartBars, 2)) paginatedResult = page;
    expect(paginatedResult?.returned).toEqual(expected.returned);

    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(chartBars.slice(0, 1));
    const appended = await incremental.appendBars(chartBars.slice(1));
    expect(appended.returned).toEqual(expected.returned);
    const checkpoint = incremental.checkpoint();
    const revised = { ...chartBars[3]!, close: 99 };
    const replaced = await incremental.replaceTail([revised]);
    const expectedReplacement = await engine.createSession(compiled, options).runBatch([...chartBars.slice(0, 3), revised]);
    expect(replaced.returned).toEqual(expectedReplacement.returned);
    const restored = await incremental.restore(checkpoint);
    expect(restored.returned).toEqual(expected.returned);
  });

  it("emits stable alert events with per-callsite frequencies", async () => {
    const compiled = program(`//@version=6
indicator("Alerts")
for i = 0 to 1
    alert("all", alert.freq_all)
    alert("once", alert.freq_once_per_bar)
alertcondition(close > open, "Bullish", "Green bar")`);
    const result = await new PineEngine().createSession(compiled, { alertMode: "all" }).runBatch(bars);
    expect(result.alerts.filter((event) => event.message === "all")).toHaveLength(bars.length * 2);
    expect(result.alerts.filter((event) => event.message === "once")).toHaveLength(bars.length);
    expect(result.alerts.filter((event) => event.type === "alertcondition")).toHaveLength(bars.length);
    expect(new Set(result.alerts.filter((event) => event.message === "once").map((event) => event.id))).toEqual(new Set(["alert_1"]));
  });

  it("replays and rolls back alert events deterministically", async () => {
    const compiled = program(`//@version=6
indicator("Alert replay")
alert("tick", alert.freq_once_per_bar)
alertcondition(close > open, "Bullish", "Green bar")`);
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled, { alertMode: "all" }).runBatch(bars);
    const session = engine.createSession(compiled, { alertMode: "all" });
    await session.runBatch(bars.slice(0, 2));
    const appended = await session.appendBars(bars.slice(2));
    expect(appended.alerts).toEqual(expected.alerts);
    const checkpoint = session.checkpoint();
    await session.replaceTail([{ ...bars[4]!, open: 20, close: 10 }]);
    const restored = await session.restore(checkpoint);
    expect(restored.alerts).toEqual(expected.alerts);
    const realtime = await engine.createSession(compiled).runBatch(bars);
    expect(realtime.alerts.every((event) => event.barIndex === bars.length - 1)).toBe(true);
  });

  it("creates, mutates, copies, queries, and deletes stable line drawings", async () => {
    const compiled = program(`//@version=6
indicator("Lines")
var primary = line.new(0, 100, 10, 200, xloc=xloc.bar_index, extend=extend.right, color=color.red, style=line.style_dashed, width=3)
primary.set_y2(close)
var copied = line.copy(primary)
if barstate.islast
    line.delete(copied)
price = line.get_price(primary, 5)
count = line.all.size()
plot(price)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.price).toEqual([55, 55.5, 56, 56.5, 57]);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.drawings).toEqual([{
      kind: "line", id: 0, x1: 0, y1: 100, x2: 10, y2: 14, xloc: "bi", extend: "r",
      color: "#F23645", style: "style_dashed", width: 3, forceOverlay: false,
    }]);
    const incremental = new PineEngine().createSession(compiled);
    await incremental.runBatch(bars.slice(0, 2));
    const appended = await incremental.appendBars(bars.slice(2));
    expect(appended.drawings).toEqual(result.drawings);
    const checkpoint = incremental.checkpoint();
    await incremental.replaceTail([{ ...bars[4]!, close: 50 }]);
    const restored = await incremental.restore(checkpoint);
    expect(restored.drawings).toEqual(result.drawings);
  });

  it("creates and updates persistent box drawings", async () => {
    const compiled = program(`//@version=6
indicator("Boxes")
var primary = box.new(0, 20, 10, 5, border_color=color.red, border_width=2, border_style=line.style_dotted, extend=extend.right, xloc=xloc.bar_index, bgcolor=color.blue, text="Zone", text_size="large", text_color=color.white, text_halign="left", text_valign="top", text_wrap="wrap_auto", text_font_family="monospace")
primary.set_right(bar_index)
primary.set_bottom(low)
primary.set_text_formatting("format_bold")
var copied = box.copy(primary)
if barstate.islast
    box.delete(copied)
bottom = box.get_bottom(primary)
count = box.all.size()
plot(bottom)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.bottom).toEqual([8, 9, 10, 11, 12]);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.drawings).toContainEqual(expect.objectContaining({
      kind: "box", id: 0, left: 0, right: 4, top: 20, bottom: 12, text: "Zone",
      borderColor: "#F23645", backgroundColor: "#2196F3", textFormatting: "format_bold",
    }));
  });

  it("creates and updates persistent label drawings", async () => {
    const compiled = program(`//@version=6
indicator("Labels")
var primary = label.new(0, 10, "Start", xloc=xloc.bar_index, yloc=yloc.price, color=color.blue, style=label.style_label_up, textcolor=color.white, size=size.large, textalign="right", tooltip="Initial", text_font_family="default")
primary.set_xy(bar_index, high)
primary.set_text("Updated")
primary.set_tooltip("Details")
primary.set_text_font_family("monospace")
var copied = label.copy(primary)
if barstate.islast
    label.delete(copied)
y = label.get_y(primary)
count = label.all.size()
plot(y)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.y).toEqual([11, 12, 13, 14, 15]);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.drawings).toContainEqual({
      kind: "label", id: 0, x: 4, y: 15, text: "Updated", xloc: "bi", yloc: "pr", color: "#2196F3",
      style: "style_label_up", textColor: "#FFFFFF", size: "large", textAlign: "right", tooltip: "Details",
      textFontFamily: "monospace", textFormatting: "format_none", forceOverlay: false,
    });
  });

  it("uses host chart colors for theme-aware Pine drawings", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Theme colors")
label.new(bar_index, close, "Theme", color=chart.bg_color, textcolor=chart.fg_color)`);
    const result = await new PineEngine().createSession(compiled, {
      chartColors: { background: "#ffffff", foreground: "#131722" },
    }).runBatch(bars.slice(0, 1));

    expect(result.drawings).toContainEqual(expect.objectContaining({
      kind: "label",
      color: "#ffffff",
      textColor: "#131722",
    }));
  });

  it("uses chart points across drawings and persistent polylines", async () => {
    const compiled = program(`//@version=6
indicator("Points")
p1 = chart.point.from_index(0, 20)
p2 = chart.point.from_index(2, 10)
p3 = chart.point.from_index(4, 15)
var pointLine = line.new(p1, p2, color=color.red, width=3, force_overlay=true)
var pointBox = box.new(p1, p2, border_color=color.green, bgcolor=color.blue, force_overlay=true)
var pointLabel = label.new(p1, "Point", color=color.orange, textcolor=color.white, size=size.large, force_overlay=true)
points = array.from(p1, p2, p3)
var shape = polyline.new(points, curved=true, closed=true, xloc=xloc.bar_index, line_color=color.green, fill_color=color.blue, line_style=line.style_dashed, line_width=2)
var removed = polyline.new(points)
latest = chart.point.now(close)
if barstate.islast
    line.set_second_point(pointLine, latest)
    box.set_bottom_right_point(pointBox, latest)
    label.set_point(pointLabel, latest)
    polyline.delete(removed)
count = polyline.all.size()
plot(line.get_y2(pointLine))`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "line", x2: 4, y2: 14, color: "#F23645", width: 3, forceOverlay: true }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "box", right: 4, bottom: 14, borderColor: "#4CAF50", backgroundColor: "#2196F3", forceOverlay: true }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "label", x: 4, y: 14, color: "#FF9800", textColor: "#FFFFFF", size: "large", forceOverlay: true }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "polyline", id: 0, curved: true, closed: true, lineWidth: 2 }));
  });

  it("preserves line and polyline creation order in the production profile", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Cross-type order")
points = array.from(chart.point.from_index(0, 10), chart.point.from_index(1, 11))
var curve = polyline.new(points)
var segment = line.new(0, 9, 1, 12)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.drawings
      .filter((drawing) => drawing.kind === "line" || drawing.kind === "polyline")
      .map((drawing) => [drawing.kind, drawing.order]))
      .toEqual([["line", 1], ["polyline", 0]]);
  });

  it("reads and mutates independent chart-point fields", async () => {
    const compiled = program(`//@version=6
indicator("Point fields")
point = chart.point.now(close)
point.price += 1
point.index := point.index + 2
point.time := point.time + 100
copy = chart.point.copy(point)
copy.price += 5
if barstate.islast
    line.new(point, copy)
price = point.price
copiedPrice = copy.price
indexValue = point.index
timeValue = point.time
plot(price)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.price).toEqual([11, 12, 13, 14, 15]);
    expect(result.returned.copiedPrice).toEqual([16, 17, 18, 19, 20]);
    expect(result.returned.indexValue).toEqual([2, 3, 4, 5, 6]);
    expect(result.returned.timeValue).toEqual([101, 102, 103, 104, 105]);
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "line", x1: 6, y1: 15, x2: 6, y2: 20 }));
  });

  it("supports typed drawing na values and null-safe handle methods", async () => {
    const compiled = program(`//@version=6
indicator("Typed drawings")
box bx = box(na)
line ln = line(na)
label lb = label(na)
polyline pl = polyline(na)
table tb = table(na)
var line current = na
current.set_xy1(bar_index, close)
if not na(current)
    current.delete()
current := line.new(bar_index, low, bar_index, high)
allMissing = na(bx) and na(ln) and na(lb) and na(pl) and na(tb)
plot(allMissing ? 1 : 0)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.allMissing).toEqual([true, true, true, true, true]);
    expect(result.drawings.filter((drawing) => drawing.kind === "line")).toEqual([
      expect.objectContaining({ kind: "line", id: 4, x1: 4, y1: 12, x2: 4, y2: 15 }),
    ]);
  });

  it("persists UDT drawing fields and delegates their methods", async () => {
    const compiled = program(`//@version=6
indicator("UDT drawings")
type Container
    line ln
    label lb = na
    box bx
    float price = na
var Container container = Container.new(
    ln=line.new(na, na, na, na, color=color.red, width=2),
    bx=box.new(na, na, na, na, border_color=color.blue))
container.ln.set_xy1(bar_index, high)
container.ln.set_xy2(bar_index, low)
container.bx.set_lefttop(bar_index - 1, high)
container.bx.set_rightbottom(bar_index, low)
container.lb.delete()
container.price := close
if barstate.islast
    container.lb := label.new(bar_index, close, "Last", color=color.green)
    container.lb.set_xy(bar_index, high)
price = container.price
plot(price)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.price).toEqual([10, 11, 12, 13, 14]);
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "line", id: 0, x1: 4, y1: 15, x2: 4, y2: 12, color: "#F23645", width: 2 }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "box", id: 0, left: 3, top: 15, right: 4, bottom: 12, borderColor: "#2196F3" }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "label", id: 0, x: 4, y: 15, text: "Last", color: "#4CAF50" }));
  });

  it("supports UDT arrays, chained drawing fields, and history field reads", async () => {
    const compiled = program(`//@version=6
indicator("UDT arrays")
type Wave
    line ln = na
    float price = na
var Wave[] waves = array.new<Wave>(0)
if barstate.isfirst
    waves.push(Wave.new(line.new(na, na, na, na, color=color.purple), close))
waves.get(0).ln.set_xy1(bar_index, high)
waves.get(0).ln.set_xy2(bar_index, low)
wave = waves.get(0)
wave.price := close
snapshot = Wave.new(price=close)
previous = snapshot.price[1]
plot(previous)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.previous).toEqual([Number.NaN, 10, 11, 12, 13]);
    expect(result.drawings.filter((drawing) => drawing.kind === "line")).toEqual([
      expect.objectContaining({ kind: "line", id: 0, x1: 4, y1: 15, x2: 4, y2: 12, color: "#9C27B0" }),
    ]);
  });

  it("runs user-defined UDT methods with drawing delegation and receiver mutation", async () => {
    const compiled = program(`//@version=6
indicator("UDT methods")
type Fib
    line first = na
    line second = na
    float last = na
setLines(float value) => value * 2
method setLines(Fib fib, int x1, int x2, float value, float offset=10) =>
    fib.first.set_xy1(x1, value)
    fib.first.set_xy2(x2, value)
    fib.second.set_xy1(x1, value + offset)
    fib.second.set_xy2(x2, value + offset)
    fib.last := value
    fib
var Fib state = Fib.new(
    line.new(na, na, na, na, color=color.blue),
    line.new(na, na, na, na, color=color.green))
var Fib empty = Fib.new()
updated = state.setLines(x1=bar_index-1, x2=bar_index, value=close)
empty.setLines(bar_index-1, bar_index, close)
regular = setLines(close)
combined = updated.last + regular
plot(combined)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.combined).toEqual([30, 33, 36, 39, 42]);
    expect(result.drawings.filter((drawing) => drawing.kind === "line")).toEqual([
      expect.objectContaining({ kind: "line", id: 0, x1: 3, y1: 14, x2: 4, y2: 14, color: "#2196F3" }),
      expect.objectContaining({ kind: "line", id: 1, x1: 3, y1: 24, x2: 4, y2: 24, color: "#4CAF50" }),
    ]);
  });

  it("mutates nested and array-returned UDT fields", async () => {
    const compiled = program(`//@version=6
indicator("Nested UDT writes")
type Item
    float value = 0
type Holder
    Item nested
var Item[] items = array.new<Item>(0)
if barstate.isfirst
    items.push(Item.new())
var Holder holder = Holder.new(Item.new())
items.get(0).value := close
items.get(0).value += 1
holder.nested.value := high
combined = items.get(0).value + holder.nested.value
plot(combined)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.combined).toEqual([22, 24, 26, 28, 30]);
  });

  it("creates independent shallow UDT copies through static and instance syntax", async () => {
    const compiled = program(`//@version=6
indicator("UDT copy")
type Holder
    line ln = na
    float price = na
var Holder original = Holder.new(line.new(na, na, na, na, color=color.red), close)
staticCopy = Holder.copy(original)
instanceCopy = original.copy()
staticCopy.price := close
instanceCopy.price := high
instanceCopy.ln.set_xy2(bar_index, high)
combined = original.price + staticCopy.price + instanceCopy.price
plot(combined)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.combined).toEqual([31, 33, 35, 37, 39]);
    expect(result.drawings).toEqual([
      expect.objectContaining({ kind: "line", id: 0, x2: 4, y2: 15, color: "#F23645" }),
    ]);
  });

  it("dispatches overloaded and UFCS methods by UDT receiver type", async () => {
    const compiled = program(`//@version=6
indicator("Typed method dispatch")
type Counter
    int value = 0
type Meter
    int value = 0
method apply(Counter receiver, int amount) =>
    receiver.value += amount
    receiver
method apply(Meter receiver, int amount) =>
    receiver.value += amount * 2
    receiver
method delete(Counter receiver) => receiver
var Counter counter = Counter.new()
var Meter meter = Meter.new()
var Counter[] counters = array.new<Counter>(0)
if barstate.isfirst
    counters.push(Counter.new())
counter.apply(1)
apply(meter, 2)
counters.get(0).apply(3)
var line builtin = line.new(na, na, na, na)
builtin.delete()
combined = counter.value + meter.value + counters.get(0).value
plot(combined)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.combined).toEqual([8, 16, 24, 32, 40]);
    expect(result.drawings).toEqual([]);
  });

  it("executes same-receiver arity and type overloads plus a builtin array override", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Method overload results")
type Item
    int value
method read(Item self) => self.value
method read(Item self, int extra) => self.value + extra
method read(Item self, bool extra) => extra ? self.value + 10 : self.value
method fill(array<float> self, float inner, float outer, float lo, float hi) =>
    self.set(0, inner)
    self
item = Item.new(2)
values = array.from(1.0)
values.fill(4.0, 0.0, 0.0, 5.0)
result = item.read() + item.read(extra=3) + item.read(true) + values.get(0) + read(item) + read(item, 3) + Item.new(2).read() + Item.new(2).read(3)
plot(result)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.result).toEqual([37, 37, 37, 37, 37]);
  });

  it("selects the narrowest compatible qualified method signature", async () => {
    const compiled = productionProgram(`//@version=6
indicator("Qualified overloads")
type Item
    int value
method choose(Item self, simple int count) => self.value + 1
method choose(Item self, series int count) => self.value + 2
item = Item.new(0)
result = item.choose(input.int(1)) + item.choose(bar_index)
plot(result)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.result).toEqual([3, 3, 3, 3, 3]);
  });

  it("raises on an evaluated v6 field read while letting a missing object reach its user method", async () => {
    // Recorded probe language-udt-missing.txt.
    const source = (expression: string) => `//@version=6
indicator("Missing object reads")
type Sample
    int n = 2
method read(Sample value) =>
    value.n
method inspect(Sample value) =>
    na(value) ? 11 : 22
Sample absent = na
bool take = input.bool(false)
int result = ${expression}
plot(result)`;
    const run = async (compiled: ReturnType<typeof productionProgram>) => {
      const session = new PineEngine().createSession(compiled);
      try {
        return (await session.runBatch(bars.slice(0, 2))).returned.result;
      } finally {
        await session.close();
      }
    };

    for (const expression of ["take ? absent.n : 7", "take ? (absent[1]).n : 7", "take ? absent.read() : 7"]) {
      await expect(run(productionProgram(source(expression)))).resolves.toEqual([7, 7]);
    }
    await expect(run(productionProgram(source("absent.inspect()")))).resolves.toEqual([11, 11]);
    for (const [expression, line] of [
      ["take ? (absent.n * 10)[1] : 7", 11],
      ["absent.n", 11],
      ["absent.read()", 6],
    ] as const) {
      await expect(run(productionProgram(source(expression)))).rejects.toMatchObject({
        code: "SCRIPT_RUNTIME_ERROR",
        method: "Sample.n",
        message: "Cannot access the 'Sample.n' field of an undefined object. The object is 'na'.",
        range: { start: { line } },
      });
    }
    await expect(run(program(source("absent.n")))).resolves.toEqual([NaN, NaN]);
    await expect(run(program(source("absent.inspect()")))).resolves.toEqual([NaN, NaN]);

    const unparenthesized = compile({
      source: source("take ? absent[1].n : 7"),
      compatibility: PINE_COMPATIBILITY.strict,
    });
    expect(unparenthesized.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT1003",
      message: "Enclose the history reference in parentheses before accessing a member",
    }));
  });

  it("keeps namespace calls distinct from shadowing method parameters", async () => {
    const compiled = program(`//@version=6
indicator("Namespace shadow")
type Palette
    color shade = na
method apply(Palette receiver, color color) =>
    receiver.shade := color.new(color, 50)
    receiver
var Palette palette = Palette.new()
updated = palette.apply(color.red)
red = color.r(updated.shade)
plot(red)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.red).toEqual([242, 242, 242, 242, 242]);
  });

  it("exposes the scoped Pine constant namespaces with reference values", async () => {
    const compiled = program(`//@version=6
indicator("Constants")
formatValue = format.percent
textValue = text.align_left
fontValue = font.family_monospace
adjustmentValue = adjustment.splits
backadjustmentValue = backadjustment.on
earningsValue = earnings.future_eps
dividendsValue = dividends.future_amount
splitsValue = splits.numerator
weekdayValue = dayofweek.friday
orderValue = order.ascending
displayNone = display.none
displayPane = display.pane
displayStatusLine = display.status_line
displayPriceScale = display.price_scale
displayDataWindow = display.data_window
displayAll = display.all
displayWithoutPane = display.all - display.pane
displayInformation = display.status_line + display.data_window
gapsValue = barmerge.gaps_on
plotValue = plot.style_stepline_diamond
linestyleValue = plot.linestyle_dashed`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(Object.fromEntries(Object.entries(result.returned).map(([name, values]) => [name, values[0]]))).toMatchObject({
      formatValue: "percent",
      textValue: "left",
      fontValue: "monospace",
      adjustmentValue: "splits",
      backadjustmentValue: "on",
      earningsValue: "earnings_future_eps",
      dividendsValue: "dividends_future_amount",
      splitsValue: "splits_numerator",
      weekdayValue: 6,
      orderValue: 1,
      displayNone: 0,
      displayPane: 1,
      displayStatusLine: 2,
      displayPriceScale: 4,
      displayDataWindow: 8,
      displayAll: 31,
      displayWithoutPane: 30,
      displayInformation: 10,
      gapsValue: "gaps_on",
      plotValue: "style_stepline_diamond",
      linestyleValue: "linestyle_dashed",
    });
  });

  it("keeps current plot-family schemas and out-of-order visual options intact", async () => {
    for (const name of Object.keys(PINE_PLOT_CALL_SIGNATURES)) {
      expect(PINE_CALLABLE_METADATA[name]?.parameters).toEqual(PINE_PLOT_CALL_SIGNATURES[name]);
    }

    const compiled = program(`//@version=6
indicator("Plot options", overlay=true)
plot(linestyle=plot.linestyle_dashed, display=display.all - display.pane, title="Line", force_overlay=true, precision=3, format=format.percent, series=close)
plotarrow(display=display.status_line + display.data_window, maxheight=9, title="Arrow", series=close - open, minheight=2, force_overlay=true, precision=2, format=format.price)
plotbar(display=display.data_window, close=close, title="Bars", open=open, force_overlay=true, precision=4, format=format.percent, low=low, high=high)
plotcandle(bordercolor=color.orange, display=display.price_scale, close=close, title="Candles", open=open, force_overlay=true, precision=5, format=format.volume, low=low, high=high, wickcolor=color.blue)
plotchar(size=size.small, display=display.status_line, title="Char", series=close > open, force_overlay=true, precision=1, format=format.price, char="C")
plotshape(style=shape.triangleup, display=display.pane, title="Shape", series=close > open, force_overlay=true, precision=0, format=format.percent)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));

    expect(result.plots.map((plot) => ({ title: plot.title, options: plot.options }))).toEqual([
      { title: "Line", options: { color: "#2962ff", linestyle: "linestyle_dashed", display: 30, force_overlay: true, precision: 3, format: "percent" } },
      { title: "Arrow", options: { display: 10, maxheight: 9, minheight: 2, force_overlay: true, precision: 2, format: "price", style: "shape" } },
      { title: "Bars", options: { display: 8, force_overlay: true, precision: 4, format: "percent", style: "bar" } },
      { title: "Candles", options: { bordercolor: "#FF9800", display: 4, force_overlay: true, precision: 5, format: "volume", wickcolor: "#2196F3", style: "candle" } },
      { title: "Char", options: { size: "small", display: 2, force_overlay: true, precision: 1, format: "price", char: "C", style: "char" } },
      { title: "Shape", options: { style: "shape", display: 1, force_overlay: true, precision: 0, format: "percent" } },
    ]);
  });

  it("creates, updates, merges, clears, and deletes stable tables", async () => {
    const compiled = program(`//@version=6
indicator("Tables")
var dashboard = table.new(position.top_right, 3, 2, bgcolor=color.black, frame_color=color.gray, frame_width=1, border_color=color.white, border_width=2)
table.cell(dashboard, 0, 0, "A", text_color=color.white, bgcolor=color.blue, tooltip="First")
dashboard.cell(1, 0, "B", text_color=color.white, text_halign=text.align_center, text_size=size.small, bgcolor=color.red, tooltip="Second", text_font_family=font.family_monospace)
table.cell(dashboard, 2, 0, "Clear")
var removed = table.new(position.bottom_left, 1, 1)
if barstate.islast
    table.cell_set_text(dashboard, 0, 0, "Updated")
    table.cell_set_width(dashboard, 0, 0, 25)
    table.merge_cells(dashboard, 0, 1, 1, 1)
    table.clear(dashboard, 2, 0)
    table.set_position(dashboard, position.bottom_center)
    table.set_bgcolor(dashboard, color.gray)
    table.delete(removed)
count = table.all.size()
plot(count)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ id: 0, position: "bottom_center", columns: 3, rows: 2, backgroundColor: "#787B86" });
    expect(result.tables[0]?.cells[0]?.[0]).toMatchObject({ text: "Updated", width: 25, tooltip: "First" });
    expect(result.tables[0]?.cells[0]?.[1]).toMatchObject({
      text: "B",
      textColor: "#FFFFFF",
      textHorizontalAlign: "center",
      textSize: "small",
      backgroundColor: "#F23645",
      tooltip: "Second",
      textFontFamily: "monospace",
    });
    expect(result.tables[0]?.cells[0]?.[2]).toBeNull();
    expect(result.tables[0]?.merges).toEqual([{ startColumn: 0, startRow: 1, endColumn: 1, endRow: 1 }]);
  });

  it("executes the current OHLC visual constants and text-formatting APIs", async () => {
    const compiled = productionProgram(`//@version=6
indicator("OHLC visual surface")
styles = array.from(label.style_arrowdown, label.style_arrowup, label.style_cross, label.style_flag, label.style_label_lower_left, label.style_label_lower_right, label.style_label_upper_left, label.style_label_upper_right, label.style_none, label.style_text_outline, label.style_triangledown, label.style_triangleup, label.style_xcross)
for style in styles
    label.new(bar_index, close, style=style)
var marker = label.new(bar_index, close, "Label", text_formatting=text.format_italic)
label.set_text_formatting(marker, text.format_bold + text.format_italic)
var panel = table.new(position.top_right, 1, 1)
table.cell(panel, 0, 0, "Cell", text_halign=text.align_left, text_valign=text.align_top, text_formatting=text.format_bold)
table.cell_set_text_formatting(panel, 0, 0, text.format_italic)
int displayValue = display.pine_screener
bool scaleValues = scale.left == "left" and scale.none == "none" and scale.right == "right"
bool settlementValues = settlement_as_close.inherit == "inherit" and settlement_as_close.off == "off" and settlement_as_close.on == "on"
bool alignValues = text.align_top == "top" and text.align_bottom == "bottom"
bool formattingValues = text.format_none == "format_none" and text.format_bold == "format_bold" and text.format_italic == "format_italic"
plot(displayValue)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));

    expect(result.returned).toMatchObject({
      displayValue: [16],
      scaleValues: [true],
      settlementValues: [true],
      alignValues: [true],
      formattingValues: [true],
    });
    expect(new Set(result.drawings.filter((drawing) => drawing.kind === "label").map((drawing) => drawing.style))).toEqual(new Set([
      "style_arrowdown", "style_arrowup", "style_cross", "style_flag", "style_label_lower_left", "style_label_lower_right",
      "style_label_upper_left", "style_label_upper_right", "style_none", "style_text_outline", "style_triangledown",
      "style_triangleup", "style_xcross", "style_label_down",
    ]));
    expect(result.drawings).toContainEqual(expect.objectContaining({
      kind: "label",
      style: "style_label_down",
      textFormatting: "format_boldformat_italic",
    }));
    expect(result.tables[0]?.cells[0]?.[0]).toMatchObject({
      textHorizontalAlign: "left",
      textVerticalAlign: "top",
      textFormatting: "format_italic",
    });
  });

  it("executes the current OHLC compute API candidates with deterministic Lumen Charts semantics", async () => {
    const compiled = productionProgram(`//@version=6
indicator("OHLC compute surface")
runningMax = ta.max(close)
runningMin = ta.min(close)
rci = ta.rci(close, 3)
dailyVariable = ta.vwap
dailyCall = ta.vwap(hlc3)
levels = ta.pivot_point_levels("Traditional", bar_index == 2)
pivot = array.get(levels, 0)
resistance = array.get(levels, 1)
grid = matrix.new<float>(2, 2, 0.0)
matrix.set(grid, 0, 0, 2.0)
matrix.set(grid, 0, 1, 1.0)
matrix.set(grid, 1, 0, 1.0)
matrix.set(grid, 1, 1, 2.0)
eigenvalues = matrix.eigenvalues(grid)
eigenvectors = matrix.eigenvectors(grid)
largestEigenvalue = array.first(eigenvalues)
smallestEigenvalue = array.last(eigenvalues)
leadingVectorX = matrix.get(eigenvectors, 0, 0)
leadingVectorY = matrix.get(eigenvectors, 1, 0)
plot(runningMax)
plot(runningMin)
plot(rci)
plot(dailyVariable)
plot(dailyCall)
plot(pivot)
plot(resistance)
plot(largestEigenvalue)
plot(smallestEigenvalue)
plot(leadingVectorX)
plot(leadingVectorY)`);
    const engine = new PineEngine();
    const options = { timezone: "America/New_York" } as const;
    const result = await engine.createSession(compiled, options).runBatch(bars);
    const expectedVwap = [
      29 / 3,
      (29 / 3 * 100 + 32 / 3 * 110) / 210,
      (29 / 3 * 100 + 32 / 3 * 110 + 35 / 3 * 120) / 330,
      (29 / 3 * 100 + 32 / 3 * 110 + 35 / 3 * 120 + 38 / 3 * 130) / 460,
      (29 / 3 * 100 + 32 / 3 * 110 + 35 / 3 * 120 + 38 / 3 * 130 + 41 / 3 * 140) / 600,
    ];
    expect(result.returned.runningMax).toEqual([10, 11, 12, 13, 14]);
    expect(result.returned.runningMin).toEqual([10, 10, 10, 10, 10]);
    expect(result.returned.rci!.slice(2)).toEqual([100, 100, 100]);
    for (const [index, value] of expectedVwap.entries()) {
      expect(result.returned.dailyVariable![index]).toBeCloseTo(value);
      expect(result.returned.dailyCall![index]).toBeCloseTo(value);
    }
    for (const value of result.returned.pivot!.slice(2)) expect(value).toBeCloseTo(31 / 3);
    for (const value of result.returned.resistance!.slice(2)) expect(value).toBeCloseTo(38 / 3);
    expect(result.returned.largestEigenvalue).toEqual([3, 3, 3, 3, 3]);
    expect(result.returned.smallestEigenvalue).toEqual([1, 1, 1, 1, 1]);
    for (const value of result.returned.leadingVectorX!) expect(value).toBeCloseTo(Math.SQRT1_2);
    for (const value of result.returned.leadingVectorY!) expect(value).toBeCloseTo(Math.SQRT1_2);

    const paginated = engine.createSession(compiled, options);
    let finalPage;
    for await (const page of paginated.runPaginated(bars, 2)) finalPage = page;
    expect(finalPage?.returned).toEqual(result.returned);

    const incremental = engine.createSession(compiled, options);
    await incremental.runBatch(bars.slice(0, 2));
    const checkpoint = JSON.parse(JSON.stringify(incremental.checkpoint())) as SessionCheckpoint;
    const appended = await incremental.appendBars(bars.slice(2));
    expect(appended.returned).toEqual(result.returned);
    await incremental.restore(checkpoint);
    expect((await incremental.appendBars(bars.slice(2))).returned).toEqual(result.returned);
  });

  it("defines pivot families, tied RCI ranks, na extrema, and fail-closed pivot inputs", async () => {
    const compiled = productionProgram(`//@version=6
indicator("OHLC compute edges")
traditional = ta.pivot_point_levels("Traditional", bar_index == 2)
fibonacci = ta.pivot_point_levels("Fibonacci", bar_index == 2)
woodie = ta.pivot_point_levels("Woodie", bar_index == 2)
classic = ta.pivot_point_levels("Classic", bar_index == 2)
dm = ta.pivot_point_levels("DM", bar_index == 2)
camarilla = ta.pivot_point_levels("Camarilla", bar_index == 2)
rciValues = array.from(10.0, 12.0, 12.0, 15.0)
tiedRci = ta.rci(array.get(rciValues, bar_index), 4)
maxWithoutNa = ta.max(bar_index == 2 ? na : close)
minWithoutNa = ta.min(bar_index == 2 ? na : close)
traditionalPivot = array.get(traditional, 0)
traditionalR4 = array.get(traditional, 7)
traditionalS5 = array.get(traditional, 10)
woodieR4 = array.get(woodie, 7)
fibonacciR1 = array.get(fibonacci, 1)
woodiePivot = array.get(woodie, 0)
classicR3 = array.get(classic, 5)
dmPivot = array.get(dm, 0)
camarillaR5 = array.get(camarilla, 9)
plot(tiedRci)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 4));
    expect(result.returned.tiedRci!.at(-1)).toBeCloseTo(94.8683298051);
    expect(result.returned.maxWithoutNa).toEqual([10, 11, 11, 13]);
    expect(result.returned.minWithoutNa).toEqual([10, 10, 10, 10]);
    expect(result.returned.traditionalPivot!.at(-1)).toBeCloseTo(31 / 3);
    expect(result.returned.fibonacciR1!.at(-1)).toBeCloseTo(31 / 3 + 0.382 * 4);
    expect(result.returned.woodiePivot!.at(-1)).toBeCloseTo(10.5);
    expect(result.returned.traditionalR4!.at(-1)).toBeCloseTo(19);
    expect(result.returned.traditionalS5!.at(-1)).toBeCloseTo(1.3333333333);
    expect(result.returned.woodieR4!.at(-1)).toBeCloseTo(21);
    expect(result.returned.classicR3!.at(-1)).toBeCloseTo(31 / 3 + 2 * 4);
    expect(result.returned.dmPivot!.at(-1)).toBeCloseTo(10.75);
    expect(result.returned.camarillaR5!.at(-1)).toBeCloseTo(16.5);

    const developingWoodie = productionProgram(`//@version=6
indicator("Invalid Woodie")
levels = ta.pivot_point_levels("Woodie", bar_index == 0, true)
plot(array.get(levels, 0))`);
    await expect(new PineEngine().createSession(developingWoodie).runBatch(bars.slice(0, 1))).rejects.toThrow("Developing Woodie");
    const unknownType = productionProgram(`//@version=6
indicator("Invalid pivot type")
levels = ta.pivot_point_levels("Unknown", bar_index == 0)
plot(array.get(levels, 0))`);
    await expect(new PineEngine().createSession(unknownType).runBatch(bars.slice(0, 1))).rejects.toThrow("Unknown pivot type");
  });

  it("deduplicates, updates, queries, and deletes stable line fills", async () => {
    const compiled = program(`//@version=6
indicator("Line fills")
var upper = line.new(0, 14, 4, 18, force_overlay=true)
var lower = line.new(0, 10, 4, 14)
var extra = line.new(0, 8, 4, 12)
fill = linefill.new(upper, lower, color.red)
var removed = linefill.new(lower, extra, color.gray)
var firstLine = upper
if barstate.islast
    fill.set_color(color.blue)
    firstLine := fill.get_line1()
    line.set_y2(firstLine, 20)
    linefill.delete(removed)
count = linefill.all.size()
plot(count)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.count).toEqual([2, 2, 2, 2, 1]);
    expect(result.drawings.filter((drawing) => drawing.kind === "linefill")).toEqual([
      { kind: "linefill", id: 0, line1Id: 0, line2Id: 1, color: "#2196F3", forceOverlay: true },
    ]);
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "line", id: 0, y2: 20 }));
  });

  it("enforces declaration-configured drawing quotas", async () => {
    const compiled = program(`//@version=6
indicator("Quotas", max_lines_count=2, max_boxes_count=3, max_labels_count=1, max_polylines_count=2)
line.new(bar_index, low, bar_index, high)
box.new(bar_index, high, bar_index, low)
label.new(bar_index, close, str.tostring(bar_index))
points = array.from(chart.point.now(low), chart.point.now(high))
polyline.new(points)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.drawings.filter((drawing) => drawing.kind === "line").map((drawing) => drawing.id)).toEqual([3, 4]);
    expect(result.drawings.filter((drawing) => drawing.kind === "box").map((drawing) => drawing.id)).toEqual([2, 3, 4]);
    expect(result.drawings.filter((drawing) => drawing.kind === "label").map((drawing) => drawing.id)).toEqual([4]);
    expect(result.drawings.filter((drawing) => drawing.kind === "polyline").map((drawing) => drawing.id)).toEqual([3, 4]);
  });

  it("emits deterministic scene deltas across append, rollback, checkpoints, pagination, and inputs", async () => {
    const compiled = program(`//@version=6
indicator("Scene replay")
offset = input.float(0, "Offset")
var primary = line.new(0, 10, 4, 14)
var lower = line.new(0, 8, 4, 12)
var area = box.new(0, 14, 4, 8)
var note = label.new(0, 10, "Initial")
var removed = label.new(0, 8, "Removed")
var fill = linefill.new(primary, lower, color.red)
var points = array.from(chart.point.from_index(0, 8), chart.point.from_index(4, 14))
var curve = polyline.new(points)
var dashboard = table.new(position.top_right, 1, 1)
if barstate.islast
    line.set_y2(primary, close + offset)
    box.set_bottom(area, low + offset)
    label.set_xy(note, bar_index, close + offset)
    label.set_text(note, str.tostring(close + offset))
    linefill.set_color(fill, close > 12 ? color.blue : color.red)
    table.cell(dashboard, 0, 0, str.tostring(close + offset))
    if close > 20
        label.delete(removed)`);
    const engine = new PineEngine();
    const expected = await engine.createSession(compiled).runBatch(bars);
    const session = engine.createSession(compiled);
    await session.runBatch(bars.slice(0, 2));
    const appended = await session.appendBars(bars.slice(2));
    expect(appended.drawings).toEqual(expected.drawings);
    expect(appended.tables).toEqual(expected.tables);
    expect(appended.sceneDelta.drawings.added).toEqual([]);
    expect(appended.sceneDelta.drawings.updated.map((drawing) => drawing.kind).sort()).toEqual(["box", "label", "line", "linefill"]);
    expect(appended.sceneDelta.tables.updated.map((table) => table.id)).toEqual([0]);

    const checkpoint = session.checkpoint();
    const revised = { ...bars[4]!, close: 50 };
    const replaced = await session.replaceTail([revised]);
    expect(replaced.sceneDelta.drawings.deleted).toEqual([{ kind: "label", id: 1 }]);
    const restored = await session.restore(checkpoint);
    expect(restored.drawings).toEqual(expected.drawings);
    expect(restored.tables).toEqual(expected.tables);
    const repeated = await session.replaceTail([revised]);
    expect(repeated.sceneDelta).toEqual(replaced.sceneDelta);

    const paginated = engine.createSession(compiled);
    let finalPage;
    for await (const page of paginated.runPaginated(bars, 2)) finalPage = page;
    expect(finalPage?.drawings).toEqual(expected.drawings);
    expect(finalPage?.tables).toEqual(expected.tables);

    await session.updateInputs({ Offset: 5 });
    const withInputs = await session.runBatch(bars);
    const freshInputs = await engine.createSession(compiled, { inputs: { Offset: 5 } }).runBatch(bars);
    expect(withInputs.drawings).toEqual(freshInputs.drawings);
    expect(withInputs.tables).toEqual(freshInputs.tables);
  });

  it("matches scalar casts and host-provided visible-range constants", async () => {
    const compiled = program(`//@version=6
indicator("Casts", "C", true)
plot(int(3.9), "Int")
plot(float(2), "Float")
plot(bool(1), "Bool")
plot(color(na), "Color")
plot(chart.left_visible_bar_time, "Left")
plot(chart.right_visible_bar_time, "Right")`);
    const result = await new PineEngine().createSession(compiled, { visibleRange: { left: 2, right: 4 } }).runBatch(bars);

    expect(result.descriptor.overlay).toBe(true);
    expect(result.plots.map((plot) => plot.points[0]?.value)).toEqual([3, 2, true, Number.NaN, 2, 4]);
  });

  it("propagates na comparisons and applies Pine numeric tolerance", async () => {
    const compiled = program(`//@version=6
indicator("Comparisons")
var float missing = na
plot(na(missing == missing) ? 1 : 0, "NA equals")
plot(na(missing != 1) ? 1 : 0, "NA differs")
plot(1.0 + 5e-11 == 1.0 ? 1 : 0, "Within")
plot(1.0 + 5e-10 > 1.0 ? 1 : 0, "Outside")`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);

    expect(result.plots.map((plot) => plot.points[0]?.value)).toEqual([1, 1, 1, 1]);
  });

  it("converts v5 numeric bool declarations and reassignments at their write sites", async () => {
    // Recorded probe language-bool-reassign-v5.txt.
    const compiled = productionProgram(`//@version=5
indicator("V5 boolean writes")
float x = bar_index == 2 ? na : 0.5
bool declared = x
var bool assigned = true
assigned := x
bool local = if bar_index < 3
    bool inner = x
    inner
else
    false
explicit = bool(x)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 3));
    expect(result.returned.declared).toEqual([true, true, NaN]);
    expect(result.returned.assigned).toEqual([false, false, NaN]);
    expect(result.returned.local).toEqual([true, true, NaN]);
    expect(result.returned.explicit).toEqual([true, true, NaN]);
  });

  it("returns false for all v6 comparisons with a missing numeric operand", async () => {
    // Recorded probe language-compare-v6-int.txt and language-compare-v6-float.txt.
    const compiled = productionProgram(`//@version=6
indicator("V6 missing comparisons")
int x = bar_index == 0 ? na : 1
float y = 1.0
eq = x == y
ne = x != y
lt = x < y
gt = x > y
le = x <= y
ge = x >= y
inverted = not (x > y)
sum = x + y`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 2));
    expect(result.returned.eq).toEqual([false, true]);
    expect(result.returned.ne).toEqual([false, false]);
    expect(result.returned.lt).toEqual([false, false]);
    expect(result.returned.gt).toEqual([false, false]);
    expect(result.returned.le).toEqual([false, true]);
    expect(result.returned.ge).toEqual([false, true]);
    expect(result.returned.inverted).toEqual([true, true]);
    expect(result.returned.sum).toEqual([NaN, 2]);
    const rejected = compile({
      source: `//@version=6
indicator("Missing bool arm")
bool invalid = bar_index == 0 ? na : close > 0`,
      compatibility: PINE_COMPATIBILITY.strict,
    });
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2138",
      message: "A bool conditional branch cannot be na in version 6 scripts",
    }));
  });

  it("iterates map keys and values through both Pine loop forms", async () => {
    const compiled = program(`//@version=6
indicator("Map iteration")
var values = map.new<int, float>()
if barstate.isfirst
    values.put(10, 1.5)
    values.put(20, 2.5)
float keys = 0
float sum = 0
int pairs = 0
for [key, value] in values
    keys += key
    sum += value
for pair in values
    pairs += 1
plot(keys, "Keys")
plot(sum, "Values")
plot(pairs, "Pairs")`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);

    expect(result.plots.map((plot) => plot.points.at(-1)?.value)).toEqual([30, 4, 2]);
  });

  it("preserves gradient fill fields and local chart-point drawing overloads", async () => {
    const compiled = program(`//@version=6
indicator("Visual overloads")
upper = plot(high, "Upper")
lower = plot(low, "Lower")
fill(upper, lower, top_value=high, bottom_value=low, top_color=color.green, bottom_color=color.red)
if barstate.isfirst
    chart.point first = chart.point.new(time, na, low)
    chart.point second = chart.point.new(time + 5, na, high)
    line.new(first, second, xloc.bar_time, color=color.green)
    box.new(first, second, xloc=xloc.bar_time, bgcolor=color.red)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);

    expect(result.plots[2]?.points[0]?.options).toMatchObject({ top_value: 11, bottom_value: 8, top_color: "#4CAF50", bottom_color: "#F23645" });
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "line", color: "#4CAF50", xloc: "bt" }));
    expect(result.drawings).toContainEqual(expect.objectContaining({ kind: "box", backgroundColor: "#F23645", xloc: "bt" }));
  });

  it("backfills direct series arguments when TA calls first execute on the last bar", async () => {
    const compiled = program(`//@version=6
indicator("Conditional TA")
float average = na
float changed = na
float highestValue = na
if barstate.islast
    average := ta.sma(close, 3)
    changed := ta.change(close, 3)
    highestValue := ta.highest(close, 3)
plot(average, "Average")
plot(changed, "Changed")
plot(highestValue, "Highest")`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);

    expect(result.plots.map((plot) => plot.points.at(-1)?.value)).toEqual([13, 3, 14]);
  });

  it("uses Pine v6 lazy boolean, fractional division, and dynamic for-bound semantics without changing the frozen profile", async () => {
    const source = ["//@version=6", "indicator(\"Modern semantics\")", "safeAnd = false and runtime.error(\"must not run\")", "safeOr = true or runtime.error(\"must not run\")", "division = 5 / 2", "bound = 3", "count = 0", "for i = 1 to bound", "    count += 1", "    bound := 1", "plot(safeAnd ? 1 : 0)", "plot(safeOr ? 1 : 0)", "plot(division)", "plot(count)"].join("\n");

    const modern = await new PineEngine().createSession(productionProgram(source)).runBatch(bars.slice(0, 1));
    expect(modern.plots.map((plot) => plot.points[0]?.value)).toEqual([0, 1, 2.5, 1]);

    await expect(new PineEngine().createSession(program(source)).runBatch(bars.slice(0, 1))).rejects.toThrow("must not run");
  });

  it("keeps the pre-v6 boolean, division, and for-bound lowering in the production profile", async () => {
    const source = ["//@version=5", "indicator(\"v5 semantics\")", "division = 5 / 2", "bound = 3", "count = 0", "for i = 1 to bound", "    count += 1", "    bound := 1", "plot(division)", "plot(count)"].join("\n");
    const result = await new PineEngine().createSession(productionProgram(source)).runBatch(bars.slice(0, 1));
    expect(result.plots.map((plot) => plot.points[0]?.value)).toEqual([2, 3]);

    const eagerSource = ["//@version=5", "indicator(\"v5 eager\")", "value = false and runtime.error(\"v5 eager\")", "plot(value ? 1 : 0)"].join("\n");
    await expect(new PineEngine().createSession(productionProgram(eagerSource)).runBatch(bars.slice(0, 1))).rejects.toThrow("v5 eager");
  });

  it("evaluates a v6 side-effectful for boundary once initially and once after each continued iteration", async () => {
    const helper = ["nextLimit() =>", "    var int calls = 0", "    calls += 1", "    calls == 1 ? 1 : 0"];
    const topLevel = ["//@version=6", "indicator(\"Dynamic top-level bound\")", ...helper, "visits = 0", "for i = 1 to nextLimit()", "    visits += 1", "    continue", "plot(visits)"].join("\n");
    const functionLoop = ["//@version=6", "indicator(\"Dynamic function bound\")", ...helper, "runLoop() =>", "    visits = 0", "    for i = 1 to nextLimit()", "        visits += 1", "        continue", "    visits", "plot(runLoop())"].join("\n");
    const expressionLoop = ["//@version=6", "indicator(\"Dynamic expression bound\")", ...helper, "visits = 0", "ignored = for i = 1 to nextLimit()", "    visits += 1", "    continue", "plot(visits)"].join("\n");

    for (const source of [topLevel, functionLoop, expressionLoop]) {
      const result = await new PineEngine().createSession(productionProgram(source)).runBatch(bars.slice(0, 1));
      expect(result.plots[0]?.points[0]?.value).toBe(1);
    }
  });

  it("returns na from a no-else if expression and executes %= in the production profile", async () => {
    const compiled = productionProgram(["//@version=6", "indicator(\"New syntax\")", "value = 5", "value %= 2", "maybe = if false", "    1", "plot(value)", "plot(maybe)"].join("\n"));
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 1));

    expect(result.plots[0]?.points[0]?.value).toBe(1);
    expect(Number.isNaN(result.plots[1]?.points[0]?.value as number)).toBe(true);
  });
});
