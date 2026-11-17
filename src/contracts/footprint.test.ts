import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY } from "./compatibility.js";
import { PineFootprintError, admitPineFootprintDataset, decodePineFootprintDatasetV1, decodePineFootprintRequestV1, extendPineFootprintStore, type PineFootprintRequestV1 } from "./footprint.js";

const request: PineFootprintRequestV1 = {
  schemaVersion: 1,
  symbol: "TEST",
  timeframe: "1",
  ticksPerRow: 2,
  fromOpenTime: 1_000,
  toOpenTime: 2_000,
};

const dataset = () => ({
  schemaVersion: 1,
  symbol: "TEST",
  timeframe: "1",
  ticksPerRow: 2,
  revision: "fixture-1",
  bars: [{
    openTime: 1_000,
    rows: [
      { lowerTick: 100, upperTickExclusive: 102, buyVolume: -0, sellVolume: 2 },
      { lowerTick: 102, upperTickExclusive: 104, buyVolume: 3, sellVolume: 4 },
    ],
  }],
});

const admit = (value: unknown = dataset(), limits = {}) => admitPineFootprintDataset(request, value, {
  mintick: 0.5,
  parentOpenTimes: [1_000, 2_000],
  compatibility: PINE_COMPATIBILITY.strict,
  executorVersion: "test",
  limits,
});

function expectFootprintCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("Expected footprint admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PineFootprintError);
    expect((error as PineFootprintError).code).toBe(code);
  }
}

function footprintFailure(run: () => unknown): { code: string; field: string | undefined } {
  try { run(); }
  catch (error) {
    expect(error).toBeInstanceOf(PineFootprintError);
    return { code: (error as PineFootprintError).code, field: (error as PineFootprintError).field };
  }
  throw new Error("Expected footprint decoding to fail");
}

