import type { MarketBar, SessionCheckpoint, SymbolInfo } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const symbolInfo: SymbolInfo = { ticker: "TEST", tickerid: "TEST", currency: "USD", pointvalue: 5, mintick: 0.1 };
const flat = (time: number, price: number): MarketBar => ({ openTime: time, open: price, high: price, low: price, close: price, volume: 100 });
function program(body: string) {
  const result = compile({ source: `//@version=6\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}
async function batch(body: string, bars: readonly MarketBar[], metadata: SymbolInfo = symbolInfo) {
  const session = new PineEngine().createSession(program(body), { symbolInfo: metadata });
  try { return await session.runBatch(bars); } finally { await session.close(); }
}

describe("S5A unregistered sizing and margin candidates", () => {
  it("fully closes a decimal position after a partial close", async () => {
    const result = await batch(`strategy("Decimal close", margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=0.3)
if bar_index == 1
    strategy.close("L", qty=0.1)
if bar_index == 2
    strategy.close("L")`, [flat(1, 10), flat(2, 10), flat(3, 10), flat(4, 10)],
    { ...symbolInfo, pointvalue: 1, mincontract: 0.1 });
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.closedTradeRecords.map((trade) => trade.quantity)).toEqual([0.1, 0.2]);
  });

  it.each(['strategy.close("L", qty=0.05)', 'strategy.exit("X", "L", qty=0.05, limit=10)'])(
    "does not close the whole position for a sub-step request: %s", async (command) => {
      const result = await batch(`strategy("Sub-step close", margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=0.3)
if bar_index == 1
    ${command}`, [flat(1, 10), flat(2, 10), flat(3, 10)],
      { ...symbolInfo, pointvalue: 1, mincontract: 0.1 });
      expect(result.strategy?.positionSize).toBe(0.3);
      expect(result.strategy?.closedTradeRecords).toEqual([]);
    },
  );

  it("preserves fractional close quantities in the sealed profile", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: `//@version=6
strategy("Legacy quantity", margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1
    strategy.close("L", qty=0.123456789)` });
    expect(compiled.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compiled.program!, { symbolInfo });
    try {
      const result = await session.runBatch([flat(1, 10), flat(2, 10), flat(3, 10)]);
      expect(result.strategy?.closedTradeRecords[0]?.quantity).toBe(0.123456789);
    } finally { await session.close(); }
  });

  it("applies the quantity step after risk-based entry reductions", async () => {
    const result = await batch(`strategy("Risk step", margin_long=0)
strategy.risk.max_position_size(2.5)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=5)`, [flat(1, 10), flat(2, 10)],
    { ...symbolInfo, pointvalue: 1, mincontract: 1 });
    expect(result.strategy?.positionSize).toBe(2);
    expect(result.strategy?.orders[0]).toMatchObject({ quantity: 2, status: "filled" });
  });

  // Recorded: FX:EURUSD liquidated 8 units with 2 whole contracts of coverage and 1 below a full contract.
  it.each([[1, 8], [3, 3]])("rounds margin coverage to a %s-unit step before liquidating %s units", async (step, quantity) => {
    const result = await batch(`strategy("Margin step", initial_capital=100, margin_long=50)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=18)
id = strategy.closedtrades.exit_id(0)
comment = strategy.closedtrades.exit_comment(0)`, [flat(1, 10), { ...flat(2, 10), low: 7.9 }],
    { ...symbolInfo, pointvalue: 1, mincontract: step });
    expect(result.strategy?.orders.find(({ command }) => command === "margin_call")?.quantity).toBe(quantity);
    expect(result.strategy?.positionSize).toBe(18 - quantity);
    expect(result.returned.id).toEqual(["", "Close position order"]);
    expect(result.returned.comment).toEqual(["", "Margin call"]);
  });

  it("floors previews, entries, and partial closes to syminfo.mincontract without decimal drift", async () => {
    const metadata = { ...symbolInfo, pointvalue: 1, mincontract: 0.125 };
    const result = await batch(`strategy("Quantity step", margin_long=0, margin_short=0, default_qty_type=strategy.fixed, default_qty_value=0.37)
preview = strategy.default_entry_qty(close)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=0.37)
if bar_index == 1
    strategy.close("L", qty=0.13)`, [flat(1_000, 10), flat(2_000, 10), flat(3_000, 10)], metadata);
    expect(result.returned.preview).toEqual([0.25, 0.25, 0.25]);
    expect(result.strategy?.orders[0]).toMatchObject({ quantity: 0.25, status: "filled" });
    expect(result.strategy?.orders[1]).toMatchObject({ quantity: 0.125, status: "filled" });
    expect(result.strategy?.positionSize).toBe(0.125);
  });

  it("uses the six-decimal fallback only when mincontract is unavailable or invalid", async () => {
    for (const mincontract of [undefined, 0, -1]) {
      const metadata = { ...symbolInfo, ...(mincontract === undefined ? {} : { mincontract }) };
      const result = await batch(`strategy("Fallback", margin_long=0, default_qty_type=strategy.fixed, default_qty_value=0.123456789)
preview = strategy.default_entry_qty(close)`, [flat(1_000, 10)], metadata);
      expect(result.returned.preview).toEqual([0.123456]);
    }
  });

  it.each([
    ["strategy.fixed", 3, 3], ["strategy.cash", 500, 5], ["strategy.percent_of_equity", 25, 2.5],
  ] as const)("S5-SIZE-01 sizes %s with point value", async (type, value, expected) => {
    const result = await batch(`strategy("Size", initial_capital=1000, default_qty_type=${type}, default_qty_value=${value})\npreview = strategy.default_entry_qty(20)\nif bar_index == 0\n    strategy.entry("Entry", strategy.long)`, [flat(1000, 20), flat(2000, 20), flat(3000, 20)]);
    expect(result.returned.preview).toEqual([expected, expected, expected]);
    expect(result.strategy?.orders[0]).toMatchObject({ quantity: expected, fillPrice: 20, status: "filled" });
    expect(result.strategy?.positionSize).toBe(expected);
  });

  it("S5-SIZE-02 keeps preview independent of explicit quantity and next-open gap", async () => {
    const bars = [flat(1000, 20), flat(2000, 25), flat(3000, 25)];
    for (const [qty, expected] of [[", qty=2", 2], ["", 5]] as const) {
      const result = await batch(`strategy("Gap", initial_capital=1000, default_qty_type=strategy.cash, default_qty_value=500)\npreview20 = strategy.default_entry_qty(20)\npreview25 = strategy.default_entry_qty(25)\nif bar_index == 0\n    strategy.entry("Short", strategy.short${qty})`, bars);
      expect(result.returned.preview20).toEqual([5, 5, 5]);
      expect(result.returned.preview25).toEqual([4, 4, 4]);
      expect(result.strategy?.orders[0]).toMatchObject({ quantity: expected, fillPrice: 25 });
      expect(result.strategy?.positionSize).toBe(-expected);
    }
  });

  it("S5-SIZE-03 recomputes percentage size from realized equity across replay", async () => {
    const source = `strategy("Equity", initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=50)\npreview = strategy.default_entry_qty(20)\nif bar_index == 0\n    strategy.entry("First", strategy.long, qty=2)\nif bar_index == 1\n    strategy.close("First")\nif bar_index == 2\n    strategy.entry("Second", strategy.long)`;
    const bars = [flat(1000, 10), { ...flat(2000, 10), close: 15, high: 15 }, { ...flat(3000, 15), close: 20, high: 20 }, flat(4000, 20)];
    const compiled = program(source);
    const options = { symbolInfo: { ...symbolInfo, pointvalue: 2 } };
    const fresh = async (data: readonly MarketBar[]) => {
      const session = new PineEngine().createSession(compiled, options);
      try { return await session.runBatch(data); } finally { await session.close(); }
    };
    const session = new PineEngine().createSession(compiled, options);
    try {
      await session.runBatch(bars.slice(0, 2));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const expected = await fresh(bars);
      expect(expected.returned.preview).toEqual([12.5, 12.75, 12.75, 12.75]);
      expect(expected.strategy?.orders.find(({ id }) => id === "Second")).toMatchObject({ quantity: 12.75, fillPrice: 20 });
      expect((await session.appendBars(bars.slice(2))).strategy).toEqual(expected.strategy);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(2))).strategy).toEqual(expected.strategy);
      const revised = { ...bars[2]!, open: 14, low: 14 };
      expect((await session.replaceTail([revised, bars[3]!])).strategy).toEqual((await fresh([bars[0]!, bars[1]!, revised, bars[3]!])).strategy);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(2))).strategy).toEqual(expected.strategy);
    } finally { await session.close(); }
  });

  it("S5-SIZE-04 returns na for invalid prices and nonpositive pricing metadata", async () => {
    const source = `strategy("Invalid", default_qty_type=strategy.cash, default_qty_value=0)\nmissing = strategy.default_entry_qty(na)\nzero = strategy.default_entry_qty(0)\nnegative = strategy.default_entry_qty(-1)\nvalid = strategy.default_entry_qty(20)\nif bar_index == 0\n    strategy.entry("None", strategy.long)`;
    const result = await batch(source, [flat(1000, 20), flat(2000, 20)]);
    for (const key of ["missing", "zero", "negative"]) expect(result.returned[key]).toEqual([Number.NaN, Number.NaN]);
    expect(result.returned.valid).toEqual([0, 0]);
    expect(result.strategy?.orders).toEqual([]);
    for (const pointvalue of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PineEngine().createSession(program(source), { symbolInfo: { ...symbolInfo, pointvalue } })).toThrow(/pointvalue/);
    }
    for (const pointvalue of [0, -1]) {
      const invalid = await batch(`strategy("Invalid point value", default_qty_type=strategy.cash, default_qty_value=500)\nvalue = strategy.default_entry_qty(20)\nif bar_index == 0\n    strategy.entry("No order", strategy.long)`, [flat(1000, 20), flat(2000, 20)], { ...symbolInfo, pointvalue });
      expect(invalid.returned.value).toEqual([Number.NaN, Number.NaN]);
      expect(invalid.strategy?.orders).toEqual([]);
    }
    const unaffected = await batch(`strategy("Fixed", default_qty_type=strategy.fixed, default_qty_value=3)\nvalue = strategy.default_entry_qty(20)\nif bar_index == 0\n    strategy.entry("Explicit", strategy.long, qty=2)`, [flat(1000, 20), flat(2000, 20)],
      { ...symbolInfo, pointvalue: 0, mintick: 0 });
    expect(unaffected.returned.value).toEqual([3, 3]);
    expect(unaffected.strategy?.orders[0]).toMatchObject({ quantity: 2, status: "filled" });
    const large = await batch(`strategy("Large finite", default_qty_type=strategy.cash, default_qty_value=1e307)\nvalue = strategy.default_entry_qty(1)`, [flat(1000, 1)],
      { ...symbolInfo, pointvalue: 1 });
    expect(large.returned.value).toEqual([1e307]);
    expect(compile({ source: `//@version=6\nstrategy("Bad")\nx = strategy.default_entry_qty("20")`, compatibility: PINE_COMPATIBILITY.strict }).diagnostics)
      .toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
  });

  it("S5-MARGIN-01/02 handles flat, long, short, and 100% short", async () => {
    const bars = [flat(1000, 100), flat(2000, 100)];
    const meta = { ...symbolInfo, pointvalue: 2 };
    const long = await batch(`strategy("Long", initial_capital=1000, margin_long=25)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=10)\nlevel = strategy.margin_liquidation_price`, bars, meta);
    expect(long.returned.level![0]).toBeNaN();
    expect(long.returned.level![1]).toBeCloseTo(66.6, 10);
    for (const [margin, expected] of [[50, 133.4], [100, 100]] as const) {
      const short = await batch(`strategy("Short", initial_capital=1000, margin_short=${margin})\nif bar_index == 0\n    strategy.entry("S", strategy.short, qty=5)\nlevel = strategy.margin_liquidation_price`, bars, meta);
      expect(short.returned.level![1]).toBeCloseTo(expected, 10);
      expect(short.strategy?.positionSize).toBe(-5);
      if (margin === 100) expect(short.strategy?.orders.some(({ command }) => command === "margin_call")).toBe(false);
    }
    const breach = await batch(`strategy("Short breach", initial_capital=1000, margin_short=100)\nif bar_index == 0\n    strategy.entry("S", strategy.short, qty=5)\nlevel = strategy.margin_liquidation_price`,
      [...bars, { ...flat(3000, 100), high: 100.1 }], meta);
    expect(breach.strategy?.orders.some(({ command, status }) => command === "margin_call" && status === "filled")).toBe(true);
  });

  it("returns na for a margin getter with nonpositive point value or tick", async () => {
    const source = `strategy("Invalid boundary", initial_capital=1000, margin_long=50)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=1)\nlevel = strategy.margin_liquidation_price`;
    for (const metadata of [{ ...symbolInfo, pointvalue: 0 }, { ...symbolInfo, pointvalue: -1 }, { ...symbolInfo, mintick: 0 }]) {
      const result = await batch(source, [flat(1000, 10), flat(2000, 10)], metadata);
      expect(result.returned.level![1]).toBeNaN();
    }
  });

  it("S5-MARGIN-03/04 keeps zero margin na and replays partial liquidation and revised tail", async () => {
    const meta = { ...symbolInfo, pointvalue: 1 };
    const zero = await batch(`strategy("Zero", initial_capital=100, margin_long=0)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=18)\nlevel = strategy.margin_liquidation_price`, [flat(1000, 10), { ...flat(2000, 10), low: 8 }], meta);
    expect(zero.returned.level![1]).toBeNaN();
    expect(zero.strategy?.positionSize).toBe(18);
    const source = `strategy("Partial", initial_capital=100, margin_long=50)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=18)\nlevel = strategy.margin_liquidation_price`;
    const bars = [flat(1000, 10), { ...flat(2000, 10), low: 8 }, flat(3000, 10)];
    const compiled = program(source);
    const options = { symbolInfo: meta };
    const fresh = async (data: readonly MarketBar[]) => {
      const session = new PineEngine().createSession(compiled, options);
      try { return await session.runBatch(data); } finally { await session.close(); }
    };
    const session = new PineEngine().createSession(compiled, options);
    try {
      await session.runBatch(bars.slice(0, 1));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const expected = await fresh(bars);
      expect(expected.returned.level![1]).toBeCloseTo(3.2, 10);
      expect(expected.strategy).toMatchObject({ positionSize: 10, netProfit: -16 });
      expect((await session.appendBars(bars.slice(1))).strategy).toEqual(expected.strategy);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(1))).strategy).toEqual(expected.strategy);
      const revised = { ...bars[1]!, low: 9 };
      const changed = await session.replaceTail([revised, bars[2]!]);
      expect(changed.returned.level![1]).toBeCloseTo(8.8, 10);
      expect(changed.strategy?.positionSize).toBe(18);
      expect(changed.strategy?.netProfit).toBe(0);
      expect(changed.strategy).toEqual((await fresh([bars[0]!, revised, bars[2]!])).strategy);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(1))).strategy).toEqual(expected.strategy);
    } finally { await session.close(); }
  });

  it("keeps a representable price genuinely below an exact tick below that boundary", async () => {
    const bars = [flat(1000, 10), flat(2000, 10)];
    for (const [capital, expected] of [[84, 3.2], [84.00000000000001, 3.1]] as const) {
      const result = await batch(`strategy("Tick neighbor", initial_capital=${capital}, margin_long=50)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=10)\nlevel = strategy.margin_liquidation_price`, bars, { ...symbolInfo, pointvalue: 1 });
      expect(result.returned.level![1]).toBe(expected);
    }
  });
});
