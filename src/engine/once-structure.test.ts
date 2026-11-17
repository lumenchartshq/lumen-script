import { PINE_COMPATIBILITY, type MarketBar, type SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";

const bars: readonly MarketBar[] = Array.from({ length: 5 }, (_, index) => ({
  openTime: index + 1,
  open: index + 1,
  high: index + 2,
  low: index,
  close: index + 1,
  volume: 100,
}));

function program(source: string) {
  const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  return result.program!;
}

describe("Pine v6 once structures", () => {
  it("executes an unconditional body once and a conditional body after its first true bar", async () => {
    const compiled = program(`//@version=6
indicator("Once")
var unconditional = 0
var delayed = 0
once
    unconditional += 1
once bar_index >= 2
    delayed += 1
plot(unconditional)
plot(delayed)`);

    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.unconditional).toEqual([1, 1, 1, 1, 1]);
    expect(result.returned.delayed).toEqual([0, 0, 1, 1, 1]);
  });

  it("keeps function latches isolated by call path and survives checkpoint restore", async () => {
    const compiled = program(`//@version=6
indicator("Once calls")
probe(float value) =>
    var result = 0.0
    once value >= 3
        result := value
    result
left = probe(close)
right = probe(close + 10)
plot(left)
plot(right)`);
    const session = new PineEngine().createSession(compiled);
    await session.runBatch(bars.slice(0, 3));
    const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
    const expected = await session.appendBars(bars.slice(3));
    const restored = new PineEngine().createSession(compiled);
    await restored.restore(checkpoint);
    const actual = await restored.appendBars(bars.slice(3));

    expect(actual.returned).toEqual(expected.returned);
    expect(actual.returned.left).toEqual([0, 0, 3, 3, 3]);
    expect(actual.returned.right).toEqual([11, 11, 11, 11, 11]);
  });

  it("leaves once available as an identifier in Pine v5", async () => {
    const compiled = program(`//@version=5
indicator("Identifier")
once = close
plot(once)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars.slice(0, 2));
    expect(result.returned.once).toEqual([1, 2]);
  });

  it("stops evaluating the condition after activation", async () => {
    const compiled = program(`//@version=6
indicator("Lazy once")
var values = array.from(1)
once array.shift(values) == 1
    log.info("activated")
remaining = array.size(values)
plot(remaining)`);
    const result = await new PineEngine().createSession(compiled).runBatch(bars);
    expect(result.returned.remaining).toEqual([0, 0, 0, 0, 0]);
  });

  it("keeps the v6 identifier available in the sealed profile", () => {
    const result = compile({ source: '//@version=6\nindicator("Legacy")\nonce = close\nplot(once)', compatibility: PINE_COMPATIBILITY.legacy });
    expect(result.diagnostics).toEqual([]);
  });
});
