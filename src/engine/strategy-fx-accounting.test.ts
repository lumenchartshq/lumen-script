import { describe, expect, it } from "vitest";
import type { FxRateBookV1, MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { createRuntime, deserializeRuntimeSnapshot, serializeRuntimeSnapshot } from "../runtime/index.js";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY, isStrictPineCompatibility } from "../contracts/index.js";

const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const flat = (date: string, price: number): MarketBar => ({ openTime: day(date), open: price, high: price, low: price, close: price, volume: 100 });
const dates = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"] as const;
const bars = [flat("2026-09-21", 20), flat("2026-09-22", 20), flat("2026-09-23", 25), flat("2026-09-24", 25)];
const symbolInfo = { ticker: "FX", tickerid: "FX", currency: "USD", pointvalue: 5, mintick: 0.1 } as const;

function book(rateByDate: Readonly<Record<string, number | null>> = {}): FxRateBookV1 {
  return {
    version: 1, provenance: "fixture:s5b-v1",
    calendar: { firstDate: "2026-09-18", lastDate: "2026-09-24", weekdays: [1, 2, 3, 4, 5], closures: [] },
    pairs: [{ symbolCurrency: "USD", accountCurrency: "EUR", slots: dates.map((date) => {
      const rate = Object.hasOwn(rateByDate, date) ? rateByDate[date] : date >= "2026-09-22" ? 1.25 : 0.8;
      return rate === null ? { date, unavailable: true as const }
        : { date, observedAt: day(date) + 12 * 60 * 60_000, symbolToAccount: rate! };
    }) }],
  };
}

function program(lines: readonly string[]) {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: ["//@version=6", ...lines].join("\n") });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

const options = (fxRateBook = book()) => ({ timeframe: "D", timezone: "UTC", now: () => day("2026-10-01"), symbolInfo, fxRateBook });

