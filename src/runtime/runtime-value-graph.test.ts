import { describe, expect, it, vi } from "vitest";
import {
  cloneRuntimeGraph,
  deserializeRuntimeGraph,
  serializeRuntimeGraph,
} from "./runtime-value-graph.js";
import { arrayCall } from "./collections.js";

describe("runtime snapshot transport", () => {
  it("clones aliases, cycles, map keys and slice-only parents before transport", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], { strict: true });
    const graph = { slice, alias: slice, map: new Map([[slice, parent]]), set: new Set([slice]), zero: -0, nan: Number.NaN };
    const cycle: unknown[] = [graph];
    cycle.push(cycle);
    const cloned = cloneRuntimeGraph({ graph, cycle });
    expect(cloned.graph.slice).toBe(cloned.graph.alias);
    expect(cloned.cycle[0]).toBe(cloned.graph);
    expect(cloned.cycle[1]).toBe(cloned.cycle);
    expect(cloned.graph.set.has(cloned.graph.slice)).toBe(true);
    expect(Object.is(cloned.graph.zero, -0)).toBe(true);
    expect(Number.isNaN(cloned.graph.nan)).toBe(true);
    arrayCall("push", [cloned.graph.slice, 9], { strict: true });
    expect(cloned.graph.map.get(cloned.graph.slice)).toEqual([1, 2, 3, 9]);
    expect(parent).toEqual([1, 2, 3]);
    const hiddenParent = cloneRuntimeGraph({ slice });
    arrayCall("set", [hiddenParent.slice, 0, 8], { strict: true });
    expect(arrayCall("get", [hiddenParent.slice, 0], { strict: true })).toBe(8);
  });
  it("preserves parent-linked array slices across checkpoint serialization", () => {
    const parent = [1, 2, 3];
    const slice = arrayCall("slice", [parent, 1, 3], { strict: true, negativeIndices: true });
    const serialized = serializeRuntimeGraph({ parent, slice });
    const restored = deserializeRuntimeGraph(serialized) as { parent: number[]; slice: number[] };
    arrayCall("set", [restored.slice, 0, 9], { strict: true, negativeIndices: true });
    expect(restored.parent).toEqual([1, 9, 3]);
  });

  it("preserves own __proto__ data without mutating object prototypes", () => {
    const nested = Object.create(null) as Record<string, unknown>;
    nested.__proto__ = { polluted: true };
    const serialized = serializeRuntimeGraph({ nested });
    const restored = deserializeRuntimeGraph(serialized) as { nested: Record<string, unknown> };

    expect(Object.getPrototypeOf(restored.nested)).toBeNull();
    expect(restored.nested.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects malformed node entries and scalar envelopes", () => {
    expect(() => deserializeRuntimeGraph(JSON.stringify({
      nodes: [{ kind: "object", entries: [["value"]] }],
      root: { reference: 0 },
    }))).toThrow("object entry");
    expect(() => deserializeRuntimeGraph(JSON.stringify({
      nodes: [],
      root: { reference: 0, special: "nan" },
    }))).toThrow("scalar");
  });
});

it("preserves signed zero through portable transport alongside other special scalars", () => {
  const data = { values: [-0, 0, Number.NaN, Infinity, -Infinity, undefined] };
  const restored = deserializeRuntimeGraph(serializeRuntimeGraph(data)) as typeof data;
  expect(restored.values).toEqual(data.values);
  expect(1 / restored.values[0]!).toBe(-Infinity);
});

it.each([true, false])("rejects slice-parent cycles before linking decoded views (self=%s)", (self) => {
  const nodes = [
    { kind: "object", entries: [["view", { reference: 1 }]] },
    { kind: "array-slice", values: [], parent: { reference: self ? 1 : 2 }, start: 0, length: 0 },
    { kind: "array-slice", values: [], parent: { reference: 1 }, start: 0, length: 0 },
  ];
  expect(() => deserializeRuntimeGraph(JSON.stringify({ root: { reference: 0 }, nodes }))).toThrow("slice parent cycle");
});

