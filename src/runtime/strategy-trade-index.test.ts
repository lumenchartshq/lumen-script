import { describe, expect, it } from "vitest";
import type { PineCompatibility, MarketBar, PineValue } from "../contracts/index.js";
import { StrategyRuntime, type MutableStrategyTrade, type StrategyRuntimeHost } from "./strategy.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1_000, closeTime: 60_999, open: 10, high: 13, low: 9, close: 12, volume: 100 },
];
const host: StrategyRuntimeHost = {
  barIndex: () => 0,
  bars: () => bars,
  data: (name) => name === "close" ? 12 : Number.NaN,
  symbolInfo: () => ({ currency: "USD", mintick: 1, pointvalue: 1 }),
  timezone: () => "Etc/UTC",
  executionBars: () => [],
  executionPoints: () => [],
};

function trade(status: "open" | "closed"): MutableStrategyTrade {
  return {
    id: `${status}-0`,
    entryId: "Long",
    direction: 1,
    quantity: 2,
    entryPrice: 10,
    entryBarIndex: 0,
    entryTime: 1_000,
    entryComment: "Entry note",
    ...(status === "closed" ? {
      exitId: "close_Long",
      exitComment: "Exit note",
      exitPrice: 11,
      exitBarIndex: 1,
      exitTime: 61_000,
      profit: 2,
      commission: 0,
    } : {}),
    entryCommission: 0,
    maxDrawdown: 1,
    maxRunup: 4,
    status,
  };
}

function runtime(compatibility: PineCompatibility = PINE_COMPATIBILITY.legacy) {
  const runtime = new StrategyRuntime(true, undefined, host, false, compatibility);
  runtime.strategy!.openTrades.push(trade("open"));
  runtime.strategy!.closedTrades.push(trade("closed"));
  runtime.strategy!.closedTradeCount = 1;
  runtime.strategy!.closedTradeProfitTotal = 2;
  return runtime;
}

const invalidIndices: readonly (PineValue | undefined)[] = [0.5, -1, undefined, Number.POSITIVE_INFINITY];

