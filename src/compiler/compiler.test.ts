import { describe, expect, it } from "vitest";
import { compile } from "./index.js";
import type { CompileRequest } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function compileFixture(request: Omit<CompileRequest, "compatibility">) {
  return compile({ ...request, compatibility: PINE_COMPATIBILITY.legacy });
}

function compileProductionFixture(request: Omit<CompileRequest, "compatibility">) {
  return compile({ ...request, compatibility: PINE_COMPATIBILITY.strict });
}

describe("compile", () => {
  it("binds targeted max_bars_back only to unambiguous series and legal constant sizes", () => {
    for (const body of [
      "max_bars_back(close, 3)\nplot(close[3])",
      "max_bars_back(close, 1)\nplot(close[1])",
      "max_bars_back(close, 5000)\nplot(close[5000])",
      "custom = close * 2\nmax_bars_back(custom, 3)\nplot(custom[3])",
      "max_bars_back(var=close, num=2 + 1)\nplot(close[3])",
      "f() =>\n    local = close\n    max_bars_back(local, 3)\n    local[3]\nplot(f())",
    ]) {
      const result = compileProductionFixture({ source: `//@version=6\nindicator("Target")\n${body}` });
      expect(result.diagnostics).toEqual([]);
    }
    for (const body of [
      "max_bars_back(close + 1, 3)",
      "max_bars_back(hl2, 3)",
      "max_bars_back(close, 0)",
      "max_bars_back(close, 5001)",
      "max_bars_back(close, 1.0)",
      "max_bars_back(close, input.int(3))",
      "f() =>\n    local = close\n    if bar_index > 0\n        local = high\n        max_bars_back(local, 3)\n    local\nplot(f())",
    ]) {
      const result = compileProductionFixture({ source: `//@version=6\nindicator("Target")\n${body}` });
      expect(result.program).toBeUndefined();
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2018" && diagnostic.range !== undefined)).toBe(true);
    }
    const v5 = compileProductionFixture({ source: '//@version=5\nindicator("Target")\nmax_bars_back(close, 5 / 2)\nplot(close[2])' });
    expect(v5.diagnostics).toEqual([]);
  });
  it("validates production declaration max_bars_back as a constant integer from 0 to 5000", () => {
    for (const [value, expected] of [["0", 0], ["2 + 3", 5], ["5000", 5000]] as const) {
      const result = compileProductionFixture({ source: `//@version=6\nindicator("History", max_bars_back=${value})\nplot(close)` });
      expect(result.diagnostics).toEqual([]);
      expect(result.descriptor?.maxBarsBack).toBe(expected);
    }
    for (const value of ["-1", "1.0", "1.5", "5001", '"2"', "input.int(2)"]) {
      const result = compileProductionFixture({ source: `//@version=6\nindicator("History", max_bars_back=${value})\nplot(close)` });
      expect(result.program).toBeUndefined();
      expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2018" && diagnostic.range?.start.line === 2)).toBe(true);
    }
    const strategy = compileProductionFixture({ source: '//@version=6\nstrategy("History", max_bars_back=5001)\nplot(close)' });
    expect(strategy.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2018" && diagnostic.range?.start.line === 2)).toBe(true);
    const v5Invalid = compileProductionFixture({ source: '//@version=5\nindicator("History", max_bars_back=5001)\nplot(close)' });
    expect(v5Invalid.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2018" && diagnostic.range?.start.line === 2)).toBe(true);
    const v5ConstDivision = compileProductionFixture({ source: '//@version=5\nindicator("History", max_bars_back=5 / 2)\nplot(close)' });
    expect(v5ConstDivision.diagnostics).toEqual([]);
    expect(v5ConstDivision.descriptor?.maxBarsBack).toBe(2);
    expect(compileFixture({ source: '//@version=6\nindicator("Frozen", max_bars_back=5001)\nplot(close)' }).diagnostics).toEqual([]);
  });
  it("requires native Pine v5 or v6", () => {
    expect(compileFixture({ source: "plot(close)" }).diagnostics[0]?.code).toBe("SCRIPT1001");
    expect(compileFixture({ source: "//@version=4\nplot(close)" }).diagnostics[0]?.code).toBe("SCRIPT1002");
  });

  it("compiles an indicator to direct runtime JavaScript", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Average")\nlength = input.int(3, title="Length")\naverage = ta.sma(close, length)\nplot(average, title="SMA")',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.callWithSource(1,"ta.sma"');
    expect(result.program?.variableNames).toEqual(["length", "average"]);
    expect(result.program?.indicatorTitle).toBe("Average");
    expect(result.descriptor).toEqual({
      version: 6,
      kind: "indicator",
      title: "Average",
      overlay: false,
      format: "inherit",
      precision: 10,
      scale: "right",
      behindChart: true,
      explicitPlotZOrder: false,
      dynamicRequests: true,
      drawingLimits: { lines: 50, boxes: 50, labels: 50, polylines: 50 },
      inputs: [{ id: "length", type: "int", title: "Length", defaultValue: 3 }],
      plots: [{ id: "plot-0", title: "SMA" }],
      alerts: [],
    });
  });

  it("extracts strategy and display metadata without execution", () => {
    const result = compileFixture({
      source: '//@version=6\nstrategy("Example", overlay=true, precision=4)\nenabled = input.bool(true, title="Enabled")\nplot(close, "Price")',
    });
    expect(result.descriptor).toMatchObject({ kind: "strategy", title: "Example", overlay: true, precision: 4, precisionSpecified: true });
    expect(result.descriptor?.inputs).toEqual([{ id: "enabled", type: "bool", title: "Enabled", defaultValue: true }]);
  });

  it("preserves a shorttitle and whether scale was explicitly declared", () => {
    const explicit = compileProductionFixture({
      source: '//@version=6\nindicator("Relative Strength Index", shorttitle="RSI", overlay=true, scale=scale.left)\nplot(close)',
    });
    const inherited = compileProductionFixture({
      source: '//@version=6\nindicator("Inherited scale", shorttitle="")\nplot(close)',
    });

    expect(explicit.descriptor).toMatchObject({
      shortTitle: "RSI",
      scale: "left",
      scaleExplicit: true,
    });
    expect(inherited.descriptor).toMatchObject({ scale: "right", scaleExplicit: false });
    expect(inherited.descriptor).not.toHaveProperty("shortTitle");
    // An omitted precision keeps Pine's descriptor default without claiming it was declared.
    expect(inherited.descriptor).toMatchObject({ precision: 10 });
    expect(inherited.descriptor).not.toHaveProperty("precisionSpecified");
  });

  it("preserves declaration-timeframe presence and generates opaque Calculation inputs", () => {
    const result = compileFixture({
      source: `//@version=6
indicator(behind_chart=false, max_polylines_count=13, timeframe_gaps=false, format=format.percent, title="Declaration options", explicit_plot_zorder=true, scale=scale.left, max_bars_back=321, overlay=true, dynamic_requests=false, timeframe="D", max_boxes_count=12, max_labels_count=11, precision=6, max_lines_count=10)
plot(close)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor).toMatchObject({
      kind: "indicator",
      title: "Declaration options",
      overlay: true,
      format: "percent",
      precision: 6,
      scale: "left",
      behindChart: false,
      explicitPlotZOrder: true,
      timeframe: "D",
      timeframeSpecified: true,
      timeframeGaps: false,
      timeframeGapsSpecified: true,
      maxBarsBack: 321,
      dynamicRequests: false,
      drawingLimits: { lines: 10, boxes: 12, labels: 11, polylines: 13 },
    });
    expect(result.descriptor?.inputs).toEqual([
      { id: "$pine.main.timeframe", type: "timeframe", title: "Timeframe", defaultValue: "D", group: "Calculation" },
      { id: "$pine.main.timeframe_gaps", type: "bool", title: "Wait for timeframe closes", defaultValue: false, group: "Calculation" },
    ]);
  });

  it("distinguishes an explicitly empty declaration timeframe and defaults wait-for-close", () => {
    const result = compileProductionFixture({
      source: '//@version=6\nindicator("Chart context", timeframe="")\nplot(close)',
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor).toMatchObject({
      timeframe: "",
      timeframeSpecified: true,
    });
    expect(result.descriptor).not.toHaveProperty("timeframeGaps");
    expect(result.descriptor).not.toHaveProperty("timeframeGapsSpecified");
    expect(result.descriptor?.inputs.at(-1)).toMatchObject({
      id: "$pine.main.timeframe_gaps",
      defaultValue: true,
    });
  });

  it("rejects drawings and alert side effects with a declaration timeframe", () => {
    for (const call of ['line.new(bar_index, close, bar_index + 1, close)', 'table.new(position.top_right, 1, 1)', 'alert("done")']) {
      const result = compileProductionFixture({
        source: `//@version=6\nindicator("Side effect", timeframe="D")\n${call}`,
      });
      expect(result.program).toBeUndefined();
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: "error", code: "SCRIPT2020" })]);
    }
  });

  it("preserves non-default, out-of-order strategy declaration visual and request settings", () => {
    const result = compileFixture({
      source: `//@version=6
strategy(explicit_plot_zorder=true, max_bars_back=144, title="Strategy declaration", scale=scale.none, behind_chart=false, format=format.volume, dynamic_requests=false, overlay=true)
plot(close)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor).toMatchObject({
      kind: "strategy",
      title: "Strategy declaration",
      overlay: true,
      format: "volume",
      scale: "none",
      behindChart: false,
      explicitPlotZOrder: true,
      maxBarsBack: 144,
      dynamicRequests: false,
    });
    expect(result.descriptor).not.toHaveProperty("timeframe");
    expect(result.descriptor).not.toHaveProperty("timeframeGaps");
  });

  it("extracts broker configuration from named strategy arguments", () => {
    const result = compileFixture({
      source: `//@version=6
strategy("Ledger", initial_capital=1000, pyramiding=2, default_qty_type=strategy.percent_of_equity, default_qty_value=10, currency=currency.USD, slippage=2, commission_type=strategy.commission.percent, commission_value=0.1)
if bar_index == 0
    strategy.entry(direction=strategy.long, id="Long", qty=3)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.strategy).toEqual({
      initial_capital: 1000,
      currency: "USD",
      pyramiding: 2,
      default_qty_type: "percent_of_equity",
      default_qty_value: 10,
      slippage: 2,
      commission_type: "percent",
      commission_value: 0.1,
      process_orders_on_close: false,
      margin_long: 100,
      margin_short: 100,
      calc_on_order_fills: false,
      calc_on_every_tick: false,
      backtest_fill_limits_assumption: 0,
      close_entries_rule: "FIFO",
      risk_free_rate: 2,
      use_bar_magnifier: false,
      fill_orders_on_standard_ohlc: false,
    });
  });

  it("extracts and bounds drawing quotas from declarations", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Quotas", max_lines_count=120, max_boxes_count=80, max_labels_count=70, max_polylines_count=60)',
    });
    expect(result.descriptor?.drawingLimits).toEqual({ lines: 120, boxes: 80, labels: 70, polylines: 60 });
    const bounded = compileFixture({
      source: '//@version=6\nindicator("Bounded", max_lines_count=900, max_boxes_count=0, max_labels_count=-2, max_polylines_count=200)',
    });
    expect(bounded.descriptor?.drawingLimits).toEqual({ lines: 500, boxes: 1, labels: 1, polylines: 100 });
  });

  it("compiles typed single-expression functions and named defaults", () => {
    const result = compileFixture({
      source: "//@version=6\nscale(float source, float factor=2) => source * factor\nresult = scale(factor=3, source=close)\nplot(result)",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const fn_scale=");
    expect(result.program?.generatedSource).toContain("r.argumentRef");
  });

  it("compiles multiline functions with local series and persistence", () => {
    const result = compileFixture({
      source: `//@version=6
accumulate(float source) =>
    local = source * 2
    var total = 0.0
    total := total + local
    total
value = accumulate(close)
plot(value)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("r.localRef");
    expect(result.program?.generatedSource).toContain("r.assignRef");
  });

  it("keeps same-named callable locals isolated across sibling branches", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Branch locals")
choose(float source, bool first) =>
    value = 0.0
    if first
        float branch = source
        value := branch
    else
        float branch = source * 2
        value := branch
    value
plot(choose(close, bar_index % 2 == 0))`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const l1=r.localRef");
    expect(result.program?.generatedSource).toContain("const l2=r.localRef");
  });

  it("still rejects duplicate callable locals in the same lexical block", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Duplicate locals")
duplicate(float source) =>
    value = source
    value = source * 2
    value
plot(duplicate(close))`,
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2006",
      message: "Local 'value' is already declared",
    }));
  });

  it("compiles indented if statements and if expressions", () => {
    const result = compileFixture({
      source: `//@version=6
choose(float source) =>
    result = 0.0
    if source > 11
        result := 1.0
    else
        result := -1.0
    result
direction = if close > 11
    1.0
else
    -1.0
plot(choose(close))
plot(direction)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("if(r.truthy");
  });

  it("compiles else-if expression chains and nested branch expressions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Nested conditions")
enum Signal
    Buy
    Sell
    Neutral
getSignal(float source) =>
    if source > 1
        Signal.Buy
    else if source < -1
        Signal.Sell
    else
        Signal.Neutral
signal = if close > open
    if close > high[1]
        Signal.Buy
    else
        Signal.Neutral
else if close < open
    Signal.Sell
else
    Signal.Neutral
plot(signal == getSignal(close - open) ? 1 : 0)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('return "Buy";');
    expect(result.program?.generatedSource).toContain('return "Sell";');
    expect(result.program?.generatedSource).toContain('return "Neutral";');
  });

  it("compiles nested if expressions inside switch arms", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Switch conditions")
mode = "market"
signal = switch mode
    "market" =>
        if close > open
            1
        else if close < open
            -1
        else
            0
    => 0
plot(signal)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const $switch=");
    expect(result.program?.generatedSource).toContain("else{if(r.truthy");
  });

  it("compiles bounded for and while loops with compound assignments", () => {
    const result = compileFixture({
      source: `//@version=6
sumTo(int length) =>
    total = 0.0
    for i = 1 to length
        total += i
    total
counter = 0.0
while counter < 2
    counter += 1
plot(sumTo(3))
plot(counter)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("r.loop()");
  });

  it("compiles discriminated and condition-only switch expressions", () => {
    const result = compileFixture({
      source: `//@version=6
kind = "EMA"
average = switch kind
    "EMA" => ta.ema(close, 3)
    "SMA" => ta.sma(close, 3)
    => close
signal = switch
    close > 12 => 1
    close < 10 => -1
    => 0
plot(average)
plot(signal)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const $switch=");
  });

  it("compiles tuple literals, function returns, destructuring, and ignored slots", () => {
    const result = compileFixture({
      source: `//@version=6
pair(float source) => [source, source * 2]
[first, second] = pair(close)
[_, third] = [second, second + 1]
plot(first)
plot(second)
plot(third)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["first", "second", "third"]);
    expect(result.program?.generatedSource).toContain("r.tupleGet");
  });

  it("compiles typed persistent arrays with namespace and method calls", () => {
    const result = compileFixture({
      source: `//@version=6
var float[] values = array.new_float(0)
values.push(close)
if values.size() > 3
    values.shift()
plot(array.avg(values))
plot(values.first())`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("r.method");
    expect(result.program?.generatedSource).toContain('"array.avg"');
  });

  it("orders named arguments for drawing receiver methods", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Receiver arguments")
var table dashboard = table.new(position.top_right, 1, 1)
dashboard.cell(0, 0, "Value", text_color=color.white, text_halign=text.align_center, text_size=size.small, bgcolor=color.red, tooltip="Details", text_font_family=font.family_monospace)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"cell",[0,0,"Value",undefined,undefined,r.constant("color.white"),r.constant("text.align_center"),undefined,r.constant("size.small"),r.constant("color.red"),"Details",r.constant("font.family_monospace"),undefined]');
  });

  it("compiles history references on calls and compound expressions", () => {
    const result = compileFixture({
      source: "//@version=6\npreviousAverage = ta.sma(close, 3)[1]\npreviousSpread = (high - low)[1]\nplot(previousAverage)\nplot(previousSpread)",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("r.history");
  });

  it("describes and compiles OHLC plot families", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("OHLC")\nplotbar(open, high, low, close, "Bars", color.red)\nplotcandle(open, high, low, close, title="Candles", color=color.green, wickcolor=color.blue, bordercolor=color.orange)',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([
      { id: "plot-0", title: "Bars" },
      { id: "plot-1", title: "Candles" },
    ]);
    expect(result.program?.generatedSource).toContain('r.visual("plot-0","bar"');
    expect(result.program?.generatedSource).toContain('r.visual("plot-1","candle"');
  });

  it("describes and compiles marker plot families", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Markers")\nplotchar(true, title="Char", char="X", location=location.abovebar, color=color.red, offset=0, text="hot", textcolor=color.white, size=size.tiny)\nplotshape(true, title="Shape", style=shape.triangleup, location=location.belowbar, color=color.green, offset=0, text="go", textcolor=color.white, size=size.small)',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([
      { id: "plot-0", title: "Char" },
      { id: "plot-1", title: "Shape" },
    ]);
    expect(result.program?.generatedSource).toContain('r.visual("plot-0","char"');
    expect(result.program?.generatedSource).toContain('r.visual("plot-1","shape"');
    expect(result.program?.generatedSource).toContain('"text":"hot"');
  });

  it("describes and compiles signed arrow plots", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Arrows")
plotarrow(close - 12, "Direction", color.green, color.red, 1, 2, 10)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([{ id: "plot-0", title: "Direction" }]);
    expect(result.program?.generatedSource).toContain('r.arrow("plot-0"');
    expect(result.program?.generatedSource).toContain('"colorup":r.constant("color.green")');
  });

  it("describes and compiles chart color overlays", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Colors")\nbgcolor(color.new(color.blue, 50), title="Background")\nbarcolor(color.red, title="Bars")',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([
      { id: "plot-0", title: "Background" },
      { id: "plot-1", title: "Bars" },
    ]);
    expect(result.program?.generatedSource).toContain('r.visual("plot-0","background"');
    expect(result.program?.generatedSource).toContain('r.visual("plot-1","barcolor"');
  });

  it("describes and compiles horizontal lines", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Levels")\nhline(50, "Mid", color.red, hline.style_dashed, 2)',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([{ id: "plot-0", title: "Mid" }]);
    expect(result.program?.generatedSource).toContain('r.visual("plot-0","hline",50');
  });

  it("returns stable plot handles for fills", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Band")\nupper = plot(high, "Upper")\nlower = plot(low, "Lower")\nfill(upper, lower, color.new(color.blue, 80), "Band fill")',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.plots).toEqual([
      { id: "plot-0", title: "Upper" },
      { id: "plot-1", title: "Lower" },
      { id: "plot-2", title: "Band fill" },
    ]);
    expect(result.program?.generatedSource).toContain('r.fill("plot-2"');
  });

  it("extracts scalar and source input descriptors", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Inputs")
enabled = input.bool(true, "Enabled")
color = input.color(color.red, "Color")
ratio = input.float(1.5, "Ratio")
count = input.int(2, "Count")
price = input.price(10.5, "Price")
session = input.session("0900-1700", "Session")
source = input.source(close, "Source")
label = input.string("fast", "Label")
symbol = input.symbol("NASDAQ:AAPL", "Symbol")
note = input.text_area("hello", "Note")
start = input.time(1000, "Start")
frame = input.timeframe("60", "Frame")
plot(ratio + count)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs.map(({ type, title, defaultValue }) => ({ type, title, defaultValue }))).toEqual([
      { type: "bool", title: "Enabled", defaultValue: true },
      { type: "color", title: "Color", defaultValue: "#F23645" },
      { type: "float", title: "Ratio", defaultValue: 1.5 },
      { type: "int", title: "Count", defaultValue: 2 },
      { type: "price", title: "Price", defaultValue: 10.5 },
      { type: "session", title: "Session", defaultValue: "0900-1700" },
      { type: "source", title: "Source", defaultValue: "close" },
      { type: "string", title: "Label", defaultValue: "fast" },
      { type: "symbol", title: "Symbol", defaultValue: "NASDAQ:AAPL" },
      { type: "text_area", title: "Note", defaultValue: "hello" },
      { type: "time", title: "Start", defaultValue: 1000 },
      { type: "timeframe", title: "Frame", defaultValue: "60" },
    ]);
  });

  it("accepts native Pine hexadecimal color literals", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Hex colors", overlay = true)
styles = "Styles"
opaque = input.color(#089981, "Opaque", group = styles)
alpha = input.color(#5b9cf680, "Alpha")
plot(close, color = opaque)
bgcolor(alpha)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs.map(({ type, title, defaultValue }) => ({ type, title, defaultValue }))).toEqual([
      { type: "color", title: "Opaque", defaultValue: "#089981" },
      { type: "color", title: "Alpha", defaultValue: "#5B9CF680" },
    ]);
    expect(result.program?.generatedSource).toContain('r.input("opaque","Opaque","#089981","color")');
    expect(result.program?.generatedSource).toContain('r.input("alpha","Alpha","#5b9cf680","color")');
    expect(result.program?.descriptor.inputs[0]?.group).toBe("Styles");
  });

  it("matches original defaults for untitled plots, inputs, and scripts", () => {
    const result = compileFixture({
      source: `//@version=6
value = input.int(5)
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor).toMatchObject({
      title: "",
      inputs: [{ id: "value", type: "int", title: "", defaultValue: 5 }],
      plots: [{ id: "plot-0", title: "#0" }],
    });
  });

  it("reads positional declaration fields and positional plot options", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Long title", "Short", true, format.price, 3)
plot(close, "Price", color.red, 4)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor).toMatchObject({ title: "Long title", overlay: true, precision: 3 });
    expect(result.program?.generatedSource).toContain('"color":r.constant("color.red")');
    expect(result.program?.generatedSource).toContain('"linewidth":4');
  });

  it("resolves typed const declarations in input metadata", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Typed constant inputs")
const string SECTION = "Signal"
const string ROW = "Window"
const string HELP = "Bars in the averaging window."
const int DEFAULT_BARS = 21
const int WINDOW = DEFAULT_BARS
const color FILL = color.new(#ff9800, 25)
computed = ta.sma(close, 5)
length = input.int(WINDOW, "Length", group = SECTION, inline = ROW, tooltip = HELP)
lineColor = input.color(FILL, "Line")
note = input.string("value", "Note", tooltip = computed)
plot(close)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs).toEqual([
      expect.objectContaining({ id: "length", defaultValue: 21, group: "Signal", inline: "Window", tooltip: "Bars in the averaging window." }),
      expect.objectContaining({ id: "lineColor", defaultValue: "#FF9800BF" }),
      expect.objectContaining({ id: "note", tooltip: "computed" }),
    ]);
  });

  it("accepts dotted and generic type annotations", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Dotted types")
chart.point[] points = array.new<chart.point>()
var chart.point point = chart.point.new(bar_index, close)
varip array<chart.point> livePoints = array.new<chart.point>()
map<string, chart.point> pointMap = map.new<string, chart.point>()
plot(array.size(points) + array.size(livePoints) + map.size(pointMap))`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["points", "point", "livePoints", "pointMap"]);
  });

  it("accepts shared and repeated comma-separated declarations", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Comma declarations")
float first = 1.0, second = 2.0
float third = 3.0, float fourth = 4.0
chart.point[] left = array.new<chart.point>(), chart.point[] right = array.new<chart.point>()
plot(first + second + third + fourth + array.size(left) + array.size(right))`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["first", "second", "third", "fourth", "left", "right"]);
  });

  it("compiles comma-separated calls, assignments, and mixed statements", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Comma statements")
var x = 0, y = 0
x := 10, y := 20
fast = ta.sma(close, 2), slow = ta.sma(close, 3), plot(fast - slow, "Spread")
plot(close, "Close"), plot(open, "Open"), plot(high, "High")`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["x", "y", "fast", "slow"]);
    expect(result.descriptor?.plots.map((plot) => plot.title)).toEqual(["Spread", "Close", "Open", "High"]);
  });

  it("compiles range and while loops used as expressions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Loop expressions")
sum = 0
rangeResult = for i = 1 to 5
    sum += i
    sum
index = 0
whileResult = while index < 3
    index += 1
    index
plot(rangeResult + whileResult)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("$loopResult");
  });

  it("keeps multiline operator continuations inside callable bodies", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Continuations")
probe(int left, int right) =>
    string summary = "L: " + str.tostring(left) + " " +
                     "R: " + str.tostring(right)
    bool ordered = left <
                   right and
                   not na(summary)
    ordered ? left +
              right : 0
plot(probe(10, 30))`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"str.tostring"');
  });

  it("compiles branch-local declarations in if and switch expressions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Expression locals")
