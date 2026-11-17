import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { deserializeRuntimeSnapshot, serializeRuntimeSnapshot, type RuntimeContext } from "../runtime/index.js";
import { PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";

const runtime = { symbolInfo: { ticker: "TEST", tickerid: "TEST", currency: "USD", mintick: 1, pointvalue: 1 } } as const;
const bar = (index: number, open: number, high = open, low = open, close = open): MarketBar => ({
  openTime: 1_000 + index * 60_000, open, high, low, close, volume: 100,
});

async function run(source: string, bars: readonly MarketBar[], compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  const compilation = compile({ source, compatibility });
  expect(compilation.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compilation.program!, runtime);
  try { return await session.runBatch(bars); }
  finally { await session.close(); }
}

describe("S3D strategy.exit scoped semantics", () => {
  it("reserves disjoint long quantities when take-profit orders fill in source order", async () => {
    const source = `//@version=6\nstrategy("Reserved exits", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=11)
    strategy.exit("B", "L", qty=8, limit=12)`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 11, 12)];
    const pending = await run(source, bars.slice(0, 2));
    expect(pending.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, status, quantity }) => ({ id, status, quantity })))
      .toEqual([{ id: "A", status: "pending", quantity: 8 }, { id: "B", status: "pending", quantity: 2 }]);
    const result = await run(source, bars);
    expect(result.strategy?.closedTradeRecords.map(({ exitId, quantity, exitPrice }) => ({ exitId, quantity, exitPrice })))
      .toEqual([{ exitId: "A", quantity: 8, exitPrice: 11 }, { exitId: "B", quantity: 2, exitPrice: 12 }]);
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.netProfit).toBe(12);
  });

  it("retains the earlier reservation when the later stop fires first", async () => {
    const source = `//@version=6\nstrategy("Reverse trigger", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=11)
    strategy.exit("B", "L", qty=8, stop=9)`;
    const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10, 10, 9), bar(3, 10, 11)]);
    expect(result.strategy?.closedTradeRecords.map(({ exitId, quantity, exitPrice }) => ({ exitId, quantity, exitPrice })))
      .toEqual([{ exitId: "B", quantity: 2, exitPrice: 9 }, { exitId: "A", quantity: 8, exitPrice: 11 }]);
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.netProfit).toBe(6);
  });

  it("allocates each exit per concrete trade and keeps original percent basis after a partial close", async () => {
    const multi = `//@version=6\nstrategy("Two trades", initial_capital=1000, pyramiding=2, margin_long=0, close_entries_rule="ANY")
if bar_index == 0
    strategy.entry("L1", strategy.long, qty=4)
if bar_index == 1
    strategy.entry("L2", strategy.long, qty=6)
if bar_index == 2
    strategy.exit("A", qty=3, limit=11)
    strategy.exit("B", qty=5, limit=12)`;
    const before = await run(multi, [bar(0, 10), bar(1, 10), bar(2, 10)]);
    expect(before.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, quantity }) => ({ id, quantity })))
      .toEqual([{ id: "A", quantity: 3 }, { id: "A", quantity: 3 }, { id: "B", quantity: 1 }, { id: "B", quantity: 3 }]);
    const after = await run(multi, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 11), bar(4, 11, 12)]);
    expect(after.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "A", quantity: 3 }, { exitId: "A", quantity: 3 }, { exitId: "B", quantity: 1 }, { exitId: "B", quantity: 3 }]);
    expect(after.strategy?.positionSize).toBe(0);

    const percent = `//@version=6\nstrategy("Original basis", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.order("Partial", strategy.short, qty=2)
if bar_index == 2
    strategy.exit("Half", "L", qty_percent=50, limit=11)`;
    const result = await run(percent, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 11)]);
    expect(result.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "Partial", quantity: 2 }, { exitId: "Half", quantity: 5 }]);
    expect(result.strategy?.positionSize).toBe(3);
  });

  it("releases cancelled claims, retains same-ID priority, and modifies pending levels", async () => {
    const source = `//@version=6\nstrategy("Exit lifecycle", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=13, comment_profit="old")
    strategy.exit("B", "L", qty=8, limit=12)
if bar_index == 2
    strategy.exit("A", "L", qty=8, limit=11, comment_profit="new")`;
    const pending = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10)]);
    expect(pending.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, status, quantity, limit }) => ({ id, status, quantity, limit })))
      .toEqual([
        { id: "A", status: "cancelled", quantity: 8, limit: 13 },
        { id: "A", status: "pending", quantity: 8, limit: 11 },
        { id: "B", status: "pending", quantity: 2, limit: 12 },
      ]);
    const filled = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 11), bar(4, 11, 12)]);
    expect(filled.strategy?.closedTradeRecords.map(({ exitId, exitComment, quantity }) => ({ exitId, exitComment, quantity })))
      .toEqual([{ exitId: "A", exitComment: "new", quantity: 8 }, { exitId: "B", exitComment: "B", quantity: 2 }]);

    const cancelled = source.replace('strategy.exit("A", "L", qty=8, limit=11, comment_profit="new")', 'strategy.cancel("A")');
    const afterCancel = await run(cancelled, [bar(0, 10), bar(1, 10), bar(2, 10)]);
    expect(afterCancel.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, status, quantity }) => ({ id, status, quantity })))
      .toEqual([{ id: "A", status: "cancelled", quantity: 8 }, { id: "B", status: "pending", quantity: 2 }]);
  });

  it("reallocates only the explicitly reissued ID after another reservation is cancelled", async () => {
    const source = `//@version=6\nstrategy("Scoped reissue", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=20)
    strategy.exit("B", "L", qty=8, limit=21)
if bar_index == 2
    strategy.cancel("A")
    strategy.exit("C", "L", qty=1, limit=30)
if bar_index == 3
    strategy.exit("C", "L", qty=1, limit=31)`;
    const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10)]);
    expect(result.strategy?.orders.filter(({ command }) => command === "exit").map(({ id, status, quantity }) => ({ id, status, quantity })))
      .toEqual([
        { id: "A", status: "cancelled", quantity: 8 },
        { id: "B", status: "pending", quantity: 2 },
        { id: "C", status: "cancelled", quantity: 1 },
        { id: "C", status: "pending", quantity: 1 },
      ]);
    const reissuedB = await run(`${source}\nif bar_index == 3\n    strategy.exit("B", "L", qty=8, limit=21)`,
      [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10)]);
    expect(reissuedB.strategy?.orders.filter(({ id, status }) => id === "B" && status === "pending")[0]?.quantity).toBe(8);
  });

  it("separates default disjoint claims from explicit public and cross-family OCA reduction", async () => {
    const publicSource = `//@version=6\nstrategy("Public OCA", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=4, limit=11, oca_name="shared")
    strategy.exit("B", "L", qty=4, limit=12, oca_name="shared")`;
    const publicResult = await run(publicSource, [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 11, 12)]);
    expect(publicResult.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "A", quantity: 4 }]);
    expect(publicResult.strategy?.orders.find(({ id }) => id === "B")?.status).toBe("cancelled");
    expect(publicResult.strategy?.positionSize).toBe(6);
    const explicitReverse = publicSource.replace('qty=4, limit=11, oca_name="shared"', 'qty=8, limit=11, oca_name="shared"')
      .replace('qty=4, limit=12, oca_name="shared"', 'qty=8, stop=9, oca_name="shared"');
    const stopFirst = await run(explicitReverse, [bar(0, 10), bar(1, 10), bar(2, 10, 10, 9), bar(3, 10, 11)]);
    expect(stopFirst.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "B", quantity: 2 }, { exitId: "A", quantity: 6 }]);
    expect(stopFirst.strategy?.positionSize).toBe(2);
    const limitFirst = await run(explicitReverse, [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 10, 10, 9)]);
    expect(limitFirst.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "A", quantity: 8 }]);
    expect(limitFirst.strategy?.orders.find(({ id }) => id === "B")?.status).toBe("cancelled");

    const mixed = (exitLimit: number, orderLimit: number, ocaType = "strategy.oca.reduce") => `//@version=6\nstrategy("Mixed OCA", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("X", "L", qty=4, limit=${exitLimit}, oca_name="shared")
    strategy.order("O", strategy.short, qty=3, limit=${orderLimit}, oca_name="shared", oca_type=${ocaType})`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 11, 12)];
    const orderFirst = await run(mixed(12, 11), bars);
    expect(orderFirst.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "O", quantity: 3 }, { exitId: "X", quantity: 1 }]);
    expect(orderFirst.strategy?.positionSize).toBe(6);
    const exitFirst = await run(mixed(11, 12), bars);
    expect(exitFirst.strategy?.orders.find(({ id }) => id === "O")?.status).toBe("cancelled");
    expect(exitFirst.strategy?.positionSize).toBe(6);
    const typeIsolated = await run(mixed(12, 11, "strategy.oca.cancel"), bars);
    expect(typeIsolated.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
      .toEqual([{ exitId: "O", quantity: 3 }, { exitId: "X", quantity: 4 }]);
    expect(typeIsolated.strategy?.positionSize).toBe(3);
  });

  it("retains an explicit OCA cap across unchanged and changed same-ID calls and portable restore", async () => {
    for (const revisedLimit of [12, 13]) {
      const source = `//@version=6\nstrategy("Retained OCA cap", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("X", "L", qty=4, limit=12, oca_name="shared")
    strategy.order("O", strategy.short, qty=3, limit=11, oca_name="shared", oca_type=strategy.oca.reduce)
if bar_index == 2
    strategy.exit("X", "L", qty=4, limit=${revisedLimit}, oca_name="shared")`;
      const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 11, revisedLimit)];
      const program = compile({ source, compatibility: PINE_COMPATIBILITY.strict }).program!;
      const engine = new PineEngine();
      const session = engine.createSession(program, runtime);
      try {
        const prefix = await session.runBatch(bars.slice(0, 3));
        expect(prefix.strategy?.orders.filter(({ id, status }) => id === "X" && status === "pending")).toMatchObject([{ quantity: 1 }]);
        const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
        const final = await session.appendBars(bars.slice(3));
        expect(final.strategy?.closedTradeRecords.map(({ exitId, quantity }) => ({ exitId, quantity })))
          .toEqual([{ exitId: "O", quantity: 3 }, { exitId: "X", quantity: 1 }]);
        await session.restore(checkpoint);
        expect((await session.appendBars(bars.slice(3))).strategy).toEqual(final.strategy);
      } finally { await session.close(); }
    }
  });

  it("replaces removed optional levels on a changed exit ID without carrying stale limit fields", async () => {
    const source = `//@version=6\nstrategy("Changed option", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1
    strategy.exit("X", "L", limit=12)
if bar_index == 2
    strategy.exit("X", "L", stop=9)`;
    const prefix = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10)]);
    expect(prefix.strategy?.orders.filter(({ id }) => id === "X")).toMatchObject([
      { status: "cancelled", limit: 12 }, { status: "pending", stop: 9 },
    ]);
    expect(prefix.strategy?.orders.filter(({ id, status }) => id === "X" && status === "pending")[0]?.limit).toBeUndefined();
    const final = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 10, 9)]);
    expect(final.strategy?.closedTradeRecords).toMatchObject([{ exitId: "X", exitPrice: 9 }]);
  });

  it("binds same-bar pending entries, ignores unmatched IDs, and persists omitted from_entry only while a position lives", async () => {
    const source = `//@version=6\nstrategy("Exit targets", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("L1", strategy.long, qty=2)
    strategy.exit("Wrong", "missing", limit=11)
    strategy.exit("Bound", "L1", limit=12)
if bar_index == 1
    strategy.exit("All", limit=13)
if bar_index == 2
    strategy.entry("L2", strategy.long, qty=3)`;
    const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10), bar(4, 10, 13)]);
    expect(result.strategy?.orders.some(({ id }) => id === "Wrong")).toBe(false);
    expect(result.strategy?.closedTradeRecords.map(({ entryId, exitId, quantity }) => ({ entryId, exitId, quantity })))
      .toEqual([{ entryId: "L1", exitId: "Bound", quantity: 2 }, { entryId: "L2", exitId: "All", quantity: 3 }]);
    expect(result.strategy?.positionSize).toBe(0);

    const noResurrection = `//@version=6\nstrategy("Exit expires", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L1", strategy.long, qty=1)
if bar_index == 1
    strategy.exit("All", limit=11)
if bar_index == 3
    strategy.entry("L2", strategy.long, qty=1)`;
    const later = await run(noResurrection, [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 10), bar(4, 10), bar(5, 10, 11)]);
    expect(later.strategy?.closedTradeRecords).toHaveLength(1);
    expect(later.strategy?.openTradeRecords).toHaveLength(1);
    expect(later.strategy?.openTradeRecords[0]?.entryId).toBe("L2");

    const orderEntry = `//@version=6\nstrategy("Order entry target", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.order("O", strategy.long, qty=2)
    strategy.exit("X", "O", limit=11)`;
    const targeted = await run(orderEntry, [bar(0, 10), bar(1, 10), bar(2, 10, 11)]);
    expect(targeted.strategy?.closedTradeRecords).toMatchObject([{ entryId: "O", exitId: "X", quantity: 2 }]);
  });

  it("preserves reserved claims through append, portable restore and repeated revised tails", async () => {
    const source = `//@version=6\nstrategy("Reserved replay", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=11)
    strategy.exit("B", "L", qty=8, limit=12)`;
    const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    expect(compilation.diagnostics).toEqual([]);
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11), bar(3, 11, 12)];
    const engine = new PineEngine();
    const session = engine.createSession(compilation.program!, runtime);
    const fresh = async (data: readonly MarketBar[]) => {
      const other = engine.createSession(compilation.program!, runtime);
      try { return await other.runBatch(data); }
      finally { await other.close(); }
    };
    try {
      await session.runBatch(bars.slice(0, 2));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const batch = await fresh(bars);
      expect((await session.appendBars(bars.slice(2))).strategy).toEqual(batch.strategy);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(2))).strategy).toEqual(batch.strategy);
      const revisedTail = [bar(2, 10, 10), bar(3, 10, 12)];
      const revised = await session.replaceTail(revisedTail);
      expect(revised.strategy).toEqual((await fresh([...bars.slice(0, 2), ...revisedTail])).strategy);
      expect((await session.replaceTail(revisedTail)).strategy).toEqual(revised.strategy);
    } finally { await session.close(); }
  });

  it("retires a concrete trade claim after an unrelated close while another trade stays open", async () => {
    const source = `//@version=6\nstrategy("Retire one trade", initial_capital=1000, pyramiding=2, margin_long=0)
if bar_index == 0
    strategy.entry("L1", strategy.long, qty=4)
    strategy.entry("L2", strategy.long, qty=6)
if bar_index == 1
    strategy.exit("A", "L1", qty=4, limit=20)
    strategy.close("L1")`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10)];
    const program = compile({ source, compatibility: PINE_COMPATIBILITY.strict }).program!;
    const engine = new PineEngine();
    const session = engine.createSession(program, runtime);
    try {
      const prefix = await session.runBatch(bars.slice(0, 3));
      expect(prefix.strategy?.openTradeRecords).toMatchObject([{ entryId: "L2", quantity: 6 }]);
      expect(prefix.strategy?.orders.find(({ id }) => id === "A")?.status).toBe("pending");
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const appended = await session.appendBars(bars.slice(3));
      const fresh = engine.createSession(program, runtime);
      try { expect(appended.strategy).toEqual((await fresh.runBatch(bars)).strategy); }
      finally { await fresh.close(); }
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(3))).strategy).toEqual(appended.strategy);
    } finally { await session.close(); }
  });

  it("keeps zero-allocation and retired records inert without resurrecting a closed position", async () => {
    const zeroSource = `//@version=6\nstrategy("Zero claim", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 1
    strategy.exit("A", "L", qty=1, limit=20)
    strategy.exit("B", "L", qty=1, stop=9)
if bar_index == 2
    strategy.cancel("A")`;
    const zero = await run(zeroSource, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 10, 9)]);
    expect(zero.strategy?.orders.find(({ id }) => id === "B")).toMatchObject({ status: "pending", quantity: 0 });
    expect(zero.strategy?.closedTradeRecords).toEqual([]);
    expect(zero.strategy?.positionSize).toBe(1);

    const retiredSource = `//@version=6\nstrategy("Retired claim", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L1", strategy.long, qty=1)
if bar_index == 1
    strategy.exit("X", "L1", stop=9)
    strategy.close_all(immediately=true)
if bar_index == 2
    strategy.entry("L2", strategy.long, qty=1)
exitLabel = strategy.closedtrades.exit_id(0)`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 10, 9)];
    const sameBar = await run(retiredSource, bars.slice(0, 2));
    expect(sameBar.strategy?.orders.find(({ id }) => id === "X")).toMatchObject({ status: "pending", quantity: 0 });
    const final = await run(retiredSource, bars);
    expect(final.strategy?.orders.find(({ id }) => id === "X")?.status).toBe("cancelled");
    expect(final.strategy?.closedTradeRecords.map(({ exitId }) => exitId)).toEqual(["close_all"]);
    expect(final.returned.exitLabel).toEqual(["", "", "Close position order", "Close position order"]);
    expect(final.strategy?.openTradeRecords).toMatchObject([{ entryId: "L2", quantity: 1 }]);
  });

  it("allocates one cash-per-order fee across the closed entry quantities", async () => {
    const source = `//@version=6
strategy("Shared close fee", initial_capital=1000, margin_long=0, pyramiding=2, commission_type=strategy.commission.cash_per_order, commission_value=2)
if bar_index == 0
    strategy.entry("A", strategy.long, qty=1)
if bar_index == 1
    strategy.entry("B", strategy.long, qty=3)
if bar_index == 2
    strategy.close_all()`;
    const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 12)]);
    expect(result.strategy?.closedTradeRecords.map(({ commission }) => commission)).toEqual([2.5, 3.5]);
    expect(result.strategy?.netProfit).toBe(2);
  });

  it("rejects a deleted public reservation before portable restore mutates the session", async () => {
    const source = `//@version=6\nstrategy("Reject forged claim", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=11)`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11)];
    const program = compile({ source, compatibility: PINE_COMPATIBILITY.strict }).program!;
    const engine = new PineEngine();
    const session = engine.createSession(program, runtime);
    try {
      await session.runBatch(bars.slice(0, 2));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const decoded = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      const order = decoded.strategy!.orders.find(({ id }) => id === "A")!;
      delete order.publicExitReservedQuantity;
      const context = (session as unknown as { runtime: RuntimeContext }).runtime;
      const beforeDirectRestore = context.snapshot();
      const missingLedger = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      Object.assign(missingLedger.strategy!, { publicExitIntents: undefined });
      expect(() => context.restore(missingLedger, bars.slice(0, 2)))
        .toThrow(/Invalid public strategy\.exit intent snapshot/u);
      expect(context.snapshot()).toEqual(beforeDirectRestore);
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(missingLedger) }))
        .rejects.toThrow(/Invalid public strategy\.exit intent snapshot/u);
      expect(() => context.restore(decoded, bars.slice(0, 2))).toThrow(/Missing public strategy\.exit reservation snapshot/u);
      expect(context.snapshot()).toEqual(beforeDirectRestore);
      const forged = { ...checkpoint, runtimeState: serializeRuntimeSnapshot(decoded) };
      await expect(session.restore(forged)).rejects.toThrow(/Missing public strategy\.exit reservation snapshot/u);
      const retired = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      const retiredOrder = retired.strategy!.orders.find(({ id }) => id === "A")!;
      retiredOrder.publicExitRetired = true;
      retiredOrder.publicExitReservedQuantity = 0;
      retiredOrder.quantity = 0;
      expect(() => context.restore(retired, bars.slice(0, 2))).toThrow(/Invalid retired public strategy\.exit snapshot/u);
      expect(context.snapshot()).toEqual(beforeDirectRestore);
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(retired) }))
        .rejects.toThrow(/Invalid retired public strategy\.exit snapshot/u);
      const missingTarget = deserializeRuntimeSnapshot(checkpoint.runtimeState!, undefined, true);
      const targetless = missingTarget.strategy!.orders.find(({ id }) => id === "A")!;
      targetless.publicExitRetired = true;
      targetless.publicExitReservedQuantity = 0;
      targetless.quantity = 0;
      delete targetless.targetTradeId;
      await expect(session.restore({ ...checkpoint, runtimeState: serializeRuntimeSnapshot(missingTarget) }))
        .rejects.toThrow(/Invalid retired public strategy\.exit snapshot/u);
      expect(() => session.checkpoint()).not.toThrow();
      const after = await session.appendBars(bars.slice(2));
      const fresh = engine.createSession(program, runtime);
      try { expect(after.strategy).toEqual((await fresh.runBatch(bars)).strategy); }
      finally { await fresh.close(); }
    } finally { await session.close(); }
  });

  it("rejects a forged tail claim before portable restore changes an existing session", async () => {
    const source = `//@version=6\nstrategy("Reject forged tail", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 1
    strategy.exit("A", "L", qty=8, limit=11)`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10), bar(3, 10, 11)];
    const program = compile({ source, compatibility: PINE_COMPATIBILITY.strict }).program!;
    const engine = new PineEngine();
    const session = engine.createSession(program, runtime);
    try {
      await session.runBatch(bars.slice(0, 3));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      expect(checkpoint.tailState).toBeDefined();
      const missingLedger = deserializeRuntimeSnapshot(checkpoint.tailState!.runtimeState, undefined, true);
      Object.assign(missingLedger.strategy!, { publicExitIntents: undefined });
      await expect(session.restore({ ...checkpoint, tailState: {
        ...checkpoint.tailState!, runtimeState: serializeRuntimeSnapshot(missingLedger),
      } })).rejects.toThrow(/Invalid public strategy\.exit intent snapshot/u);
      const tail = deserializeRuntimeSnapshot(checkpoint.tailState!.runtimeState, undefined, true);
      delete tail.strategy!.orders.find(({ id }) => id === "A")!.publicExitReservedQuantity;
      const forged = { ...checkpoint, tailState: { ...checkpoint.tailState!, runtimeState: serializeRuntimeSnapshot(tail) } };
      await expect(session.restore(forged)).rejects.toThrow(/Missing public strategy\.exit reservation snapshot/u);
      expect(() => session.checkpoint()).not.toThrow();
      const actual = await session.appendBars(bars.slice(3));
      const fresh = engine.createSession(program, runtime);
      try { expect(actual.strategy).toEqual((await fresh.runBatch(bars)).strategy); }
      finally { await fresh.close(); }
    } finally { await session.close(); }
  });

  it("uses the earlier profit/loss pair in v6 and the absolute level in v5", async () => {
    const bars = [bar(0, 10), bar(1, 10), bar(2, 10, 11, 10), bar(3, 10, 13, 10)];
    for (const [version, expected] of [[5, 13], [6, 11]] as const) {
      const source = `//@version=${version}\nstrategy("Exit pair", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
    strategy.exit("X", "L", profit=1, limit=13, comment_profit="relative", alert_profit="relative alert")`;
      const result = await run(source, bars);
      expect(result.strategy?.closedTradeRecords).toMatchObject([{ exitPrice: expected, exitId: "X", exitComment: "relative" }]);
      expect(result.strategy?.orders.find(({ id }) => id === "X")).toMatchObject({ fillPrice: expected, alertMessage: "relative alert" });
    }
    for (const [version, expected] of [[5, 7], [6, 9]] as const) {
      const source = `//@version=${version}\nstrategy("Exit loss pair", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
    strategy.exit("X", "L", loss=1, stop=7, comment_loss="relative loss", alert_loss="loss alert")`;
      const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10, 10, 9), bar(3, 9, 9, 7)]);
      expect(result.strategy?.closedTradeRecords).toMatchObject([{ exitPrice: expected, exitComment: "relative loss" }]);
      expect(result.strategy?.orders.find(({ id }) => id === "X")).toMatchObject({ fillPrice: expected, alertMessage: "loss alert" });
    }
  });

  it("closes short partial exits with separate profit and loss comments and conserved quantities", async () => {
    const source = `//@version=6\nstrategy("Short exits", initial_capital=1000, margin_short=0, commission_type=strategy.commission.cash_per_contract, commission_value=0.25)
if bar_index == 0
    strategy.entry("S", strategy.short, qty=4)
    strategy.exit("Take", "S", qty_percent=50, profit=1, comment_profit="short take", alert_profit="take alert", disable_alert=true)
    strategy.exit("Stop", "S", loss=1, comment_loss="short stop", alert_loss="stop alert")`;
    const result = await run(source, [bar(0, 10), bar(1, 10), bar(2, 10, 10, 9), bar(3, 10, 11)]);
    expect(result.strategy?.closedTradeRecords.map(({ exitId, exitComment, quantity, exitPrice, profit }) => ({ exitId, exitComment, quantity, exitPrice, profit })))
      .toEqual([
        { exitId: "Take", exitComment: "short take", quantity: 2, exitPrice: 9, profit: 1 },
        { exitId: "Stop", exitComment: "short stop", quantity: 2, exitPrice: 11, profit: -3 },
      ]);
    expect(result.strategy?.orders.find(({ id }) => id === "Take")).toMatchObject({ alertMessage: "take alert", disableAlert: true });
    expect(result.strategy?.orders.find(({ id }) => id === "Stop")).toMatchObject({ alertMessage: "stop alert" });
    expect(result.strategy?.positionSize).toBe(0);
    expect(result.strategy?.netProfit).toBe(-2);
  });

  it("carries trailing activation and peak into a later bar and preserves the trailing alert override", async () => {
    const source = `//@version=6\nstrategy("Trailing exit", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=1)
    strategy.exit("Trail", "L", trail_price=12, trail_points=3, trail_offset=1, comment_trailing="trailing fill", alert_message="base alert", alert_trailing="trail alert")`;
    const bars = [bar(0, 10), bar(1, 10), bar(2, 12), bar(3, 13, 13, 12, 12)];
    const prefix = await run(source, bars.slice(0, 3));
    expect(prefix.strategy?.orders.find(({ id }) => id === "Trail")).toMatchObject({ status: "pending", trailArmed: true, trailPeak: 12 });
    const result = await run(source, bars);
    expect(result.strategy?.closedTradeRecords).toMatchObject([{ exitId: "Trail", exitComment: "trailing fill", exitPrice: 12, quantity: 1 }]);
    expect(result.strategy?.orders.find(({ id }) => id === "Trail")).toMatchObject({ status: "filled", trailPeak: 13, alertMessage: "trail alert" });
    expect(result.strategy?.netProfit).toBe(2);
  });

  it("reports incomplete/no-price calls as typed strict runtime failures while sealed calls remain admitted", async () => {
    const bars = [bar(0, 10)];
    for (const args of [
      '"X"', '"X", trail_price=11', '"X", trail_offset=1', '"X", profit=2, trail_offset=1',
      '"X", qty=0, limit=11', '"X", qty=-1, limit=11', '"X", qty_percent=0, limit=11',
      '"X", trail_price=11, trail_offset=-1',
    ]) {
      const source = `//@version=6\nstrategy("Invalid exit")\nstrategy.exit(${args})`;
      const compilation = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
      expect(compilation.diagnostics).toEqual([]);
      const session = new PineEngine().createSession(compilation.program!, runtime);
      try { await expect(session.runBatch(bars)).rejects.toMatchObject({ name: "PineRuntimeError" }); }
      finally { await session.close(); }
    }
    const precedence = `//@version=6\nstrategy("Qty precedence", initial_capital=1000, margin_long=0)
if bar_index == 0
    strategy.entry("L", strategy.long, qty=2)
    strategy.exit("X", "L", qty=1, qty_percent=0, limit=11)`;
    expect((await run(precedence, [bar(0, 10), bar(1, 10), bar(2, 10, 11)])).strategy?.closedTradeRecords)
      .toMatchObject([{ exitId: "X", quantity: 1 }]);
    expect((await run('//@version=6\nstrategy("Sealed")\nstrategy.exit("X")', bars, PINE_COMPATIBILITY.legacy)).strategy?.orders).toHaveLength(1);
  });
});