describe("strategy trade index compatibility", () => {
  it("retains the newest 9,000 strict trades while keeping absolute indexes and lifetime counts", () => {
    const strict = new StrategyRuntime(true, undefined, host, false, PINE_COMPATIBILITY.strict);
    strict.strategy!.closedTrades.push(...Array.from({ length: 9_000 }, (_, index) => ({
      ...trade("closed"), id: `closed-${String(index)}`, profit: index,
    })));
    strict.strategy!.closedTradeCount = 9_000;
    strict.strategy!.openTrades.push({ ...trade("open"), id: "newest", entryBasis: 20 });
    strict.closeStrategyTradeQuantity(strict.strategy!.openTrades[0]!, 2, 11, 61_000);

    expect(strict.strategy!.closedTrades).toHaveLength(9_000);
    expect(strict.strategy!.closedTradeCount).toBe(9_001);
    expect(strict.strategy!.closedTradeFirstIndex).toBe(1);
    expect(strict.strategyValue("closedtrades")).toBe(9_001);
    expect(strict.closedStrategyTradeValue("first_index", undefined)).toBe(1);
    expect(strict.closedStrategyTradeValue("profit", 0)).toBe(0);
    expect(strict.closedStrategyTradeValue("profit", 1)).toBe(1);
    expect(strict.closedStrategyTradeValue("profit", 9_000)).toBe(2);
  });

  it("preserves sealed index coercion for assigned open and closed trade reads", () => {
    const sealed = runtime();
    for (const index of [...invalidIndices, Number.NaN]) {
      expect(sealed.openStrategyTradeValue("entry_price", index)).toBe(10);
      expect(sealed.openStrategyTradeValue("entry_comment", index)).toBe("Entry note");
      expect(sealed.closedStrategyTradeValue("profit", index)).toBe(2);
      expect(sealed.closedStrategyTradeValue("exit_id", index)).toBe("close_Long");
    }
    expect(sealed.openStrategyTradeValue("entry_price", 0)).toBe(10);
    expect(sealed.closedStrategyTradeValue("profit", 0)).toBe(2);
  });

  it("strictly validates every selected metadata accessor and preserves its result kind", () => {
    const strict = runtime(PINE_COMPATIBILITY.strict);
    for (const index of invalidIndices) {
      expect(strict.openStrategyTradeValue("entry_price", index)).toBeNaN();
      expect(strict.openStrategyTradeValue("size", index)).toBe(0);
      expect(strict.openStrategyTradeValue("entry_bar_index", index)).toBeNaN();
      expect(strict.openStrategyTradeValue("entry_time", index)).toBeNaN();
      expect(strict.openStrategyTradeValue("entry_id", index)).toBe("");
      expect(strict.openStrategyTradeValue("entry_comment", index)).toBe("");
      expect(strict.closedStrategyTradeValue("entry_price", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("exit_price", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("profit", index)).toBe(0);
      expect(strict.closedStrategyTradeValue("entry_bar_index", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("entry_time", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("entry_id", index)).toBe("");
      expect(strict.closedStrategyTradeValue("entry_comment", index)).toBe("");
      expect(strict.closedStrategyTradeValue("exit_bar_index", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("exit_time", index)).toBeNaN();
      expect(strict.closedStrategyTradeValue("exit_id", index)).toBe("");
      expect(strict.closedStrategyTradeValue("exit_comment", index)).toBe("");
      expect(strict.closedStrategyTradeValue("size", index)).toBe(0);
    }
    expect(strict.openStrategyTradeValue("entry_price", 0)).toBe(10);
    expect(strict.openStrategyTradeValue("size", 0)).toBe(2);
    expect(strict.closedStrategyTradeValue("entry_price", 0)).toBe(10);
    expect(strict.closedStrategyTradeValue("exit_price", 0)).toBe(11);
    expect(strict.closedStrategyTradeValue("profit", 0)).toBe(2);
    expect(strict.openStrategyTradeValue("entry_bar_index", 0)).toBe(0);
    expect(strict.openStrategyTradeValue("entry_time", 0)).toBe(1_000);
    expect(strict.openStrategyTradeValue("entry_id", 0)).toBe("Long");
    expect(strict.openStrategyTradeValue("entry_comment", 0)).toBe("Entry note");
    expect(strict.closedStrategyTradeValue("entry_bar_index", 0)).toBe(0);
    expect(strict.closedStrategyTradeValue("entry_time", 0)).toBe(1_000);
    expect(strict.closedStrategyTradeValue("entry_id", 0)).toBe("Long");
    expect(strict.closedStrategyTradeValue("entry_comment", 0)).toBe("Entry note");
    expect(strict.closedStrategyTradeValue("exit_bar_index", 0)).toBe(1);
    expect(strict.closedStrategyTradeValue("exit_time", 0)).toBe(61_000);
    expect(strict.closedStrategyTradeValue("exit_id", 0)).toBe("close_Long");
    expect(strict.closedStrategyTradeValue("exit_comment", 0)).toBe("Exit note");
    expect(strict.closedStrategyTradeValue("size", 0)).toBe(2);
    expect(strict.openStrategyTradeValue("entry_id", 1)).toBe("");
    expect(strict.closedStrategyTradeValue("size", 1)).toBe(0);
  });

  it("uses the reference numeric defaults when a trade is absent", () => {
    const strict = runtime(PINE_COMPATIBILITY.strict);
    for (const index of [...invalidIndices, 99]) {
      for (const name of ["commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit", "profit_percent"]) {
        expect(strict.openStrategyTradeValue(name, index), `open/${name}`).toBe(0);
      }
      for (const name of ["commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit_percent"]) {
        expect(strict.closedStrategyTradeValue(name, index), `closed/${name}`).toBe(0);
      }
    }
    expect(strict.openStrategyTradeValue("commission", 0)).toBe(0);
    expect(strict.closedStrategyTradeValue("max_runup", 0)).toBe(4);
    const sealed = runtime();
    expect(sealed.openStrategyTradeValue("commission", 0.5)).toBe(0);
    expect(sealed.closedStrategyTradeValue("max_runup", -1)).toBe(4);
  });

  it("selects absolute trade zero for a Pine na index", () => {
    const strict = runtime(PINE_COMPATIBILITY.strict);
    expect(strict.openStrategyTradeValue("entry_id", NaN)).toBe("Long");
    expect(strict.openStrategyTradeValue("max_runup", NaN)).toBe(4);
    expect(strict.closedStrategyTradeValue("exit_price", NaN)).toBe(11);
    expect(strict.closedStrategyTradeValue("profit", NaN)).toBe(2);
    strict.strategy!.closedTradeFirstIndex = 1;
    expect(strict.closedStrategyTradeValue("profit", NaN)).toBe(0);
    expect(strict.closedStrategyTradeValue("profit", 1)).toBe(2);
  });

  it("includes the allocated entry fee in strict trade percentages", () => {
    const strict = runtime(PINE_COMPATIBILITY.strict);
    const open = strict.strategy!.openTrades[0]!;
    const closed = strict.strategy!.closedTrades[0]!;
    open.entryCommission = 1;
    closed.entryCommission = 1;
    closed.commission = 3;
    expect(strict.openStrategyTradeValue("max_runup_percent", 0)).toBeCloseTo(400 / 21);
    expect(strict.closedStrategyTradeValue("max_drawdown_percent", 0)).toBeCloseTo(100 / 21);
    expect(strict.closedStrategyTradeValue("profit_percent", 0)).toBeCloseTo(200 / 21);
  });

  it("preserves sealed held capital with nonunit point value and directional reduced margin", () => {
    const nonunitHost: StrategyRuntimeHost = {
      ...host,
      symbolInfo: () => ({ currency: "USD", mintick: 1, pointvalue: 2 }),
    };
    const config = { ...runtime().strategy!.config, margin_long: 50, margin_short: 25 };
    const long = trade("open"); // 2 × 10 × 50% = 10 sealed, 20 strict.
    const short = { ...trade("open"), id: "short-1", direction: -1 as const, quantity: 1, entryPrice: 20 }; // 1 × 20 × 25% = 5 sealed, 10 strict.
    const sealed = new StrategyRuntime(true, config, nonunitHost, false, PINE_COMPATIBILITY.legacy);
    const strict = new StrategyRuntime(true, config, nonunitHost, false, PINE_COMPATIBILITY.strict);
    expect(sealed.openStrategyTradeValue("capital_held", undefined)).toBeNaN();
    expect(strict.openStrategyTradeValue("capital_held", undefined)).toBe(0);
    sealed.strategy!.openTrades.push({ ...long }, { ...short });
    strict.strategy!.openTrades.push({ ...long }, { ...short });
    expect(sealed.openStrategyTradeValue("capital_held", undefined)).toBe(15);
    expect(strict.openStrategyTradeValue("capital_held", undefined)).toBe(30);
  });
});