ifResult = if close > open
    body = close - open
    wick = high - close
    body + wick
else
    body = open - close
    wick = open - low
    body + wick
mode = "calculate"
switchResult = switch mode
    "calculate" =>
        temp = close * 2
        adjusted = temp + 10
        adjusted
    => 0.0
plot(ifResult + switchResult)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("$branchLocal");
  });

  it("scopes declarations inside top-level control-flow blocks", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Block locals")
outer = 0
total = 0
while outer < 3
    int inner = 0
    while inner < 4
        total += 1
        inner += 1
    outer += 1
if barstate.isfirst
    chart.point first = chart.point.new(time, na, low)
    chart.point second = chart.point.new(time + 1000, na, high)
    line.new(first, second, xloc = xloc.bar_time)
plot(total)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("$blockLocal");
  });

  it("parses generic UDT fields and member-expression for-in loops", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Generic fields")
type bucket
    array<array<float>> nested = na
    map<string, float> lookup = na
    array<float> prices = na
var value = bucket.new(na, na, array.from(10.0, 20.0, 30.0))
indexSum = 0
valueSum = 0.0
for [index, price] in value.prices
    indexSum += index
    valueSum += price
plot(indexSum + valueSum)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.property(r.get(0),"prices")');
  });

  it.each(["#12345", "#1234567", "#xyzxyz"])("rejects malformed native Pine color literal %s", (color) => {
    const result = compileFixture({
      source: `//@version=6\nindicator("Bad color")\nvalue = input.color(${color}, "Color")`,
    });

    expect(result.program).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("SCRIPT1003");
    expect(result.diagnostics[0]?.message).toContain("expected #RRGGBB or #RRGGBBAA");
  });

  it("auto-types bare inputs and assigns stable variable identifiers", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Bare inputs")
count = input(42, "Duplicate")
ratio = input(3.14, "Duplicate")
label = input("hi", "")
enabled = input(true, "Enabled")
source = input(close, "Source")`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs).toEqual([
      { id: "count", type: "int", title: "Duplicate", defaultValue: 42 },
      { id: "ratio", type: "float", title: "Duplicate", defaultValue: 3.14 },
      { id: "label", type: "string", title: "", defaultValue: "hi" },
      { id: "enabled", type: "bool", title: "Enabled", defaultValue: true },
      { id: "source", type: "source", title: "Source", defaultValue: "close" },
    ]);
    expect(result.program?.generatedSource).toContain('r.input("source","Source",r.data("close"),"source")');
  });

  it("resolves native enum fields for typed enum inputs", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Enums")
enum timezone
    utc = "UTC"
    local = "Exchange"
timezone selected = input.enum(timezone.utc, "Timezone", options=[timezone.utc, timezone.local])
plot(selected == "UTC" ? 1 : 0)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs).toEqual([
      { id: "selected", type: "enum", title: "Timezone", defaultValue: "UTC", options: ["UTC", "Exchange"] },
    ]);
    expect(result.program?.generatedSource).toContain('r.input("selected","Timezone","UTC","enum")');
  });

  it("extracts complete input widget metadata", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Input metadata")
length = input.int(14, "Length", minval=1, maxval=100, step=1, tooltip="Window", inline="row", group="Calculation", confirm=true, display=display.status_line + display.data_window, active=true)
mode = input.string("EMA", "Mode", options=["EMA", "SMA"], tooltip="Average")`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.inputs).toEqual([
      {
        id: "length",
        type: "int",
        title: "Length",
        defaultValue: 14,
        tooltip: "Window",
        inline: "row",
        group: "Calculation",
        confirm: true,
        display: 10,
        active: true,
        minValue: 1,
        maxValue: 100,
        step: 1,
      },
      { id: "mode", type: "string", title: "Mode", defaultValue: "EMA", tooltip: "Average", options: ["EMA", "SMA"] },
    ]);
  });

  it("does not parse operator-shaped strings as operators", () => {
    const result = compileFixture({
      source: '//@version=6\nindicator("Strings")\nplot(str.repeat("x", 3, "-"))',
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"-"');
  });

  it("compiles zero-argument TA properties as calls", () => {
    const result = compileFixture({ source: "//@version=6\nindicator(\"Volume\")\nplot(ta.obv)\nplot(ta.accdist)" });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.obv",[]');
    expect(result.program?.generatedSource).toContain('"ta.accdist",[]');
  });

  it("parses generic map factories and method calls", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Map")\nvar values = map.new<string, float>()\nvalues.put("close", close)\nplot(values.get("close"))' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"map.new"');
    expect(result.program?.generatedSource).toContain('r.method');
  });

  it("dispatches method calls on temporary expression receivers", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Temporary")\nplot(matrix.new<float>(0, 0, 0.0).is_zero())' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.method');
    expect(result.program?.generatedSource).not.toContain('"<expression>.is_zero"');
  });

  it("preserves generic array factory element types", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Arrays")\nints = array.new<int>(2)\nfloats = array.new<float>(2)\nplot(ints.first())' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"array.new_int"');
    expect(result.program?.generatedSource).toContain('"array.new_float"');
  });

  it("rejects loop control outside a loop", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Invalid")\nbreak' });
    expect(result.program).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2010" }));
  });

  it("emits integer division only for statically integer operands", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Division")\nint left = 11\nint right = 2\nwhole = left / right\nfraction = 11.0 / 2.0' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"__idiv"');
    expect(result.program?.generatedSource).toContain('"/"');
  });

  it("compiles security expressions into child plans", () => {
    const result = compileFixture({ source: '//@version=6\nindicator("Request")\nvalue = request.security("NASDAQ:MSFT", "D", ta.sma(close, 2))' });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(1);
    expect(result.program?.requestPlans[0]).toMatchObject({ id: "request-0", symbol: "NASDAQ:MSFT", timeframe: "D" });
    expect(result.program?.generatedSource).toContain('r.request("request-0")');
  });

  it("preserves parenthesized expressions before a security child plan", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Request parenthesized prefix")
isExpansionBar = (high - low > 0) and ((math.abs(close - open) / (high - low)) >= 0.6) and (math.abs(close - open) > ta.atr(10) * 0.7)
requestedClose = request.security(syminfo.tickerid, "D", close)
plot(requestedClose)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(1);
  });

  it("preserves zero-argument calls when slicing request expressions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Request function")
