import type { MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const fixture: readonly MarketBar[] = [
  { openTime: 1_000, closeTime: 60_999, open: 9, high: 11, low: 8, close: 10, volume: 100 },
  { openTime: 61_000, closeTime: 120_999, open: 10, high: 13, low: 9, close: 12, volume: 110 },
  { openTime: 121_000, closeTime: 180_999, open: 12, high: 14, low: 10, close: 11, volume: 120 },
  { openTime: 181_000, closeTime: 240_999, open: 11, high: 16, low: 10, close: 15, volume: 130 },
  { openTime: 241_000, closeTime: 300_999, open: 15, high: 16, low: 7, close: 8, volume: 140 },
  { openTime: 301_000, closeTime: 360_999, open: 8, high: 15, low: 7, close: 14, volume: 150 },
];

function program(source: string) {
  const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

const options = {
  timeframe: "1",
  symbolInfo: { ticker: "AAPL", tickerid: "NASDAQ:AAPL", prefix: "NASDAQ", timezone: "UTC", session: "24x7" },
} as const;

describe("synthetic OHLC ticker APIs", () => {
  it("compiles and executes every constructor plus symbol identity calls", async () => {
    const compiled = program(`//@version=6
indicator("Ticker identities")
plain = ticker.new("NASDAQ", "AAPL")
modified = ticker.modify(plain, session=session.regular, adjustment=adjustment.none, backadjustment=backadjustment.off, settlement_as_close=settlement_as_close.off)
ha = ticker.heikinashi(modified)
inherited = ticker.inherit(ha, "NYSE:IBM")
renko = ticker.renko(plain, "Traditional", 2.0, true, "OHLC")
kagi = ticker.kagi(plain, 2.0)
linebreak = ticker.linebreak(plain, 3)
pnf = ticker.pointfigure(plain, "hl", "Traditional", 2.0, 3)
plot(syminfo.prefix(inherited) == "NYSE" ? 1 : 0)
plot(syminfo.ticker(inherited) == "IBM" ? 1 : 0)
plot(ticker.standard(inherited) == "NYSE:IBM" ? 1 : 0)
plot(syminfo.ticker(renko) == "AAPL" and syminfo.ticker(kagi) == "AAPL" and syminfo.ticker(linebreak) == "AAPL" and syminfo.ticker(pnf) == "AAPL" ? 1 : 0)`);
    const result = await new PineEngine().createSession(compiled, options).runBatch(fixture.slice(0, 1));
    expect(result.plots.map((plot) => plot.points[0]?.value)).toEqual([1, 1, 1, 1]);
  });

  it("derives deterministic Heikin-Ashi OHLC from the current standard dataset", async () => {
    const compiled = program(`//@version=6
indicator("Heikin Ashi")
symbol = ticker.heikinashi(syminfo.tickerid)
[haOpen, haHigh, haLow, haClose] = request.security(symbol, timeframe.period, [open, high, low, close])
plot(haOpen)
plot(haHigh)
plot(haLow)
plot(haClose)`);
    const result = await new PineEngine().createSession(compiled, options).runBatch(fixture.slice(0, 4));
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([9.5, 9.5, 10.25, 11]);
    expect(result.plots[1]?.points.map((point) => point.value)).toEqual([11, 13, 14, 16]);
    expect(result.plots[2]?.points.map((point) => point.value)).toEqual([8, 9, 10, 10]);
    expect(result.plots[3]?.points.map((point) => point.value)).toEqual([9.5, 11, 11.75, 13]);
  });

  it("keeps all five stateful views equivalent across batch, pagination, append, tail replacement and checkpoint restart", async () => {
    const compiled = program(`//@version=6
indicator("Synthetic views")
plot(request.security(ticker.heikinashi(syminfo.tickerid), timeframe.period, close), "HA")
plot(request.security(ticker.renko(syminfo.tickerid, "Traditional", 2.0, true, "OHLC"), timeframe.period, close), "Renko")
plot(request.security(ticker.kagi(syminfo.tickerid, 2.0), timeframe.period, close), "Kagi")
plot(request.security(ticker.linebreak(syminfo.tickerid, 2), timeframe.period, close), "Line Break")
plot(request.security(ticker.pointfigure(syminfo.tickerid, "hl", "Traditional", 2.0, 2), timeframe.period, close), "PnF")`);
    const engine = new PineEngine();
    const batch = await engine.createSession(compiled, options).runBatch(fixture);
    const values = (result: typeof batch) => result.plots.map((plot) => plot.points.map((point) => point.value));
    expect(values(batch).every((series) => series.some((value) => typeof value === "number" && Number.isFinite(value)))).toBe(true);
    expect(values(batch)[0]).not.toEqual(fixture.map((bar) => bar.close));

    const paginatedSession = engine.createSession(compiled, options);
    let paginated;
    for await (const page of paginatedSession.runPaginated(fixture, 2)) paginated = page;
    expect(values(paginated!)).toEqual(values(batch));

    const appendSession = engine.createSession(compiled, options);
    await appendSession.runBatch(fixture.slice(0, 3));
    const appended = await appendSession.appendBars(fixture.slice(3));
    expect(values(appended)).toEqual(values(batch));

    const checkpointSession = engine.createSession(compiled, options);
    await checkpointSession.runBatch(fixture.slice(0, 4));
    const checkpoint: SessionCheckpoint = checkpointSession.checkpoint();
    await checkpointSession.appendBars(fixture.slice(4));
    await checkpointSession.restore(checkpoint);
    const restarted = await checkpointSession.appendBars(fixture.slice(4));
    expect(values(restarted)).toEqual(values(batch));

    const revised = Object.freeze({ ...fixture.at(-1)!, open: 8, high: 8, low: 8, close: 8 });
    const expectedRevision = await engine.createSession(compiled, options).runBatch([...fixture.slice(0, -1), revised]);
    const tailSession = engine.createSession(compiled, options);
    await tailSession.runBatch(fixture);
    const replaced = await tailSession.replaceTail([revised]);
    expect(values(replaced)).toEqual(values(expectedRevision));
  });

  it("unwraps provider symbols, loads bounded full transform history and exposes the extended child identity", async () => {
    const requests: Array<{ readonly symbol: string; readonly timeframe: string; readonly calcBarsCount?: number }> = [];
    const providerBars = fixture.map((bar, index) => {
      const close = [10, 11, 12, 20, 5, 30][index]!;
      return Object.freeze({ ...bar, open: close, high: close + 1, low: close - 1, close });
    });
    const compiled = program(`//@version=6
indicator("Provider routing")
synthetic = ticker.renko("NYSE:IBM", "ATR", 3)
[childTicker, childPrefix, childId, rebuiltId] = request.security(synthetic, "1", [syminfo.ticker, syminfo.prefix, syminfo.tickerid, synthetic], calc_bars_count=2)
plot(childTicker == "IBM" and childPrefix == "NYSE" and childId == rebuiltId ? 1 : 0)`);
    const result = await new PineEngine().createSession(compiled, {
      ...options,
      limits: { maxBars: 12 },
      marketDataGateway: {
        async load(request) {
          requests.push(request);
          return { bars: providerBars, symbolInfo: { ticker: "IBM", tickerid: "NYSE:IBM", prefix: "NYSE", timezone: "UTC", session: "24x7" } };
        },
      },
    }).runBatch(fixture);
    expect(requests).toEqual([{ symbol: "NYSE:IBM", timeframe: "1", calcBarsCount: 12 }]);
    const childTicker = result.returned.childTicker;
    const childPrefix = result.returned.childPrefix;
    const childId = result.returned.childId;
    const rebuiltId = result.returned.rebuiltId;
    expect(childTicker).toBeDefined();
    expect(childPrefix).toBeDefined();
    expect(childId).toBeDefined();
    expect(rebuiltId).toBeDefined();
    if (childTicker === undefined || childPrefix === undefined || childId === undefined || rebuiltId === undefined) return;
    const observed = childTicker.findIndex((value) => value === "IBM");
    expect(observed).toBeGreaterThanOrEqual(0);
    expect(childPrefix[observed]).toBe("NYSE");
    expect(childId[observed]).toBe(rebuiltId[observed]);
    expect(result.plots[0]?.points.some((point) => point.value === 1)).toBe(true);
  });

  it("fails closed when a modifier requires data outside the OHLCV contract", async () => {
    const compiled = program(`//@version=6
indicator("Unsupported adjustment")
adjusted = ticker.modify(syminfo.tickerid, adjustment=adjustment.dividends)
plot(request.security(adjusted, timeframe.period, close))`);
    await expect(new PineEngine().createSession(compiled, options).runBatch(fixture)).rejects.toThrow("corporate-actions provider");
  });

  it("filters inherited regular-session identities from host schedule metadata", async () => {
    const sessionBars = [
      { openTime: Date.UTC(2024, 0, 2, 8), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { openTime: Date.UTC(2024, 0, 2, 10), open: 2, high: 2, low: 2, close: 2, volume: 1 },
      { openTime: Date.UTC(2024, 0, 2, 17), open: 3, high: 3, low: 3, close: 3, volume: 1 },
    ];
    const compiled = program(`//@version=6
indicator("Regular session")
regular = ticker.modify(syminfo.tickerid, session=session.regular)
inherited = ticker.inherit(regular, syminfo.tickerid)
plot(request.security(inherited, timeframe.period, close))`);
    const result = await new PineEngine().createSession(compiled, {
      ...options,
      timeframe: "60",
      sessionSchedule: { activeSession: "0000-0000:1234567", regularSession: "0930-1600:23456", timezone: "UTC" },
    }).runBatch(sessionBars);
    const finite = result.plots[0]!.points.map((point) => point.value).filter((value) => typeof value === "number" && Number.isFinite(value));
    expect(finite).toContain(2);
    expect(finite).not.toContain(1);
    expect(finite).not.toContain(3);
  });

  it("supports a synthetic request nested inside a same-context request", async () => {
    const compiled = program(`//@version=6
indicator("Nested synthetic request")
direct = request.security(ticker.heikinashi(syminfo.tickerid), timeframe.period, close)
nested = request.security(syminfo.tickerid, timeframe.period, request.security(ticker.heikinashi(syminfo.tickerid), timeframe.period, close))
plot(direct)
plot(nested)`);
    const result = await new PineEngine().createSession(compiled, options).runBatch(fixture);
    expect(result.plots[1]?.points.map((point) => point.value)).toEqual(result.plots[0]?.points.map((point) => point.value));
  });

  it("does not reapply an already-active synthetic identity in a nested request", async () => {
    const compiled = program(`//@version=6
indicator("Nested active identity")
ha = ticker.heikinashi(syminfo.tickerid)
direct = request.security(ha, timeframe.period, close)
again = request.security(ha, timeframe.period, request.security(syminfo.tickerid, timeframe.period, close))
plot(direct)
plot(again)`);
    const result = await new PineEngine().createSession(compiled, options).runBatch(fixture.slice(0, 4));
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([9.5, 11, 11.75, 13]);
    expect(result.plots[1]?.points.map((point) => point.value)).toEqual(result.plots[0]?.points.map((point) => point.value));
  });

  it("reloads standard source bars when ticker.standard is requested inside a synthetic context", async () => {
    const requests: Array<{ readonly symbol: string; readonly timeframe: string; readonly calcBarsCount?: number }> = [];
    const compiled = program(`//@version=6
indicator("Nested standard identity")
ha = ticker.heikinashi(syminfo.tickerid)
standard = request.security(ha, timeframe.period, request.security(ticker.standard(syminfo.tickerid), timeframe.period, close))
plot(standard)`);
    const result = await new PineEngine().createSession(compiled, {
      ...options,
      marketDataGateway: {
        async load(request) {
          requests.push(request);
          return { bars: fixture, symbolInfo: options.symbolInfo };
        },
      },
    }).runBatch(fixture.slice(0, 4));
    expect(requests.some((request) => request.symbol === "NASDAQ:AAPL")).toBe(true);
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([10, 12, 11, 15]);
  });

  it("derives sparse event transforms before trimming calc_bars_count", async () => {
    const closes = [10, 20, 0, 0, 15];
    const providerBars = fixture.slice(0, closes.length).map((bar, index) => Object.freeze({
      ...bar,
      open: closes[index]!, high: closes[index]!, low: closes[index]!, close: closes[index]!,
    }));
    const requests: Array<{ readonly symbol: string; readonly timeframe: string; readonly calcBarsCount?: number }> = [];
    const compiled = program(`//@version=6
indicator("Sparse line break")
synthetic = ticker.linebreak("NYSE:IBM", 2)
plot(request.security(synthetic, "1", close, calc_bars_count=1))`);
    const result = await new PineEngine().createSession(compiled, {
      ...options,
      limits: { maxBars: 8 },
      marketDataGateway: {
        async load(request) {
          requests.push(request);
          const bars = request.calcBarsCount === undefined ? providerBars : providerBars.slice(-request.calcBarsCount);
          return { bars, symbolInfo: { ...options.symbolInfo, ticker: "IBM", tickerid: "NYSE:IBM", prefix: "NYSE" } };
        },
      },
    }).runBatch(fixture.slice(0, closes.length));
    expect(requests).toEqual([{ symbol: "NYSE:IBM", timeframe: "1", calcBarsCount: 8 }]);
    const finite = result.plots[0]!.points.map((point) => point.value).filter((value) => typeof value === "number" && Number.isFinite(value));
    expect(finite).not.toContain(15);
  });
});