describe("S5B supplied FX accounting candidate", () => {
  it("converts signed values and sizes cash at one selected primary-bar rate", async () => {
    const compiled = program([
      'strategy("FX", currency=currency.EUR, initial_capital=1000, default_qty_type=strategy.cash, default_qty_value=500)',
      "toAccount = strategy.convert_to_account(50)", "toSymbol = strategy.convert_to_symbol(75)",
      "negative = strategy.convert_to_account(-50)", "zero = strategy.convert_to_symbol(0)",
      "preview = strategy.default_entry_qty(20)", "if bar_index == 0", '    strategy.entry("Explicit", strategy.long, qty=2)',
    ]);
    const session = new PineEngine().createSession(compiled, options());
    try {
      const result = await session.runBatch(bars.slice(0, 3));
      expect(result.returned.toAccount).toEqual([40, 40, 62.5]);
      expect(result.returned.toSymbol).toEqual([93.75, 93.75, 60]);
      expect(result.returned.negative).toEqual([-40, -40, -62.5]);
      expect(result.returned.zero).toEqual([0, 0, 0]);
      expect(result.returned.preview).toEqual([6.25, 6.25, 4]);
      expect(result.strategy?.orders[0]).toMatchObject({ quantity: 2, fillPrice: 20 });
    } finally { await session.close(); }
  });

  it("freezes historical entry fees and basis while realized cash stays fixed", async () => {
    const compiled = program([
      'strategy("FX ledger", currency=currency.EUR, initial_capital=1000, commission_type=strategy.commission.percent, commission_value=1)',
      "if bar_index == 0", '    strategy.entry("A", strategy.long, qty=2)',
      "if bar_index == 1", '    strategy.close("A")',
      "tradePercent = strategy.closedtrades.profit_percent(0)",
    ]);
    const session = new PineEngine().createSession(compiled, options());
    try {
      const result = await session.runBatch(bars);
      expect(result.strategy?.closedTradeRecords[0]).toMatchObject({ quantity: 2, entryPrice: 20, exitPrice: 25,
        commission: 4.725, profit: 57.775 });
      expect(result.returned.tradePercent?.at(-1)).toBeCloseTo(57.775 * 100 / 161.6, 8);
      expect(result.strategy?.netProfit).toBeCloseTo(57.775, 8);
      expect(result.strategy?.equity).toBeCloseTo(1057.775, 8);
      expect(result.strategy?.buyAndHoldProfit).toBeCloseTo(390.625, 8);
      expect(result.strategy?.buyAndHoldPercent).toBe(25);
      const state = deserializeRuntimeSnapshot(session.checkpoint().runtimeState!);
      expect(state.strategy?.closedTrades[0]?.entryBasis).toBe(160);
      expect(state.strategy?.firstEntryRate).toBe(0.8);
      expect(state.strategy?.closedTrades[0]?.entryCommission).toBe(1.6);
    } finally { await session.close(); }
  });

  it("prorates historical basis and held capital on a partial close", async () => {
    const compiled = program([
      'strategy("Partial", currency=currency.EUR, initial_capital=1000, margin_long=25, commission_type=strategy.commission.percent, commission_value=1)',
      "if bar_index == 0", '    strategy.entry("A", strategy.long, qty=2)',
      "if bar_index == 1", '    strategy.close("A", qty=1)',
      "held = strategy.opentrades.capital_held",
    ]);
    const session = new PineEngine().createSession(compiled, options());
    try {
      const result = await session.runBatch(bars);
      expect(result.returned.held?.[1]).toBe(40);
      expect(result.returned.held?.[2]).toBe(20);
      const state = deserializeRuntimeSnapshot(session.checkpoint().runtimeState!).strategy!;
      expect(state.closedTrades[0]?.entryBasis).toBe(80);
      expect(state.openTrades[0]?.entryBasis).toBe(80);
      expect(state.closedTrades[0]?.entryCommission).toBe(0.8);
      expect(state.openTrades[0]?.entryCommission).toBe(0.8);
    } finally { await session.close(); }
  });

  it("rejects explicit pair mismatches while flat unavailable pure calls return na", async () => {
    const pure = program(['strategy("Missing", currency=currency.EUR)', "converted = strategy.convert_to_account(50)"]);
    expect(() => new PineEngine().createSession(pure, { timeframe: "D", timezone: "UTC", symbolInfo })).toThrow(/matching supplied FX pair/);
    expect(() => new PineEngine().createSession(pure, { ...options(), symbolInfo: { ...symbolInfo, currency: "GBP" } })).toThrow(/matching supplied FX pair/);
    const unavailable = new PineEngine().createSession(pure, options(book({ "2026-09-21": null })));
    try { expect((await unavailable.runBatch(bars.slice(1, 2))).returned.converted).toEqual([Number.NaN]); }
    finally { await unavailable.close(); }
    const ordinary = program(['strategy("Unknown")', "converted = strategy.convert_to_account(50)"]);
    const unknown = new PineEngine().createSession(ordinary, { timeframe: "D" });
    try { expect((await unknown.runBatch(bars.slice(0, 1))).returned.converted).toEqual([Number.NaN]); }
    finally { await unknown.close(); }
  });

  it("resolves conversion inside a request using the child symbol pair", async () => {
    const root = program(['strategy("Child FX", currency=currency.EUR)',
      'rootValue = strategy.convert_to_account(50)',
      'childValue = request.security("CHILD", "D", strategy.convert_to_account(50))']);
    const supplied = book();
    const fxRateBook: FxRateBookV1 = { ...supplied, pairs: [supplied.pairs[0]!, {
      symbolCurrency: "GBP", accountCurrency: "EUR",
      slots: dates.map((date) => ({ date, observedAt: day(date) + 12 * 60 * 60_000, symbolToAccount: 2 })),
    }] };
    const session = new PineEngine().createSession(root, { ...options(fxRateBook),
      marketDataGateway: { load: async () => ({ bars, symbolInfo: { ticker: "CHILD", tickerid: "CHILD", currency: "GBP" } }) },
    });
    try {
      const result = await session.runBatch(bars.slice(0, 3));
      expect(result.returned.rootValue).toEqual([40, 40, 62.5]);
      expect(result.returned.childValue).toEqual([100, 100, 100]);
    } finally { await session.close(); }
  });

  it("compares full FX content before portable, cached, main and tail restore", async () => {
    const compiled = program(['strategy("Restore", currency=currency.EUR)', "if bar_index == 0", '    strategy.entry("A", strategy.long, qty=2)']);
    const source = new PineEngine().createSession(compiled, options());
    const same = new PineEngine().createSession(compiled, options(book()));
    const revised = new PineEngine().createSession(compiled, options(book({ "2026-09-24": 1.5 })));
    try {
      await source.runBatch(bars.slice(0, 3));
      const checkpoint = source.checkpoint();
      const portable = JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint;
      expect((await same.restore(portable)).strategy).toEqual((await source.restore(checkpoint)).strategy);
      await expect(revised.restore(checkpoint)).rejects.toThrow(/FX checkpoint context/);
      await expect(revised.restore(portable)).rejects.toThrow(/FX checkpoint context/);
      const decoded = deserializeRuntimeSnapshot(portable.runtimeState!);
      const missingBasis = { ...decoded, strategy: { ...decoded.strategy!, openTrades: decoded.strategy!.openTrades.map((trade) => {
        const missing = { ...trade };
        delete missing.entryBasis;
        return missing;
      }) } };
      const badMain = { ...portable, runtimeState: serializeRuntimeSnapshot(missingBasis) };
      await expect(same.restore(badMain)).rejects.toThrow(/FX strategy trade monetary basis/);
      const badTail = { ...portable, tailState: { ...portable.tailState!, runtimeState: serializeRuntimeSnapshot(missingBasis) } };
      await expect(same.restore(badTail)).rejects.toThrow();
      const direct = createRuntime(compiled, options());
      expect(() => direct.restore(decoded, bars.slice(0, 3))).not.toThrow();
      const changed = createRuntime(compiled, options(book({ "2026-09-24": 1.5 })));
      expect(() => changed.restore(decoded, bars.slice(0, 3))).toThrow(/FX checkpoint context/);
    } finally { await Promise.all([source.close(), same.close(), revised.close()]); }
  });

  it("keeps ordinary indicator checkpoints usable when the host supplies an FX book", async () => {
    const compiled = program(['indicator("Plain")', 'value = close', 'plot(value)']);
    const source = new PineEngine().createSession(compiled, options());
    const restored = new PineEngine().createSession(compiled, options());
    try {
      await source.runBatch(bars.slice(0, 2));
      const checkpoint = source.checkpoint();
      expect(checkpoint.fxSelectionIdentity).toBeUndefined();
      expect((await restored.restore(JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint)).returned.value)
        .toEqual([20, 20]);
      expect((await restored.appendBars(bars.slice(2, 3))).returned.value).toEqual([20, 20, 25]);
    } finally { await Promise.all([source.close(), restored.close()]); }
  });

  it("rejects an FX scalar changed without its selected-rate identity", async () => {
    const compiled = program(['strategy("Scalar", currency=currency.EUR)', 'value = strategy.convert_to_account(50)']);
    const source = new PineEngine().createSession(compiled, options());
    const restored = new PineEngine().createSession(compiled, options());
    try {
      await source.runBatch(bars.slice(0, 3));
      const checkpoint = source.checkpoint();
      const decoded = deserializeRuntimeSnapshot(checkpoint.runtimeState!);
      const tampered = { ...decoded, strategy: { ...decoded.strategy!, lastFxRate: 2 } };
      expect(() => createRuntime(compiled, options()).restore(tampered, bars.slice(0, 3)))
        .toThrow(/selected rate does not match selection identity/);
      await expect(restored.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(tampered) }))
        .rejects.toThrow(/selected rate does not match selection identity/);
      const tail = deserializeRuntimeSnapshot(checkpoint.tailState!.runtimeState);
      await expect(restored.restore({ ...checkpoint, tailState: { ...checkpoint.tailState!,
        runtimeState: serializeRuntimeSnapshot({ ...tail, strategy: { ...tail.strategy!, lastFxRate: Number.NaN } }),
      } })).rejects.toThrow(/selected rate does not match selection identity/);
      const forgedTailIdentity = JSON.stringify(["historical", { kind: "rate", rate: 2, date: "2026-09-22", observedAt: day("2026-09-22") + 12 * 60 * 60_000 }]);
      await expect(restored.restore({ ...checkpoint, tailState: { ...checkpoint.tailState!,
        runtimeState: serializeRuntimeSnapshot({ ...tail, fxSelectionIdentity: forgedTailIdentity,
          strategy: { ...tail.strategy!, lastFxRate: 2 } }),
      } })).rejects.toThrow(/tail selected rate/);
    } finally { await Promise.all([source.close(), restored.close()]); }
  });

  it("rejects a stale realtime selection when the captured clock advances", async () => {
    const compiled = program(['strategy("Clock", currency=currency.EUR)', 'converted = strategy.convert_to_account(50)']);
    const realtime = { ...flat("2026-09-22", 20), closeTime: day("2026-09-24") };
    const early = new PineEngine().createSession(compiled, { ...options(), now: () => day("2026-09-22") + 3_600_000 });
    const later = new PineEngine().createSession(compiled, { ...options(), now: () => day("2026-09-23") + 3_600_000 });
    try {
      expect((await early.runBatch([realtime])).returned.converted).toEqual([40]);
      const checkpoint = early.checkpoint();
      expect(checkpoint.fxSelectionIdentity).toBeDefined();
      await expect(later.restore(checkpoint)).rejects.toThrow(/selected rate/);
      await expect(later.restore(JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint)).rejects.toThrow(/selected rate/);
      expect((await later.runBatch([realtime])).returned.converted).toEqual([62.5]);
      const direct = createRuntime(compiled, { ...options(), now: () => day("2026-09-23") + 3_600_000 });
      expect(() => direct.restore(deserializeRuntimeSnapshot(checkpoint.runtimeState!), [realtime])).toThrow(/selected rate/);
    } finally { await Promise.all([early.close(), later.close()]); }
  });

  it("rejects a removed selected rate and rolls back an unavailable pending or new order", async () => {
    const rateBook = book({ "2026-09-22": null });
    const scripts = [
      ['strategy("Pending", currency=currency.EUR)', 'var count = 0', 'count += 1',
        'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=1)'],
      ['strategy("New", currency=currency.EUR)', 'var count = 0', 'count += 1',
        'if bar_index == 1', '    strategy.entry("A", strategy.long, qty=1)'],
    ];
    for (const lines of scripts) {
      const session = new PineEngine().createSession(program(lines), options(rateBook));
      try {
        await session.runBatch(bars.slice(1, 2));
        const checkpoint = session.checkpoint();
        const snapshot = deserializeRuntimeSnapshot(checkpoint.runtimeState!);
        const runtime = (session as unknown as { runtime: ReturnType<typeof createRuntime> }).runtime;
        const before = runtime.snapshot();
        await expect(session.appendBars(bars.slice(2, 3))).rejects.toThrow(/FX rate is unavailable/);
        expect(runtime.snapshot()).toEqual(before);
        const missingRate = { ...snapshot.strategy! };
        delete missingRate.lastFxRate;
        expect(() => createRuntime(program(lines), options(rateBook)).restore({ ...snapshot, strategy: missingRate }, bars.slice(1, 2)))
          .toThrow(/Missing FX strategy selected rate/);
      } finally { await session.close(); }
    }
  });

  it("returns an exact margin tick and rejects overflow before account profit commits", async () => {
    const exact = program(['strategy("Tick", currency=currency.EUR, initial_capital=35, margin_long=50)',
      'if bar_index == 0', '    strategy.entry("L", strategy.long, qty=10)',
      'level = strategy.margin_liquidation_price']);
    const exactBook = book(Object.fromEntries(dates.map((date) => [date, 0.7])));
    const exactSession = new PineEngine().createSession(exact, { ...options(exactBook), symbolInfo: { ...symbolInfo, pointvalue: 0.1 } });
    try { expect((await exactSession.runBatch([flat("2026-09-21", 100), flat("2026-09-22", 100)])).returned.level?.[1]).toBe(100); }
    finally { await exactSession.close(); }
    const overflow = program(['strategy("Overflow", currency=currency.EUR, initial_capital=1000, margin_long=0)',
      'if bar_index == 0', '    strategy.entry("L", strategy.long, qty=1)',
      'if bar_index == 1', '    strategy.close("L")']);
    const hugeBook = book(Object.fromEntries(dates.map((date) => [date, 1e300])));
    const overflowSession = new PineEngine().createSession(overflow, { ...options(hugeBook), symbolInfo: { ...symbolInfo, pointvalue: 1 } });
    try { await expect(overflowSession.runBatch([flat("2026-09-21", 1e-300), flat("2026-09-22", 1e-300), flat("2026-09-23", 1e20)]))
      .rejects.toThrow(/finite range/); }
    finally { await overflowSession.close(); }
  });

  it("rejects finite leg fees whose closed-trade commission sum overflows", async () => {
    const compiled = program([
      'strategy("Fee sum", currency=currency.EUR, initial_capital=1.7e308, margin_long=0, commission_type=strategy.commission.cash_per_order, commission_value=1e308)',
      'if bar_index == 0', '    strategy.entry("L", strategy.long, qty=1)',
      'if bar_index == 1', '    strategy.close("L")',
    ]);
    const same = book(Object.fromEntries(dates.map((date) => [date, 1])));
    const session = new PineEngine().createSession(compiled, { ...options(same), symbolInfo: { ...symbolInfo, pointvalue: 1 } });
    try {
      await expect(session.runBatch([flat("2026-09-21", 100), flat("2026-09-22", 100), flat("2026-09-23", 5e307)]))
        .rejects.toThrow(/finite range/);
    } finally { await session.close(); }
  });

  it("rejects an intrabar FX excursion beyond finite account range", async () => {
    const compiled = program([
      'strategy("High", currency=currency.EUR, initial_capital=1000, margin_long=0)',
      'if bar_index == 0', '    strategy.entry("L", strategy.long, qty=1)',
    ]);
    const huge = book(Object.fromEntries(dates.map((date) => [date, 1e300])));
    const session = new PineEngine().createSession(compiled, { ...options(huge), symbolInfo: { ...symbolInfo, pointvalue: 1 } });
    try {
      const entry = { ...flat("2026-09-22", 1e-300), high: 1e20 };
      await expect(session.runBatch([flat("2026-09-21", 1e-300), entry])).rejects.toThrow(/finite range/);
    } finally { await session.close(); }
  });

  it("retains short fees and FIFO attribution across a partial close and reversal", async () => {
    const compiled = program([
      'strategy("Short reverse", currency=currency.EUR, initial_capital=1000, commission_type=strategy.commission.percent, commission_value=1)',
      'if bar_index == 0', '    strategy.entry("S", strategy.short, qty=2)',
      'if bar_index == 1', '    strategy.close("S", qty=1)',
      'if bar_index == 2', '    strategy.entry("L", strategy.long, qty=1)',
      'pct0 = strategy.closedtrades.profit_percent(0)',
      'pct1 = strategy.closedtrades.profit_percent(1)',
    ]);
    const rates = [0.8, 0.8, 1.25, 0.5, 0.5];
    const fxRateBook = book(Object.fromEntries(dates.map((date, index) => [date, rates[index]!])));
    const session = new PineEngine().createSession(compiled, options(fxRateBook));
    try {
      const result = await session.runBatch([flat("2026-09-21", 20), flat("2026-09-22", 20),
        flat("2026-09-23", 15), flat("2026-09-24", 10)]);
      expect(result.strategy?.closedTradeRecords.map((trade) => trade.profit)).toEqual([29.5125, 23.95]);
      expect(result.strategy?.positionSize).toBe(1);
      expect(result.strategy?.netProfit).toBeCloseTo(53.2125, 9);
      expect(result.returned.pct0?.at(-1)).toBeCloseTo(29.5125 * 100 / 80.8, 9);
      expect(result.returned.pct1?.at(-1)).toBeCloseTo(23.95 * 100 / 80.8, 9);
      const ledger = deserializeRuntimeSnapshot(session.checkpoint().runtimeState!).strategy!;
      expect(ledger.closedTrades.map((trade) => trade.entryBasis)).toEqual([80, 80]);
      expect(ledger.closedTrades.map((trade) => trade.entryCommission)).toEqual([0.8, 0.8]);
      expect(ledger.openTrades[0]?.direction).toBe(1);
    } finally { await session.close(); }
  });

  it("marks open profit at the current rate and keeps cash commissions in account units", async () => {
    const open = program([
      'strategy("Open mark", currency=currency.EUR, initial_capital=1000, commission_type=strategy.commission.percent, commission_value=1)',
      'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=2)',
      'estimated = strategy.opentrades.profit(0)',
    ]);
    const marked = new PineEngine().createSession(open, options());
    try {
      const result = await marked.runBatch(bars.slice(0, 3));
      expect(result.strategy?.openProfit).toBe(62.5);
      expect(result.strategy?.equity).toBeCloseTo(1060.9, 9);
      expect(result.returned.estimated?.[2]).toBeCloseTo(57.775, 9);
    } finally { await marked.close(); }
    for (const [feeType, fee, net] of [
      ["cash_per_contract", 2, 54.5], ["cash_per_order", 3, 56.5],
    ] as const) {
      const compiled = program([
        `strategy("Cash fees", currency=currency.EUR, initial_capital=1000, commission_type=strategy.commission.${feeType}, commission_value=${fee})`,
        'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=2)',
        'if bar_index == 1', '    strategy.close("A")',
      ]);
      const session = new PineEngine().createSession(compiled, options());
      try { expect((await session.runBatch(bars.slice(0, 3))).strategy?.netProfit).toBeCloseTo(net, 9); }
      finally { await session.close(); }
    }
  });

  it("evaluates a cash risk threshold on account-valued closed loss", async () => {
    const compiled = program([
      'strategy("Cash risk", currency=currency.EUR, initial_capital=1000, margin_long=0)',
      'strategy.risk.max_drawdown(50, strategy.cash)',
      'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=2)',
      'if bar_index == 1', '    strategy.close("A")',
    ]);
    const data = [flat("2026-09-21", 20), flat("2026-09-22", 20), flat("2026-09-23", 15)];
    const high = new PineEngine().createSession(compiled, options());
    const low = new PineEngine().createSession(compiled, options(book(Object.fromEntries(dates.map((date) => [date, 0.8])))));
    try {
      await high.runBatch(data);
      await low.runBatch(data);
      expect(deserializeRuntimeSnapshot(high.checkpoint().runtimeState!).strategy?.riskHalted).toBe(true);
      expect(deserializeRuntimeSnapshot(low.checkpoint().runtimeState!).strategy?.riskHalted).toBe(false);
    } finally { await Promise.all([high.close(), low.close()]); }
  });

  it("uses current FX for margin and liquidation while retaining entry-rate held capital", async () => {
    const compiled = program([
      'strategy("Margin", currency=currency.EUR, initial_capital=1000, margin_long=25)',
      'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=10)',
      'level = strategy.margin_liquidation_price',
      'held = strategy.opentrades.capital_held',
    ]);
    const session = new PineEngine().createSession(compiled, { ...options(), symbolInfo: { ...symbolInfo, pointvalue: 2 } });
    try {
      const result = await session.runBatch([flat("2026-09-21", 100), flat("2026-09-22", 100), flat("2026-09-23", 100)]);
      expect(result.returned.level).toEqual([Number.NaN, 50, 80]);
      expect(result.returned.held).toEqual([0, 400, 400]);
      expect(deserializeRuntimeSnapshot(session.checkpoint().runtimeState!).strategy?.openTrades[0]?.entryBasis).toBe(1600);
    } finally { await session.close(); }
  });

  it("derives a higher-timeframe exclusive end instead of treating closeTime as that boundary", async () => {
    const compiled = program(['strategy("Weekly", currency=currency.EUR)', 'converted = strategy.convert_to_account(50)']);
    const weekDates = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28"];
    const fxRateBook: FxRateBookV1 = { version: 1, provenance: "fixture:weekly-end",
      calendar: { firstDate: "2026-09-21", lastDate: "2026-09-28", weekdays: [1, 2, 3, 4, 5], closures: [] },
      pairs: [{ symbolCurrency: "USD", accountCurrency: "EUR", slots: weekDates.map((date) => ({
        date, observedAt: day(date) + 12 * 60 * 60_000, symbolToAccount: date === "2026-09-25" ? 1.5 : 0.8,
      })) }],
    };
    const session = new PineEngine().createSession(compiled, { ...options(fxRateBook), timeframe: "W" });
    try {
      const weekly = { ...flat("2026-09-21", 20), closeTime: day("2026-09-25") + 23 * 60 * 60_000 };
      expect((await session.runBatch([weekly])).returned.converted).toEqual([75]);
    } finally { await session.close(); }
  });

  it("keeps same-currency economics independent of an unrelated book", async () => {
    const source = ["//@version=6", 'strategy("Identity", currency=currency.USD, initial_capital=1000, default_qty_type=strategy.cash, default_qty_value=500)',
      'converted = strategy.convert_to_account(50)',
      'if bar_index == 0', '    strategy.entry("A", strategy.long)',
      'if bar_index == 1', '    strategy.close("A")'].join("\n");
    for (const compatibility of [PINE_COMPATIBILITY.strict, PINE_COMPATIBILITY.legacy] as const) {
      const compiled = compile({ compatibility, source });
      expect(compiled.diagnostics).toEqual([]);
      const without = new PineEngine().createSession(compiled.program!, { timeframe: "D", now: () => day("2026-10-01"), symbolInfo });
      const withBook = new PineEngine().createSession(compiled.program!, options());
      try {
        const data = bars.slice(0, 3);
        const baseline = await without.runBatch(data);
        const supplied = await withBook.runBatch(data);
        expect(supplied.returned.converted).toEqual([50, 50, 50]);
        expect(supplied.strategy).toEqual(baseline.strategy);
        expect(supplied.strategy?.orders[0]?.quantity).toBe(isStrictPineCompatibility(compatibility) ? 5 : 25);
      } finally { await Promise.all([without.close(), withBook.close()]); }
    }
  });

  it("matches batch, append, repeated tail and portable continuation", async () => {
    const compiled = program([
      'strategy("Replay", currency=currency.EUR, initial_capital=1000, commission_type=strategy.commission.percent, commission_value=1)',
      'if bar_index == 0', '    strategy.entry("A", strategy.long, qty=2)',
      'if bar_index == 1', '    strategy.close("A")',
      'account = strategy.convert_to_account(50)',
    ]);
    const expectedSession = new PineEngine().createSession(compiled, options());
    const incremental = new PineEngine().createSession(compiled, options());
    const portable = new PineEngine().createSession(compiled, options());
    try {
      const expected = await expectedSession.runBatch(bars);
      await incremental.runBatch(bars.slice(0, 2));
      const checkpoint = JSON.parse(JSON.stringify(incremental.checkpoint())) as SessionCheckpoint;
      const appended = await incremental.appendBars(bars.slice(2));
      expect(appended.strategy).toEqual(expected.strategy);
      expect(appended.returned).toEqual(expected.returned);
      expect((await incremental.replaceTail(bars.slice(3))).strategy).toEqual(expected.strategy);
      expect((await incremental.replaceTail(bars.slice(3))).strategy).toEqual(expected.strategy);
      await portable.restore(checkpoint);
      expect((await portable.appendBars(bars.slice(2))).strategy).toEqual(expected.strategy);
      const revised = [...bars.slice(0, 2), flat("2026-09-23", 26), bars[3]!];
      const fresh = new PineEngine().createSession(compiled, options());
      try { expect((await incremental.replaceTail(revised.slice(2))).strategy).toEqual((await fresh.runBatch(revised)).strategy); }
      finally { await fresh.close(); }
    } finally { await Promise.all([expectedSession.close(), incremental.close(), portable.close()]); }
  });
});
