import type { PineCompatibility } from "./compatibility.js";

export interface PineFootprintRequestV1 {
  readonly schemaVersion: 1;
  readonly symbol: string;
  readonly timeframe: string;
  readonly ticksPerRow: number;
  readonly fromOpenTime: number;
  readonly toOpenTime: number;
}

export interface PineFootprintRowV1 {
  readonly lowerTick: number;
  readonly upperTickExclusive: number;
  readonly buyVolume: number;
  readonly sellVolume: number;
}

export interface PineFootprintBarV1 {
  readonly openTime: number;
  readonly rows: readonly PineFootprintRowV1[];
}

export interface PineFootprintDatasetV1 {
  readonly schemaVersion: 1;
  readonly symbol: string;
  readonly timeframe: string;
  readonly ticksPerRow: number;
  readonly revision: string;
  readonly bars: readonly PineFootprintBarV1[];
}

export interface PineFootprintGateway {
  load(request: PineFootprintRequestV1, signal: AbortSignal): Promise<PineFootprintDatasetV1>;
}

export interface PineFootprintLimits {
  readonly maxBars?: number;
  readonly maxRowsPerBar?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
  readonly maxIdentityBytes?: number;
}

export const PINE_FOOTPRINT_LIMITS = Object.freeze({
  maxBars: 10_000,
  maxRowsPerBar: 4_096,
  maxRows: 500_000,
  maxBytes: 64 * 1_024 * 1_024,
  maxIdentityBytes: 512,
} as const);

/** Pine defaults for the optional `request.footprint()` arguments. */
export const PINE_FOOTPRINT_DEFAULTS = Object.freeze({ vaPercent: 70, imbalancePercent: 300 } as const);

export const PINE_FOOTPRINT_ERROR_CODES = Object.freeze([
  "SCRIPT_FOOTPRINT_PROVIDER_UNAVAILABLE",
  "SCRIPT_FOOTPRINT_PROVIDER_FAILURE",
  "SCRIPT_FOOTPRINT_INVALID_REQUEST",
  "SCRIPT_FOOTPRINT_INVALID_DATASET",
  "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED",
  "SCRIPT_FOOTPRINT_STALE_RESPONSE",
  "SCRIPT_FOOTPRINT_CHECKPOINT_MISMATCH",
] as const);

export type PineFootprintErrorCode = typeof PINE_FOOTPRINT_ERROR_CODES[number];

export interface PineFootprintErrorOptions extends ErrorOptions {
  /** Offending request or dataset field, such as `bars[2].rows[0].buyVolume`. */
  readonly field?: string;
}

export class PineFootprintError extends Error {
  public readonly field: string | undefined;

  public constructor(
    public readonly code: PineFootprintErrorCode,
    message: string,
    options?: PineFootprintErrorOptions,
  ) {
    super(message, options);
    this.name = "PineFootprintError";
    this.field = options?.field;
  }
}

export interface AdmittedPineFootprintStoreV1 {
  readonly schemaVersion: 1;
  /** Exact admitted content, including the parent range; binds checkpoints. */
  readonly identity: string;
  /**
   * Source identity shared by every slice of one provider revision. Bars admitted
   * under the same key never change, so appends keep existing handles valid.
   */
  readonly datasetKey: string;
  readonly request: PineFootprintRequestV1;
  readonly revision: string;
  readonly mintick: number;
  readonly bars: readonly PineFootprintBarV1[];
}

export interface PineFootprintAdmissionContext {
  readonly mintick: number;
  readonly parentOpenTimes: readonly number[];
  readonly compatibility: PineCompatibility;
  readonly executorVersion: string;
  readonly limits?: PineFootprintLimits;
}

/** Per-bar admission facts kept private so an extension never revalidates retained rows. */
interface AdmittedBarFacts {
  readonly digests: readonly string[];
  readonly bytes: readonly number[];
  readonly rows: readonly number[];
}

const encoder = new TextEncoder();
const admittedFacts = new WeakMap<AdmittedPineFootprintStoreV1, AdmittedBarFacts>();

/**
 * Context-free request validation shared by every trust boundary (host, worker, engine).
 * Throws `SCRIPT_FOOTPRINT_INVALID_REQUEST`.
 */
export function decodePineFootprintRequestV1(value: unknown, limits?: PineFootprintLimits): PineFootprintRequestV1 {
  return decodeRequest(value, normalizedLimits(limits));
}

