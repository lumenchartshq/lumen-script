import { validateSnapshotDomains } from "./snapshot-domain-validation.js";
import { isPineMatrix, validateStrictMatrix } from "./collections.js";
import { isPineFootprintHandle, isPineVolumeRowHandle } from "./footprint.js";
import type { AlertEvent, PineValue, PlotPoint, PineCheckpointLimits } from "../contracts/index.js";
import { deserializeRuntimeGraph, serializeRuntimeGraph } from "./runtime-value-graph.js";
export { cloneRuntimeGraph } from "./runtime-value-graph.js";
import type {
  MutablePineBox,
  MutablePineLabel,
  MutablePineLine,
  MutablePineLinefill,
  MutablePinePolyline,
  MutablePineTable,
} from "./drawings.js";
import type { MutableStrategyState } from "./strategy.js";
import type { StateId } from "./technical-analysis.js";

export interface RuntimeLocalState {
  readonly values: RuntimeHistoryWindow;
  readonly persistence: "bar" | "var" | "varip";
  initialized: boolean;
  persistentValue: PineValue;
}

export interface RuntimeHistoryWindow {
  origin: number;
  last: number;
  readonly indices: number[];
  readonly values: PineValue[];
  /** Bar of the last write, for windows whose slots count executions. */
  lastExecutionBar?: number;
}

export const HISTORY_WINDOW_CAPACITY = 5001;

export function createHistoryWindow(): RuntimeHistoryWindow {
  return { origin: 0, last: -1, indices: [], values: [] };
}

export function readHistoryWindow(window: RuntimeHistoryWindow, index: number): PineValue | undefined {
  if (index < window.origin || index > window.last) return undefined;
  const slot = index % HISTORY_WINDOW_CAPACITY;
  return window.indices[slot] === index ? window.values[slot] : undefined;
}

export function writeHistoryWindow(window: RuntimeHistoryWindow, index: number, value: PineValue): void {
  if (index < 0) return;
  const slot = index % HISTORY_WINDOW_CAPACITY;
  window.indices[slot] = index;
  window.values[slot] = value;
  window.last = Math.max(window.last, index);
  window.origin = Math.max(0, window.last - HISTORY_WINDOW_CAPACITY + 1);
}

/** Replace `target` in place with the contents of `source`. */
export function assignHistoryWindow(target: RuntimeHistoryWindow, source: RuntimeHistoryWindow): void {
  target.origin = source.origin;
  target.last = source.last;
  replaceArray(target.indices, source.indices);
  replaceArray(target.values, source.values);
  if (source.lastExecutionBar === undefined) delete target.lastExecutionBar;
  else target.lastExecutionBar = source.lastExecutionBar;
}

/**
 * Local history commits one sample per bar that executes this code. Multiple
 * writes on the same bar replace that sample; skipped bars consume no slots.
 */
export function writeHistoryWindowExecution(window: RuntimeHistoryWindow, barIndex: number, value: PineValue): number {
  const index = window.lastExecutionBar === barIndex ? window.last : window.last + 1;
  writeHistoryWindow(window, index, value);
  window.lastExecutionBar = barIndex;
  return index;
}

/** Converts the retained slots of an admitted older execution window. */
export function migrateExecutionHistory(window: RuntimeHistoryWindow): void {
  if (window.lastExecutionBar !== undefined || window.last < 0) return;
  const migrated = createHistoryWindow();
  for (let bar = window.origin; bar <= window.last; bar += 1) {
    const value = readHistoryWindow(window, bar);
    if (value !== undefined) writeHistoryWindowExecution(migrated, bar, value);
  }
  assignHistoryWindow(window, migrated);
}

/** One upcoming bar can overwrite at most one slot in each identity. */
export function captureHistoryWindow(window: RuntimeHistoryWindow, nextIndex: number): () => void {
  const { origin, last, lastExecutionBar } = window;
  const index = lastExecutionBar === undefined ? nextIndex : last + Number(lastExecutionBar !== nextIndex);
  const slot = index % HISTORY_WINDOW_CAPACITY;
  const indicesLength = window.indices.length;
  const valuesLength = window.values.length;
  const oldIndex = window.indices[slot];
  const oldValue = window.values[slot];
  return () => {
    window.origin = origin;
    window.last = last;
    if (lastExecutionBar === undefined) delete window.lastExecutionBar;
    else window.lastExecutionBar = lastExecutionBar;
    window.indices.length = indicesLength;
    window.values.length = valuesLength;
    if (slot < indicesLength) window.indices[slot] = oldIndex!;
    if (slot < valuesLength) window.values[slot] = oldValue!;
  };
}

