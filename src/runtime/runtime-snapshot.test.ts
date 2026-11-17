import { compile } from "../compiler/index.js";
import { describe, expect, it } from "vitest";
import { createRuntime } from "./index.js";
import { captureHistoryWindow, createHistoryWindow, deserializeRuntimeSnapshot, HISTORY_WINDOW_CAPACITY, readHistoryWindow, serializeRuntimeSnapshot, writeHistoryWindow, writeHistoryWindowExecution } from "./runtime-snapshot.js";
import { serializeRuntimeGraph } from "./runtime-value-graph.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Snapshot")\nvalue = close' });
const snapshot = () => createRuntime(compiled.program!, {}).snapshot();

describe("snapshot restore containers", () => {
  it("admits an unevaluated runtime snapshot", () => {
    const state = snapshot();
    expect(deserializeRuntimeSnapshot(serializeRuntimeSnapshot(state))).toEqual(state);
  });

  it.each([
    ["variables", [1]], ["globalPersistence", undefined], ["plots", []],
    ["firedAlerts", []], ["lines", {}], ["barIndex", 0.5],
    ["requestSeries", null], ["strategy", []],
  ])("rejects an invalid %s container", (field, value) => {
    const state = { ...snapshot(), [field]: value };
    expect(() => deserializeRuntimeSnapshot(serializeRuntimeGraph(state))).toThrow(`field ${field}`);
  });

  it("rejects forged footprint handles during checkpoint admission", () => {
    const state = snapshot();
    const forged = { __pineFootprint: 1, storeKey: "store", openTime: 1, injected: true };
    expect(() => deserializeRuntimeSnapshot(serializeRuntimeGraph({ ...state, variables: [[forged]] })))
      .toThrow("Invalid runtime checkpoint footprint handle");
  });
});

it.each([
  ["argumentSeries", new Map([["a", 1]])],
  ["historySeries", new Map([[{}, []]])],
  ["localState", new Map([["a", { values: [], initialized: false, persistence: "invalid" }]])],
  ["plots", new Map([["plot", { id: "other", title: "Plot", options: {}, points: [] }]])],
  ["plots", new Map([["plot", { id: "plot", title: "Plot", options: {}, points: [{ time: "bad", value: 1 }] }]])],
  ["requestSeries", { a: 1 }],
  ["firedAlerts", new Set([1])],
  ["globalPersistence", ["invalid"]],
])("rejects malformed nested %s state", (field, value) => {
  expect(() => deserializeRuntimeSnapshot(serializeRuntimeGraph({ ...snapshot(), [field]: value }))).toThrow(`field ${field}`);
});

it.each([
  ["lines", [null]], ["boxes", [{ __pineBox: true }]],
  ["labels", [{ __pineLabel: true, id: 0 }]], ["polylines", [{ points: [null] }]],
  ["linefills", [{ line1: null, line2: null }]], ["tables", [{ cells: [[]] }]],
  ["alerts", [{ type: "alert", id: "x", message: 1, barIndex: 0, time: 0 }]],
  ["strategy", {}],
])("rejects malformed domain records in %s", (field, value) => {
  expect(() => deserializeRuntimeSnapshot(serializeRuntimeGraph({ ...snapshot(), [field]: value }))).toThrow(`field ${field}`);
});

it.each(["orders", "openTrades", "closedTrades", "timeline", "riskRules", "config"])("validates nested strategy %s before restoration", (field) => {
  const strategy = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nstrategy("State")\nplot(close)' }).program!;
  const state = createRuntime(strategy, { symbolInfo: { currency: "USD" } }).snapshot();
  expect(deserializeRuntimeSnapshot(serializeRuntimeSnapshot(state))).toEqual(state);
  const invalid = { ...state, strategy: { ...state.strategy, [field]: field === "riskRules" ? { maxDrawdown: { value: "bad", type: "cash" } } : [null] } };
  expect(() => deserializeRuntimeSnapshot(serializeRuntimeGraph(invalid))).toThrow("field strategy");
});

it("rejects unsupported fill recalculation on direct runtime restore before changing state", () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nstrategy("Safe")\nplot(close)' }).program!;
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD" } });
  const safe = runtime.snapshot();
  const unsafe = { ...safe, strategy: { ...safe.strategy!, config: { ...safe.strategy!.config, calc_on_order_fills: true } } };

  expect(() => runtime.restore(unsafe, [])).toThrow("calc_on_order_fills is unsupported");
  expect(runtime.snapshot()).toEqual(safe);
  expect(() => runtime.restoreTail({ kind: "full", snapshot: unsafe }, [])).toThrow("calc_on_order_fills is unsupported");
  expect(runtime.snapshot()).toEqual(safe);
  expect(() => runtime.restore(safe, [])).not.toThrow();
});

it("preserves direct restore of enabled order-fill state in the frozen profile", () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.legacy, source: '//@version=6\nstrategy("Legacy", calc_on_order_fills=true)\nplot(close)' }).program!;
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD" } });
  const state = runtime.snapshot();
  expect(state.strategy?.config.calc_on_order_fills).toBe(true);
  expect(() => runtime.restore(state, [])).not.toThrow();
  expect(() => runtime.restoreTail({ kind: "full", snapshot: state }, [])).not.toThrow();
});