gated() => barstate.islast ? 42.0 : na
value = request.security(syminfo.tickerid, "D", gated())
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans[0]?.program.generatedSource).toContain("fn_gated(0,");
  });

  it("compiles tuple request results inside user functions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Function request tuple")
getData() =>
    [requestedClose, requestedVolume] = request.security(syminfo.tickerid, timeframe.period, [close, volume])
    requestedClose + requestedVolume
value = getData()
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans[0]?.tupleArity).toBe(2);
    expect(result.program?.generatedSource).toContain("r.tupleGet");
  });

  it("slices parameter-bound requests through function call sites", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Function request parameter")
fetch(float source) =>
    request.security(syminfo.tickerid, timeframe.period, ta.sma(source, 2))
value = fetch(close)
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    const childSource = result.program?.requestPlans[0]?.program.source;
    expect(childSource).toContain("__request_capture_request_0_0(float source)");
    expect(childSource).toContain("__request_capture_request_0_0(close)");
  });

  it("slices receiver state before requests inside methods", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Method request")
type Counter
    int n = 0
method tick(Counter this) =>
    this.n += 1
    values = request.security_lower_tf(syminfo.tickerid, timeframe.period, this.n)
    values.first()
var Counter counter = Counter.new()
value = counter.tick()
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    const childSource = result.program?.requestPlans[0]?.program.source;
    expect(childSource).toContain("method __request_capture_request_0_0(Counter this)");
    expect(childSource).toContain("this.n += 1");
    expect(childSource).toContain("counter.__request_capture_request_0_0()");
  });

  it("threads request captures through caller-local bindings", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Nested request caller")
fetch(float source) =>
    request.security(syminfo.tickerid, timeframe.period, source)
wrapper() =>
    localSource = volume
    fetch(localSource)
value = wrapper()
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    const childSource = result.program?.requestPlans[0]?.program.source;
    expect(childSource).toContain("__request_capture_request_0_1()");
    expect(childSource).toContain("localSource = volume");
    expect(childSource).toContain("__request_capture_request_0_0(localSource)");
  });

  it("rejects multiple written callers of a captured request before execution", () => {
    const result = compileProductionFixture({ source: `//@version=6
indicator("Two request callers")
fetch(float source) => request.security(syminfo.tickerid, timeframe.period, source)
plot(fetch(close) + fetch(volume))` });

    expect(result.program).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2012",
      message: "Request expressions in functions with multiple written callers require independent capture plans",
    }));
  });

  it("rejects multiple written callers through a nested capture chain", () => {
    const result = compileProductionFixture({ source: `//@version=6
indicator("Nested request callers")
fetch(float source) => request.security(syminfo.tickerid, timeframe.period, source)
wrapper(float source) => fetch(source)
plot(wrapper(close) + wrapper(volume))` });

    expect(result.program).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2012",
      message: "Request expressions in functions with multiple written callers require independent capture plans",
    }));
  });

  it("slices request dependencies and user functions into child plans", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Request dependencies")
smooth(float source, int length) => ta.sma(source, length)
length = input.int(2, "Length")
basis = hl2
value = request.security("NASDAQ:MSFT", "D", smooth(basis, length))`,
    });
    expect(result.diagnostics).toEqual([]);
    const child = result.program?.requestPlans[0]?.program;
    expect(child?.generatedSource).toContain("const fn_smooth=");
    expect(child?.variableNames).toEqual(["length", "basis", "__request"]);
  });

  it("compiles input-backed request selectors", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Dynamic request")
requestedSymbol = input.symbol("NASDAQ:MSFT", "Requested symbol")
requestedTimeframe = input.timeframe("D", "Requested timeframe")
value = request.security(requestedSymbol, requestedTimeframe, close)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans[0]).toMatchObject({
      symbol: "NASDAQ:MSFT",
      timeframe: "D",
      symbolInputId: "requestedSymbol",
      symbolInputTitle: "Requested symbol",
      timeframeInputId: "requestedTimeframe",
      timeframeInputTitle: "Requested timeframe",
    });
  });

  it("compiles chart symbol and timeframe request selectors", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Chart-relative request")
value = request.security(syminfo.tickerid, timeframe.period, close)
plot(value)`,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toHaveLength(1);
    expect(result.program?.requestPlans[0]).toMatchObject({ symbol: "", timeframe: "" });
  });

  it("extracts alertcondition definitions and stable callsites", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Alerts")
alertcondition(close > open, "Bullish", "Green bar")
if close > open
    alert("Bullish", alert.freq_once_per_bar)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.alerts).toEqual([{ id: "alertcondition_0", title: "Bullish", message: "Green bar" }]);
    expect(result.program?.generatedSource).toContain('r.alertCondition("alertcondition_0"');
    expect(result.program?.generatedSource).toContain('r.alert("alert_0"');
  });

  it("reports source-located unknown identifiers", () => {
    const result = compileFixture({ source: "//@version=5\nx = missing + 1" });
    expect(result.program).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code: "SCRIPT2001", range: { start: { line: 2 } } });
  });

  it("parses callable na and lets declared variables shadow builtin fields", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Shadowing")
second = close + 1
missing = na(close[10])
present = not na(second)
plot(second)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain(',"na",[');
    expect(result.program?.generatedSource).toContain("r.plot(\"plot-0\",r.get(0)");
  });

  it("orders named options for chart-point drawing overloads", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Point options")
p1 = chart.point.from_index(0, 10)
p2 = chart.point.from_index(1, 20)
line.new(p1, p2, color=color.red, width=3, force_overlay=true)
box.new(p1, p2, border_color=color.green, bgcolor=color.blue)
label.new(p1, "Point", color=color.orange, textcolor=color.white)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.descriptor.kind).toBe("indicator");
  });

  it("compiles chart-point field reads and assignments", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Point fields")
point = chart.point.now(close)
point.price += 1
point.index := point.index + 2
point.time := point.time + 100
plot(point.price)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.property(r.get(0),"price")');
    expect(result.program?.generatedSource).toContain('r.updateProperty(r.get(0),"price","+"');
    expect(result.program?.generatedSource).toContain('r.setProperty(r.get(0),"index"');
    expect(result.program?.generatedSource).toContain('r.setProperty(r.get(0),"time"');
  });

  it("accepts typed drawing declarations and typed-na casts", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Typed drawings")
box bx = box(na)
line ln = line(na)
label lb = label(na)
var line current = na
current.set_xy1(bar_index, close)
plot(na(ln) ? 1 : 0)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["bx", "ln", "lb", "current"]);
    expect(result.program?.generatedSource).toContain(',"box",[NaN]');
    expect(result.program?.generatedSource).toContain(',"line",[NaN]');
    expect(result.program?.generatedSource).toContain(',"label",[NaN]');
  });

  it("compiles user-defined types with drawing fields and named constructors", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("UDT drawings")
type Container
    line ln
    label lb = na
    box bx
    float price = na
var Container container = Container.new(
    ln=line.new(na, na, na, na),
    bx=box.new(na, na, na, na))
container.price := close
container.ln.set_xy1(bar_index, high)
plot(container.price)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["container"]);
    expect(result.program?.generatedSource).toContain('r.object("Container",{"ln":r.call(');
    expect(result.program?.generatedSource).toContain('"lb":NaN');
    expect(result.program?.generatedSource).toContain('r.setProperty(r.get(0),"price"');
    expect(result.program?.generatedSource).toContain('r.method(');
  });

  it("compiles UDT arrays, chained fields, and history field reads", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("UDT arrays")
type Wave
    line ln = na
    float price = na
var Wave[] waves = array.new<Wave>(0)
if barstate.isfirst
    waves.push(Wave.new(line.new(na, na, na, na), close))
waves.get(0).ln.set_xy1(bar_index, high)
snapshot = Wave.new(price=close)
previous = snapshot.price[1]
plot(previous)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"array.new_Wave"');
    expect(result.program?.generatedSource).toContain('r.property(r.get(1,1),"price")');
    expect(result.program?.generatedSource).toContain('r.property(r.method(');
  });

  it("accepts typed UDT arrays and variadic builtins in the production profile", () => {
    const result = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: [
        "//@version=6",
        "indicator(\"Typed arrays and variadics\")",
        "type State",
        "    float value = na",
        "var states = array.new<State>(2)",
        "values = array.from(1.0, 2.0, 3.0)",
        "plot(array.size(states) + array.size(values))",
      ].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"array.new_State"');
    expect(result.program?.generatedSource).toContain('"array.from",[1,2,3]');
  });

  it("accepts implemented visual namespace constants and still rejects unknown members", () => {
    const accepted = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: [
        "//@version=6",
        "indicator(\"Visual constants\")",
        "plot(close, style=plot.style_linebr)",
        "line.new(bar_index, close, bar_index + 1, close, style=line.style_dotted)",
        "label.new(bar_index, close, style=label.style_label_right, text_font_family=font.family_monospace)",
      ].join("\n"),
    });
    expect(accepted.diagnostics).toEqual([]);

    const rejected = compile({
      compatibility: PINE_COMPATIBILITY.strict,
      source: "//@version=6\nindicator(\"Unknown constant\")\nplot(close, style=plot.style_not_real)",
    });
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2015", message: "Unknown namespace variable 'plot.style_not_real'" }));
  });

  it("compiles user-defined methods with receiver mutation, defaults, and function-name collisions", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("UDT methods")
type Fib
    line first = na
    line second = na
    float last = na
setLines(float value) => value * 2
method setLines(Fib fib, int x1, int x2, float value, float offset=10) =>
    fib.first.set_xy1(x1, value)
    fib.first.set_xy2(x2, value)
    fib.second.set_xy1(x1, value + offset)
    fib.second.set_xy2(x2, value + offset)
    fib.last := value
    fib
var Fib state = Fib.new(line.new(na, na, na, na), line.new(na, na, na, na))
updated = state.setLines(x1=bar_index-1, x2=bar_index, value=close)
regular = setLines(close)
plot(updated.last + regular)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const fn_setLines=");
    expect(result.program?.generatedSource).toContain("const method_Fib_setLines=");
    expect(result.program?.generatedSource).toContain("method_Fib_setLines(");
    expect(result.program?.generatedSource).toContain('r.setProperty(p0.get(0),"last"');
  });

  it("compiles nested and call-chain UDT field assignments", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Nested UDT writes")
type Item
    float value = 0
type Holder
    Item nested
var Item[] items = array.new<Item>(0)
if barstate.isfirst
    items.push(Item.new())
var Holder holder = Holder.new(Item.new())
items.get(0).value := close
items.get(0).value += 1
holder.nested.value := high
plot(items.get(0).value + holder.nested.value)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.setProperty(r.method(');
    expect(result.program?.generatedSource).toContain('r.updateProperty(r.method(');
    expect(result.program?.generatedSource).toContain('r.setProperty(r.property(r.get(1),"nested"),"value"');
  });

  it("compiles static and instance UDT copies", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("UDT copy")
type Holder
    line ln = na
    float price = na
var Holder original = Holder.new(line.new(na, na, na, na), close)
staticCopy = Holder.copy(original)
instanceCopy = original.copy()
staticCopy.price := close
instanceCopy.price := high
plot(original.price + staticCopy.price + instanceCopy.price)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.copyObject(r.get(0),"Holder")');
    expect(result.program?.generatedSource).toContain('r.get(0),"copy",[]');
  });

  it("dispatches overloaded UDT methods by receiver type without stealing builtin methods", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Typed method dispatch")
type Counter
    int value = 0
type Meter
    int value = 0
method apply(Counter receiver, int amount) =>
    receiver.value += amount
    receiver
method apply(Meter receiver, int amount) =>
    receiver.value += amount * 2
    receiver
method delete(Counter receiver) => receiver
var Counter counter = Counter.new()
var Meter meter = Meter.new()
counter.apply(1)
apply(meter, 2)
var line builtin = line.new(na, na, na, na)
builtin.delete()
plot(counter.value + meter.value)`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain("const method_Counter_apply=");
    expect(result.program?.generatedSource).toContain("const method_Meter_apply=");
    expect(result.program?.generatedSource).toContain('r.objectType($receiver)==="Counter"');
    expect(result.program?.generatedSource).toContain('r.objectType($receiver)==="Meter"');
    expect(result.program?.generatedSource).toContain('r.method(');
    expect(result.program?.generatedSource).toContain('$receiver,"delete",[]');
  });

  it("selects same-receiver method signatures and rejects duplicate or ambiguous calls", () => {
    const source = `//@version=6
indicator("Method signatures")
type Item
    int value
method read(Item self) => self.value
method read(Item self, int extra) => self.value + extra
method read(Item self, bool extra) => extra ? self.value + 10 : self.value
plot(Item.new(2).read() + Item.new(2).read(extra=3) + Item.new(2).read(true))`;
    const result = compileProductionFixture({ source });
    expect(result.diagnostics).toEqual([]);
    const generated = result.program?.generatedSource ?? "";
    expect([...generated.matchAll(/const (method_Item_read\$[A-Za-z0-9_]+)=/gu)].map((match) => match[1]).length).toBe(3);

    const duplicate = compileProductionFixture({ source: `//@version=6
indicator("Duplicate")
type Item
    int value
method read(Item self) => self.value
method read(Item self, int optional=1) => self.value + optional
plot(Item.new(2).read())` });
    expect(duplicate.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2013" && diagnostic.message.includes("duplicate required signature"))).toBe(true);

    const equivalentArray = compileProductionFixture({ source: `//@version=6
indicator("Equivalent array signatures")
type Item
    int value
method read(Item self, array<float> values) => 1
method read(Item self, float[] values) => 2
plot(Item.new(0).read(array.new_float(0)))` });
    expect(equivalentArray.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2013"
      && diagnostic.message.includes("duplicate required signature"))).toBe(true);

    const equivalentUdt = compileProductionFixture({ source: `//@version=6
indicator("Equivalent UDT qualifiers")
type Item
    int value
method read(Item self, Item other) => 1
method read(Item self, simple Item other) => 2
item = Item.new(0)
plot(item.read(item))` });
    expect(equivalentUdt.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2013"
      && diagnostic.message.includes("duplicate required signature"))).toBe(true);

    for (const enumName of ["Mode", "line"]) {
      const distinctEnum = compileProductionFixture({ source: `//@version=6
indicator("Distinct enum qualifiers")
enum ${enumName}
    first
type Item
    int value
method read(Item self, simple ${enumName} mode) => 1
method read(Item self, series ${enumName} mode) => 2
plot(1)` });
      expect(distinctEnum.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2013")).toBe(false);
    }

    const ambiguous = compileProductionFixture({ source: `//@version=6
indicator("Ambiguous")
type Item
    int value
method read(Item self, int extra) => self.value + extra
method read(Item self, bool extra) => extra ? self.value : 0
f(extra) => Item.new(2).read(extra)
plot(f(1))` });
    expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2018", message: "Ambiguous method overload 'read'" }));
  });

  it("preserves namespace calls when a method parameter shadows the namespace", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("Namespace shadow")
type Palette
    color shade = na
method apply(Palette receiver, color color) =>
    receiver.shade := color.new(color, 50)
    receiver
var Palette palette = Palette.new()
updated = palette.apply(color.red)
plot(color.r(updated.shade))`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.call(r.scope($scope,0),"color.new",[p1.get(0),50])');
    expect(result.program?.generatedSource).not.toContain('p1.get(0),"new"');
  });

  it("emits source-aware TA calls for directly addressable series", () => {
    const result = compileFixture({
      source: `//@version=6
indicator("TA backfill")
source = close
if barstate.islast
    plot(ta.sma(close, 3))
    plot(ta.highest(source, 3))`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.sma",[r.data("close"),3],r.dataRef("close")');
    expect(result.program?.generatedSource).toContain('"ta.highest",[r.get(0),3],r.variableRef(0)');
  });

  it("accepts typed and persistent declarations", () => {
    const result = compileFixture({
      source: "//@version=6\nint length = 3\nvar float total = 0.0\ntotal := total + close\nplot(total)",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.variableNames).toEqual(["length", "total"]);
  });

  it("uses callable metadata to lower out-of-order named builtin arguments in the production profile", () => {
    const result = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Named builtin\")", "length = input.int(title=\"Length\", defval=2)", "average = ta.sma(length=length, source=close)", "plot(average)"].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.sma",[r.data("close"),r.get(0)],r.dataRef("close")');
  });

  it("uses callable metadata to extract out-of-order request arguments in the production profile", () => {
    const result = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Named request\")", "requested = request.security(expression=close, calc_bars_count=25, timeframe=\"D\", symbol=\"TEST:DAILY\")", "plot(requested)"].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.requestPlans).toEqual([expect.objectContaining({ symbol: "TEST:DAILY", timeframe: "D", calcBarsCount: 25 })]);
  });

  it("maps lower-timeframe request parameters at their metadata positions in the production profile", () => {
    const named = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Named lower request\")", "requested = request.security_lower_tf(calc_bars_count=12, expression=close, ignore_invalid_timeframe=true, timeframe=\"1\", symbol=\"TEST:LOWER\")", "plot(array.size(requested))"].join("\n"),
    });
    const positional = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Positional lower request\")", "requested = request.security_lower_tf(\"TEST:LOWER\", \"1\", close, false, currency.NONE, true, 13)", "plot(array.size(requested))"].join("\n"),
    });

    expect(named.diagnostics).toEqual([]);
    expect(named.program?.requestPlans).toEqual([expect.objectContaining({ kind: "security_lower_tf", symbol: "TEST:LOWER", timeframe: "1", ignoreInvalidTimeframe: true, calcBarsCount: 12 })]);
    expect(positional.diagnostics).toEqual([]);
    expect(positional.program?.requestPlans).toEqual([expect.objectContaining({ kind: "security_lower_tf", ignoreInvalidTimeframe: true, calcBarsCount: 13 })]);
  });

  it("keeps only default static request options executable and fails closed for unsupported symbol and currency behavior", () => {
    const namedDefaults = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Named default request options\")", "requested = request.security(expression=close, currency=currency.NONE, ignore_invalid_symbol=false, timeframe=\"D\", symbol=\"TEST:DAILY\")", "plot(requested)"].join("\n"),
    });
    const positionalDefaults = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Positional default request options\")", "requested = request.security(\"TEST:DAILY\", \"D\", close, barmerge.gaps_off, barmerge.lookahead_off, false, currency.NONE)", "plot(requested)"].join("\n"),
    });
    const unsupported = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Unsupported request options\")", "one = request.security(\"TEST:ONE\", \"D\", close, ignore_invalid_symbol=true)", "two = request.security(\"TEST:TWO\", \"D\", close, currency=currency.USD)", "three = request.security_lower_tf(\"TEST:THREE\", \"1\", close, true, currency.NONE, false)", "four = request.security_lower_tf(\"TEST:FOUR\", \"1\", close, currency=currency.MYR)", "plot(one)"].join("\n"),
    });

    expect(namedDefaults.diagnostics).toEqual([]);
    expect(namedDefaults.program?.requestPlans).toEqual([expect.objectContaining({ symbol: "TEST:DAILY", timeframe: "D" })]);
    expect(positionalDefaults.diagnostics).toEqual([]);
    expect(positionalDefaults.program?.requestPlans).toEqual([expect.objectContaining({ symbol: "TEST:DAILY", timeframe: "D" })]);
    const unsupportedDiagnostics = unsupported.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2018");
    expect(unsupportedDiagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining("ignore_invalid_symbol"),
      expect.stringContaining("currency"),
      expect.stringContaining("ignore_invalid_symbol"),
      expect.stringContaining("currency"),
    ]);
    expect(unsupportedDiagnostics.every((diagnostic) => diagnostic.range !== undefined)).toBe(true);
  });

  it("uses currency.NONE as the current-profile default and types cross-currency calls", () => {
    const source = ["//@version=6", "strategy(\"Currency default\")", "account = strategy.account_currency"].join("\n");
    const frozen = compileFixture({ source });
    const production = compileProductionFixture({ source });
    const explicitNone = compileProductionFixture({
      source: ["//@version=6", "strategy(\"Explicit chart currency\", currency=currency.NONE)"].join("\n"),
    });
    const converted = compileProductionFixture({
      source: ["//@version=6", "strategy(\"USD account\", currency=currency.USD)", "account = strategy.convert_to_account(100)", "symbol = strategy.convert_to_symbol(25)"].join("\n"),
    });

    expect(frozen.diagnostics).toEqual([]);
    expect(frozen.descriptor?.strategy?.currency).toBe("USD");
    expect(production.diagnostics).toEqual([]);
    expect(production.descriptor?.strategy?.currency).toBe("NONE");
    expect(explicitNone.diagnostics).toEqual([]);
    expect(explicitNone.descriptor?.strategy?.currency).toBe("NONE");
    expect(converted.diagnostics).toEqual([]);
    expect(converted.descriptor?.strategy?.currency).toBe("USD");
    const wrong = compileProductionFixture({
      source: ["//@version=6", "strategy(\"Wrong type\")", "account = strategy.convert_to_account(\"100\")"].join("\n"),
    });
    expect(wrong.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
  });

  it("uses callable metadata for determinate receiver-method named arguments in the production profile", () => {
    const result = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Named receiver\")", "var values = array.new_int()", "values.push(value=7)", "plot(array.get(index=0, id=values))"].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.method(1,r.get(0),"push",[7],"array")');
    expect(result.program?.generatedSource).toContain('"array.get",[r.get(0),0]');
  });

  it("accepts active named arguments for generic, bool, color, and time inputs in the production profile", () => {
    const result = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Input active\")", "generic = input(active=true, defval=1)", "enabled = input.bool(active=true, defval=true)", "shade = input.color(active=true, defval=color.red)", "moment = input.time(active=true, defval=0)", "plot(generic)", "plot(enabled ? 1 : 0)", "plot(shade == color.red ? 1 : 0)", "plot(moment)"].join("\n"),
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.descriptor?.inputs.map((input) => input.active)).toEqual([true, true, true, true]);
  });

  it("emits global varip persistence mode only in the production profile", () => {
    const source = ["//@version=6", "indicator(\"Global varip\")", "varip counter = 0", "counter += 1", "plot(counter)"].join("\n");

    expect(compileFixture({ source }).program?.generatedSource).toContain("r.setPersistent(0,()=>0)");
    expect(compileProductionFixture({ source }).program?.generatedSource).toContain('r.setPersistent(0,()=>0,"varip")');
  });

  it("fails closed for invalid named arguments and determinable unknown symbols in the production profile", () => {
    const result = compileProductionFixture({
      source: ["//@version=6", "indicator(\"Validation\")", "identity(value) => value", "one = ta.sma(close, length=2, 3)", "two = ta.sma(close, length=2, length=3)", "three = ta.sma(close, missing=2)", "four = identity()", "five = identity(1, 2)", "six = missing_callable()", "seven = ta.missing_callable(close)", "eight = syminfo.unknown_field", "plot(one)"].join("\n"),
    });

    expect(result.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2014").map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      "Positional arguments cannot follow named arguments in 'ta.sma'",
      "Argument 'length' is specified more than once for 'ta.sma'",
      "Unknown argument 'missing' for 'ta.sma'",
      "Missing required argument 'value' for 'identity'",
      "'identity' accepts at most 1 argument",
    ]));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2015", message: "Unknown callable 'missing_callable'" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2015", message: "Unknown namespace callable 'ta.missing_callable'" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2015", message: "Unknown namespace variable 'syminfo.unknown_field'" }));
  });

  it("requires one global declaration and prohibits global-only calls in local scopes in the production profile", () => {
    const missing = compileProductionFixture({ source: "//@version=6\nplot(close)" });
    expect(missing.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2016" && diagnostic.message.includes("exactly one global"))).toBe(true);

    const duplicateAndLocal = compileProductionFixture({
      source: ["//@version=6", "indicator(\"First\")", "strategy(\"Second\")", "if barstate.isfirst", "    plot(close)"].join("\n"),
    });
    expect(duplicateAndLocal.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2016" && diagnostic.message.includes("only one global"))).toBe(true);
    expect(duplicateAndLocal.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2016", message: "'plot()' is only allowed in global scope" }));

    const library = compileProductionFixture({ source: "//@version=6\nlibrary(overlay=true, title=\"Exports\")" });
    expect(library.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2017" && diagnostic.message.includes("does not execute or export"))).toBe(true);
  });

  it("enables %= and if expressions without else only in the production profile", () => {
    const source = ["//@version=6", "indicator(\"New syntax\")", "value = 5", "value %= 2", "maybe = if false", "    1", "plot(value)", "plot(maybe)"].join("\n");

    const frozen = compileFixture({ source });
    expect(frozen.diagnostics[0]).toMatchObject({ code: "SCRIPT1003" });
    const result = compileProductionFixture({ source });
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.binary("%"');
    expect(result.program?.generatedSource).toContain("else{return NaN;}");
  });
});