/**
 * Context-free dataset validation shared by every trust boundary: schema, bounded
 * identity text, budgets, strictly ascending bars, and contiguous fixed-width rows.
 * Returns an owned, frozen copy. Throws `SCRIPT_FOOTPRINT_INVALID_DATASET` or
 * `SCRIPT_FOOTPRINT_LIMIT_EXCEEDED`; nothing is clamped, sorted, or dropped.
 */
export function decodePineFootprintDatasetV1(value: unknown, limits?: PineFootprintLimits): PineFootprintDatasetV1 {
  return decodeDataset(value, normalizedLimits(limits));
}

/** Atomically validates and owns a provider response for one request before runtime evaluation. */
export function admitPineFootprintDataset(
  requestValue: PineFootprintRequestV1,
  datasetValue: unknown,
  context: PineFootprintAdmissionContext,
): AdmittedPineFootprintStoreV1 {
  const limits = normalizedLimits(context.limits);
  const request = decodeRequest(requestValue, limits);
  if (!Number.isFinite(context.mintick) || context.mintick <= 0) invalidRequest("Symbol mintick must be finite and positive");
  const dataset = decodeDataset(datasetValue, limits);
  if (dataset.symbol !== request.symbol || dataset.timeframe !== request.timeframe
    || dataset.ticksPerRow !== request.ticksPerRow) invalid("Footprint dataset identity does not match its request");

  const parentTimes = new Set(context.parentOpenTimes);
  const facts = { digests: [] as string[], bytes: [] as number[], rows: [] as number[] };
  dataset.bars.forEach((bar, index) => {
    if (bar.openTime < request.fromOpenTime || bar.openTime > request.toOpenTime || !parentTimes.has(bar.openTime)) {
      invalid("Footprint bar does not match a requested parent bar", `bars[${index}].openTime`);
    }
    const canonicalBar = JSON.stringify(bar);
    facts.digests.push(digest(canonicalBar));
    facts.bytes.push(encoder.encode(canonicalBar).byteLength);
    facts.rows.push(bar.rows.length);
  });
  const datasetKey = footprintDatasetKey(request, dataset.revision, context);
  return sealStore({ datasetKey, request, revision: dataset.revision, mintick: context.mintick, bars: dataset.bars }, facts, limits);
}

function decodeRequest(value: unknown, limits: Required<PineFootprintLimits>): PineFootprintRequestV1 {
  const request = record(value, "request", invalidRequest);
  if (request.schemaVersion !== 1) invalidRequest("Unsupported footprint request schema", "schemaVersion");
  const symbol = boundedText(request.symbol, "symbol", limits.maxIdentityBytes, invalidRequest);
  const timeframe = boundedText(request.timeframe, "timeframe", limits.maxIdentityBytes, invalidRequest);
  const ticksPerRow = safeInteger(request.ticksPerRow, "ticksPerRow", invalidRequest);
  const fromOpenTime = safeInteger(request.fromOpenTime, "fromOpenTime", invalidRequest);
  const toOpenTime = safeInteger(request.toOpenTime, "toOpenTime", invalidRequest);
  if (ticksPerRow <= 0) invalidRequest("ticksPerRow must be positive", "ticksPerRow");
  if (fromOpenTime > toOpenTime) invalidRequest("Footprint request range is reversed", "toOpenTime");
  return Object.freeze({ schemaVersion: 1, symbol, timeframe, ticksPerRow, fromOpenTime, toOpenTime });
}

