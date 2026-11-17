import { PINE_COMPATIBILITY, type MarketBar, type PineCompatibility } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

const bar = (index: number, open: number): MarketBar => ({
  openTime: 1_000 + index * 60_000, open, high: open, low: open, close: open, volume: 100,
});

async function run(source: string, bars: readonly MarketBar[], compatibility: PineCompatibility) {
  const { program, diagnostics } = compile({ source, compatibility });
  if (!program) throw new Error(JSON.stringify(diagnostics));
  const session = new PineEngine().createSession(program, {
    symbolInfo: { currency: "USD", mintick: 0.00001, pointvalue: 1, mincontract: 1 },
  });
  try {
    return await session.runBatch(bars);
  } finally {
    await session.close();
  }
}

describe("broker observations", () => {
  it("slips the stop exit at the gap open and leaves the marketable limit at the open", async () => {
    // broker-cash-per-order.txt records limit 1.11245 and stop 1.11791 (open 1.11794).
    const source = `//@version=6
strategy("Exit slippage", initial_capital=100000, margin_long=0, slippage=3)
if bar_index == 0
    strategy.entry("market", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("limit", "market", qty=4, limit=1.08)
if bar_index == 2
    strategy.exit("stop", "market", qty_percent=100, stop=1.15)`;
    const bars = [bar(0, 1.12031), bar(1, 1.12205), bar(2, 1.11245), bar(3, 1.11794)];
    const strict = await run(source, bars, PINE_COMPATIBILITY.strict);
    const legacy = await run(source, bars, PINE_COMPATIBILITY.legacy);
    expect(strict.strategy?.closedTradeRecords.map(({ quantity, exitPrice }) => ({ quantity, exitPrice })))
      .toEqual([{ quantity: 4, exitPrice: 1.11245 }, { quantity: 6, exitPrice: 1.11791 }]);
    expect(legacy.strategy?.closedTradeRecords.at(-1)?.exitPrice).toBe(1.11794);
  });

  it("allocates one reversal fee by transaction size and reports the named close label in Pine", async () => {
    // broker-cash-per-order.txt: a 2 USD fee on the five-unit reversal assigns 0.8 to the long
    // and 1.2 to the new short. One third of the short's entry fee belongs to its first exit.
    const source = `//@version=6
strategy("Reversal fee", initial_capital=100000, margin_long=0, margin_short=0, slippage=3, commission_type=strategy.commission.cash_per_order, commission_value=2)
if bar_index == 0
    strategy.entry("before reversal", strategy.long, qty=2)
if bar_index == 1
    strategy.entry("reverse", strategy.short, qty=3)
if bar_index == 2
    strategy.order("net", strategy.long, qty=1)
if bar_index == 3
    strategy.close("reverse")
exitId = strategy.closedtrades.exit_id(2)`;
    const bars = [bar(0, 1.11794), bar(1, 1.11574), bar(2, 1.11863), bar(3, 1.12277), bar(4, 1.12183)];
    const strict = await run(source, bars, PINE_COMPATIBILITY.strict);
    const legacy = await run(source, bars, PINE_COMPATIBILITY.legacy);
    const commissions = strict.strategy?.closedTradeRecords.map(({ commission }) => commission);
    expect(commissions).toHaveLength(3);
    expect(commissions?.[0]).toBeCloseTo(2.8, 12);
    expect(commissions?.[1]).toBeCloseTo(2.4, 12);
    expect(commissions?.[2]).toBeCloseTo(2.8, 12);
    expect(strict.returned.exitId?.at(-1)).toBe("Close entry(s) order reverse");
    expect(strict.strategy?.closedTradeRecords.at(-1)?.exitId).toBe("close_reverse");
    expect(legacy.strategy?.closedTradeRecords[0]?.commission).toBe(4);
    expect(legacy.returned.exitId?.at(-1)).toBe("close_reverse");
  });
});
