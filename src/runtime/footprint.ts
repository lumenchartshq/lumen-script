import type { AdmittedPineFootprintStoreV1, PineFootprintBarV1, PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

export interface PineFootprintHandle {
  readonly [key: string]: PineValue;
  readonly __pineFootprint: 1;
  readonly storeKey: string;
  readonly openTime: number;
}

export interface PineVolumeRowHandle {
  readonly [key: string]: PineValue;
  readonly __pineVolumeRow: 1;
  readonly storeKey: string;
  readonly openTime: number;
  readonly rowIndex: number;
}

/** Pine-side calculation arguments; they never affect which provider data is loaded. */
export interface FootprintCalculation {
  readonly vaPercent: number;
  readonly imbalancePercent: number;
}

export interface FootprintArguments extends FootprintCalculation {
  readonly ticksPerRow: number;
}

interface ComputedRow {
  readonly lowerPrice: number;
  readonly upperPrice: number;
  readonly buyVolume: number;
  readonly sellVolume: number;
  readonly totalVolume: number;
  readonly delta: number;
  readonly buyImbalance: boolean;
  readonly sellImbalance: boolean;
}

interface ComputedFootprint {
  readonly rows: readonly ComputedRow[];
  readonly buyVolume: number;
  readonly sellVolume: number;
  readonly totalVolume: number;
  readonly delta: number;
  readonly pocIndex: number;
  readonly valIndex: number;
  readonly vahIndex: number;
}

interface FootprintEntry {
  readonly source: PineFootprintBarV1;
  readonly footprint: ComputedFootprint;
  readonly handle: PineFootprintHandle;
  rowHandles?: readonly PineVolumeRowHandle[];
}

/** Optional deterministic instrumentation used to enforce the footprint work contract. */
export interface FootprintWorkCounter {
  precomputedRows: number;
  scalarReads: number;
  emittedRowHandles: number;
  priceSearchSteps: number;
}

export interface FootprintRuntimeStoreOptions {
  /** Store being replaced; bars it computed from the same admitted rows are reused as-is. */
  readonly previous?: FootprintRuntimeStore;
  readonly work?: FootprintWorkCounter;
}

/** Ledger rule: Value Area expansion stops before overshooting its target by more than this volume. */
const VALUE_AREA_OVERSHOOT_TOLERANCE = 0.01;

/**
 * Validates `request.footprint()` arguments. Returns `undefined` when `ticks_per_row`
 * is `na` or zero, which disables footprint data for every bar.
 */
export function admitFootprintArguments(ticksPerRow: number, vaPercent: number, imbalancePercent: number): FootprintArguments | undefined {
  if (Number.isNaN(ticksPerRow) || ticksPerRow === 0) return undefined;
  if (!Number.isSafeInteger(ticksPerRow) || ticksPerRow < 0) {
    throw new PineRuntimeError("ticks_per_row must be a positive simple int", "request.footprint");
  }
  if (!nonnegativeOrNa(vaPercent) || !nonnegativeOrNa(imbalancePercent)) {
    throw new PineRuntimeError("Footprint percentages must be nonnegative numbers or na", "request.footprint");
  }
  return Object.freeze({ ticksPerRow, vaPercent, imbalancePercent });
}

/** Session-owned immutable derived store. Provider rows never escape this boundary. */
export class FootprintRuntimeStore {
  /** Exact admitted content identity; checkpoints bind to it. */
  public readonly identity: string;
  /** Handle binding: stable while the provider revision and calculation arguments are unchanged. */
  public readonly key: string;
  private readonly entries = new Map<number, FootprintEntry>();
  private readonly work: FootprintWorkCounter | undefined;

  public constructor(
    public readonly admitted: AdmittedPineFootprintStoreV1,
    public readonly calculation: FootprintCalculation,
    options: FootprintRuntimeStoreOptions = {},
  ) {
    this.identity = admitted.identity;
    this.key = `${admitted.datasetKey}/${canonicalPercent(calculation.vaPercent)}/${canonicalPercent(calculation.imbalancePercent)}`;
    this.work = options.work;
    const reusable = options.previous?.key === this.key ? options.previous.entries : undefined;
    for (const bar of admitted.bars) {
      const retained = reusable?.get(bar.openTime);
      this.entries.set(bar.openTime, retained?.source === bar ? retained : {
        source: bar,
        footprint: computeFootprint(bar, admitted.mintick, calculation, this.work),
        handle: Object.freeze({ __pineFootprint: 1, storeKey: this.key, openTime: bar.openTime }),
      });
    }
  }

  public reusableFor(admitted: AdmittedPineFootprintStoreV1, calculation: FootprintCalculation): boolean {
    return this.admitted === admitted
      && Object.is(this.calculation.vaPercent, calculation.vaPercent)
      && Object.is(this.calculation.imbalancePercent, calculation.imbalancePercent);
  }

  public select(openTime: number): PineFootprintHandle | undefined {
    return this.entries.get(openTime)?.handle;
  }

  public footprintCall(name: string, args: readonly PineValue[]): PineValue {
    const operation = `footprint.${name}`;
    const handle = args[0];
    if (!isPineFootprintHandle(handle) || handle.storeKey !== this.key) return invalidFootprintHandle(operation);
    const entry = this.entries.get(handle.openTime) ?? invalidFootprintHandle(operation);
    const { footprint } = entry;
    switch (name) {
      case "total_volume": return this.scalar(footprint.totalVolume);
      case "buy_volume": return this.scalar(footprint.buyVolume);
      case "sell_volume": return this.scalar(footprint.sellVolume);
      case "delta": return this.scalar(footprint.delta);
      case "rows": {
        const handles = this.rowHandles(entry);
        if (this.work !== undefined) this.work.emittedRowHandles += handles.length;
        return [...handles];
      }
      case "poc": return this.scalar(this.rowHandles(entry)[footprint.pocIndex]!);
      case "vah": return this.scalar(this.rowHandles(entry)[footprint.vahIndex]!);
      case "val": return this.scalar(this.rowHandles(entry)[footprint.valIndex]!);
      case "get_row_by_price": return this.rowByPrice(entry, args[1]);
      default: throw new PineRuntimeError(`Unknown footprint operation ${name}`, operation);
    }
  }

  public rowCall(name: string, args: readonly PineValue[]): PineValue {
    const operation = `volume_row.${name}`;
    const handle = args[0];
    if (!isPineVolumeRowHandle(handle) || handle.storeKey !== this.key) return invalidFootprintHandle(operation);
    const row = this.entries.get(handle.openTime)?.footprint.rows[handle.rowIndex] ?? invalidFootprintHandle(operation);
    switch (name) {
      case "up_price": return this.scalar(row.upperPrice);
      case "down_price": return this.scalar(row.lowerPrice);
      case "total_volume": return this.scalar(row.totalVolume);
      case "buy_volume": return this.scalar(row.buyVolume);
      case "sell_volume": return this.scalar(row.sellVolume);
      case "delta": return this.scalar(row.delta);
      case "has_buy_imbalance": return this.scalar(row.buyImbalance);
      case "has_sell_imbalance": return this.scalar(row.sellImbalance);
      default: throw new PineRuntimeError(`Unknown volume-row operation ${name}`, operation);
    }
  }

  private rowHandles(entry: FootprintEntry): readonly PineVolumeRowHandle[] {
    entry.rowHandles ??= Object.freeze(entry.footprint.rows.map((_, rowIndex): PineVolumeRowHandle => Object.freeze({
      __pineVolumeRow: 1, storeKey: this.key, openTime: entry.source.openTime, rowIndex,
    })));
    return entry.rowHandles;
  }

  private rowByPrice(entry: FootprintEntry, value: PineValue | undefined): PineValue {
    if (typeof value !== "number" || !Number.isFinite(value)) return Number.NaN;
    const { rows } = entry.footprint;
    let low = 0;
    let high = rows.length - 1;
    while (low <= high) {
      if (this.work !== undefined) this.work.priceSearchSteps += 1;
      const middle = (low + high) >>> 1;
      const row = rows[middle]!;
      if (value < row.lowerPrice) high = middle - 1;
      else if (value >= row.upperPrice) low = middle + 1;
      else return this.rowHandles(entry)[middle]!;
    }
    return Number.NaN;
  }

  private scalar<T extends PineValue>(value: T): T {
    if (this.work !== undefined) this.work.scalarReads += 1;
    return value;
  }
}

export function invalidFootprintHandle(operation: string): never {
  throw new PineRuntimeError("Invalid or stale footprint handle", operation);
}

export function isPineFootprintHandle(value: unknown): value is PineFootprintHandle {
  return handleRecord(value) && value.__pineFootprint === 1 && typeof value.storeKey === "string"
    && Number.isSafeInteger(value.openTime) && Object.keys(value).length === 3;
}

export function isPineVolumeRowHandle(value: unknown): value is PineVolumeRowHandle {
  return handleRecord(value) && value.__pineVolumeRow === 1 && typeof value.storeKey === "string"
    && Number.isSafeInteger(value.openTime) && typeof value.rowIndex === "number" && Number.isSafeInteger(value.rowIndex) && value.rowIndex >= 0
    && Object.keys(value).length === 4;
}

function computeFootprint(
  bar: PineFootprintBarV1,
  mintick: number,
  calculation: FootprintCalculation,
  work: FootprintWorkCounter | undefined,
): ComputedFootprint {
  // Ledger rule: thresholds below 100% behave as 100%; `na` disables imbalance flags.
  const threshold = Number.isNaN(calculation.imbalancePercent) ? Number.NaN : Math.max(100, calculation.imbalancePercent) / 100;
  const sourceRows = bar.rows;
  let buyVolume = 0;
  let sellVolume = 0;
  const rows = sourceRows.map((source, index): ComputedRow => {
    if (work !== undefined) work.precomputedRows += 1;
    buyVolume = finiteSum(buyVolume, source.buyVolume);
    sellVolume = finiteSum(sellVolume, source.sellVolume);
    const totalVolume = finiteSum(source.buyVolume, source.sellVolume);
    const belowSell = sourceRows[index - 1]?.sellVolume;
    const aboveBuy = sourceRows[index + 1]?.buyVolume;
    return Object.freeze({
      lowerPrice: finiteProduct(source.lowerTick, mintick),
      upperPrice: finiteProduct(source.upperTickExclusive, mintick),
      buyVolume: source.buyVolume,
      sellVolume: source.sellVolume,
      totalVolume,
      delta: finiteSum(source.buyVolume, -source.sellVolume),
      buyImbalance: belowSell !== undefined && source.buyVolume > 0 && Number.isFinite(threshold)
        && source.buyVolume >= belowSell * threshold,
      sellImbalance: aboveBuy !== undefined && source.sellVolume > 0 && Number.isFinite(threshold)
        && source.sellVolume >= aboveBuy * threshold,
    });
  });
  const totalVolume = finiteSum(buyVolume, sellVolume);
  const pocIndex = pointOfControl(rows);
  const [valIndex, vahIndex] = valueArea(rows, pocIndex, totalVolume, calculation.vaPercent);
  return Object.freeze({ rows: Object.freeze(rows), buyVolume, sellVolume, totalVolume,
    delta: finiteSum(buyVolume, -sellVolume), pocIndex, valIndex, vahIndex });
}

function pointOfControl(rows: readonly ComputedRow[]): number {
  const middle = (rows.length - 1) / 2;
  let selected = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const total = rows[index]!.totalVolume;
    const current = rows[selected]!.totalVolume;
    if (total > current || total === current && (Math.abs(index - middle) < Math.abs(selected - middle)
      || Math.abs(index - middle) === Math.abs(selected - middle) && index < selected)) selected = index;
  }
  return selected;
}