function decodeDataset(value: unknown, limits: Required<PineFootprintLimits>): PineFootprintDatasetV1 {
  let rawBytes: number;
  try { rawBytes = encoder.encode(JSON.stringify(value)).byteLength; }
  catch { return invalid("Footprint dataset must be serializable"); }
  if (rawBytes > limits.maxBytes) exceeded("Footprint serialized-byte limit exceeded");
  const dataset = record(value, "dataset");
  if (dataset.schemaVersion !== 1) invalid("Unsupported footprint dataset schema", "schemaVersion");
  const symbol = boundedText(dataset.symbol, "symbol", limits.maxIdentityBytes);
  const timeframe = boundedText(dataset.timeframe, "timeframe", limits.maxIdentityBytes);
  const ticksPerRow = safeInteger(dataset.ticksPerRow, "ticksPerRow");
  if (ticksPerRow <= 0) invalid("ticksPerRow must be positive", "ticksPerRow");
  const revision = boundedText(dataset.revision, "revision", limits.maxIdentityBytes);
  if (!Array.isArray(dataset.bars)) invalid("Footprint bars must be an array", "bars");
  if (dataset.bars.length > limits.maxBars) exceeded("Footprint bar limit exceeded", "bars");

  const bars: PineFootprintBarV1[] = [];
  let priorOpenTime = Number.NEGATIVE_INFINITY;
  let totalRows = 0;
  for (let barIndex = 0; barIndex < dataset.bars.length; barIndex += 1) {
    const barPath = `bars[${barIndex}]`;
    const sourceBar = record(dataset.bars[barIndex], barPath);
    const openTime = safeInteger(sourceBar.openTime, `${barPath}.openTime`);
    if (openTime <= priorOpenTime) invalid("Footprint bars must be unique and strictly ascending", `${barPath}.openTime`);
    if (!Array.isArray(sourceBar.rows) || sourceBar.rows.length === 0) invalid("A present footprint bar must contain rows", `${barPath}.rows`);
    if (sourceBar.rows.length > limits.maxRowsPerBar) exceeded("Footprint rows-per-bar limit exceeded", `${barPath}.rows`);
    totalRows += sourceBar.rows.length;
    if (totalRows > limits.maxRows) exceeded("Footprint total-row limit exceeded", `${barPath}.rows`);

    const rows: PineFootprintRowV1[] = [];
    let expectedLower: number | undefined;
    for (let rowIndex = 0; rowIndex < sourceBar.rows.length; rowIndex += 1) {
      const rowPath = `${barPath}.rows[${rowIndex}]`;
      const sourceRow = record(sourceBar.rows[rowIndex], rowPath);
      const lowerTick = safeInteger(sourceRow.lowerTick, `${rowPath}.lowerTick`);
      const upperTickExclusive = safeInteger(sourceRow.upperTickExclusive, `${rowPath}.upperTickExclusive`);
      if (upperTickExclusive - lowerTick !== ticksPerRow) invalid("Footprint row width does not match ticksPerRow", `${rowPath}.upperTickExclusive`);
      if (expectedLower !== undefined && lowerTick !== expectedLower) invalid("Footprint rows must be ascending and contiguous", `${rowPath}.lowerTick`);
      const buyVolume = volume(sourceRow.buyVolume, `${rowPath}.buyVolume`);
      const sellVolume = volume(sourceRow.sellVolume, `${rowPath}.sellVolume`);
      if (!Number.isFinite(buyVolume + sellVolume)) invalid("Footprint row volume overflow", rowPath);
      rows.push(Object.freeze({ lowerTick, upperTickExclusive, buyVolume, sellVolume }));
      expectedLower = upperTickExclusive;
    }
    bars.push(Object.freeze({ openTime, rows: Object.freeze(rows) }));
    priorOpenTime = openTime;
  }
  return Object.freeze({ schemaVersion: 1, symbol, timeframe, ticksPerRow, revision, bars: Object.freeze(bars) });
}

/**
 * Replaces the tail of an admitted store with a newly admitted slice of the same
 * provider revision. Work is proportional to the slice plus the retained bar count;
 * retained rows are neither copied nor revalidated.
 */
export function extendPineFootprintStore(
  previous: AdmittedPineFootprintStoreV1,
  slice: AdmittedPineFootprintStoreV1,
  context: Pick<PineFootprintAdmissionContext, "parentOpenTimes" | "limits">,
): AdmittedPineFootprintStoreV1 {
  const limits = normalizedLimits(context.limits);
  const previousFacts = admittedFacts.get(previous);
  const sliceFacts = admittedFacts.get(slice);
  if (previousFacts === undefined || sliceFacts === undefined) invalid("Footprint stores must come from admission");
  if (previous.datasetKey !== slice.datasetKey) invalid("Footprint slice belongs to a different dataset");
  const fromOpenTime = context.parentOpenTimes[0];
  const toOpenTime = context.parentOpenTimes.at(-1);
  if (fromOpenTime === undefined || toOpenTime === undefined || slice.request.toOpenTime !== toOpenTime) {
    invalid("Footprint slice must end at the last parent bar");
  }
  const parentTimes = new Set(context.parentOpenTimes);
  const keep: number[] = [];
  for (let index = 0; index < previous.bars.length; index += 1) {
    const openTime = previous.bars[index]!.openTime;
    if (openTime < fromOpenTime) continue;
    if (openTime >= slice.request.fromOpenTime) break;
    if (!parentTimes.has(openTime)) invalid("Retained footprint bar no longer matches a parent bar");
    keep.push(index);
  }
  const pick = <T>(values: readonly T[]): T[] => keep.map((index) => values[index]!);
  return sealStore({
    datasetKey: previous.datasetKey,
    request: Object.freeze({ ...slice.request, fromOpenTime, toOpenTime }),
    revision: slice.revision,
    mintick: slice.mintick,
    bars: [...pick(previous.bars), ...slice.bars],
  }, {
    digests: [...pick(previousFacts.digests), ...sliceFacts.digests],
    bytes: [...pick(previousFacts.bytes), ...sliceFacts.bytes],
    rows: [...pick(previousFacts.rows), ...sliceFacts.rows],
  }, limits);
}

