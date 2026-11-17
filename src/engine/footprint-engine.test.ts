import { describe, expect, it } from "vitest";
import { PINE_COMPATIBILITY, type ExecutionDelta, type MarketBar, type PineFootprintDatasetV1, type PineFootprintGateway, type PineFootprintRequestV1, type SessionCheckpoint } from "../contracts/index.js";
import { compile, PineEngine } from "./index.js";

const bar = (openTime: number): MarketBar => ({ openTime, open: 1, high: 2, low: 0, close: 1, volume: 10 });
const bars = [bar(1_000), bar(2_000), bar(3_000)];

function program(ticks = "1") {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Footprint")
footprint fp = request.footprint(${ticks})
total = na(fp) ? na : fp.total_volume()
volume_row poc = na(fp) ? na : fp.poc()
poc_price = na(poc) ? na : poc.down_price()
row = na(fp) ? na : fp.get_row_by_price(0.25)
row_delta = na(row) ? na : row.delta()` });
  expect(result.diagnostics).toEqual([]);
  return result.program!;
}

function dataset(request: PineFootprintRequestV1, revision = "r1"): PineFootprintDatasetV1 {
  return {
    schemaVersion: 1,
    symbol: request.symbol,
    timeframe: request.timeframe,
    ticksPerRow: request.ticksPerRow,
    revision,
    bars: bars.filter(({ openTime }) => openTime >= request.fromOpenTime && openTime <= request.toOpenTime).map(({ openTime }) => ({
      openTime,
      rows: [
        { lowerTick: 0, upperTickExclusive: 1, buyVolume: openTime / 1_000, sellVolume: 1 },
        { lowerTick: 1, upperTickExclusive: 2, buyVolume: 4, sellVolume: 2 },
      ],
    })),
  };
}

function options(gateway?: PineFootprintGateway) {
  return { timeframe: "1", symbolInfo: { ticker: "TEST", tickerid: "TEST", mintick: 0.25 }, ...(gateway === undefined ? {} : { footprintGateway: gateway }) };
}

function portable(checkpoint: SessionCheckpoint): SessionCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as unknown as SessionCheckpoint;
}

describe("footprint engine lifecycle", () => {
  it("preloads once and executes Pine accessors, including missing bars", async () => {
    const requests: PineFootprintRequestV1[] = [];
    const gateway: PineFootprintGateway = { async load(request) {
      requests.push(request);
      const loaded = dataset(request);
      return { ...loaded, bars: loaded.bars.filter((entry) => entry.openTime !== 2_000) };
    } };
    const session = new PineEngine().createSession(program(), options(gateway));
    try {
      const result = await session.runBatch(bars.slice(0, 2));
      expect(result.returned.total![0]).toBe(8);
      expect(Number.isNaN(result.returned.total![1] as number)).toBe(true);
      expect(result.returned.poc_price![0]).toBe(0.25);
      expect(result.returned.row_delta![0]).toBe(2);
      expect(requests).toHaveLength(1);
    } finally { await session.close(); }
  });

  it("loads only appended and corrected ranges while pagination reuses the store", async () => {
    const requests: PineFootprintRequestV1[] = [];
    const gateway: PineFootprintGateway = { async load(request) { requests.push(request); return dataset(request); } };
    const session = new PineEngine().createSession(program(), options(gateway));
    let incremental: ExecutionDelta | undefined;
    try {
      await session.runBatch(bars.slice(0, 1));
      await session.appendBars(bars.slice(1, 2));
      incremental = await session.replaceTail(bars.slice(1, 3));
    } finally { await session.close(); }
    const paged = new PineEngine().createSession(program(), options(gateway));
    try { for await (const page of paged.runPaginated(bars, 1)) void page; }
    finally { await paged.close(); }
    const fresh = new PineEngine().createSession(program(), options(gateway));
    try {
      const replay = await fresh.runBatch(bars);
      expect(incremental!.returned).toEqual(replay.returned);
    } finally { await fresh.close(); }
    expect(requests.map(({ fromOpenTime, toOpenTime }) => [fromOpenTime, toOpenTime])).toEqual([
      [1_000, 1_000], [2_000, 2_000], [2_000, 3_000],
      [1_000, 1_000], [2_000, 2_000], [3_000, 3_000],
      [1_000, 3_000],
    ]);
  });

  it("round-trips checkpoints only against the exact admitted revision", async () => {
    const gateway: PineFootprintGateway = { async load(request) { return dataset(request); } };
    const first = new PineEngine().createSession(program(), options(gateway));
    let checkpoint: SessionCheckpoint;
    try { await first.runBatch(bars.slice(0, 2)); checkpoint = portable(first.checkpoint()); }
    finally { await first.close(); }
    const restored = new PineEngine().createSession(program(), options(gateway));
    try { expect((await restored.restore(checkpoint)).returned.total).toEqual([8, 9]); }
    finally { await restored.close(); }
    const changed = new PineEngine().createSession(program(), options({ async load(request) { return dataset(request, "r2"); } }));
    try { await expect(changed.restore(checkpoint)).rejects.toThrow("Footprint checkpoint store"); }
    finally { await changed.close(); }
  });

  it("replays bars-and-inputs checkpoints without requiring a stored footprint identity", async () => {
    const gateway: PineFootprintGateway = { async load(request) { return dataset(request); } };
    const session = new PineEngine().createSession(program(), options(gateway));
    try {
      const replayOnly: SessionCheckpoint = { bars: bars.slice(0, 2), inputs: {} };
      expect((await session.restore(replayOnly)).returned.total).toEqual([8, 9]);
    } finally { await session.close(); }
  });

  it("keeps the live dataset and footprint store when restore admission fails", async () => {
    let revision = "r1";
    const gateway: PineFootprintGateway = { async load(request) { return dataset(request, revision); } };
    const session = new PineEngine().createSession(program(), options(gateway));
    try {
      await session.runBatch(bars.slice(0, 1));
      const older = portable(session.checkpoint());
      await session.appendBars(bars.slice(1, 2));
      const before = session.checkpoint();
      revision = "r2";
      await expect(session.restore(older)).rejects.toThrow("Footprint checkpoint store");
      expect(session.checkpoint()).toEqual(before);
      expect((await session.appendBars(bars.slice(2))).returned.total).toEqual([8, 9, 10]);
    } finally { await session.close(); }
  });

  it("fails before evaluation without a provider and skips dispatch for zero ticks", async () => {
    const missing = new PineEngine().createSession(program(), options());
    try {
      await expect(missing.runBatch(bars.slice(0, 1))).rejects.toMatchObject({ code: "SCRIPT_FOOTPRINT_PROVIDER_UNAVAILABLE" });
    } finally { await missing.close(); }
    let calls = 0;
    const zero = new PineEngine().createSession(program("0"), options({ async load(request) { calls += 1; return dataset(request); } }));
    try {
      const result = await zero.runBatch(bars.slice(0, 1));
      expect(Number.isNaN(result.returned.total![0] as number)).toBe(true);
      expect(calls).toBe(0);
    } finally { await zero.close(); }
  });

  it("cancels an outstanding provider and rejects a late response", async () => {
    let deliver!: (value: PineFootprintDatasetV1) => void;
    let requested!: PineFootprintRequestV1;
    const pending = new Promise<PineFootprintDatasetV1>((resolve) => { deliver = resolve; });
    const session = new PineEngine().createSession(program(), options({ load(request) { requested = request; return pending; } }));
    const run = session.runBatch(bars.slice(0, 1));
    await session.close();
    deliver(dataset(requested));
    await expect(run).rejects.toThrow("closed");
  });

  it("appends without replaying earlier bars or recomputing their footprints", async () => {
    const requests: PineFootprintRequestV1[] = [];
    const session = new PineEngine().createSession(program(), options({ async load(request) { requests.push(request); return dataset(request); } }));
    try {
      await session.runBatch(bars.slice(0, 2));
      const appended = await session.appendBars(bars.slice(2));
      // Only the reopened last bar and the new bar run; a full replay would evaluate all three.
      expect(appended.stats.processedBars).toBe(2);
      expect(appended.returned.total).toEqual([8, 9, 10]);
      expect(requests.map(({ fromOpenTime, toOpenTime }) => [fromOpenTime, toOpenTime])).toEqual([[1_000, 2_000], [3_000, 3_000]]);
    } finally { await session.close(); }
  });

  it("recalculates value areas from new inputs without reloading provider data", async () => {
    const requests: PineFootprintRequestV1[] = [];
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Footprint inputs")
footprint fp = request.footprint(input.int(1, "Rows"), input.float(70, "VA"))
volume_row val = na(fp) ? na : fp.val()
val_price = na(val) ? na : val.down_price()` });
    expect(compiled.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compiled.program!, options({ async load(request) { requests.push(request); return dataset(request); } }));
    try {
      expect((await session.runBatch(bars.slice(0, 1))).returned.val_price).toEqual([0.25]);
      await session.updateInputs({ "input-1": 100.5 });
      expect((await session.replaceTail([])).returned.val_price).toEqual([0]);
      expect(requests).toHaveLength(1);
      await session.updateInputs({ "input-0": 2 });
      await expect(session.replaceTail([])).rejects.toMatchObject({ code: "SCRIPT_FOOTPRINT_INVALID_DATASET" });
      expect(requests.map(({ ticksPerRow }) => ticksPerRow)).toEqual([1, 2]);
    } finally { await session.close(); }
  });

  it("validates the resolved footprint argument rather than intermediate input defaults", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Footprint input expressions")
ticks = input.int(-1, "Rows")
va = input.float(-70, "VA")
footprint fp = request.footprint(math.abs(ticks), math.abs(va))
total = na(fp) ? na : fp.total_volume()` });
    expect(compiled.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compiled.program!, options({ async load(request) { return dataset(request); } }));
    try { expect((await session.runBatch(bars.slice(0, 1))).returned.total).toEqual([8]); }
    finally { await session.close(); }
  });

  it("keeps method calls on an na matrix independent of footprint use", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Matrix")
footprint fp = request.footprint(1)
matrix<float> m = na
rows = m.rows()` });
    expect(compiled.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compiled.program!, options({ async load(request) { return dataset(request); } }));
    try {
      expect(Number.isNaN((await session.runBatch(bars.slice(0, 1))).returned.rows![0] as number)).toBe(true);
    } finally { await session.close(); }
  });
});
