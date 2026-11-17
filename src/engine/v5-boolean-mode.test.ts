import { PINE_COMPATIBILITY, type MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1794175200000, closeTime: 1794261600000, open: 1.1135, high: 1.1225, low: 1.11343, close: 1.12235, volume: 133345 },
  { openTime: 1794261600000, closeTime: 1794348000000, open: 1.12235, high: 1.12513, low: 1.11472, close: 1.11485, volume: 137848 },
];

async function runProbe(body: string): Promise<readonly string[]> {
  const source = `//@version=5
indicator("Pine v5 missing booleans")
float x = bar_index >= 0 ? na : 1.25
int y = bar_index >= 0 ? na : 1
bool f = x > 0
bool i = y > 0
if barstate.islastconfirmedhistory
    log.info(str.tostring(f) + "|" + str.tostring(i))
plot(close)
${body}`;
  const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  if (!program) throw new Error(JSON.stringify(diagnostics));
  const session = new PineEngine().createSession(program, {
    timeframe: "1D",
    symbolInfo: { tickerid: "FX:EURUSD" },
    now: () => 1794347000000,
  });
  try {
    await session.runBatch(bars);
    return session.logs().events.map((event) => event.message);
  } finally {
    await session.close();
  }
}

describe("Pine v5 missing booleans", () => {
  // FX:EURUSD 1D observations in language-compare-v5-bool-{discarded,reachability,fallbacks}.txt.
  it.each([
    ["a discarded na(bool) result", "bool unused = na(f)"],
    ["a discarded history result", "bool unused = f[1]"],
    ["a discarded function result", "hasMissing(bool b) => na(b)\nhasMissing(f)"],
    ["a literal-false ternary", "plot((false ? na(f) : false) ? 1 : 0)"],
    ["a literal-false branch", "if false\n    log.info(str.tostring(na(f)))"],
    ["a numeric condition", 'if y\n    log.info("unexpected")'],
  ])("emits false comparisons with %s", async (_name, body) => {
    expect(await runProbe(body)).toEqual(["false|false"]);
  });

  it.each([
    ["an unused implicit declaration", "bool coerced = y"],
    ["an unused implicit reassignment", "bool coerced = true\ncoerced := y"],
    ["an unreachable implicit declaration", "if false\n    bool coerced = y"],
    ["an unused callable with an implicit declaration", "discarded(int n) =>\n    bool b = n\n    b"],
    ["an observed history value", "bool history = f[1]\nplot(history ? 1 : 0)"],
    ["an eagerly evaluated logical operand", "bool probe = false and na(f)\nplot(probe ? 1 : 0)"],
    ["a used pure function result", "hasMissing(bool b) => na(b)\nplot(hasMissing(f) ? 1 : 0)"],
    ["a series-controlled branch", "if bar_index < 0\n    log.info(str.tostring(na(f)))"],
    ["an unused partial switch", "bool flag = switch bar_index\n    -1 => true"],
    ["an unused if with an explicit missing branch", "bool flag = if bar_index < 0\n    true\nelse\n    na"],
  ])("preserves missing comparisons with %s", async (_name, body) => {
    expect(await runProbe(body)).toEqual(["NaN|NaN"]);
  });

  it("observes effects of calls whose results are discarded", async () => {
    const body = `note(bool b) =>
    if barstate.islastconfirmedhistory
        log.info(str.tostring(na(b)))
    true
note(f)`;
    expect(await runProbe(body)).toEqual(["NaN|NaN", "true"]);
  });

  it.each([
    ["explicit initializer", "bool absent = na"],
    ["explicit reassignment", "bool absent = true\nabsent := na"],
    ["unmatched if", "bool absent = if bar_index < 0\n    true"],
  ])("normalizes a missing bool from an %s", async (_name, body) => {
    expect(await runProbe(`${body}
if barstate.islastconfirmedhistory
    log.info(str.tostring(absent))`)).toEqual(["false|false", "false"]);
  });

  it("uses the chart's boolean representation in request.security children", async () => {
    const requests = `requestedText = request.security(syminfo.tickerid, timeframe.period, str.tostring(f))
if barstate.islastconfirmedhistory
    log.info(requestedText)`;
    expect(await runProbe(requests)).toEqual(["false|false", "false"]);
    expect(await runProbe(`bool requestedFlag = request.security(syminfo.tickerid, timeframe.period, f)
${requests}
if barstate.islastconfirmedhistory
    log.info(str.tostring(requestedFlag))`)).toEqual(["NaN|NaN", "NaN", "NaN"]);
  });

  it("inherits both v5 boolean modes through nested request captures", async () => {
    const body = `requestedText = request.security(syminfo.tickerid, timeframe.period, request.security(syminfo.tickerid, timeframe.period, str.tostring(f)))
if barstate.islastconfirmedhistory
    log.info(requestedText)`;
    expect(await runProbe(body)).toEqual(["false|false", "false"]);
    expect(await runProbe(`bool coerced = y\n${body}`)).toEqual(["NaN|NaN", "NaN"]);
  });

  it("preserves missing bools for unused tuple security results", async () => {
    expect(await runProbe("[a, b] = request.security(syminfo.tickerid, timeframe.period, [f, close])")).toEqual(["NaN|NaN"]);
  });

  it("keeps chart logging out of an unused callable's request context", async () => {
    expect(await runProbe("unused() => request.security(syminfo.tickerid, timeframe.period, f)")).toEqual(["NaN|NaN"]);
  });

  it("preserves v5 bool mode for a request in an unselected ternary arm", async () => {
    const body = "bool unused = false ? request.security(syminfo.tickerid, timeframe.period, f) : false";
    expect(await runProbe(body)).toEqual(["NaN|NaN"]);
  });
});