it("round-trips ordinary cycles and shared slice parents across maps and sets", () => {
  const parent: unknown[] = [1, 2];
  const slice = arrayCall("slice", [parent as number[], 0, 2], { strict: true });
  parent.push(slice);
  const source = { parent, slice, alias: slice, map: new Map([[slice, parent]]), set: new Set([slice]) };
  const restored = deserializeRuntimeGraph(serializeRuntimeGraph(source)) as typeof source;
  expect(restored.parent[2]).toBe(restored.slice);
  expect(restored.slice).toBe(restored.alias);
  expect(restored.map.get(restored.slice)).toBe(restored.parent);
  expect(restored.set.has(restored.slice)).toBe(true);
  arrayCall("set", [restored.slice, 0, 9], { strict: true });
  expect(restored.parent[0]).toBe(9);
  expect(parent[0]).toBe(1);
});

it("clones and transports deep graphs and wide arrays without stack-sized argument lists", () => {
  let nested: unknown = -0;
  for (let i = 0; i < 20_000; i++) nested = { next: nested };
  const wide = Array.from({ length: 150_000 }, (_, index) => index);
  const restored = deserializeRuntimeGraph(serializeRuntimeGraph(cloneRuntimeGraph({ nested, wide }))) as { nested: unknown; wide: number[] };
  let node = restored.nested;
  for (let i = 0; i < 20_000; i++) node = (node as { next: unknown }).next;
  expect(Object.is(node, -0)).toBe(true);
  expect(restored.wide.length).toBe(150_000);
  expect(restored.wide.at(-1)).toBe(149_999);
});

it("enforces exact UTF-8, node and entry budgets before graph hydration", () => {
  const graph = { data: ["日本", "😀"] };
  const serialized = serializeRuntimeGraph(graph);
  const bytes = new TextEncoder().encode(serialized).length;
  const limits = { maxBytes: bytes, maxNodes: 2, maxEntries: 3 };
  expect(deserializeRuntimeGraph(serialized, limits)).toEqual(graph);
  expect(serializeRuntimeGraph(graph, limits)).toBe(serialized);
  for (const [key, value] of Object.entries(limits)) {
    const insufficient = { ...limits, [key]: value - 1 };
    expect(() => deserializeRuntimeGraph(serialized, insufficient)).toThrow("budget exceeded");
    expect(() => serializeRuntimeGraph(graph, insufficient)).toThrow("budget exceeded");
  }
  expect(() => deserializeRuntimeGraph("{".repeat(10), { maxBytes: 5 })).toThrow("byte budget");
  expect(() => deserializeRuntimeGraph(serialized, { maxNodes: NaN })).toThrow("positive safe integer");
});

it("counts the hydrated collection even when a node contains an unrelated values field", () => {
  const graph = JSON.parse(serializeRuntimeGraph({ first: 1, second: 2 })) as { nodes: Array<{ values?: unknown[] }> };
  graph.nodes[0]!.values = [];
  expect(() => deserializeRuntimeGraph(JSON.stringify(graph), { maxEntries: 1 })).toThrow("entry budget");
});


it("rejects oversized scalar state before allocating the serialized JSON body", () => {
  const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw new Error("serialization was reached"); });
  try {
    expect(() => serializeRuntimeGraph({ text: "x".repeat(1024 * 1024) }, { maxBytes: 100 })).toThrow("byte budget");
  } finally { stringify.mockRestore(); }
});

it.each(['"\\\n\t\u0000\u001f', "日本😀", "\ud800", "\udfff", "\ud800\udfff"])("counts escaped JSON string bytes exactly: %s", (text) => {
  const graph = { [text]: text };
  const serialized = serializeRuntimeGraph(graph);
  const maxBytes = new TextEncoder().encode(serialized).length;
  expect(serializeRuntimeGraph(graph, { maxBytes })).toBe(serialized);
  expect(() => serializeRuntimeGraph(graph, { maxBytes: maxBytes - 1 })).toThrow("byte budget");
});
