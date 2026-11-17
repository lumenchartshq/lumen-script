import { describe, expect, it } from "vitest";
import type { MarketBar } from "../contracts/index.js";
import { PineEngine, compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compatibility = PINE_COMPATIBILITY.strict;

function program(source: string) {
  const result = compile({ source, compatibility });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

function bar(openTime: number, close: number, closeTime?: number): MarketBar {
  return { openTime, ...(closeTime === undefined ? {} : { closeTime }), open: close, high: close, low: close, close, volume: 1 };
}

describe("calendar and runtime resource limits", () => {
  it("keeps all daily request bars inside a 3M calendar parent", async () => {
    const compiled = program(`//@version=6
indicator("Quarterly lower request")
values = request.security_lower_tf("TEST:DAILY", "D", close)`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "3M",
      marketDataGateway: {
        load: async () => ({
          bars: [
            bar(Date.parse("2026-04-15T00:00:00.000Z"), 11),
            bar(Date.parse("2026-06-30T00:00:00.000Z"), 22),
          ],
        }),
      },
    }).runBatch([bar(Date.parse("2026-04-01T00:00:00.000Z"), 10)]);

    expect(result.returned.values).toEqual([[11, 22]]);
  });

  it("resets intraday strategy risk at exchange midnight rather than UTC midnight", async () => {
    const compiled = program(`//@version=6
strategy("Exchange risk day", pyramiding=10)
strategy.risk.max_intraday_filled_orders(2, "")
strategy.entry(str.tostring(bar_index), strategy.long)`);
    const result = await new PineEngine().createSession(compiled, {
      timezone: "America/New_York",
      symbolInfo: { ticker: "TEST", tickerid: "TEST", timezone: "America/New_York", currency: "USD" },
    }).runBatch([
      bar(Date.parse("2026-03-10T02:00:00.000Z"), 10), // Mar 9, 22:00 EDT
      bar(Date.parse("2026-03-10T03:00:00.000Z"), 11), // Mar 9, 23:00 EDT
      bar(Date.parse("2026-03-10T04:00:00.000Z"), 12), // Mar 10, 00:00 EDT
    ]);

    expect(result.strategy?.positionSize).toBe(2);
  });

  it("uses the source bar open when deriving a higher-timeframe close at an exact boundary", async () => {
    const compiled = program(`//@version=6
indicator("Quarter close")
quarterClose = time_close("3M")`);
    const quarterEnd = Date.parse("2026-07-01T04:00:00.000Z");
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "D",
      timezone: "America/New_York",
    }).runBatch([bar(Date.parse("2026-06-30T04:00:00.000Z"), 10, quarterEnd)]);

    expect(result.returned.quarterClose).toEqual([quarterEnd]);
  });

  it("detects exchange-local daily changes when UTC remains on the same date", async () => {
    const compiled = program(`//@version=6
indicator("Exchange day change")
newDay = timeframe.change("D")`);
    const result = await new PineEngine().createSession(compiled, {
      timeframe: "60",
      timezone: "America/New_York",
    }).runBatch([
      bar(Date.parse("2026-03-10T03:00:00.000Z"), 10),
      bar(Date.parse("2026-03-10T04:00:00.000Z"), 11),
    ]);

    expect(result.returned.newDay).toEqual([false, true]);
  });

  it("rejects dynamic table cells outside the declared dimensions", async () => {
    const compiled = program(`//@version=6
indicator("Table dimensions")
var table display = table.new(position.top_right, 1, 1)
table.cell(display, 1, 0, "outside")`);

    await expect(new PineEngine().createSession(compiled).runBatch([bar(0, 10)])).rejects.toThrow("Table cell (1, 0) is outside 1 columns by 1 rows");
  });

  it("rejects aggregate table cells before allocating beyond the runtime budget", async () => {
    const compiled = program(`//@version=6
indicator("Table budget")
columns = int(close)
var table display = table.new(position.top_right, columns, 2)`);
    const session = new PineEngine().createSession(compiled, { limits: { maxTableCells: 4 } });

    await expect(session.runBatch([bar(0, 3)])).rejects.toThrow("Table cell limit exceeded: Lumen Script supports at most 4 active table cells");
  });

  it("keeps one active table for each supported table position", async () => {
    const compiled = program(`//@version=6
indicator("Table position limit")
var table first = table.new(position.top_right, 1, 1)
var table second = table.new(position.top_right, 1, 1)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0, 10)]);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ position: "top_right", columns: 1, rows: 1 });
  });

  it("keeps a hidden table handle usable when a newer table occupies its position", async () => {
    const compiled = program(`//@version=6
indicator("Reusable hidden table")
var table first = table.new(position.top_right, 1, 1)
var table second = table.new(position.top_right, 1, 1)
if barstate.islast
    table.cell(first, 0, 0, "moved")
    table.set_position(first, position.bottom_left)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0, 10)]);

    expect(result.tables).toHaveLength(2);
    expect(result.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 0, position: "bottom_left" }),
      expect.objectContaining({ id: 1, position: "top_right" }),
    ]));
  });

  it("reveals the previous table after deleting the newer table at that position", async () => {
    const compiled = program(`//@version=6
indicator("Reveal previous table")
var table first = table.new(position.top_right, 1, 1)
var table second = table.new(position.top_right, 1, 1)
if barstate.islast
    table.delete(second)`);
    const result = await new PineEngine().createSession(compiled).runBatch([bar(0, 10)]);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ id: 0, position: "top_right" });
  });
});