describe("footprint contract admission", () => {
  it("owns and freezes a normalized provider response", () => {
    const source = dataset();
    const store = admit(source);
    source.bars[0]!.rows[0]!.buyVolume = 999;
    expect(store.bars[0]!.rows[0]!.buyVolume).toBe(0);
    expect(Object.isFrozen(store.bars[0]!.rows)).toBe(true);
    expect(store.identity).toMatch(/^footprint-v1:[0-9a-f]{16}$/u);
  });

  it.each([
    ["schema", () => ({ ...dataset(), schemaVersion: 2 })],
    ["identity", () => ({ ...dataset(), symbol: "OTHER" })],
    ["bar order", () => ({ ...dataset(), bars: [dataset().bars[0], dataset().bars[0]] })],
    ["parent", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], openTime: 1_500 }] })],
    ["empty", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], rows: [] }] })],
    ["width", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], rows: [{ lowerTick: 100, upperTickExclusive: 103, buyVolume: 1, sellVolume: 1 }] }] })],
    ["gap", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], rows: [dataset().bars[0]!.rows[0], { ...dataset().bars[0]!.rows[1], lowerTick: 103, upperTickExclusive: 105 }] }] })],
    ["negative", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], rows: [{ ...dataset().bars[0]!.rows[0], buyVolume: -1 }] }] })],
    ["non-finite", () => ({ ...dataset(), bars: [{ ...dataset().bars[0], rows: [{ ...dataset().bars[0]!.rows[0], sellVolume: Number.POSITIVE_INFINITY }] }] })],
  ])("rejects invalid %s data atomically", (_name, value) => {
    expect(() => admit(value())).toThrow(PineFootprintError);
  });

  it("enforces row and byte budgets without truncation", () => {
    expectFootprintCode(() => admit(dataset(), { maxRows: 1 }), "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED");
    expectFootprintCode(() => admit(dataset(), { maxBytes: 1 }), "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED");
    expectFootprintCode(
      () => admit({ ...dataset(), ignoredProviderBlob: "x".repeat(2_000) }, { maxBytes: 1_000 }),
      "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED",
    );
  });

  it("enforces configured identity limits and reports request problems separately", () => {
    expect(() => admit(dataset(), { maxIdentityBytes: 2 })).toThrow(PineFootprintError);
    expectFootprintCode(() => admitPineFootprintDataset(request, dataset(), {
      mintick: 0, parentOpenTimes: [1_000, 2_000], compatibility: PINE_COMPATIBILITY.strict, executorVersion: "test",
    }), "SCRIPT_FOOTPRINT_INVALID_REQUEST");
  });

  it("binds identity to source arguments and provider revision", () => {
    const first = admit();
    const second = admit({ ...dataset(), revision: "fixture-2" });
    const third = admitPineFootprintDataset(request, dataset(), {
      mintick: 0.25,
      parentOpenTimes: [1_000, 2_000],
      compatibility: PINE_COMPATIBILITY.strict,
      executorVersion: "test",
    });
    expect(new Set([first.identity, second.identity, third.identity]).size).toBe(3);
    expect(new Set([first.datasetKey, second.datasetKey, third.datasetKey]).size).toBe(3);
  });

  it("extends a store with a tail slice to the same identity as a batch admission", () => {
    const twoBars = () => ({ ...dataset(), bars: [...dataset().bars, { ...dataset().bars[0]!, openTime: 2_000 }] });
    const batch = admit(twoBars());
    const head = admitPineFootprintDataset({ ...request, toOpenTime: 1_000 }, dataset(), {
      mintick: 0.5, parentOpenTimes: [1_000], compatibility: PINE_COMPATIBILITY.strict, executorVersion: "test",
    });
    const tail = admitPineFootprintDataset({ ...request, fromOpenTime: 2_000 }, { ...dataset(), bars: twoBars().bars.slice(1) }, {
      mintick: 0.5, parentOpenTimes: [2_000], compatibility: PINE_COMPATIBILITY.strict, executorVersion: "test",
    });
    const extended = extendPineFootprintStore(head, tail, { parentOpenTimes: [1_000, 2_000] });
    expect(head.datasetKey).toBe(batch.datasetKey);
    expect(extended.identity).toBe(batch.identity);
    expect(extended.bars[0]).toBe(head.bars[0]);
    expect(extended.request).toEqual(batch.request);
    expect(() => extendPineFootprintStore(head, admit({ ...twoBars(), revision: "fixture-2" }), { parentOpenTimes: [1_000, 2_000] }))
      .toThrow("different dataset");
    expectFootprintCode(() => extendPineFootprintStore(head, tail, { parentOpenTimes: [1_000, 2_000], limits: { maxBars: 1 } }),
      "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED");
  });

  it("applies the exact UTF-8 dataset byte limit to batches and appended slices", () => {
    const symbol = "市場";
    const full = { ...dataset(), symbol, bars: [...dataset().bars, { ...dataset().bars[0]!, openTime: 2_000 }] };
    const fullRequest = { ...request, symbol };
    const bytes = new TextEncoder().encode(JSON.stringify(full)).byteLength;
    const context = { mintick: 0.5, compatibility: PINE_COMPATIBILITY.strict, executorVersion: "test" };
    const batch = admitPineFootprintDataset(fullRequest, full, { ...context, parentOpenTimes: [1_000, 2_000], limits: { maxBytes: bytes } });
    const head = admitPineFootprintDataset({ ...fullRequest, toOpenTime: 1_000 }, { ...full, bars: full.bars.slice(0, 1) },
      { ...context, parentOpenTimes: [1_000] });
    const tail = admitPineFootprintDataset({ ...fullRequest, fromOpenTime: 2_000 }, { ...full, bars: full.bars.slice(1) },
      { ...context, parentOpenTimes: [2_000] });
    expect(extendPineFootprintStore(head, tail, { parentOpenTimes: [1_000, 2_000], limits: { maxBytes: bytes } }).identity).toBe(batch.identity);
    expectFootprintCode(() => extendPineFootprintStore(head, tail, { parentOpenTimes: [1_000, 2_000], limits: { maxBytes: bytes - 1 } }),
      "SCRIPT_FOOTPRINT_LIMIT_EXCEEDED");
  });

  it("decodes payloads without request context and names the offending field", () => {
    expect(decodePineFootprintDatasetV1(dataset()).bars[0]!.rows[0]!.buyVolume).toBe(0);
    const negative = { ...dataset(), bars: [{ ...dataset().bars[0]!, rows: [{ ...dataset().bars[0]!.rows[0]!, buyVolume: -1 }] }] };
    expect(footprintFailure(() => decodePineFootprintDatasetV1(negative))).toEqual({
      code: "SCRIPT_FOOTPRINT_INVALID_DATASET", field: "bars[0].rows[0].buyVolume",
    });
    expect(footprintFailure(() => decodePineFootprintRequestV1({ ...request, ticksPerRow: 0 }))).toEqual({
      code: "SCRIPT_FOOTPRINT_INVALID_REQUEST", field: "ticksPerRow",
    });
  });
});