it("migrates pre-retention strategy checkpoints with lifetime aggregates", () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nstrategy("Migration")\nplot(close)' }).program!;
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD", pointvalue: 2 } });
  const state = runtime.snapshot();
  state.strategy!.closedTrades.push({
    id: "closed-0", entryId: "Long", direction: 1, quantity: 2, entryPrice: 10,
    entryBarIndex: 0, entryTime: 1_000, exitPrice: 11, exitBarIndex: 1, exitTime: 61_000,
    profit: 4, entryCommission: 0, commission: 0, maxDrawdown: 0, maxRunup: 4, status: "closed",
  });
  state.strategy!.winningTrades = 1;
  state.strategy!.winningProfit = 4;
  const legacy = state.strategy! as unknown as Record<string, unknown>;
  for (const field of ["closedTradeCount", "closedTradeFirstIndex", "closedTradeProfitTotal", "closedTradePercentTotal",
    "winningTradePercentTotal", "losingTradePercentTotal"]) Reflect.deleteProperty(legacy, field);

  const restored = deserializeRuntimeSnapshot(serializeRuntimeGraph(state));
  expect(() => runtime.restore(restored, [])).not.toThrow();
  expect(runtime.snapshot().strategy).toMatchObject({
    closedTradeCount: 1,
    closedTradeFirstIndex: 0,
    closedTradeProfitTotal: 4,
    closedTradePercentTotal: 10,
    winningTradePercentTotal: 10,
    losingTradePercentTotal: 0,
  });
});

it("rejects partially populated retained-trade checkpoint metadata", () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nstrategy("Migration")\nplot(close)' }).program!;
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD" } });
  const state = runtime.snapshot();
  delete (state.strategy! as unknown as Record<string, unknown>).closedTradePercentTotal;

  expect(() => runtime.restore(state, [])).toThrow("Invalid retained closed-trade snapshot");
});

it("migrates oversized pre-retention checkpoints without losing lifetime aggregates", () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nstrategy("Migration")\nplot(close)' }).program!;
  const runtime = createRuntime(program, { symbolInfo: { currency: "USD", pointvalue: 1 } });
  const state = runtime.snapshot();
  for (let index = 0; index < 9001; index++) state.strategy!.closedTrades.push({
    id: `closed-${index}`, entryId: "Long", direction: 1, quantity: 1, entryPrice: 10,
    entryBarIndex: 0, entryTime: 1, exitPrice: 11, exitBarIndex: 1, exitTime: 2,
    profit: 1, entryCommission: 0, commission: 0, maxDrawdown: 0, maxRunup: 1, status: "closed",
  });
  state.strategy!.winningTrades = 9001;
  state.strategy!.winningProfit = 9001;
  const legacy = state.strategy! as unknown as Record<string, unknown>;
  for (const field of ["closedTradeCount", "closedTradeFirstIndex", "closedTradeProfitTotal", "closedTradePercentTotal",
    "winningTradePercentTotal", "losingTradePercentTotal"]) Reflect.deleteProperty(legacy, field);

  runtime.restore(state, []);
  expect(runtime.snapshot().strategy).toMatchObject({ closedTradeCount: 9001, closedTradeFirstIndex: 1,
    closedTradeProfitTotal: 9001, closedTradePercentTotal: 90010 });
  expect(runtime.snapshot().strategy!.closedTrades).toHaveLength(9000);
  expect(state.strategy!.closedTrades).toHaveLength(9001);
});

describe("execution-counted history windows", () => {
  it("counts bars with writes, even across gaps or multiple writes on a bar", () => {
    const window = createHistoryWindow();
    for (const index of [0, 1, 2, 5, 6, 6009]) writeHistoryWindowExecution(window, index, index * 10);
    const index = writeHistoryWindowExecution(window, 6009, 99);
    expect(readHistoryWindow(window, index)).toBe(99);
    expect(readHistoryWindow(window, index - 1)).toBe(60);
    expect(readHistoryWindow(window, index - 3)).toBe(20);
    expect(readHistoryWindow(window, index - 6)).toBeUndefined();
  });

  it("restores sparse execution samples from a bar-indexed checkpoint", () => {
    const runtime = createRuntime(compiled.program!, {});
    runtime.beginBar(2);
    const state = runtime.snapshot();
    const legacyWindow = () => {
      const window = createHistoryWindow();
      writeHistoryWindow(window, 0, 10);
      writeHistoryWindow(window, 2, 20);
      return window;
    };
    state.argumentSeries.set("probe:0", legacyWindow());
    state.localState.set("probe:1", { values: legacyWindow(), initialized: true, persistence: "bar", persistentValue: 20 });
    state.historySeries.set("probe-expression", legacyWindow());
    state.historySeries.set("builtin:last_bar_index", legacyWindow());
    runtime.restore(deserializeRuntimeSnapshot(serializeRuntimeSnapshot(state)), []);
    runtime.beginBar(4);
    expect(runtime.argumentRef("probe", 0, 30).get(2)).toBe(10);
    expect(runtime.localRef("probe", 1, () => 30, "bar").get(2)).toBe(10);
    expect(runtime.history("probe-expression", 30, 2)).toBe(10);
    expect(runtime.builtin("last_bar_index", 2)).toBe(20);
  });

  it("restores an evicted execution slot during compact rollback", () => {
    const window = createHistoryWindow();
    for (let index = 0; index < HISTORY_WINDOW_CAPACITY; index++) writeHistoryWindowExecution(window, index, index);
    const restore = captureHistoryWindow(window, 9000);
    const index = writeHistoryWindowExecution(window, 9000, 9000);
    expect(readHistoryWindow(window, 0)).toBeUndefined();
    restore();
    expect(window).toMatchObject({ last: index - 1, lastExecutionBar: HISTORY_WINDOW_CAPACITY - 1 });
    expect(readHistoryWindow(window, 0)).toBe(0);
  });
});
