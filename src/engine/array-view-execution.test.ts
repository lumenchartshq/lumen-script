import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

it("replays linked view growth identically through append, replace-tail, and portable restore", async () => {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Slice replay")
var parent = array.from(1.0, 2.0, 3.0)
var view = array.slice(parent, 1, 3)
array.push(view, close)
value = array.sum(parent)
size = array.size(parent)` });
  expect(compiled.diagnostics).toEqual([]);
  const bar = (openTime: number, close: number): MarketBar => ({ openTime, closeTime: openTime + 60_000, open: close, high: close, low: close, close, volume: 1 });
  const engine = new PineEngine();
  const session = engine.createSession(compiled.program!);
  const batch = engine.createSession(compiled.program!);
  try {
    await session.runBatch([bar(0, 1)]);
    await session.appendBars([bar(60_000, 2)]);
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const expected = await batch.runBatch([bar(0, 1), bar(60_000, 9), bar(120_000, 3)]);
    const replacement = await session.replaceTail([bar(60_000, 9), bar(120_000, 3)]);
    expect(replacement.returned.value).toEqual([7, 16, 19]);
    expect(replacement.returned.size).toEqual([4, 5, 6]);
    expect(replacement.returned.value).toEqual(expected.returned.value);
    await session.restore(checkpoint);
    const restored = await session.replaceTail([bar(60_000, 9), bar(120_000, 3)]);
    expect(restored.returned.value).toEqual(expected.returned.value);
    expect(restored.returned.size).toEqual(expected.returned.size);
  } finally {
    await session.close();
    await batch.close();
  }
});

it("preserves cross-variable varip aliases as one graph during tail rollback", async () => {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Intrabar slice")
varip parent = array.from(1.0, 2.0, 3.0)
varip view = array.slice(parent, 1, 3)
array.push(view, close)
value = array.sum(parent)` });
  expect(compiled.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compiled.program!);
  const bar = { openTime: 0, closeTime: 60_000, open: 1, high: 9, low: 1, close: 1, volume: 1 };
  try {
    expect((await session.runBatch([bar])).returned.value).toEqual([7]);
    expect((await session.replaceTail([{ ...bar, close: 9 }])).returned.value).toEqual([16]);
  } finally { await session.close(); }
});

it("refreshes function-local views before iteration after a parent write", async () => {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Local slice read")
sumView() =>
    parent = array.from(1, 2, 3)
    view = array.slice(parent, 1, 3)
    array.set(parent, 1, 9)
    total = 0
    for item in view
        total += item
    total
value = sumView()` });
  expect(compiled.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compiled.program!);
  try {
    const result = await session.runBatch([{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    expect(result.returned.value).toEqual([12]);
  } finally { await session.close(); }
});

it("restores same-length array writes and front replacement across repeated tail revisions", async () => {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Array rollback ownership")
var values = array.from(1.0, 2.0, 3.0)
var alias = values
array.set(values, 1, close)
removed = array.shift(alias)
array.unshift(values, removed + 10)
front = array.first(alias)
middle = array.get(values, 1)
size = array.size(alias)` });
  expect(compiled.diagnostics).toEqual([]);
  const bar = (openTime: number, close: number): MarketBar => ({
    openTime, closeTime: openTime + 60_000, open: close, high: close, low: close, close, volume: 1,
  });
  const prefix = [bar(0, 1), bar(60_000, 2)];
  const engine = new PineEngine();
  const session = engine.createSession(compiled.program!);
  const runFresh = async (bars: readonly MarketBar[]) => {
    const fresh = engine.createSession(compiled.program!);
    try { return await fresh.runBatch(bars); }
    finally { await fresh.close(); }
  };
  try {
    await session.runBatch(prefix);
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const original = await session.appendBars([bar(120_000, 3)]);
    expect(original.returned).toMatchObject({
      removed: [1, 11, 21], front: [11, 21, 31], middle: [1, 2, 3], size: [3, 3, 3],
    });

    for (const close of [9, 4]) {
      const replacement = await session.replaceTail([bar(120_000, close)]);
      const fresh = await runFresh([...prefix, bar(120_000, close)]);
      expect(replacement.returned).toEqual(fresh.returned);
      expect(replacement.returned.middle).toEqual([1, 2, close]);
      expect(replacement.returned.front).toEqual([11, 21, 31]);
    }

    await session.restore(checkpoint);
    const restored = await session.appendBars([bar(120_000, 4)]);
    const expected = await runFresh([...prefix, bar(120_000, 4)]);
    expect(restored.returned).toEqual(expected.returned);
  } finally {
    await session.close();
  }
});
