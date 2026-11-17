import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bar = (index: number): MarketBar => ({ openTime: index * 60_000, closeTime: (index + 1) * 60_000, open: index + 1, high: index + 1, low: index + 1, close: index + 1, volume: 1 });
const bars = [bar(0), bar(1), bar(2)];
const program = (body = "var float total = 0\ntotal += close") => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Admission")\n${body}` });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
};
const portable = (checkpoint: SessionCheckpoint): SessionCheckpoint => JSON.parse(JSON.stringify(checkpoint)) as SessionCheckpoint;

describe("session admission", () => {
  it.each(["replace", "paginate"] as const)("keeps the previous dataset when %s rejects unordered bars", async (operation) => {
    const session = new PineEngine().createSession(program());
    try {
      await session.runBatch(bars.slice(0, 2));
      const before = session.checkpoint();
      const invalid = [bar(1), bar(0)];
      const run = async () => {
        if (operation === "replace") await session.replaceTail(invalid);
        else for await (const page of session.runPaginated(invalid, 1)) { void page; }
      };
      await expect(run()).rejects.toThrow("strictly ordered");
      expect(session.checkpoint()).toEqual(before);
      expect((await session.appendBars([bar(2)])).returned.total).toEqual([1, 3, 6]);
    } finally { await session.close(); }
  });

  it.each(["identity", "encoding", "containers", "tail"] as const)("keeps the previous dataset and inputs when checkpoint %s is invalid", async (invalidity) => {
    const session = new PineEngine().createSession(program());
    try {
      await session.runBatch([bar(0)]);
      const previous = portable(session.checkpoint());
      await session.appendBars([bar(1)]);
      const before = session.checkpoint();
      let checkpoint: SessionCheckpoint = { ...previous, inputs: { bogus: 99 } };
      if (invalidity === "identity") checkpoint = { ...checkpoint, programFingerprint: "wrong" };
      if (invalidity === "encoding") checkpoint = { ...checkpoint, runtimeState: "{" };
      if (invalidity === "containers") checkpoint = { ...checkpoint, runtimeState: JSON.stringify({ root: { reference: 0 }, nodes: [{ kind: "object", entries: [] }] }) };
      if (invalidity === "tail") checkpoint = { ...checkpoint, tailState: { nextIndex: 999, runtimeState: previous.runtimeState! } };
      await expect(session.restore(checkpoint)).rejects.toThrow();
      expect(session.checkpoint()).toEqual(before);
      expect((await session.appendBars([bar(2)])).returned.total).toEqual([1, 3, 6]);
    } finally { await session.close(); }
  });

  it("checks producer identity even before the first evaluation", async () => {
    const engine = new PineEngine();
    const session = engine.createSession(program());
    const other = engine.createSession(program("value = open"));
    try {
      await expect(session.restore(other.checkpoint())).rejects.toThrow("does not belong");
      expect((await session.restore({ bars, inputs: {} })).returned.total).toEqual([1, 3, 6]);
    } finally { await session.close(); await other.close(); }
  });

  it.each([false, true])("rebuilds child requests when restoring older inputs (portable=%s)", async (json) => {
    const session = new PineEngine().createSession(program('factor = input.float(2.0, "Factor")\nvalue = request.security("", "", close * factor)'), { timeframe: "1" });
    try {
      expect((await session.runBatch(bars)).returned.value).toEqual([2, 4, 6]);
      const checkpoint = session.checkpoint();
      await session.updateInputs({ Factor: 10 });
      expect((await session.runBatch(bars)).returned.value).toEqual([10, 20, 30]);
      await session.restore(json ? portable(checkpoint) : checkpoint);
      expect((await session.appendBars([])).returned.value).toEqual([2, 4, 6]);
    } finally { await session.close(); }
  });
});

it("distinguishes programs whose root executor is identical but child expressions differ", async () => {
  const first = program('value = request.security("", "", close)');
  const second = program('value = request.security("", "", open)');
  expect(first.generatedSource).toBe(second.generatedSource);
  const engine = new PineEngine();
  const producer = engine.createSession(first, { timeframe: "1" });
  const consumer = engine.createSession(second, { timeframe: "1" });
  try {
    await producer.runBatch(bars);
    await expect(consumer.restore(portable(producer.checkpoint()))).rejects.toThrow("does not belong");
  } finally { await producer.close(); await consumer.close(); }
});

it("owns admitted rows even if the caller mutates them during evaluation", async () => {
  const session = new PineEngine().createSession(program());
  const incoming = { ...bar(0) };
  try {
    const run = session.runBatch([incoming]);
    incoming.close = 99;
    incoming.openTime = 99;
    expect((await run).returned.total).toEqual([1]);
    expect(session.checkpoint().bars[0]).toEqual(bar(0));
    expect((await session.appendBars([bar(1)])).returned.total).toEqual([1, 3]);
  } finally { await session.close(); }
});

it.each([NaN, Infinity, -Infinity])("rejects non-finite market times %s before admission", async (time) => {
  const session = new PineEngine().createSession(program());
  try {
    await session.runBatch([bar(0)]);
    const before = session.checkpoint();
    await expect(session.replaceTail([{ ...bar(1), openTime: time }])).rejects.toThrow("finite");
    await expect(session.runBatch([{ ...bar(0), closeTime: time }])).rejects.toThrow("finite");
    expect(session.checkpoint()).toEqual(before);
  } finally { await session.close(); }
});

it("does not capture new inputs together with runtime state evaluated under old inputs", async () => {
  const session = new PineEngine().createSession(program());
  try {
    await session.runBatch(bars);
    await session.updateInputs({ factor: 2 });
    expect(() => session.checkpoint()).toThrow("pending input");
    await session.appendBars([]);
    expect(session.checkpoint().inputs).toEqual({ factor: 2 });
  } finally { await session.close(); }
});

it.each(["position", "variables", "tail"] as const)("rejects inconsistent checkpoint %s before changing the session", async (field) => {
  const { deserializeRuntimeSnapshot, serializeRuntimeSnapshot } = await import("../runtime/index.js");
  const session = new PineEngine().createSession(program());
  try {
    await session.runBatch([bar(0)]);
    const before = session.checkpoint();
    const state = deserializeRuntimeSnapshot(before.runtimeState!);
    let checkpoint: SessionCheckpoint;
    if (field === "position") checkpoint = { ...before, runtimeState: serializeRuntimeSnapshot({ ...state, barIndex: 10 }) };
    else if (field === "variables") checkpoint = { ...before, runtimeState: serializeRuntimeSnapshot({ ...state, variables: [] }) };
    else checkpoint = { ...before, tailState: { nextIndex: 0, runtimeState: before.runtimeState! } };
    await expect(session.restore(checkpoint)).rejects.toThrow("program or dataset position");
    expect(session.checkpoint()).toEqual(before);
  } finally { await session.close(); }
});

it("includes host-overridden descriptors in checkpoint producer identity", async () => {
  const compiled = program();
  const engine = new PineEngine();
  const producer = engine.createSession(compiled);
  const consumer = engine.createSession({ ...compiled, descriptor: { ...compiled.descriptor, title: "Changed" } });
  try {
    await producer.runBatch(bars);
    await expect(consumer.restore(producer.checkpoint())).rejects.toThrow("does not belong");
  } finally { await producer.close(); await consumer.close(); }
});
