import { PINE_COMPATIBILITY, type MarketBar, type SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1, open: 10, high: 11, low: 9, close: 10, volume: 100 },
  { openTime: 2, open: 10, high: 11, low: 9, close: 10, volume: 100 },
];
const options = { symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "USD", pointvalue: 1, mintick: 0.01 } } as const;

function program(body: string) {
  const result = compile({
    compatibility: PINE_COMPATIBILITY.strict,
    source: `//@version=5\nstrategy("When", margin_long=0, margin_short=0)\n${body}`,
  });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

describe("Pine v5 strategy when execution", () => {
  it("skips all seven commands for false or na without mutating a pending order", async () => {
    const compiled = program(`strategy.entry("keep", strategy.long, limit=1)
strategy.entry("entry", strategy.long, when=false)
strategy.order("order", strategy.long, when=na)
strategy.exit("exit", profit=1, when=false)
strategy.close("keep", when=false)
strategy.close_all(when=na)
strategy.cancel("keep", when=false)
strategy.cancel_all(when=na)`);
    const result = await new PineEngine().createSession(compiled, options).runBatch(bars.slice(0, 1));
    expect(result.strategy?.orders.map((order) => [order.id, order.status])).toEqual([["keep", "pending"]]);
  });

  it("evaluates a series condition and preserves the result through checkpoint restore", async () => {
    const compiled = program(`strategy.entry("keep", strategy.long, limit=1)
strategy.cancel_all(when=bar_index >= 1)`);
    const session = new PineEngine().createSession(compiled, options);
    await session.runBatch(bars.slice(0, 1));
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const expected = await session.appendBars(bars.slice(1));
    const restored = new PineEngine().createSession(compiled, options);
    await restored.restore(checkpoint);
    const actual = await restored.appendBars(bars.slice(1));
    expect(actual.strategy).toEqual(expected.strategy);
    expect(actual.strategy?.orders.every((order) => order.status === "cancelled")).toBe(true);
  });
});
