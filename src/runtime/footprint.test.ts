import { describe, expect, it } from "vitest";
import type { AdmittedPineFootprintStoreV1 } from "../contracts/index.js";
import { FootprintRuntimeStore, admitFootprintArguments, isPineFootprintHandle, isPineVolumeRowHandle, type FootprintCalculation, type FootprintWorkCounter } from "./footprint.js";
import { pineString } from "./values.js";

function fixture(overrides: Partial<AdmittedPineFootprintStoreV1> = {}): AdmittedPineFootprintStoreV1 {
  return {
    schemaVersion: 1,
    identity: "footprint-v1:test",
    datasetKey: "footprint-v1:dataset",
    request: { schemaVersion: 1, symbol: "TEST", timeframe: "1", ticksPerRow: 1, fromOpenTime: 1000, toOpenTime: 1000 },
    revision: "r1",
    mintick: 0.25,
    bars: [{ openTime: 1000, rows: [
      { lowerTick: 0, upperTickExclusive: 1, buyVolume: 10, sellVolume: 10 },
      { lowerTick: 1, upperTickExclusive: 2, buyVolume: 20, sellVolume: 10 },
      { lowerTick: 2, upperTickExclusive: 3, buyVolume: 15, sellVolume: 15 },
      { lowerTick: 3, upperTickExclusive: 4, buyVolume: 5, sellVolume: 15 },
    ] }],
    ...overrides,
  };
}

const defaults: FootprintCalculation = { vaPercent: 70, imbalancePercent: 300 };