function valueArea(rows: readonly ComputedRow[], poc: number, total: number, percent: number): readonly [number, number] {
  if (Number.isNaN(percent) || percent <= 0) return [poc, poc];
  if (percent > 100) return [0, rows.length - 1];
  const target = total * percent / 100;
  let selected = rows[poc]!.totalVolume;
  let low = poc;
  let high = poc;
  while (selected < target && (low > 0 || high < rows.length - 1)) {
    const below = low > 0 ? rows[low - 1]!.totalVolume : Number.NEGATIVE_INFINITY;
    const above = high < rows.length - 1 ? rows[high + 1]!.totalVolume : Number.NEGATIVE_INFINITY;
    let chooseAbove: boolean;
    if (above !== below) chooseAbove = above > below;
    else {
      const belowDistance = low > 0 ? poc - (low - 1) : Number.POSITIVE_INFINITY;
      const aboveDistance = high < rows.length - 1 ? high + 1 - poc : Number.POSITIVE_INFINITY;
      chooseAbove = aboveDistance <= belowDistance;
    }
    const candidate = chooseAbove ? above : below;
    if (selected + candidate - target > VALUE_AREA_OVERSHOOT_TOLERANCE) break;
    selected = finiteSum(selected, candidate);
    if (chooseAbove) high += 1;
    else low -= 1;
  }
  return [low, high];
}

function handleRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new PineRuntimeError("Footprint calculation overflow", "request.footprint");
  return Object.is(result, -0) ? 0 : result;
}

function finiteProduct(left: number, right: number): number {
  const result = left * right;
  if (!Number.isFinite(result)) throw new PineRuntimeError("Footprint price overflow", "request.footprint");
  return Object.is(result, -0) ? 0 : result;
}

function nonnegativeOrNa(value: number): boolean {
  return Number.isNaN(value) || (Number.isFinite(value) && value >= 0);
}

function canonicalPercent(value: number): string {
  return Number.isNaN(value) ? "na" : String(Object.is(value, -0) ? 0 : value);
}
