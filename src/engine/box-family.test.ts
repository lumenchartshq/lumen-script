import type { ExecutionResult, SessionCheckpoint } from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars = [
  { openTime: 1_700_000_000_000, closeTime: 1_700_000_060_000, open: 11, high: 14, low: 9, close: 11, volume: 100 },
  { openTime: 1_700_000_060_000, closeTime: 1_700_000_120_000, open: 12, high: 15, low: 10, close: 12, volume: 110 },
  { openTime: 1_700_000_120_000, closeTime: 1_700_000_180_000, open: 13, high: 16, low: 11, close: 13, volume: 120 },
];
const header = '//@version=6\nindicator("Box family", overlay=true)\n';

function program(body: string) {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: header + body });
  expect(result.diagnostics, body).toEqual([]);
  return result.program!;
}

async function batch(body: string, sequence = bars): Promise<ExecutionResult> {
  const session = new PineEngine().createSession(program(body));
  try { return await session.runBatch(sequence); }
  finally { await session.close(); }
}

describe("strict box family", () => {
  const mutation = `var box area = na
if bar_index == 0
    area := box.new(0, 20, 1, 10, border_color=#112233, border_width=2, bgcolor=#334455, text="one two three")
if bar_index == 1
    area.set_lefttop(1, 22)
    area.set_rightbottom(2, 8)
    area.set_border_style(line.style_dashed)
    area.set_extend(extend.right)
    area.set_text_halign(text.align_left)
    area.set_text_valign(text.align_top)
    area.set_text_size(size.large)
    area.set_text_wrap(text.wrap_auto)
    area.set_text_font_family(font.family_monospace)
    area.set_text_formatting(text.format_bold)
series int left = area.get_left()
series float top = area.get_top()
series int active = array.size(box.all)
plot(left)
plot(top)
plot(active)`;

  it("preserves exact box identity, appearance and getters across replay", async () => {
    const expected = await batch(mutation);
    expect(expected.returned.left).toEqual([0, 1, 1]);
    expect(expected.returned.top).toEqual([20, 22, 22]);
    expect(expected.returned.active).toEqual([1, 1, 1]);
    expect(expected.drawings).toMatchObject([{ kind: "box", id: 0, left: 1, top: 22, right: 2, bottom: 8,
      xloc: "bi", borderColor: "#112233", borderStyle: "style_dashed", borderWidth: 2,
      backgroundColor: "#334455", text: "one two three", textHorizontalAlign: "left", textVerticalAlign: "top",
      textSize: "large", textWrap: "auto", textFontFamily: "monospace", textFormatting: "format_bold" }]);
    const session = new PineEngine().createSession(program(mutation));
    try {
      await session.runBatch(bars.slice(0, 1));
      const saved = JSON.parse(JSON.stringify(session.checkpoint())) as SessionCheckpoint;
      const appended = await session.appendBars(bars.slice(1));
      expect(appended.drawings).toEqual(expected.drawings);
      await session.restore(saved);
      expect((await session.appendBars(bars.slice(1))).drawings).toEqual(expected.drawings);
      const revised = [...bars.slice(0, 2), { ...bars[2]!, close: 17 }];
      expect((await session.replaceTail([revised[2]!])).drawings).toEqual((await batch(mutation, revised)).drawings);
      expect((await session.replaceTail([revised[2]!])).drawings).toEqual((await batch(mutation, revised)).drawings);
    } finally { await session.close(); }
  });

  it("selects the requested point coordinate and keeps box xloc when setting a point", async () => {
    const first = bars[0]!.openTime;
    const second = bars[1]!.openTime;
    const result = await batch(`var box area = na
if bar_index == 0
    area := box.new(chart.point.new(${first}, 0, 20), chart.point.new(${second}, 1, 10), xloc=xloc.bar_time)
if bar_index == 1
    area.set_top_left_point(chart.point.from_index(9, 25))
    area.set_bottom_right_point(chart.point.from_time(${first}, 9))
plot(area.get_left())`);
    expect(result.drawings).toMatchObject([{ kind: "box", id: 0, left: NaN, top: 25, right: first, bottom: 9, xloc: "bt" }]);
  });

  it("copies independently, deletes by owner and keeps the active collection", async () => {
    const result = await batch(`var box original = na
var box copied = na
if bar_index == 0
    original := box.new(0, 20, 1, 10, text="original")
    copied := original.copy()
if bar_index == 1
    copied.set_text("copy")
    original.delete()
series int active = array.size(box.all)
plot(active)`);
    expect(result.returned.active).toEqual([2, 1, 1]);
    expect(result.drawings).toMatchObject([{ kind: "box", id: 1, text: "copy" }]);
  });

  it("carries integer box typography through named construction, setter, and copy", async () => {
    const result = await batch(`var box first = na
if bar_index == 0
    first := box.new(left=0, top=20, right=2, bottom=10, text="one", text_size=18)
if bar_index == 1
    box.set_text_size(id=first, size=20)
    box clone = first.copy()
    clone.set_text_size(17)
plot(array.size(box.all))`);
    expect(result.drawings).toMatchObject([
      { kind: "box", id: 0, text: "one", textSize: "20" },
      { kind: "box", id: 1, text: "one", textSize: "17" },
    ]);
  });

  it("keeps stale and missing handles inert after batched box eviction", async () => {
    const source = '//@version=6\nindicator("Box quota", max_boxes_count=2)\n' + `var box first = na
if bar_index == 0
    first := box.new(0, 20, 1, 10, text="first")
    box.new(1, 21, 2, 11, text="second")
if bar_index == 1
    for i = 2 to 7
        box.new(i, 20 + i, i + 1, 10 + i)
    first.set_top(99)
    box copied = first.copy()
if bar_index == 2
    box missing = box(na)
    missing.set_top(99)
    box copiedMissing = missing.copy()
series int active = array.size(box.all)
plot(active)`;
    const compilation = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    expect(compilation.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(compilation.program!);
    try {
      const result = await session.runBatch(bars);
      expect(result.returned.active).toEqual([2, 2, 2]);
      expect(result.drawings.map(({ id }) => id)).toEqual([6, 7]);
      expect(result.drawings).toMatchObject([{ kind: "box", top: 26 }, { kind: "box", top: 27 }]);
    } finally { await session.close(); }
  });

  it("keeps the sealed point inference while strict source requires matching coordinates", async () => {
    const source = header + `var box area = na
if bar_index == 0
    area := box.new(0, 20, 1, 10)
if bar_index == 1
    area.set_top_left_point(chart.point.from_time(time, 25))`;
    const result = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });
    expect(result.diagnostics).toEqual([]);
    const session = new PineEngine().createSession(result.program!);
    try { expect((await session.runBatch(bars)).drawings).toMatchObject([{ kind: "box", xloc: "bt", left: bars[1]!.openTime }]); }
    finally { await session.close(); }
  });
});
