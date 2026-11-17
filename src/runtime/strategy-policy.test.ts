import { expect, it } from "vitest";
import { createStrategyState } from "./strategy-accounting.js";
import type { MutableStrategyOrder, MutableStrategyTrade } from "./strategy.js";
import { projectedPosition, strategyOrderBlocked, strategyRiskDecision, strategyRiskHaltRequired, strategyMarginCallDecision, strategyExitDecision } from "./strategy-policy.js";
const order: MutableStrategyOrder = { id: "order", command: "entry", direction: -1, quantity: 2, type: "market", createdBarIndex: 0, createdTime: 0, status: "pending" };
const trade: MutableStrategyTrade = { id: "trade", entryId: "entry", direction: 1, quantity: 10, entryPrice: 100, entryBarIndex: 0, entryTime: 0, entryCommission: 0, maxDrawdown: 0, maxRunup: 0, status: "open" };

it("keeps reversal sizing distinct from order additions and does not mutate risk state", () => {
  const state = { ...createStrategyState(undefined), positionSize: 10, riskRules: { maxPositionSize: 5 } };
  const before = structuredClone(state);
  expect(projectedPosition(state, order)).toBe(-2);
  expect(projectedPosition(state, { ...order, command: "order" })).toBe(8);
  expect(strategyOrderBlocked(state, order)).toBe(false);
  expect(strategyOrderBlocked(state, { ...order, command: "order" })).toBe(true);
  expect(strategyRiskHaltRequired({ ...state, intradayFills: 2, riskRules: { maxIntradayFilledOrders: 2 } })).toBe(true);
  expect(state).toEqual(before);
});

it("measures risk drawdown from closed profit and its peak", () => {
  const state = createStrategyState(undefined);
  state.riskClosedProfitPeak = 100_000;
  state.equity = 600_000;
  state.maxDrawdown = 500_000;
  state.maxDrawdownPercent = 50;
  state.riskRules.maxDrawdown = { value: 10, type: "percent_of_equity" };
  expect(strategyRiskDecision(state).permanent).toBe(false);
  state.closedTradeProfitTotal = -10_000;
  expect(strategyRiskDecision(state).permanent).toBe(true);
});

it("preserves adverse-path and trailing exit precedence", () => {
  const exit = { ...order, command: "exit" as const, limit: 110, stop: 90 };
  const bar = { openTime: 0, open: 95, high: 115, low: 85, close: 100, volume: 1 };
  expect(strategyExitDecision(exit, trade, bar, 1, undefined)).toMatchObject({ price: 90, kind: "loss", direction: -1 });
  expect(strategyExitDecision(exit, trade, { ...bar, open: 110 }, 1, undefined)).toMatchObject({ price: 110, kind: "profit" });
  expect(strategyExitDecision(exit, trade, bar, 1, 101)).toMatchObject({ price: 101, kind: "trailing" });
  expect(exit.status).toBe("pending");
});

it("computes the quantity needed to cover margin without closing trades", () => {
  const initial = createStrategyState(undefined);
  const state = { ...initial, config: { ...initial.config, initial_capital: 100, margin_long: 20 }, positionSize: 10, positionAveragePrice: 100, openTrades: [trade] };
  const bar = { openTime: 0, open: 110, high: 120, low: 80, close: 100, volume: 1 };
  expect(strategyMarginCallDecision(state, bar, 1, "open")).toEqual({ coverQuantity: 10 / 11, legacyQuantity: 40 / 11, price: 110, direction: -1 });
  expect(strategyMarginCallDecision(state, bar, 1, "extreme")).toEqual({ coverQuantity: 260 / 16, legacyQuantity: 10, price: 80, direction: -1 });
  expect(state.openTrades).toEqual([trade]);
});
