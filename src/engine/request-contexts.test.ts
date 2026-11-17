import type { ExecutionResult } from "../contracts/index.js";
import { expect, it, vi } from "vitest";
import { compile, PineEngine } from "./index.js";
import { RequestContextBudget } from "./request-context-budget.js";
import { RequestContexts } from "./request-contexts.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

it("owns pending children during cleanup and rejects their late completion", async () => {
  const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Empty")' }).program!;
  const engine = new PineEngine().createSession(program);
  const result = await engine.runBatch([]);
  await engine.close();
  let resolve!: (value: ExecutionResult) => void;
  const pending = new Promise<ExecutionResult>((done) => { resolve = done; });
  const child = { runBatch: () => pending, appendBars: () => pending, replaceTail: () => pending, close: vi.fn(async () => {}) };
  const contexts = new RequestContexts(1);
  const execution = contexts.execute("a", "a", [], false, () => child);
  expect(contexts.size).toBe(1);
  await expect(contexts.execute("b", "b", [], false, () => child)).rejects.toThrow("limit");
  await contexts.close();
  resolve(result);
  await expect(execution).rejects.toThrow("disposed");
  expect(contexts.size).toBe(0);
  expect(child.close).toHaveBeenCalledTimes(1);
});

async function emptyResult(): Promise<ExecutionResult> {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Empty")' }).program!;
  const session = new PineEngine().createSession(compiled);
  try { return await session.runBatch([]); } finally { await session.close(); }
}
function childFor(result: ExecutionResult) {
  return { runBatch: vi.fn(async () => result), appendBars: vi.fn(async () => result), replaceTail: vi.fn(async () => result), close: vi.fn(async () => {}) };
}

it("retains several dataset selections for a callsite and reuses A after A-B-A", async () => {
  const result = await emptyResult();
  const a = childFor(result), b = childFor(result);
  const contexts = new RequestContexts(2);
  await contexts.execute("call", "A", [], false, () => a);
  await contexts.execute("call", "B", [], false, () => b);
  await contexts.execute("call", "A", [], false, () => { throw new Error("must reuse"); });
  expect(contexts.size).toBe(2);
  expect(a.runBatch).toHaveBeenCalledTimes(1);
  expect(b.runBatch).toHaveBeenCalledTimes(1);
  await expect(contexts.execute("call", "C", [], false, () => a)).rejects.toThrow("limit");
  await contexts.close();
  expect(a.close).toHaveBeenCalledTimes(1);
  expect(b.close).toHaveBeenCalledTimes(1);
});

it("replaces metadata revisions without consuming another selection slot", async () => {
  const result = await emptyResult();
  const a = childFor(result), b = childFor(result);
  const budget = new RequestContextBudget(1);
  const contexts = new RequestContexts(budget);
  await contexts.execute("call", "metadata-v1", [], false, () => a, "symbol@60");
  await contexts.execute("call", "metadata-v2", [], false, () => b, "symbol@60");
  expect(budget.size).toBe(1);
  expect(a.close).toHaveBeenCalledTimes(1);
  expect(b.runBatch).toHaveBeenCalledTimes(1);
  await contexts.close();
  expect(budget.size).toBe(0);
});

it("shares capacity across nested registries and releases failed construction", async () => {
  const result = await emptyResult();
  const budget = new RequestContextBudget(2);
  const parent = new RequestContexts(budget), nested = new RequestContexts(budget);
  await parent.execute("a", "A", [], false, () => childFor(result));
  await expect(nested.execute("b", "B", [], false, () => { throw new Error("factory failed"); })).rejects.toThrow("factory failed");
  expect(budget.size).toBe(1);
  await nested.execute("b", "B", [], false, () => childFor(result));
  await expect(parent.execute("c", "C", [], false, () => childFor(result))).rejects.toThrow("limit");
  await parent.close();
  expect(budget.size).toBe(1);
  await nested.close();
  expect(budget.size).toBe(0);
});

it("releases a failed child while retaining independent contexts", async () => {
  const result = await emptyResult();
  const budget = new RequestContextBudget(2);
  const contexts = new RequestContexts(budget);
  const failed = childFor(result);
  failed.runBatch.mockRejectedValueOnce(new Error("failed"));
  await contexts.execute("call", "A", [], false, () => childFor(result));
  await expect(contexts.execute("call", "B", [], false, () => failed)).rejects.toThrow("failed");
  expect(budget.size).toBe(1);
  expect(failed.close).toHaveBeenCalledTimes(1);
  await contexts.close();
  expect(budget.size).toBe(0);
});

it("preserves the frozen lane's single-child replacement", async () => {
  const result = await emptyResult();
  const a = childFor(result), b = childFor(result);
  const contexts = new RequestContexts(1, false);
  await contexts.execute("call", "A", [], false, () => a);
  await contexts.execute("call", "B", [], false, () => b);
  expect(contexts.size).toBe(1);
  expect(a.close).toHaveBeenCalledTimes(1);
  await contexts.close();
});

it("enforces the production budget across actual child engine sessions", async () => {
  const compatibility = PINE_COMPATIBILITY.strict;
  const childSource = '//@version=6\nindicator("Children")\n' + Array.from({ length: 20 }, (_, index) => `plot(request.security("", "", close + ${index}))`).join("\n");
  const child = compile({ compatibility, source: childSource }).program!;
  const root = compile({ compatibility, source: '//@version=6\nindicator("Root")\na = request.security("", "1", close)\nb = request.security("", "2", close)\nplot(a + b)' }).program!;
  expect(child.requestPlans).toHaveLength(20);
  expect(root.requestPlans).toHaveLength(2);
  const program = { ...root, requestPlans: root.requestPlans.map((plan) => ({ ...plan, program: child })) };
  const bars = [{ open: 1, high: 2, low: 1, close: 2, volume: 100, openTime: 0 }];
  const session = new PineEngine().createSession(program, { timeframe: "1", marketDataGateway: { load: async () => ({ bars }) } });
  try { await expect(session.runBatch(bars)).rejects.toThrow("Request context limit exceeded"); }
  finally { await session.close(); }
});