describe("FootprintRuntimeStore", () => {
  it("precomputes footprint totals, POC, value area, and immutable fresh row arrays", () => {
    const store = new FootprintRuntimeStore(fixture(), defaults);
    const footprint = store.select(1000)!;
    expect(isPineFootprintHandle(footprint)).toBe(true);
    expect(store.footprintCall("total_volume", [footprint])).toBe(100);
    expect(store.footprintCall("buy_volume", [footprint])).toBe(50);
    expect(store.footprintCall("sell_volume", [footprint])).toBe(50);
    expect(store.footprintCall("delta", [footprint])).toBe(0);
    const poc = store.footprintCall("poc", [footprint]);
    const val = store.footprintCall("val", [footprint]);
    const vah = store.footprintCall("vah", [footprint]);
    expect(store.rowCall("down_price", [poc])).toBe(0.25);
    expect(store.rowCall("down_price", [val])).toBe(0.25);
    expect(store.rowCall("down_price", [vah])).toBe(0.5);
    const first = store.footprintCall("rows", [footprint]) as unknown[];
    const second = store.footprintCall("rows", [footprint]) as unknown[];
    expect(first).not.toBe(second);
    expect(first).toHaveLength(4);
    expect(store.select(1000)).toBe(footprint);
    expect(store.footprintCall("poc", [footprint])).toBe(first[1]);
    expect(pineString(footprint)).toBe("footprint");
    expect(pineString(first[0] as never)).toBe("volume_row");
  });

  it("implements row access, diagonal imbalance, and half-open price lookup", () => {
    const store = new FootprintRuntimeStore(fixture(), defaults);
    const footprint = store.select(1000)!;
    const rows = store.footprintCall("rows", [footprint]) as never[];
    expect(isPineVolumeRowHandle(rows[1])).toBe(true);
    expect(store.rowCall("up_price", [rows[1]!])).toBe(0.5);
    expect(store.rowCall("total_volume", [rows[1]!])).toBe(30);
    expect(store.rowCall("delta", [rows[1]!])).toBe(10);
    expect(store.rowCall("has_buy_imbalance", [rows[1]!])).toBe(false);
    expect(store.rowCall("has_sell_imbalance", [rows[2]!])).toBe(true);
    expect(store.footprintCall("get_row_by_price", [footprint, 0.25])).toEqual(rows[1]);
    expect(Number.isNaN(store.footprintCall("get_row_by_price", [footprint, 1]) as number)).toBe(true);
  });

  it("uses the middle/lower POC tie rule and special percentage rules", () => {
    const pocOnly = new FootprintRuntimeStore(fixture(), { vaPercent: Number.NaN, imbalancePercent: Number.NaN });
    const footprint = pocOnly.select(1000)!;
    expect(pocOnly.footprintCall("poc", [footprint])).toEqual(pocOnly.footprintCall("val", [footprint]));
    expect(pocOnly.footprintCall("poc", [footprint])).toEqual(pocOnly.footprintCall("vah", [footprint]));
    const all = new FootprintRuntimeStore(fixture(), { ...defaults, vaPercent: 101 });
    const allHandle = all.select(1000)!;
    expect(all.rowCall("down_price", [all.footprintCall("val", [allHandle])])).toBe(0);
    expect(all.rowCall("up_price", [all.footprintCall("vah", [allHandle])])).toBe(1);
  });

  it("rejects forged, stale, and overflowing handles or calculations", () => {
    const store = new FootprintRuntimeStore(fixture(), defaults);
    expect(() => store.footprintCall("total_volume", [Number.NaN])).toThrow("Invalid or stale");
    expect(() => store.footprintCall("total_volume", [{ __pineFootprint: 1, storeKey: "other", openTime: 1000 }])).toThrow("Invalid or stale");
    expect(() => new FootprintRuntimeStore(fixture({ mintick: Number.MAX_VALUE }), defaults)).toThrow("overflow");
  });

  it("keeps scalar work constant and price lookup logarithmic after one bounded precompute", () => {
    const rows = Array.from({ length: 4_096 }, (_, index) => ({
      lowerTick: index,
      upperTickExclusive: index + 1,
      buyVolume: 1,
      sellVolume: 1,
    }));
    const work: FootprintWorkCounter = { precomputedRows: 0, scalarReads: 0, emittedRowHandles: 0, priceSearchSteps: 0 };
    const store = new FootprintRuntimeStore(fixture({ bars: [{ openTime: 1000, rows }] }), defaults, { work });
    const footprint = store.select(1000)!;
    expect(work.precomputedRows).toBe(4_096);
    for (let index = 0; index < 100; index += 1) store.footprintCall("total_volume", [footprint]);
    expect(work.scalarReads).toBe(100);
    expect(work.precomputedRows).toBe(4_096);
    store.footprintCall("get_row_by_price", [footprint, 1023.25]);
    expect(work.priceSearchSteps).toBeLessThanOrEqual(13);
    store.footprintCall("rows", [footprint]);
    expect(work.emittedRowHandles).toBe(4_096);
  });

  it("reuses unchanged bars across tail extensions and keeps their handles valid", () => {
    const first = fixture();
    const work: FootprintWorkCounter = { precomputedRows: 0, scalarReads: 0, emittedRowHandles: 0, priceSearchSteps: 0 };
    const previous = new FootprintRuntimeStore(first, defaults, { work });
    const handle = previous.select(1000)!;
    const appended = fixture({
      identity: "footprint-v1:test-2",
      bars: [first.bars[0]!, { openTime: 2000, rows: [{ lowerTick: 0, upperTickExclusive: 1, buyVolume: 1, sellVolume: 1 }] }],
    });
    const next = new FootprintRuntimeStore(appended, defaults, { previous, work });
    expect(work.precomputedRows).toBe(5);
    expect(next.key).toBe(previous.key);
    expect(next.identity).not.toBe(previous.identity);
    expect(next.select(1000)).toBe(handle);
    expect(next.footprintCall("total_volume", [handle])).toBe(100);
    expect(next.reusableFor(appended, defaults)).toBe(true);
    expect(next.reusableFor(appended, { ...defaults, vaPercent: 60 })).toBe(false);
    const recalculated = new FootprintRuntimeStore(appended, { ...defaults, vaPercent: 60 }, { previous: next, work });
    expect(recalculated.key).not.toBe(next.key);
    expect(work.precomputedRows).toBe(10);
    expect(() => recalculated.footprintCall("total_volume", [handle])).toThrow("Invalid or stale");
  });

  it("admits footprint arguments once with na/zero disabling the request", () => {
    expect(admitFootprintArguments(Number.NaN, 70, 300)).toBeUndefined();
    expect(admitFootprintArguments(0, 70, 300)).toBeUndefined();
    expect(admitFootprintArguments(2, Number.NaN, 300)).toEqual({ ticksPerRow: 2, vaPercent: Number.NaN, imbalancePercent: 300 });
    expect(() => admitFootprintArguments(1.5, 70, 300)).toThrow("ticks_per_row");
    expect(() => admitFootprintArguments(-1, 70, 300)).toThrow("ticks_per_row");
    expect(() => admitFootprintArguments(1, -1, 300)).toThrow("percentages");
    expect(() => admitFootprintArguments(1, 70, Number.POSITIVE_INFINITY)).toThrow("percentages");
  });
});