export function captureHistoryWindowMap<Key extends StateId>(map: Map<Key, RuntimeHistoryWindow>, nextIndex: number): () => void {
  const entries = [...map.entries()].map(([key, window]) => ({ key, window, restore: captureHistoryWindow(window, nextIndex) }));
  return () => {
    map.clear();
    for (const { key, window, restore } of entries) {
      restore();
      map.set(key, window);
    }
  };
}

export interface RuntimePlotBuffer {
  readonly id: string;
  readonly title: string;
  readonly points: PlotPoint[];
  options: Readonly<Record<string, PineValue>>;
}

export interface RuntimeSnapshot {
  readonly fxContextIdentity?: string;
  readonly fxSelectionIdentity?: string;
  /** Footprint handle binding (provider revision + calculation arguments), not dataset content. */
  readonly footprintStoreKey?: string;
  readonly barIndex: number;
  readonly variables: PineValue[][];
  readonly variableHistory: RuntimeHistoryWindow[];
  readonly globalPersistence: readonly ("var" | "varip" | undefined)[];
  readonly plots: Map<string, RuntimePlotBuffer>;
  readonly callState: Map<StateId, unknown>;
  readonly lastSourceCallBar: Map<StateId, number>;
  readonly argumentSeries: Map<string, RuntimeHistoryWindow>;
  readonly localState: Map<string, RuntimeLocalState>;
  readonly historySeries: Map<StateId, RuntimeHistoryWindow>;
  readonly historyDepthBySource: Map<string, number>;
  readonly alerts: AlertEvent[];
  readonly firedAlerts: Set<string>;
  readonly lines: MutablePineLine[];
  readonly nextVisualOrder: number;
  readonly nextLineId: number;
  readonly boxes: MutablePineBox[];
  readonly nextBoxId: number;
  readonly labels: MutablePineLabel[];
  readonly nextLabelId: number;
  readonly polylines: MutablePinePolyline[];
  readonly nextPolylineId: number;
  readonly linefills: MutablePineLinefill[];
  readonly nextLinefillId: number;
  readonly tables: MutablePineTable[];
  readonly nextTableId: number;
  readonly requestSeries: Readonly<Record<string, readonly PineValue[]>>;
  readonly strategy: MutableStrategyState | undefined;
  readonly operations: number;
  readonly randomState: number;
}

export type RuntimeTailSnapshot =
  | { readonly kind: "full"; readonly snapshot: RuntimeSnapshot }
  | { readonly kind: "rollback"; readonly restore: () => void };

/** The enclosing session checkpoint supplies the codec's executor identity. */
export function serializeRuntimeSnapshot(snapshot: RuntimeSnapshot, limits?: PineCheckpointLimits): string {
  return serializeRuntimeGraph(snapshot, limits);
}

