import type { ExecutionResult, MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const source = `//@version=6
indicator("Matrix numeric lifecycle")
var matrix<float> values = matrix.new<float>(2, 3, 0)
values.set(0, 0, values.get(0, 0) + close)
values.set(0, 1, close)
values.set(0, 2, na)
values.set(1, 0, close)
values.set(1, 1, close)
values.set(1, 2, -3)
plot(values.min())
plot(values.max())
plot(values.mode())
plot(values.trace())`;

const bars = [10, 20, 30].map((close, index): MarketBar => ({
  openTime: index * 60_000,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
}));

function plotValues(result: ExecutionResult): unknown[][] {
  return result.plots.map((plot) => plot.points.map((point) => point.value));
}

describe("matrix numeric lifecycle candidate", () => {
  it("replays exact four-form values through append, portable restore and repeated tail replacement", async () => {
    const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compiled.diagnostics).toEqual([]);
    const engine = new PineEngine();
    const runFresh = async (input: readonly MarketBar[]): Promise<ExecutionResult> => {
      const session = engine.createSession(compiled.program!);
      try { return await session.runBatch(input); }
      finally { await session.close(); }
    };
    const session = engine.createSession(compiled.program!);
    try {
      const batch = await runFresh(bars);
      expect(plotValues(batch)).toEqual([
        [-3, -3, -3],
        [10, 30, 60],
        [10, 20, 30],
        [20, 50, 90],
      ]);

      await session.runBatch(bars.slice(0, 2));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const appended = await session.appendBars(bars.slice(2));
      expect(plotValues(appended)).toEqual(plotValues(batch));

      await session.restore(checkpoint);
      const restored = await session.appendBars(bars.slice(2));
      expect(plotValues(restored)).toEqual(plotValues(batch));

      const revised = { ...bars[2]!, close: 5, open: 5, high: 5, low: 5 };
      const replaced = await session.replaceTail([revised]);
      const revisedFresh = await runFresh([...bars.slice(0, 2), revised]);
      expect(plotValues(replaced)).toEqual(plotValues(revisedFresh));
      expect(plotValues(replaced).map((values) => values.at(-1))).toEqual([-3, 35, 5, 40]);

      const repeated = { ...bars[2]!, close: 40, open: 40, high: 40, low: 40 };
      const repeatedResult = await session.replaceTail([repeated]);
      const repeatedFresh = await runFresh([...bars.slice(0, 2), repeated]);
      expect(plotValues(repeatedResult)).toEqual(plotValues(repeatedFresh));
      expect(plotValues(repeatedResult).map((values) => values.at(-1))).toEqual([-3, 70, 40, 110]);

      await session.restore(checkpoint);
      const replayed = await session.appendBars([repeated]);
      expect(plotValues(replayed)).toEqual(plotValues(repeatedFresh));
      expect(plotValues(await runFresh(bars))).toEqual(plotValues(batch));
    } finally {
      await session.close();
    }
  });
});
