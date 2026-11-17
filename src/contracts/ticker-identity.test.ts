import { describe, expect, it } from "vitest";
import {
  decodeLumenChartsTickerIdentity,
  encodeLumenChartsTickerIdentity,
  lumenChartsTickerBaseSymbol,
  lumenChartsTickerParts,
} from "./ticker-identity.js";

describe("Lumen Charts ticker identities", () => {
  it("keeps plain symbols plain and round-trips a canonical versioned transform", () => {
    expect(encodeLumenChartsTickerIdentity({ version: 1, symbol: " NASDAQ:AAPL " })).toBe("NASDAQ:AAPL");
    const encoded = encodeLumenChartsTickerIdentity({
      version: 1,
      symbol: "NASDAQ:AAPL",
      session: "REGULAR",
      transform: { kind: "renko", style: "atr", param: 14, requestWicks: true, source: "ohlc" },
    });
    expect(encoded.startsWith("lumencharts:v1:")).toBe(true);
    expect(decodeLumenChartsTickerIdentity(encoded)).toEqual({
      version: 1,
      symbol: "NASDAQ:AAPL",
      session: "regular",
      transform: { kind: "renko", style: "atr", param: 14, requestWicks: true, source: "ohlc" },
    });
    expect(lumenChartsTickerBaseSymbol(encoded)).toBe("NASDAQ:AAPL");
    expect(lumenChartsTickerParts(encoded)).toEqual({ prefix: "NASDAQ", ticker: "AAPL" });
  });

  it("rejects malformed owned identities and invalid transform parameters", () => {
    expect(() => decodeLumenChartsTickerIdentity("lumencharts:v1:not-json")).toThrow("encoding");
    expect(() => encodeLumenChartsTickerIdentity({
      version: 1,
      symbol: "NASDAQ:AAPL",
      transform: { kind: "linebreak", lines: 0 },
    })).toThrow("positive integer");
  });

  it("normalizes untyped style casing without producing identities the decoder rejects", () => {
    const encoded = encodeLumenChartsTickerIdentity({
      version: 1,
      symbol: "NASDAQ:AAPL",
      transform: { kind: "renko", style: "ATR", param: 14, requestWicks: false, source: "close" },
    } as never);
    expect(decodeLumenChartsTickerIdentity(encoded)?.transform).toEqual({
      kind: "renko", style: "atr", param: 14, requestWicks: false, source: "close",
    });
    expect(() => encodeLumenChartsTickerIdentity({
      version: 1,
      symbol: "NASDAQ:AAPL",
      transform: { kind: "renko", style: "ATR", param: 2.5, requestWicks: false, source: "close" },
    } as never)).toThrow("positive integer");
  });

  it("rejects untyped non-boolean Renko wick flags", () => {
    expect(() => encodeLumenChartsTickerIdentity({
      version: 1,
      symbol: "NASDAQ:AAPL",
      transform: { kind: "renko", style: "traditional", param: 2, requestWicks: "yes", source: "close" },
    } as never)).toThrow("request_wicks must be a boolean");
  });
});