/** Validate restore containers before the live runtime starts replacing state. */
export function deserializeRuntimeSnapshot(serialized: string, limits?: PineCheckpointLimits, strictMatrices = true): RuntimeSnapshot {
  const value = deserializeRuntimeGraph(serialized, limits);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid runtime checkpoint root");
  const state = value as Record<keyof RuntimeSnapshot, unknown>;
  const invalid = (field: keyof RuntimeSnapshot): never => { throw new TypeError(`Invalid runtime checkpoint field ${field}`); };
  if (state.fxContextIdentity !== undefined && (typeof state.fxContextIdentity !== "string" || state.fxContextIdentity.length > 1_100_000)) invalid("fxContextIdentity");
  if (state.fxSelectionIdentity !== undefined && (typeof state.fxSelectionIdentity !== "string" || state.fxSelectionIdentity.length > 512)) invalid("fxSelectionIdentity");
  if (state.footprintStoreKey !== undefined && (typeof state.footprintStoreKey !== "string" || state.footprintStoreKey.length > 512)) invalid("footprintStoreKey");
  for (const field of ["variables", "variableHistory", "globalPersistence", "alerts", "lines", "boxes", "labels", "polylines", "linefills", "tables"] as const) {
    if (!Array.isArray(state[field])) invalid(field);
  }
  if (!(state.variables as unknown[]).every(Array.isArray)) invalid("variables");
  if (!(state.variableHistory as unknown[]).every(historyWindow)) invalid("variableHistory");
  for (const field of ["plots", "callState", "lastSourceCallBar", "argumentSeries", "localState", "historySeries", "historyDepthBySource"] as const) {
    if (!(state[field] instanceof Map)) invalid(field);
  }
  if (!(state.firedAlerts instanceof Set)) invalid("firedAlerts");
  for (const field of ["barIndex", "nextVisualOrder", "nextLineId", "nextBoxId", "nextLabelId", "nextPolylineId", "nextLinefillId", "nextTableId", "operations", "randomState"] as const) {
    if (!Number.isSafeInteger(state[field])) invalid(field);
  }
  if (state.requestSeries === null || typeof state.requestSeries !== "object" || Array.isArray(state.requestSeries)) invalid("requestSeries");
  if (state.strategy !== undefined && (state.strategy === null || typeof state.strategy !== "object" || Array.isArray(state.strategy))) invalid("strategy");
  if (!(state.globalPersistence as unknown[]).every((entry) => entry === undefined || entry === "var" || entry === "varip")) invalid("globalPersistence");
  for (const field of ["argumentSeries", "historySeries"] as const) {
    for (const [key, series] of state[field] as Map<unknown, unknown>) {
      if (!stateId(key) || !historyWindow(series)) invalid(field);
    }
  }
  for (const [key, local] of state.localState as Map<unknown, unknown>) {
    if (typeof key !== "string" || !snapshotRecord(local) || !historyWindow(local.values)
      || typeof local.initialized !== "boolean" || !["bar", "var", "varip"].includes(String(local.persistence))) invalid("localState");
  }
  for (const [key, depth] of state.historyDepthBySource as Map<unknown, unknown>) {
    if (typeof key !== "string" || !Number.isInteger(depth) || (depth as number) < 0 || (depth as number) > 10000) invalid("historyDepthBySource");
  }
  for (const [key, plot] of state.plots as Map<unknown, unknown>) {
    if (typeof key !== "string" || !snapshotRecord(plot) || plot.id !== key || typeof plot.title !== "string"
      || !snapshotRecord(plot.options) || !Array.isArray(plot.points)) invalid("plots");
    // Sparse plot histories represent bars without an emitted point.
    for (const point of (plot as RuntimePlotBuffer).points) {
      if (point === undefined) continue;
      if (!snapshotRecord(point) || typeof point.time !== "number" || !Object.hasOwn(point, "value")
        || (point.options !== undefined && !snapshotRecord(point.options))) invalid("plots");
    }
  }
  for (const [key, index] of state.lastSourceCallBar as Map<unknown, unknown>) {
    if (!stateId(key) || !Number.isSafeInteger(index)) invalid("lastSourceCallBar");
  }
  if (![...(state.firedAlerts as Set<unknown>)].every((key) => typeof key === "string")) invalid("firedAlerts");
  if (!snapshotRecord(state.requestSeries) || !Object.values(state.requestSeries).every(Array.isArray)) invalid("requestSeries");
  validateSnapshotDomains(state, strictMatrices);
  if (strictMatrices) validateNestedMatrices(state);
  return state as unknown as RuntimeSnapshot;
}

