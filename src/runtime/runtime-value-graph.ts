import { checkpointBudget, assertCheckpointBytes, assertCheckpointJsonBytes } from "./checkpoint-budget.js";
import type { PineValue, PineCheckpointLimits } from "../contracts/index.js";
import { pineArraySliceInfo, restorePineArraySlice } from "./array-views.js";

/**
 * Clone the runtime-owned value graph, including non-enumerable array-view
 * links. structuredClone drops those links before portable encoding can see
 * them. One reference map covers values, Map keys, and hidden slice parents.
 */
export function cloneRuntimeGraph<T>(value: T): T {
  const references = new Map<object, unknown>();
  const pending: object[] = [];
  const allocate = (source: unknown): unknown => {
    if (source === null || typeof source !== "object") return source;
    if (references.has(source)) return references.get(source);
    let target: unknown;
    if (Array.isArray(source)) target = [];
    else if (source instanceof Map) target = new Map<unknown, unknown>();
    else if (source instanceof Set) target = new Set<unknown>();
    else target = Object.create(null) as Record<string, unknown>;
    references.set(source, target);
    pending.push(source);
    return target;
  };
  const root = allocate(value);
  for (let index = 0; index < pending.length; index += 1) {
    const source = pending[index]!;
    const target = references.get(source);
    if (Array.isArray(source)) {
      for (const entry of source) (target as unknown[]).push(allocate(entry));
      const slice = pineArraySliceInfo(source);
      if (slice) restorePineArraySlice(target as PineValue[], allocate(slice.parent) as PineValue[], slice.start, slice.length);
    } else if (source instanceof Map) {
      for (const [key, entry] of source) (target as Map<unknown, unknown>).set(allocate(key), allocate(entry));
    } else if (source instanceof Set) {
      for (const entry of source) (target as Set<unknown>).add(allocate(entry));
    } else {
      for (const [key, entry] of Object.entries(source)) (target as Record<string, unknown>)[key] = allocate(entry);
    }
  }
  return root as T;
}

interface EncodedRuntimeGraph {
  readonly root: EncodedRuntimeValue;
  readonly nodes: readonly EncodedRuntimeNode[];
}

type EncodedRuntimeValue = null | boolean | string | number | { readonly special: "undefined" | "nan" | "positive-infinity" | "negative-infinity" | "negative-zero" } | { readonly reference: number };
type EncodedRuntimeNode =
  | { readonly kind: "array"; readonly values: readonly EncodedRuntimeValue[] }
  | { readonly kind: "array-slice"; readonly values: readonly EncodedRuntimeValue[]; readonly parent: EncodedRuntimeValue; readonly start: number; readonly length: number }
  | { readonly kind: "map"; readonly entries: readonly (readonly [EncodedRuntimeValue, EncodedRuntimeValue])[] }
  | { readonly kind: "set"; readonly values: readonly EncodedRuntimeValue[] }
  | { readonly kind: "object"; readonly entries: readonly (readonly [string, EncodedRuntimeValue])[] };