function sealStore(
  store: Omit<AdmittedPineFootprintStoreV1, "schemaVersion" | "identity">,
  facts: AdmittedBarFacts,
  limits: Required<PineFootprintLimits>,
): AdmittedPineFootprintStoreV1 {
  if (store.bars.length > limits.maxBars) exceeded("Footprint bar limit exceeded");
  if (facts.rows.reduce((sum, rows) => sum + rows, 0) > limits.maxRows) exceeded("Footprint total-row limit exceeded");
  const envelope = JSON.stringify({ schemaVersion: 1, symbol: store.request.symbol, timeframe: store.request.timeframe,
    ticksPerRow: store.request.ticksPerRow, revision: store.revision, bars: [] });
  const serializedBytes = facts.bytes.reduce((sum, bytes) => sum + bytes, encoder.encode(envelope).byteLength)
    + Math.max(0, facts.bytes.length - 1);
  if (serializedBytes > limits.maxBytes) {
    exceeded("Footprint serialized-byte limit exceeded");
  }
  // Content identity is path independent: a batch load and any sequence of
  // extensions over the same bars produce the same identity.
  const identityHeader = JSON.stringify({ datasetKey: store.datasetKey,
    fromOpenTime: store.request.fromOpenTime, toOpenTime: store.request.toOpenTime });
  const sealed: AdmittedPineFootprintStoreV1 = Object.freeze({
    schemaVersion: 1,
    identity: `footprint-v1:${digest(`${identityHeader}|${facts.digests.join(",")}`)}`,
    ...store,
    bars: Object.freeze(store.bars),
  });
  admittedFacts.set(sealed, Object.freeze(facts));
  return sealed;
}

function footprintDatasetKey(request: PineFootprintRequestV1, revision: string, context: PineFootprintAdmissionContext): string {
  return `footprint-v1:${digest(JSON.stringify({
    compatibility: context.compatibility,
    executorVersion: context.executorVersion,
    symbol: request.symbol,
    timeframe: request.timeframe,
    ticksPerRow: request.ticksPerRow,
    mintick: context.mintick,
    revision,
  }))}`;
}

function normalizedLimits(value: PineFootprintLimits | undefined): Required<PineFootprintLimits> {
  const result = { ...PINE_FOOTPRINT_LIMITS, ...value };
  for (const [name, limit] of Object.entries(result)) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PINE_FOOTPRINT_LIMITS[name as keyof typeof PINE_FOOTPRINT_LIMITS]) {
      invalidRequest(`Invalid footprint limit ${name}`);
    }
  }
  return result;
}

type Reject = (message: string, field?: string) => never;

function record(value: unknown, field: string, reject: Reject = invalid): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject(`Invalid footprint ${field}`, field === "request" || field === "dataset" ? undefined : field);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, maxBytes: number, reject: Reject = invalid): string {
  if (typeof value !== "string" || value.length === 0 || encoder.encode(value).byteLength > maxBytes) reject(`Invalid footprint ${field}`, field);
  return value;
}

function safeInteger(value: unknown, field: string, reject: Reject = invalid): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) reject(`Invalid footprint ${field}`, field);
  return value;
}

function volume(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`Invalid footprint ${field}`, field);
  return Object.is(value, -0) ? 0 : value;
}

function invalid(message: string, field?: string): never {
  throw new PineFootprintError("SCRIPT_FOOTPRINT_INVALID_DATASET", message, field === undefined ? undefined : { field });
}

function invalidRequest(message: string, field?: string): never {
  throw new PineFootprintError("SCRIPT_FOOTPRINT_INVALID_REQUEST", message, field === undefined ? undefined : { field });
}

function exceeded(message: string, field?: string): never {
  throw new PineFootprintError("SCRIPT_FOOTPRINT_LIMIT_EXCEEDED", message, field === undefined ? undefined : { field });
}

/** Non-cryptographic 64-bit identity digest (two 32-bit multiplicative lanes over UTF-16 units). */
function digest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193);
    second = Math.imul(second ^ unit, 0x5bd1e995);
    second ^= second >>> 15;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