function validateNestedMatrices(root: object): void {
  const visited = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (visited.size > 500_000) throw new TypeError("Runtime checkpoint graph exceeds matrix validation limit");
    if ((value as { __pineMatrix?: unknown }).__pineMatrix === true) {
      const matrix = value as PineValue;
      if (!isPineMatrix(matrix)) throw new TypeError("Invalid runtime checkpoint matrix");
      try { validateStrictMatrix(matrix, "matrix.restore"); }
      catch { throw new TypeError("Invalid runtime checkpoint matrix"); }
    }
    if (Object.hasOwn(value, "__pineFootprint") && !isPineFootprintHandle(value)) throw new TypeError("Invalid runtime checkpoint footprint handle");
    if (Object.hasOwn(value, "__pineVolumeRow") && !isPineVolumeRowHandle(value)) throw new TypeError("Invalid runtime checkpoint volume-row handle");
    if (Array.isArray(value)) for (const entry of value) pending.push(entry);
    else if (value instanceof Map) for (const [key, entry] of value) pending.push(key, entry);
    else if (value instanceof Set) for (const entry of value) pending.push(entry);
    else for (const entry of Object.values(value)) pending.push(entry);
  }
}

function snapshotRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set);
}

function stateId(value: unknown): boolean {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function historyWindow(value: unknown): value is RuntimeHistoryWindow {
  if (!snapshotRecord(value) || !Number.isSafeInteger(value.origin) || !Number.isSafeInteger(value.last)
    || (value.origin as number) < 0 || (value.last as number) < -1
    || (value.last as number) - (value.origin as number) >= HISTORY_WINDOW_CAPACITY
    || !Array.isArray(value.indices) || !Array.isArray(value.values)
    || value.indices.length > HISTORY_WINDOW_CAPACITY || value.values.length > HISTORY_WINDOW_CAPACITY
    || value.indices.length !== value.values.length
    || (value.lastExecutionBar !== undefined && (typeof value.lastExecutionBar !== "number"
      || !Number.isSafeInteger(value.lastExecutionBar) || value.lastExecutionBar < (value.last as number) || (value.last as number) < 0))) return false;
  return (value.indices as unknown[]).every((index) => index === undefined || Number.isSafeInteger(index));
}

export function mutablePineValue(value: PineValue | undefined): boolean {
  return value !== null && typeof value === "object";
}

export function captureMutableState(value: unknown, deepArrays: boolean, references = new WeakMap<object, () => void>()): () => void {
  if (value === null || typeof value !== "object") return () => undefined;
  const existing = references.get(value);
  if (existing !== undefined) return existing;
  let restore = () => undefined;
  references.set(value, () => restore());
  if (Array.isArray(value)) {
    const arrayValue = value as unknown[];
    const length = arrayValue.length;
    const entries = deepArrays ? arrayValue.map((entry) => ({ entry, nested: captureMutableState(entry, true, references) })) : [];
    restore = () => {
      arrayValue.length = length;
      if (deepArrays) entries.forEach(({ entry, nested }, index) => { arrayValue[index] = entry; nested(); });
    };
    return restore;
  }
  if (value instanceof Map) {
    const mapValue = value as Map<unknown, unknown>;
    const entries = [...mapValue.entries()].map(([key, entry]) => ({ key, entry, nested: captureMutableState(entry, deepArrays, references) }));
    restore = () => {
      mapValue.clear();
      for (const { key, entry, nested } of entries) {
        mapValue.set(key, entry);
        nested();
      }
    };
    return restore;
  }
  if (value instanceof Set) {
    const setValue = value as Set<unknown>;
    const entries = [...setValue];
    restore = () => {
      setValue.clear();
      for (const entry of entries) setValue.add(entry);
    };
    return restore;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record).map(([key, entry]) => ({ key, entry, nested: captureMutableState(entry, deepArrays, references) }));
  const keys = new Set(Object.keys(record));
  restore = () => {
    for (const key of Object.keys(record)) if (!keys.has(key)) Reflect.deleteProperty(record, key);
    for (const { key, entry, nested } of entries) {
      record[key] = entry;
      nested();
    }
  };
  return restore;
}

export function replaceArray<T>(target: T[], source: readonly T[]): void {
  target.length = 0;
  for (const value of source) target.push(value);
}

export function replaceArrays<T>(target: T[][], source: readonly (readonly T[])[]): void {
  for (const [index, targetSeries] of target.entries()) replaceArray(targetSeries, source[index] ?? []);
}

export function replaceMap<K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

export function replaceSet<T>(target: Set<T>, source: ReadonlySet<T>): void {
  target.clear();
  for (const value of source) target.add(value);
}