/** Serializes a runtime snapshot without losing Maps, Sets, non-finite numbers, aliases, or cycles. */
export function serializeRuntimeGraph(snapshot: unknown, limits?: PineCheckpointLimits): string {
  const budget = checkpointBudget(limits);
  let entries = 0;
  const references = new Map<object, number>();
  const nodes: EncodedRuntimeNode[] = [];
  const pending: object[] = [];
  const encode = (value: unknown): EncodedRuntimeValue => {
    if (value === undefined) return { special: "undefined" };
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (Object.is(value, -0)) return { special: "negative-zero" };
      if (Number.isNaN(value)) return { special: "nan" };
      if (value === Number.POSITIVE_INFINITY) return { special: "positive-infinity" };
      if (value === Number.NEGATIVE_INFINITY) return { special: "negative-infinity" };
      return value;
    }
    if (typeof value !== "object") throw new TypeError(`Unsupported runtime checkpoint value: ${typeof value}`);
    const existing = references.get(value);
    if (existing !== undefined) return { reference: existing };
    if (nodes.length >= budget.maxNodes) throw new RangeError("Script checkpoint node budget exceeded");
    const reference = nodes.length;
    references.set(value, reference);
    nodes.push({ kind: "object", entries: [] });
    pending.push(value);
    return { reference };
  };
  const root = encode(snapshot);
  for (let reference = 0; reference < pending.length; reference += 1) {
    const value = pending[reference]!;
    const count = Array.isArray(value) ? value.length : value instanceof Map || value instanceof Set ? value.size : Object.keys(value).length;
    entries += count;
    if (entries > budget.maxEntries) throw new RangeError("Script checkpoint entry budget exceeded");
    if (Array.isArray(value)) {
      const slice = pineArraySliceInfo(value);
      nodes[reference] = slice
        ? { kind: "array-slice", values: Array.from(value, encode), parent: encode(slice.parent), start: slice.start, length: slice.length }
        : { kind: "array", values: Array.from(value, encode) };
    }
    else if (value instanceof Map) nodes[reference] = { kind: "map", entries: [...value].map(([key, entry]) => [encode(key), encode(entry)] as const) };
    else if (value instanceof Set) nodes[reference] = { kind: "set", values: [...value].map(encode) };
    else nodes[reference] = { kind: "object", entries: Object.entries(value).map(([key, entry]) => [key, encode(entry)] as const) };
  }
  const graph: EncodedRuntimeGraph = { root, nodes };
  assertCheckpointJsonBytes(graph, budget.maxBytes);
  const serialized = JSON.stringify(graph);
  assertCheckpointBytes(serialized, budget.maxBytes);
  return serialized;
}

/** Restores a snapshot produced by serializeRuntimeGraph. */
export function deserializeRuntimeGraph(serialized: string, limits?: PineCheckpointLimits): unknown {
  const budget = checkpointBudget(limits);
  assertCheckpointBytes(serialized, budget.maxBytes);
  const decoded = JSON.parse(serialized) as unknown;
  const graphRecord = checkpointRecord(decoded, "graph");
  if (!Array.isArray(graphRecord.nodes) || !("root" in graphRecord)) throw new TypeError("Invalid runtime checkpoint graph");
  if (graphRecord.nodes.length > budget.maxNodes) throw new RangeError("Script checkpoint node budget exceeded");
  let entries = 0;
  for (const value of graphRecord.nodes) {
    const node = checkpointRecord(value, "node");
    const items = node.kind === "map" || node.kind === "object" ? node.entries : node.values;
    if (Array.isArray(items)) entries += items.length;
    if (entries > budget.maxEntries) throw new RangeError("Script checkpoint entry budget exceeded");
  }
  const nodes = graphRecord.nodes.map((value, index): EncodedRuntimeNode => {
    const node = checkpointRecord(value, `nodes.${String(index)}`);
    if (node.kind === "array" || node.kind === "set" || node.kind === "array-slice") {
      if (!Array.isArray(node.values)) throw new TypeError(`Invalid runtime checkpoint ${node.kind} node`);
      if (node.kind === "array-slice") {
        if (typeof node.start !== "number" || typeof node.length !== "number" || !Number.isInteger(node.start) || !Number.isInteger(node.length) || node.start < 0 || node.length < 0) throw new TypeError("Invalid runtime checkpoint slice bounds");
        return { kind: "array-slice", values: node.values.map((item) => checkpointValue(item)), parent: checkpointValue(node.parent), start: node.start, length: node.length };
      }
      return { kind: node.kind, values: node.values.map((item) => checkpointValue(item)) };
    }
    if (node.kind === "map") {
      if (!Array.isArray(node.entries)) throw new TypeError("Invalid runtime checkpoint map node");
      return {
        kind: "map",
        entries: node.entries.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError("Invalid runtime checkpoint map entry");
          return [checkpointValue(entry[0]), checkpointValue(entry[1])] as const;
        }),
      };
    }
    if (node.kind === "object") {
      if (!Array.isArray(node.entries)) throw new TypeError("Invalid runtime checkpoint object node");
      return {
        kind: "object",
        entries: node.entries.map((entry) => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") throw new TypeError("Invalid runtime checkpoint object entry");
          return [entry[0], checkpointValue(entry[1])] as const;
        }),
      };
    }
    throw new TypeError("Invalid runtime checkpoint node");
  });
  validateSliceParents(nodes);
  const root = checkpointValue(graphRecord.root);
  const values: unknown[] = nodes.map((node) => {
    if (node.kind === "array" || node.kind === "array-slice") return [];
    if (node.kind === "map") return new Map();
    if (node.kind === "set") return new Set();
    if (node.kind === "object") return Object.create(null) as Record<string, unknown>;
    throw new TypeError("Invalid runtime checkpoint node");
  });
  const decode = (value: EncodedRuntimeValue): unknown => {
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
    if ("reference" in value) {
      if (!Number.isInteger(value.reference) || value.reference < 0 || value.reference >= values.length) throw new TypeError("Invalid runtime checkpoint reference");
      return values[value.reference];
    }
    if (value.special === "negative-zero") return -0;
    if (value.special === "undefined") return undefined;
    if (value.special === "nan") return Number.NaN;
    if (value.special === "positive-infinity") return Number.POSITIVE_INFINITY;
    if (value.special === "negative-infinity") return Number.NEGATIVE_INFINITY;
    throw new TypeError("Invalid runtime checkpoint scalar");
  };
  nodes.forEach((node, index) => {
    const target = values[index];
    if (node.kind === "array" || node.kind === "array-slice") {
      for (const value of node.values) (target as unknown[]).push(decode(value));
    }
    else if (node.kind === "map") for (const [key, value] of node.entries) (target as Map<unknown, unknown>).set(decode(key), decode(value));
    else if (node.kind === "set") for (const value of node.values) (target as Set<unknown>).add(decode(value));
    else for (const [key, value] of node.entries) (target as Record<string, unknown>)[key] = decode(value);
  });
  nodes.forEach((node, index) => {
    if (node.kind !== "array-slice") return;
    const parent = decode(node.parent);
    if (!Array.isArray(parent)) throw new TypeError("Invalid runtime checkpoint slice parent");
    restorePineArraySlice(values[index] as PineValue[], parent as PineValue[], node.start, node.length);
  });
  return decode(root);
}

function checkpointRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid runtime checkpoint ${path}`);
  }
  return value as Record<string, unknown>;
}

function checkpointValue(value: unknown): EncodedRuntimeValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return value;
  const record = checkpointRecord(value, "scalar");
  if (Object.keys(record).length !== 1) throw new TypeError("Invalid runtime checkpoint scalar");
  if ("reference" in record) {
    if (!Number.isInteger(record.reference)) throw new TypeError("Invalid runtime checkpoint reference");
    return { reference: record.reference as number };
  }
  if (record.special === "undefined" || record.special === "nan" || record.special === "positive-infinity" || record.special === "negative-infinity" || record.special === "negative-zero") {
    return { special: record.special };
  }
  throw new TypeError("Invalid runtime checkpoint scalar");
}

/** Slice ancestry must be acyclic even though ordinary value references may cycle. */
function validateSliceParents(nodes: readonly EncodedRuntimeNode[]): void {
  const parents = new Map<number, number>();
  nodes.forEach((node, index) => {
    if (node.kind !== "array-slice") return;
    const parent = node.parent;
    if (parent === null || typeof parent !== "object" || !("reference" in parent)) throw new TypeError("Invalid runtime checkpoint slice parent");
    const target = nodes[parent.reference];
    if (target?.kind !== "array" && target?.kind !== "array-slice") throw new TypeError("Invalid runtime checkpoint slice parent");
    parents.set(index, parent.reference);
  });
  // Each node is visited at most twice, including shared parents and long chains.
  const complete = new Set<number>();
  for (const start of parents.keys()) {
    const path = new Set<number>();
    let current: number | undefined = start;
    while (current !== undefined && !complete.has(current)) {
      if (path.has(current)) throw new TypeError("Invalid runtime checkpoint slice parent cycle");
      path.add(current);
      current = parents.get(current);
    }
    for (const index of path) complete.add(index);
  }
}
