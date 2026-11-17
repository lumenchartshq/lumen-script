import type { ExecutionResult, MarketBar, SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars: MarketBar[] = [
  { openTime: 1000, open: 10, high: 12, low: 8, close: 10, volume: 100 },
  { openTime: 2000, open: 11, high: 13, low: 9, close: 11, volume: 110 },
  { openTime: 3000, open: 12, high: 14, low: 10, close: 12, volume: 120 },
];

function program(body: string, declaration = 'indicator("D5", overlay=true)') {
  const compiled = compile({ source: `//@version=6\n${declaration}\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(compiled.diagnostics, body).toEqual([]);
  return compiled.program!;
}

async function batch(body: string, sequence = bars, declaration?: string): Promise<ExecutionResult> {
  const session = new PineEngine().createSession(program(body, declaration));
  try { return await session.runBatch(sequence); }
  finally { await session.close(); }
}

describe("strict linefill and polyline family", () => {
  const fill = `var line upper = na
var line lower = na
var linefill first = na
var linefill replacement = na
if bar_index == 0
    upper := line.new(0, 20, 2, 22, color=#112233)
    lower := line.new(0, 10, 2, 8, color=#445566)
    first := linefill.new(upper, lower, #aabbcc)
if bar_index == 1
    upper.set_y1(25)
    replacement := linefill.new(lower, upper, #ccddee)
    first.set_color(#ffffff)
if bar_index == 2
    upper.delete()
series int count = array.size(linefill.all)
series float firstY = linefill.get_line1(replacement).get_y1()
series float secondY = replacement.get_line2().get_y1()
plot(count)`;

  it("replaces same-pair IDs, retains endpoint order, follows line motion and deletes on line deletion", async () => {
    const prefix = await batch(fill, bars.slice(0, 2));
    expect(prefix.returned.count).toEqual([1, 1]);
    expect(prefix.returned.firstY).toEqual([NaN, 10]);
    expect(prefix.returned.secondY).toEqual([NaN, 25]);
    expect(prefix.drawings.filter((drawing) => drawing.kind === "linefill")).toEqual([
      { kind: "linefill", id: 1, line1Id: 1, line2Id: 0, color: "#ccddee", forceOverlay: false },
    ]);
    const complete = await batch(fill);
    expect(complete.returned.count).toEqual([1, 1, 0]);
    expect(complete.drawings.some((drawing) => drawing.kind === "linefill")).toBe(false);
  });

  it("keeps append, portable restore and revised tails consistent with fresh replay", async () => {
    const session = new PineEngine().createSession(program(fill));
    try {
      await session.runBatch(bars.slice(0, 1));
      const checkpoint = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const appended = await session.appendBars(bars.slice(1, 2));
      expect(appended.drawings).toEqual((await batch(fill, bars.slice(0, 2))).drawings);
      await session.restore(checkpoint);
      expect((await session.appendBars(bars.slice(1, 2))).drawings).toEqual(appended.drawings);
      const revised = { ...bars[1]!, close: 17 };
      expect((await session.replaceTail([revised])).drawings).toEqual((await batch(fill, [bars[0]!, revised])).drawings);
      expect((await session.replaceTail([revised])).drawings).toEqual((await batch(fill, [bars[0]!, revised])).drawings);
      expect((await session.appendBars(bars.slice(2))).drawings.some((drawing) => drawing.kind === "linefill")).toBe(false);
    } finally { await session.close(); }
  });

  it("copies polyline points, selects time/index anchors and retains paths within the quota allowance", async () => {
    const source = `var polyline first = na
if bar_index == 0
    chart.point p = chart.point.new(1000, 0, 20)
    array<chart.point> pts = array.from(p, chart.point.new(3000, 2, 15), chart.point.new(2000, 1, 22))
    first := polyline.new(pts, curved=true, closed=true, xloc=xloc.bar_time, line_color=#112233, fill_color=#334455, line_style=line.style_dashed, line_width=3)
    p.price := 99
if bar_index == 1
    array<chart.point> pts = array.from(chart.point.from_index(0, 11), chart.point.from_index(1, 13))
    polyline.new(pts, line_color=#abcdef)
if bar_index == 2
    array<chart.point> pts = array.from(chart.point.from_index(1, 10), chart.point.from_index(2, 12))
    polyline.new(pts, line_color=#fedcba)
series int count = array.size(polyline.all)
plot(count)`;
    const declaration = 'indicator("D5", overlay=true, max_polylines_count=2)';
    const first = await batch(source, bars.slice(0, 1), declaration);
    expect(first.drawings.filter((drawing) => drawing.kind === "polyline")).toMatchObject([{ id: 0, curved: true, closed: true,
      xloc: "bt", lineColor: "#112233", fillColor: "#334455", lineStyle: "style_dashed", lineWidth: 3,
      points: [{ time: 1000, index: 0, price: 20 }, { time: 3000, index: 2, price: 15 }, { time: 2000, index: 1, price: 22 }],
    }]);
    const complete = await batch(source, bars, declaration);
    expect(complete.returned.count).toEqual([1, 2, 3]);
    expect(complete.drawings.filter((drawing) => drawing.kind === "polyline").map((drawing) => drawing.id)).toEqual([0, 1, 2]);
  });

  it("retains handles for empty and single-point polylines without emitting graphics", async () => {
    const result = await batch(`if bar_index == 0
    polyline empty = polyline.new(array.new<chart.point>())
    polyline single = polyline.new(array.from(chart.point.from_index(0, 10)))
    if na(empty) or na(single)
        runtime.error("missing short polyline handle")
series int active = array.size(polyline.all)
plot(active)`);
    expect(result.returned.active).toEqual([2, 2, 2]);
    expect(result.drawings).toEqual([]);
  });

  it("retains orphaned Pine fill handles after line eviction and isolates collection copies", async () => {
    const lines = await batch(`var line a = na
var line b = na
if bar_index == 0
    a := line.new(0, 20, 2, 22)
    b := line.new(0, 10, 2, 8)
    linefill.new(a, b, #aabbcc)
if bar_index == 1
    for i = 0 to 5
        line.new(0, 15, 2, 13)
series int fills = array.size(linefill.all)
plot(fills)`, bars, 'indicator("D5 quota", max_lines_count=2)');
    expect(lines.returned.fills).toEqual([1, 1, 1]);
    expect(lines.drawings.some((drawing) => drawing.kind === "linefill")).toBe(false);

    const fillCopy = await batch(`var line a = na
var line b = na
if bar_index == 0
    a := line.new(0, 20, 2, 22)
    b := line.new(0, 10, 2, 8)
    linefill.new(a, b, #aabbcc)
array<linefill> copy = linefill.all
copy.clear()
series int active = array.size(linefill.all)
plot(active)`);
    expect(fillCopy.returned.active).toEqual([1, 1, 1]);

    const paths = await batch(`var polyline shape = na
if bar_index == 0
    shape := polyline.new(array.from(chart.point.from_index(0, 10), chart.point.from_index(2, 12)))
array<polyline> copy = polyline.all
copy.clear()
series int active = array.size(polyline.all)
plot(active)`);
    expect(paths.returned.active).toEqual([1, 1, 1]);
    expect(paths.drawings.filter((drawing) => drawing.kind === "polyline")).toHaveLength(1);
  });
});
