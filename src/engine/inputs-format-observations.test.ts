import { PINE_COMPATIBILITY } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

const bar = { openTime: 1_000, open: 1, high: 1, low: 1, close: 1, volume: 1 };
const symbolInfo = { mintick: 0.00001, timezone: "America/New_York" } as const;

describe("input and formatting observations", () => {
  it("preserves manual off-step float inputs and resolves a constant date-string input", async () => {
    // inputs-admission.txt records 0.33 at step 0.25 and the date string as 1704067200000.
    const source = `//@version=6
indicator("Input defaults")
ratio = input.float(0.33, "Ratio", minval=0.0, maxval=1.0, step=0.25)
start = input.time(timestamp("01 Jan 2024 00:00 +0000"), "Start")`;
    const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    expect(program.descriptor.inputs).toMatchObject([
      { type: "float", defaultValue: 0.33, step: 0.25 },
      { type: "time", defaultValue: 1704067200000 },
    ]);
    const session = new PineEngine().createSession(program, { symbolInfo });
    try {
      expect((await session.runBatch([bar])).returned).toMatchObject({ ratio: [0.33], start: [1704067200000] });
      // inputs-override.txt records the manual value and the UI-clamped bounds.
      for (const ratio of [0.37, 1, 0]) {
        await session.updateInputs({ ratio });
        expect((await session.runBatch([bar])).returned.ratio).toEqual([ratio]);
      }
      await expect(session.updateInputs({ ratio: 1.4 })).rejects.toThrow("must not exceed 1");
    } finally {
      await session.close();
    }
  });

  it("preserves the minute across a spring gap and matches observed decimal and array text", async () => {
    // context-and-objects.txt, language-values.txt and numeric-edges.txt.
    const source = `//@version=6
indicator("Timestamp and text")
gap = timestamp("America/New_York", 2024, 3, 10, 2, 30)
localText = str.format_time(gap, "yyyy-MM-dd HH:mm:ss Z", "America/New_York")
volumeText = str.tostring(999.99, format.volume)
arrayText = str.tostring(str.split("a||b|", "|"))
numberText = str.tonumber(" 1 ")
exponent = str.tonumber("1e3")
exact = math.round_to_mintick(-0.000005)
near = math.round_to_mintick(-0.00000499999)`;
    const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    const session = new PineEngine().createSession(program, { symbolInfo });
    try {
      expect((await session.runBatch([bar])).returned).toMatchObject({
        gap: [1710055800000],
        localText: ["2024-03-10 03:30:00 -0400"],
        volumeText: ["1000"],
        arrayText: ["[a, , b, ]"],
        numberText: [1],
        exponent: [Number.NaN],
        exact: [-0.00001],
        near: [0],
      });
    } finally {
      await session.close();
    }
  });
  it("matches weekday and zone token runs, repeated local time and price patterns", async () => {
    // Recorded probe formatting-price-controls.txt and formatting-time-controls.txt.
    const source = `//@version=6
indicator("Formatting boundaries")
fold = timestamp("America/New_York", 2024, 11, 3, 1, 30)
weekday = str.format_time(fold, "E|EE|EEE|EEEE|EEEEE", "UTC")
utc = str.format_time(fold, "z|zz|zzz|zzzz", "UTC")
ianaUtc = str.format_time(fold, "z|zzzz", "Etc/UTC")
newYork = str.format_time(fold, "yyyy-MM-dd HH:mm z Z", "America/New_York")
price = str.tostring(-2.5, format.price)
literal = str.tostring(-3.5, "abc")`;
    const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    const session = new PineEngine().createSession(program, { symbolInfo });
    try {
      expect((await session.runBatch([bar])).returned).toMatchObject({
        fold: [1730615400000],
        weekday: ["Sun|Sun|Sun|Sunday|Sunday"],
        utc: ["GMT|GMT|GMT|Greenwich Mean Time"],
        ianaUtc: ["UTC|Coordinated Universal Time"],
        newYork: ["2024-11-03 01:30 EST -0500"],
        price: ["-price3"],
        literal: ["-abc4"],
      });
    } finally {
      await session.close();
    }
  });

  it.each([5, 6] as const)("matches the missing-value and arithmetic uses of infinity in v%s", async (version) => {
    // Recorded probe language-edge-infinity-controls.txt.
    const source = `//@version=${version}
indicator("Infinity")
float divided = 1.0 / 0.0
float over = math.pow(10.0, 310.0)
dividedMissing = na(divided)
overMissing = na(over)
dividedReplacement = nz(divided, 7.0)
overReplacement = nz(over, 7.0)
minimum = math.min(over, 7.0)
comparison = over > 7.0
dividedText = str.tostring(divided)
overflowText = str.tostring(over)`;
    const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    const session = new PineEngine().createSession(program);
    try {
      expect((await session.runBatch([bar])).returned).toMatchObject({
        dividedMissing: [true],
        overMissing: [true],
        dividedReplacement: [7],
        overReplacement: [7],
        minimum: [7],
        comparison: [true],
        dividedText: ["NaN"],
        overflowText: ["NaN"],
      });
    } finally {
      await session.close();
    }
  });

  it("keeps quoted braces inside a numeric placeholder and rejects an unquoted nested argument", async () => {
    const prefix = '//@version=6\nindicator("Nested format")\n';
    const { program, diagnostics } = compile({
      source: prefix + `result = str.format("{0,number,0.0 '{x}'}", 2.0)`,
      compatibility: PINE_COMPATIBILITY.strict,
    });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    const session = new PineEngine().createSession(program);
    try {
      expect((await session.runBatch([bar])).returned.result).toEqual(["2.0 {x}"]);
    } finally {
      await session.close();
    }
    const invalid = compile({
      source: prefix + `result = str.format("{{0}}", "x")`,
      compatibility: PINE_COMPATIBILITY.strict,
    });
    if (!invalid.program) throw new Error(JSON.stringify(invalid.diagnostics));
    const rejected = new PineEngine().createSession(invalid.program);
    try {
      await expect(rejected.runBatch([bar])).rejects.toThrow("can't parse argument number: {0}");
    } finally {
      await rejected.close();
    }
  });

  it("formats numeric matrices row by row with the supplied number pattern", async () => {
    // Recorded probe matrix-formatting.txt.
    const source = `//@version=6
indicator("Matrix strings")
matrix<float> values = matrix.new<float>(2, 3, 0.0)
values.set(0, 0, 0.125)
values.set(0, 1, na)
values.set(1, 2, -1.5)
ordinary = str.tostring(values)
patterned = str.tostring(values, "0.00")
integerText = str.tostring(matrix.new<int>(2, 2, 7), "0.00")
empty = str.tostring(matrix.new<float>())`;
    const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
    if (!program) throw new Error(JSON.stringify(diagnostics));
    const session = new PineEngine().createSession(program);
    try {
      expect((await session.runBatch([bar])).returned).toMatchObject({
        ordinary: ["[0.125, NaN, 0]\n[0, 0, -1.5]"],
        patterned: ["[0.13, NaN, 0.00]\n[0.00, 0.00, -1.50]"],
        integerText: ["[7.00, 7.00]\n[7.00, 7.00]"],
        empty: [""],
      });
    } finally {
      await session.close();
    }
  });

  it("formats float joins consistently for namespace and receiver calls", async () => {
    // join-and-drawing-limits.txt and drawing-retention.txt capture these exact spellings.
    const source = `//@version=6
indicator("Typed array join")
array<float> floats = array.from(1.0, -2.0, 0.0009999, 0.001, 9999999.0, 10000000.0, float(na))
array<int> ints = array.from(1, -2, 0)
namespaceText = array.join(id=floats)
methodText = floats.join(separator="|")
intText = ints.join("|")`;
    for (const compatibility of [PINE_COMPATIBILITY.strict, PINE_COMPATIBILITY.legacy]) {
      const { program, diagnostics } = compile({ source, compatibility });
      if (!program) throw new Error(JSON.stringify(diagnostics));
      const session = new PineEngine().createSession(program);
      try {
        const { returned } = await session.runBatch([bar]);
        const values = compatibility === PINE_COMPATIBILITY.strict
          ? ["1.0", "-2.0", "9.999E-4", "0.001", "9999999.0", "1.0E7", "NaN"]
          : ["1", "-2", "0.0009999", "0.001", "9999999", "10000000", "NaN"];
        expect(returned).toMatchObject({ namespaceText: [values.join(",")], methodText: [values.join("|")], intText: ["1|-2|0"] });
      } finally {
        await session.close();
      }
    }
  });

});
