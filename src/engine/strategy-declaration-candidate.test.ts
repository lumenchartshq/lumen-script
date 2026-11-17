import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot, validatePublicExitSnapshot, type RuntimeContext } from "../runtime/index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bar = (index: number, open: number, close = open): MarketBar => ({
  openTime: 1_000 + index * 60_000, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 100,
});
const bars = [bar(0, 10), bar(1, 10, 20), bar(2, 20, 30), bar(3, 30)];
const runtime = { symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "USD", mintick: 1, pointvalue: 1 } } as const;

describe("strategy declaration candidate", () => {
  it.each(["FIFO", "ANY"] as const)("attributes targeted close under %s", async (rule) => {
    const source = `//@version=6\nstrategy("Close allocation", initial_capital=1000, pyramiding=2, margin_long=0, close_entries_rule="${rule}")
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=1)
if bar_index == 2
    strategy.close("B")`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      const result = await session.runBatch(bars);
      expect(result.strategy?.closedTradeRecords.map(({ entryId, entryPrice, profit }) => ({ entryId, entryPrice, profit }))).toEqual([
        rule === "FIFO" ? { entryId: "A", entryPrice: 10, profit: 20 } : { entryId: "B", entryPrice: 20, profit: 10 },
      ]);
      expect(result.strategy?.openTradeRecords.map(({ entryId, entryPrice }) => ({ entryId, entryPrice }))).toEqual([
        rule === "FIFO" ? { entryId: "B", entryPrice: 20 } : { entryId: "A", entryPrice: 10 },
      ]);
    } finally { await session.close(); }
  });

  it("retains a named exit's price and size claim after FIFO attribution retires its source entry", async () => {
    const source = `//@version=6\nstrategy("FIFO source claim", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=10)
if bar_index == 2
    strategy.close("B")
    strategy.exit("A limit", from_entry="A", limit=40)`;
    const data = [bar(0, 10), bar(1, 10), bar(2, 20), bar(3, 30), bar(4, 40)];
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      const result = await session.runBatch(data);
      expect(result.strategy?.closedTradeRecords.map(({ entryId, quantity, exitId, entryPrice, exitPrice, profit }) =>
        ({ entryId, quantity, exitId, entryPrice, exitPrice, profit }))).toEqual([
        { entryId: "A", quantity: 5, exitId: "close_B", entryPrice: 10, exitPrice: 30, profit: 100 },
        { entryId: "B", quantity: 5, exitId: "close_B", entryPrice: 20, exitPrice: 30, profit: 50 },
        { entryId: "B", quantity: 5, exitId: "A limit", entryPrice: 20, exitPrice: 40, profit: 100 },
      ]);
      expect(result.strategy?.positionSize).toBe(0);
    } finally { await session.close(); }
  });

  it.each(["FIFO", "ANY"] as const)("attributes a partial close under %s without losing entry fees", async (rule) => {
    const source = `//@version=6\nstrategy("Partial attribution", initial_capital=1000, pyramiding=2, margin_long=0, close_entries_rule="${rule}", commission_type=strategy.commission.cash_per_order, commission_value=0.5)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=1)
if bar_index == 2
    strategy.close("B", qty=0.5)`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      const result = await session.runBatch(bars);
      const entryId = rule === "FIFO" ? "A" : "B";
      expect(result.strategy?.closedTradeRecords).toEqual([expect.objectContaining({
        entryId, quantity: 0.5, exitPrice: 30, commission: 0.75,
        profit: rule === "FIFO" ? 9.25 : 4.25,
      })]);
      expect(result.strategy?.openTradeRecords.map(({ entryId: id, quantity, commission }) =>
        ({ entryId: id, quantity, commission }))).toEqual(rule === "FIFO"
        ? [{ entryId: "A", quantity: 0.5, commission: 0.25 }, { entryId: "B", quantity: 1, commission: 0.5 }]
        : [{ entryId: "A", quantity: 1, commission: 0.5 }, { entryId: "B", quantity: 0.5, commission: 0.25 }]);
    } finally { await session.close(); }
  });

  it.each(["FIFO", "ANY"] as const)("keeps a named exit's trigger on B while attributing under %s", async (rule) => {
    const source = `//@version=6\nstrategy("Named trigger", initial_capital=1000, pyramiding=2, margin_long=0, close_entries_rule="${rule}")
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=1)
if bar_index == 2
    strategy.exit("B-profit", from_entry="B", profit=10)`;
    const data = [...bars.slice(0, 3), bar(3, 25), bar(4, 30)];
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      const before = await session.runBatch(data.slice(0, 4));
      expect(before.strategy?.closedTradeRecords).toEqual([]);
      const after = await session.appendBars(data.slice(4));
      expect(after.strategy?.closedTradeRecords).toEqual([expect.objectContaining({
        entryId: rule === "FIFO" ? "A" : "B", exitId: "B-profit", exitPrice: 30,
        profit: rule === "FIFO" ? 20 : 10,
      })]);
    } finally { await session.close(); }
  });

  it("replays FIFO claim ownership through portable restore and revised tail", async () => {
    const source = `//@version=6\nstrategy("Replay FIFO", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=10)
if bar_index == 2
    strategy.close("B")
    strategy.exit("A limit", from_entry="A", limit=40)`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const engine = new PineEngine();
    const session = engine.createSession(compilation.program!, runtime);
    const fresh = async (data: readonly MarketBar[]) => {
      const other = engine.createSession(compilation.program!, runtime);
      try { return (await other.runBatch(data)).strategy; }
      finally { await other.close(); }
    };
    const data = [bar(0, 10), bar(1, 10), bar(2, 20), bar(3, 30), bar(4, 40)];
    try {
      await session.runBatch(data.slice(0, 4));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      expect((await session.appendBars(data.slice(4))).strategy).toEqual(await fresh(data));
      await session.restore(checkpoint);
      expect((await session.appendBars(data.slice(4))).strategy).toEqual(await fresh(data));
      const revised = [...data.slice(0, 4), bar(4, 35)];
      expect((await session.replaceTail(revised.slice(4))).strategy).toEqual(await fresh(revised));
      expect((await session.replaceTail(revised.slice(4))).strategy).toEqual(await fresh(revised));
    } finally { await session.close(); }
  });

  it("caps simultaneous FIFO reservations after a named close and keeps OCA reduction bounded", async () => {
    const source = `//@version=6\nstrategy("FIFO OCA", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=10)
if bar_index == 2
    strategy.close("B")
    strategy.exit("A-exit", from_entry="A", limit=40, oca_name="pair")
    strategy.exit("B-exit", from_entry="B", limit=50, oca_name="pair")`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      const pending = await session.runBatch([bar(0, 10), bar(1, 10), bar(2, 20), bar(3, 30)]);
      expect(pending.strategy?.positionSize).toBe(5);
      expect(pending.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, quantity, status }) =>
        ({ id, quantity, status }))).toEqual([
        { id: "A-exit", quantity: 5, status: "pending" },
        { id: "B-exit", quantity: 0, status: "pending" },
      ]);
      const final = await session.appendBars([bar(4, 40), bar(5, 50)]);
      expect(final.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity }))).toEqual([
        { exitId: "close_B", quantity: 5 }, { exitId: "close_B", quantity: 5 },
        { exitId: "A-exit", quantity: 5 },
      ]);
      expect(final.strategy?.positionSize).toBe(0);
      expect(final.strategy?.orders.find(({ id }) => id === "B-exit")?.status).not.toBe("filled");
    } finally { await session.close(); }
  });

  it("rejects an enlarged orphan claim before direct, main, or tail restore mutates the session", async () => {
    const source = `//@version=6\nstrategy("Bounded orphan", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=10)
if bar_index == 2
    strategy.exit("X", from_entry="A", qty=5, limit=40)
    strategy.close("B", qty=5)`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const data = [bar(0, 10), bar(1, 10), bar(2, 20), bar(3, 30), bar(4, 35), bar(5, 40)];
    const session = new PineEngine().createSession(compilation.program!, runtime);
    const enlarge = (snapshot: NonNullable<SessionCheckpoint["runtimeState"]>) => {
      const decoded = deserializeRuntimeSnapshot(snapshot, undefined, true);
      const order = decoded.strategy!.orders.find(({ id }) => id === "X")!;
      expect(order.publicExitReservedQuantity).toBe(5);
      order.quantity = 8;
      order.publicExitReservedQuantity = 8;
      order.publicExitAllocationCeiling = 8;
      return decoded;
    };
    try {
      await session.runBatch(data.slice(0, 5));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const context = (session as unknown as { runtime: RuntimeContext }).runtime;
      const before = context.snapshot();
      expect(() => context.restore(enlarge(checkpoint.runtimeState!), data.slice(0, 5)))
        .toThrow(/Invalid public strategy\.exit reservation snapshot/u);
      expect(context.snapshot()).toEqual(before);
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(enlarge(checkpoint.runtimeState!)) }))
        .rejects.toThrow(/Invalid public strategy\.exit reservation snapshot/u);
      await expect(session.restore({ ...checkpoint, tailState: {
        ...checkpoint.tailState!, runtimeState: serializeRuntimeSnapshot(enlarge(checkpoint.tailState!.runtimeState)),
      } })).rejects.toThrow(/Invalid public strategy\.exit reservation snapshot/u);
      expect(session.checkpoint()).toEqual(checkpoint);
      const actual = await session.appendBars(data.slice(5));
      const fresh = new PineEngine().createSession(compilation.program!, runtime);
      try { expect(actual.strategy).toEqual((await fresh.runBatch(data)).strategy); }
      finally { await fresh.close(); }
    } finally { await session.close(); }
  });

  it("rejects aggregate sibling growth and a forged source direction for FIFO orphan claims", async () => {
    const source = `//@version=6\nstrategy("Sibling source", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=5)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=10)
if bar_index == 2
    strategy.exit("X", from_entry="A", qty=5, limit=40)
    strategy.exit("Y", from_entry="A", qty=5, limit=40)
    strategy.close("B", qty=5)`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!, runtime);
    try {
      await session.runBatch([bar(0, 10), bar(1, 10), bar(2, 20), bar(3, 30)]);
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const siblings = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      for (const id of ["X", "Y"]) {
        const order = siblings.strategy!.orders.find((candidate) => candidate.id === id)!;
        order.quantity = 4;
        order.publicExitReservedQuantity = 4;
        order.publicExitAllocationCeiling = 4;
      }
      expect(() => validatePublicExitSnapshot(siblings.strategy!)).toThrow(/Overclaimed public strategy\.exit reservation snapshot/u);
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(siblings) }))
        .rejects.toThrow(/Overclaimed public strategy\.exit reservation snapshot/u);
      const direction = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      direction.strategy!.closedTrades.find((trade) => trade.entryId === "A")!.direction = -1;
      expect(() => validatePublicExitSnapshot(direction.strategy!)).toThrow(/Invalid public strategy\.exit reservation snapshot/u);
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(direction) }))
        .rejects.toThrow(/Invalid public strategy\.exit reservation snapshot/u);
      expect(session.checkpoint()).toEqual(checkpoint);
    } finally { await session.close(); }
  });
});
