import { describe, expect, it } from "vitest";
import { normalizeFxRateBook, selectFxRate, type FxRateBookV1, type FxRateSlotV1 } from "./fx-rate-book.js";

const ms = (source: string): number => Date.parse(source);
const dates = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"];

function book(slots: readonly FxRateSlotV1[] = dates.map((date, index) => ({
  date, observedAt: ms(`${date}T23:59:00Z`), symbolToAccount: [0.7, 0.8, 1.25, 1.1, 1.3, 1.4, 1.5, 1.6][index]!,
})), closures: readonly string[] = []): FxRateBookV1 {
  return {
    version: 1, provenance: "synthetic-fixture/r1",
    calendar: { firstDate: "2026-09-21", lastDate: "2026-09-30", weekdays: [1, 2, 3, 4, 5], closures },
    pairs: [{ symbolCurrency: "USD", accountCurrency: "EUR", slots }],
  };
}

describe("supplied UTC daily FX book", () => {
  it("selects the previous confirmed session for intraday and daily bars", () => {
    const normalized = normalizeFxRateBook(book());
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "intraday", barOpen: ms("2026-09-23T09:00:00Z"), barEndExclusive: ms("2026-09-23T10:00:00Z"),
    })).toEqual({ kind: "rate", date: "2026-09-22", observedAt: ms("2026-09-22T23:59:00Z"), rate: 0.8 });
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "daily", barOpen: ms("2026-09-24T00:00:00Z"), barEndExclusive: ms("2026-09-25T00:00:00Z"),
    })).toEqual({ kind: "rate", date: "2026-09-23", observedAt: ms("2026-09-23T23:59:00Z"), rate: 1.25 });
  });

  it("uses the date containing exclusive close minus one millisecond for higher bars", () => {
    const normalized = normalizeFxRateBook(book());
    const from = ms("2026-09-21T00:00:00Z");
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "higher", barOpen: from, barEndExclusive: ms("2026-09-26T00:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-24", rate: 1.1 });
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "higher", barOpen: from, barEndExclusive: ms("2026-09-25T00:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-23", rate: 1.25 });
  });

  it("uses the latest closed session at captured realtime time and expires at coverage boundary", () => {
    const normalized = normalizeFxRateBook(book());
    expect(selectFxRate(normalized, "USD", "EUR", { mode: "realtime", evaluatedAt: ms("2026-09-25T00:00:00Z") }))
      .toMatchObject({ kind: "rate", date: "2026-09-24", rate: 1.1 });
    expect(selectFxRate(normalized, "USD", "EUR", { mode: "realtime", evaluatedAt: ms("2026-10-01T00:00:00Z") }))
      .toEqual({ kind: "unavailable", reason: "outside-coverage" });
  });

  it("skips explicit closures and weekends, but never carries through an unavailable eligible slot", () => {
    const closed = book(dates.filter((date) => date !== "2026-09-24").map((date, index) => ({
      date, observedAt: ms(`${date}T23:59:00Z`), symbolToAccount: index + 1,
    })), ["2026-09-24"]);
    const normalized = normalizeFxRateBook(closed);
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "intraday", barOpen: ms("2026-09-24T09:00:00Z"), barEndExclusive: ms("2026-09-24T10:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-23", rate: 3 });
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "intraday", barOpen: ms("2026-09-25T09:00:00Z"), barEndExclusive: ms("2026-09-25T10:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-23", rate: 3 });
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "daily", barOpen: ms("2026-09-26T00:00:00Z"), barEndExclusive: ms("2026-09-27T00:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-25", rate: 4 });
    expect(selectFxRate(normalized, "USD", "EUR", {
      mode: "historical", timeframe: "intraday", barOpen: ms("2026-09-28T09:00:00Z"), barEndExclusive: ms("2026-09-28T10:00:00Z"),
    })).toMatchObject({ kind: "rate", date: "2026-09-25", rate: 4 });
    const missing = book(book().pairs[0]!.slots.map((slot) => slot.date === "2026-09-23" ? { date: slot.date, unavailable: true } : slot));
    expect(selectFxRate(normalizeFxRateBook(missing), "USD", "EUR", {
      mode: "historical", timeframe: "intraday", barOpen: ms("2026-09-24T09:00:00Z"), barEndExclusive: ms("2026-09-24T10:00:00Z"),
    })).toEqual({ kind: "unavailable", reason: "explicit-unavailable" });
  });

  it("distinguishes identity, missing currency and missing pair", () => {
    const normalized = normalizeFxRateBook(book());
    const selection = { mode: "realtime", evaluatedAt: ms("2026-09-24T09:00:00Z") } as const;
    expect(selectFxRate(undefined, "USD", "USD", selection)).toEqual({ kind: "identity", rate: 1 });
    expect(selectFxRate(normalized, undefined, "EUR", selection)).toEqual({ kind: "missing-currency" });
    expect(selectFxRate(normalized, "NONE", "EUR", selection)).toEqual({ kind: "missing-currency" });
    expect(selectFxRate(normalized, "", "EUR", selection)).toEqual({ kind: "missing-currency" });
    expect(selectFxRate(normalized, "GBP", "EUR", selection)).toEqual({ kind: "missing-pair" });
    expect(selectFxRate(undefined, "USD", "EUR", selection)).toEqual({ kind: "missing-pair" });
  });

  it("admits every existing resolved currency constant, including a USDT pair and identity", () => {
    const constants = "AED ARS AUD BHD BRL BTC CAD CHF CLP CNY COP CZK DKK EGP ETH EUR GBP HKD HUF IDR ILS INR ISK JPY KRW KWD MAD MXN MYR NGN NOK NZD PEN PHP PKR PLN QAR RON RUB SAR SEK SGD THB TRY TWD USD USDT VND ZAR".split(" ");
    const selection = { mode: "realtime", evaluatedAt: ms("2026-09-24T09:00:00Z") } as const;
    for (const code of constants) {
      expect(selectFxRate(undefined, code, code, selection)).toEqual({ kind: "identity", rate: 1 });
    }
    const supplied = book();
    const usdt = normalizeFxRateBook({ ...supplied, pairs: [{ ...supplied.pairs[0]!, symbolCurrency: "usdt" }] });
    expect(selectFxRate(usdt, "USDT", "EUR", selection)).toMatchObject({ kind: "rate", date: "2026-09-23", rate: 1.25 });
    expect(selectFxRate(undefined, "USDT", "usdt", selection)).toEqual({ kind: "identity", rate: 1 });
    expect(() => normalizeFxRateBook({ ...supplied, pairs: [{ ...supplied.pairs[0]!, symbolCurrency: "NONE" }] }))
      .toThrow("Invalid FX currency");
  });

  it("uses valid four-digit dates beyond the former 1970–2100 restriction", () => {
    const supplied = book();
    const early = normalizeFxRateBook({ ...supplied,
      calendar: { firstDate: "1969-12-30", lastDate: "1970-01-02", weekdays: [1, 2, 3, 4, 5, 6, 7], closures: [] },
      pairs: [{ symbolCurrency: "USD", accountCurrency: "EUR", slots: ["1969-12-30", "1969-12-31", "1970-01-01", "1970-01-02"]
        .map((date, index) => ({ date, observedAt: ms(`${date}T23:59:00Z`), symbolToAccount: index + 1 })) }],
    });
    expect(selectFxRate(early, "USD", "EUR", { mode: "historical", timeframe: "daily",
      barOpen: ms("1970-01-01T00:00:00Z"), barEndExclusive: ms("1970-01-02T00:00:00Z") }))
      .toMatchObject({ kind: "rate", date: "1969-12-31", rate: 2 });
    const late = normalizeFxRateBook({ ...supplied,
      calendar: { firstDate: "9999-12-29", lastDate: "9999-12-31", weekdays: [1, 2, 3, 4, 5, 6, 7], closures: [] },
      pairs: [{ symbolCurrency: "USD", accountCurrency: "EUR", slots: ["9999-12-29", "9999-12-30", "9999-12-31"]
        .map((date, index) => ({ date, observedAt: ms(`${date}T23:59:00Z`), symbolToAccount: index + 1 })) }],
    });
    expect(selectFxRate(late, "USD", "EUR", { mode: "realtime", evaluatedAt: ms("9999-12-31T12:00:00Z") }))
      .toMatchObject({ kind: "rate", date: "9999-12-30", rate: 2 });
  });

  it("rejects incomplete, misdated, future, duplicate and invalid-rate slots", () => {
    const base = book();
    const slots = base.pairs[0]!.slots;
    const replace = (index: number, slot: FxRateSlotV1): FxRateBookV1 => book(slots.map((value, at) => at === index ? slot : value));
    expect(() => normalizeFxRateBook(book(slots.slice(1)))).toThrow("every eligible dated slot");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-22", observedAt: ms("2026-09-23T00:00:00Z"), symbolToAccount: 0.8 })))
      .toThrow("outside its daily slot");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-22", observedAt: ms("2026-09-21T23:59:59Z"), symbolToAccount: 0.8 })))
      .toThrow("outside its daily slot");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-21", observedAt: ms("2026-09-21T23:59:00Z"), symbolToAccount: 0.8 })))
      .toThrow("Duplicate FX slot date");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-22", observedAt: ms("2026-09-22T23:59:00Z"), symbolToAccount: 0 })))
      .toThrow("Invalid FX observation");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-22", observedAt: ms("2026-09-22T23:59:00Z"), symbolToAccount: Number.NaN })))
      .toThrow("Invalid FX observation");
    expect(() => normalizeFxRateBook(replace(1, { date: "2026-09-31", unavailable: true }))).toThrow("Invalid FX slot date");
  });

  it("normalizes ordering and fingerprints all content, including later rate replacement", () => {
    const original = normalizeFxRateBook(book());
    const reordered = normalizeFxRateBook({ ...book(), pairs: [{ ...book().pairs[0]!, slots: [...book().pairs[0]!.slots].reverse() }],
      calendar: { ...book().calendar, weekdays: [5, 4, 3, 2, 1] } });
    expect(reordered.fingerprint).toBe(original.fingerprint);
    const changed = normalizeFxRateBook(book(book().pairs[0]!.slots.map((slot) => slot.date === "2026-09-29" && "symbolToAccount" in slot
      ? { ...slot, symbolToAccount: 2 } : slot)));
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(normalizeFxRateBook({ ...book(), provenance: "synthetic-fixture/r2" }).fingerprint).not.toBe(original.fingerprint);
    expect(Object.isFrozen(original.pairs[0]!.slots[0])).toBe(true);
    const supplied = book([...book().pairs[0]!.slots]);
    const retained = normalizeFxRateBook(supplied);
    (supplied.pairs[0]!.slots as FxRateSlotV1[])[1] = { date: "2026-09-22", unavailable: true };
    expect(retained.fingerprint).toBe(original.fingerprint);
    expect(selectFxRate(retained, "USD", "EUR", { mode: "realtime", evaluatedAt: ms("2026-09-23T12:00:00Z") }))
      .toMatchObject({ kind: "rate", date: "2026-09-22", rate: 0.8 });
  });

  it("bounds calendar policy and rejects malformed dates before cloning observations", () => {
    expect(() => normalizeFxRateBook({ ...book(), calendar: { ...book().calendar, weekdays: [] } })).toThrow("nonempty");
    expect(() => normalizeFxRateBook({ ...book(), calendar: { ...book().calendar, closures: ["2026-09-26"] } })).toThrow("unscheduled");
    expect(() => normalizeFxRateBook({ ...book(), calendar: { ...book().calendar, closures: ["2026-09-24", "2026-09-24"] } })).toThrow("duplicate");
    expect(() => normalizeFxRateBook({ ...book(), calendar: { ...book().calendar, lastDate: "2026-02-29" } })).toThrow("Invalid FX lastDate");
    expect(() => normalizeFxRateBook({ ...book(), calendar: { ...book().calendar, lastDate: "2040-01-01" } })).toThrow("span exceeds limit");
    const manySlots = Array.from({ length: 4_096 }, (_, index): FxRateSlotV1 => {
      const date = new Date(ms("2020-01-01T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10);
      return { date, observedAt: ms(`${date}T23:59:00Z`), symbolToAccount: 1.2345678901234567 };
    });
    const tooLarge = {
      ...book(), calendar: { firstDate: "2020-01-01", lastDate: manySlots.at(-1)!.date, weekdays: [1, 2, 3, 4, 5, 6, 7], closures: [] },
      pairs: ["EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "NZD", "SEK"].map((accountCurrency) => ({ symbolCurrency: "USD", accountCurrency, slots: manySlots })),
    };
    expect(() => normalizeFxRateBook(tooLarge)).toThrow("canonical content exceeds byte limit");
  });
});
