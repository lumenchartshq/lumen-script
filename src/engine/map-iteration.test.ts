import { PINE_COMPATIBILITY, type MarketBar } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";

const bars: readonly MarketBar[] = [
  { openTime: 1, closeTime: 2, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { openTime: 2, closeTime: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 },
];

const createMap = `m = map.new<string, int>()
m.put("a", 1)
m.put("b", 2)`;
const replaceInLoop = `int total = 0
for [key, item] in m
    total += item
    if key == "a"
        m.put("b", 5)`;

async function logged(body: string, version: 5 | 6 = 6): Promise<string[]> {
  const source = `//@version=${String(version)}\nindicator("Map iteration")\n${body}`;
  const { program, diagnostics } = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  if (!program) throw new Error(JSON.stringify(diagnostics));
  const session = new PineEngine().createSession(program, { now: () => 2 });
  try {
    await session.runBatch(bars);
    return session.logs().events.map(({ message }) => message);
  } finally {
    await session.close();
  }
}

describe("map iteration", () => {
  // FX:EURUSD controls in collections-map-iteration-mode.txt.
  it.each([
    ["plot(total)", "", "", "3"],
    ["plot(close)", "", "", "6"],
    ["plotshape(total > 0)", "", "", "3"],
    ["bgcolor(total > 0 ? color.red : color.blue)", "", "", "3"],
    ["plot(total + m.size() - 2)", "", "", "6"],
    ["plot(total + before - 2)", 'int before = m.get("b")', "", "3"],
    ["plot(total)", "", 'discarded = m.get("b")', "3"],
    ["plot(total)", "", 'm.put("b", 2)', "3"],
    ["plot(total)", "", 'alias = m\nif bar_index < 0\n    total += alias.keys().size()', "6"],
    ["plot(total)", "", 'alias = m\nif false\n    total += alias.keys().size()', "3"],
  ])("matches the source dependencies of %s with prefix %j and suffix %j", async (plot, before, after, expected) => {
    const body = `${createMap}
${before}
${replaceInLoop}
${after}
${plot}
if barstate.islastconfirmedhistory
    log.info(str.tostring(total))`;
    expect(await logged(body)).toEqual([expected]);
  });

  it("uses a later logged map read even when a separate plot observes the loop", async () => {
    const body = `${createMap}
${replaceInLoop}
plot(total)
if barstate.islastconfirmedhistory
    log.info(str.tostring(total) + "|" + str.tostring(m.get("b")))`;
    expect(await logged(body)).toEqual(["6|5"]);
    expect(await logged(body, 5)).toEqual(["6|5"]);
  });

  it("distinguishes two loops over the same map according to their order", async () => {
    const body = `${createMap}
${replaceInLoop}
m.put("b", 2)
${replaceInLoop.replaceAll("total", "second")}
plot(second)
if barstate.islastconfirmedhistory
    log.info(str.tostring(total) + "|" + str.tostring(second))`;
    expect(await logged(body)).toEqual(["6|3"]);
  });

  // FX:EURUSD controls in collections-map-callables.txt.
  it("reads replacements when the map is a callable parameter", async () => {
    const body = `sum(map<string, int> m) =>
${replaceInLoop.split("\n").map((line) => `    ${line}`).join("\n")}
    total
${createMap}
total = sum(m)
plot(total)
if barstate.islastconfirmedhistory
    log.info(str.tostring(total))`;
    expect(await logged(body)).toEqual(["6"]);
  });

  it("snapshots a callable-local map when the loop feeds its observed return", async () => {
    const body = `sum() =>
${`${createMap}\n${replaceInLoop}`.split("\n").map((line) => `    ${line}`).join("\n")}
    total
total = sum()
plot(close)
if barstate.islastconfirmedhistory
    log.info(str.tostring(total))`;
    expect(await logged(body)).toEqual(["3"]);
  });
});
