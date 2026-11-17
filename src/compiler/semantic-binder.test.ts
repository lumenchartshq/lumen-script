import { describe, expect, it } from "vitest";
import { PINE_CALLABLE_METADATA, PINE_COMPATIBILITY } from "../contracts/index.js";
import { compile } from "./index.js";

const compileCurrent = (source: string) => compile({ compatibility: PINE_COMPATIBILITY.strict, source });

describe("strict-profile semantic binder", () => {
  it("models the complete qualifier hierarchy", () => {
    const valid = compileCurrent(`//@version=6
indicator("Qualifiers")
const float constant = 1
configured = input.int(2)
simple float stable = configured
series float changing = close
plot(constant + stable + changing)`);
    expect(valid.diagnostics).toEqual([]);
  });

  it("types mathematical namespace constants as const floats", () => {
    const result = compileCurrent(`//@version=6
indicator("Math constant types")
const float eValue = math.e
const float phiValue = math.phi
const float piValue = math.pi
const float rphiValue = math.rphi
plot(eValue + phiValue + piValue + rphiValue)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.constant("math.e")');
    expect(result.program?.generatedSource).toContain('r.constant("math.rphi")');
  });

  it("types display and formatting namespace constants with exact const kinds", () => {
    const result = compileCurrent(`//@version=6
indicator("Display constant types")
const int weekday = dayofweek.monday
const int displayMask = display.all
const int sortOrder = order.ascending
const string extension = extend.both
const string fontFamily = font.family_monospace
const string numberFormat = format.mintick
const string horizontalLine = hline.style_dashed
const string plotLocation = location.abovebar
const string plotStyle = plot.style_line
const string tablePosition = position.top_right
const string markerShape = shape.arrowdown
const string markerSize = size.normal
const string textAlignment = text.align_center
const string xLocation = xloc.bar_index
const string yLocation = yloc.price
plot(weekday + displayMask + sortOrder + (extension == "b" and fontFamily == "monospace" and numberFormat == "mintick" and horizontalLine == "dashed" and plotLocation == "AboveBar" and plotStyle == "style_line" and tablePosition == "top_right" and markerShape == "shape_arrow_down" and markerSize == "normal" and textAlignment == "center" and xLocation == "bi" and yLocation == "pr" ? 1 : 0))`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.constant("dayofweek.monday")');
    expect(result.program?.generatedSource).toContain('r.constant("plot.style_line")');
    expect(result.program?.generatedSource).toContain('r.constant("yloc.price")');
  });

  it("rejects display and formatting constants assigned to the wrong scalar kind", () => {
    for (const source of [
      "const string invalidWeekday = dayofweek.monday",
      "const string invalidDisplay = display.all",
      "const string invalidOrder = order.ascending",
      "const int invalidStyle = plot.style_line",
      "const int invalidPosition = position.top_right",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Display constant type rejection")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("types static selector namespace constants as const strings", () => {
    const result = compileCurrent(`//@version=6
indicator("Static selector constant types")
const string alertAll = alert.freq_all
const string alertOnce = alert.freq_once_per_bar
const string alertClose = alert.freq_once_per_bar_close
const string backadjustmentInherit = backadjustment.inherit
const string backadjustmentOff = backadjustment.off
const string backadjustmentOn = backadjustment.on
const string gapsOff = barmerge.gaps_off
const string gapsOn = barmerge.gaps_on
const string lookaheadOff = barmerge.lookahead_off
const string lookaheadOn = barmerge.lookahead_on
const string dividendsGross = dividends.gross
const string dividendsNet = dividends.net
const string earningsActual = earnings.actual
const string earningsEstimate = earnings.estimate
const string earningsStandardized = earnings.standardized
const string splitsDenominator = splits.denominator
const string splitsNumerator = splits.numerator
plot(alertAll == "alert.freq_all" and alertOnce == "alert.freq_once_per_bar" and alertClose == "alert.freq_once_per_bar_close" and backadjustmentInherit == "inherit" and backadjustmentOff == "off" and backadjustmentOn == "on" and gapsOff == "gaps_off" and gapsOn == "gaps_on" and lookaheadOff == "lookahead_off" and lookaheadOn == "lookahead_on" and dividendsGross == "dividends_gross" and dividendsNet == "dividends_net" and earningsActual == "earnings_actual" and earningsEstimate == "earnings_estimate" and earningsStandardized == "earnings_standardized" and splitsDenominator == "splits_denominator" and splitsNumerator == "splits_numerator" ? 1 : 0)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.constant("alert.freq_all")');
    expect(result.program?.generatedSource).toContain('r.constant("barmerge.lookahead_on")');
    expect(result.program?.generatedSource).toContain('r.constant("earnings.standardized")');
    expect(result.program?.generatedSource).toContain('r.constant("splits.numerator")');
  });

  it("rejects static selector constants assigned to the wrong scalar kind", () => {
    for (const source of [
      "const int invalidAlert = alert.freq_all",
      "const int invalidBackadjustment = backadjustment.on",
      "const int invalidBarmerge = barmerge.gaps_off",
      "const int invalidDividends = dividends.gross",
      "const int invalidEarnings = earnings.actual",
      "const int invalidSplits = splits.numerator",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Static selector type rejection")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("rejects nonnumeric deterministic math arguments and noninteger round precision", () => {
    for (const source of [
      'value = math.abs("bad")',
      'value = math.avg(1.0, "bad")',
      'value = math.acos("bad")',
      'value = math.pow(2.0, "bad")',
      'value = math.round(1.25, precision = 1.5)',
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Math argument types")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("types random, mintick rounding and rolling sums with their admitted qualifiers", () => {
    const result = compileCurrent(`//@version=6
indicator("Stateful math contracts")
series float seeded = math.random(seed = bar_index)
series float bounded = math.random(min = -2.0, max = 3.0, seed = 42)
simple float simpleRounded = math.round_to_mintick(1.125)
series float seriesRounded = math.round_to_mintick(number = close)
series float rolling = math.sum(source = close, length = bar_index % 3 + 1)
plot(seeded + bounded + simpleRounded + seriesRounded + rolling)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"math.random",[undefined,undefined,r.barIndex]');
    expect(result.program?.generatedSource).toContain('"math.round_to_mintick",[r.data("close")]');
    expect(result.program?.generatedSource).toContain('"math.sum"');
  });

  it("rejects invalid remaining-math argument and result types", () => {
    for (const source of [
      'value = math.random(min = "bad")',
      "value = math.random(seed = 1.5)",
      'value = math.round_to_mintick("bad")',
      'value = math.sum("bad", 2)',
      'value = math.sum(close, "bad")',
      "simple float invalid = math.random(seed = 42)",
      "simple float invalid = math.round_to_mintick(close)",
      "simple float invalid = math.sum(close, 2)",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Remaining math rejection")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({
        code: source.startsWith("simple float") ? "SCRIPT2102" : "SCRIPT2117",
      }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("rejects invalid core string argument types", () => {
    for (const source of [
      'value = str.contains(1, "x")',
      'value = str.endswith("x", 1)',
      "value = str.length(1)",
      "value = str.lower(1)",
      'value = str.pos("x", 1)',
      'value = str.repeat("x", 1.5)',
      'value = str.replace("x", "x", "y", 1.5)',
      'value = str.replace_all("x", "x", 1)',
      'value = str.split("x", 1)',
      'value = str.startswith(1, "x")',
      'value = str.substring("x", 0.5)',
      "value = str.tonumber(1)",
      "value = str.trim(1)",
      "value = str.upper(1)",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("String argument types")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("binds reordered named core string arguments and exact result types", () => {
    const result = compileCurrent(`//@version=6
indicator("String contracts")
series string changing = close > open ? "A😀B" : " A-b-b "
series bool contains = str.contains(str = "😀", source = changing)
series bool ending = str.endswith(str = "B", source = changing)
series int length = str.length(string = changing)
series string lower = str.lower(string = changing)
series int position = str.pos(str = "B", source = changing)
series string repeated = str.repeat(separator = "-", repeat = 2, source = changing)
series string replaced = str.replace(occurrence = 1, replacement = "x", target = "b", source = changing)
series string allReplaced = str.replace_all(replacement = "x", target = "b", source = changing)
array<string> parts = str.split(separator = "-", string = changing)
series bool starting = str.startswith(str = "A", source = changing)
series string substring = str.substring(end_pos = 2, begin_pos = 1, source = changing)
series float number = str.tonumber(string = "12.5")
series string trimmed = str.trim(string = changing)
series string upper = str.upper(string = changing)
plot(contains and ending and starting ? length + position + number : 0)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"str.repeat",[r.get(0),2,"-"]');
    expect(result.program?.generatedSource).toContain('"str.substring",[r.get(0),1,2]');
  });

  it("rejects invalid advanced string argument types and undocumented collections", () => {
    for (const source of [
      "value = str.format(1, 2)",
      'value = str.format("{0}", array.from(1, 2))',
      'value = str.format_time("not-time")',
      "value = str.format_time(time, 1)",
      'value = str.match(1, "x")',
      'value = str.match("x", 1)',
      "value = str.tostring(map.new<string, float>())",
      "value = str.tostring(1, 2)",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Advanced string argument types")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("binds named advanced string arguments and exact result types", () => {
    const result = compileCurrent(`//@version=6
indicator("Advanced string contracts")
series string formatted = str.format(formatString = "{0}", arg0 = close)
series string formattedTime = str.format_time(time = time, timezone = "UTC+5:45", format = "yyyy-MM-dd HH:mm")
series string matched = str.match(regex = "[A-Z]+", source = close > open ? "UP" : "down")
series string rendered = str.tostring(value = close, format = format.mintick)
series string renderedArray = str.tostring(array.from(1, 2))
plot(formatted == "" or formattedTime == "" or matched == "" or rendered == "" ? 0 : 1)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"str.format_time",[r.data("time"),"yyyy-MM-dd HH:mm","UTC+5:45"]');
    expect(result.program?.generatedSource).toContain('"str.match"');
    expect(result.program?.generatedSource).toContain('"str.tostring"');
  });

  it("types pivot, SAR and Supertrend arguments and results", () => {
    const result = compileCurrent(`//@version=6
indicator("Pivot and trend contracts")
int dynamicLeft = bar_index % 2
series float explicitHigh = ta.pivothigh(source = close, leftbars = dynamicLeft, rightbars = 1)
series float implicitHigh = ta.pivothigh(leftbars = 2, rightbars = 1)
series float explicitLow = ta.pivotlow(close, dynamicLeft, 1)
series float implicitLow = ta.pivotlow(2, 1)
series float sarValue = ta.sar(start = 0.02, inc = 0.02, max = 0.2)
[supertrendLine, supertrendDirection] = ta.supertrend(factor = close > open ? 2.0 : 3.0, atrPeriod = 2)
series float typedLine = supertrendLine
series int typedDirection = supertrendDirection
plot(explicitHigh + implicitHigh + explicitLow + implicitLow + sarValue + typedLine + typedDirection)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.pivothigh",[2,1]');
    expect(result.program?.generatedSource).toContain('"ta.sar",[0.02,0.02,0.2]');
    expect(result.program?.generatedSource).toContain('"ta.supertrend"');
  });

  it("rejects invalid pivot, SAR and Supertrend argument kinds and qualifiers", () => {
    for (const source of [
      "value = ta.pivothigh(1.5, 1)",
      'value = ta.pivothigh("bad", 1, 1)',
      "value = ta.pivotlow(1, 1.5)",
      'value = ta.sar("bad", 0.02, 0.2)',
      "value = ta.sar(bar_index, 0.02, 0.2)",
      'values = ta.supertrend("bad", 2)',
      "values = ta.supertrend(2, bar_index)",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Pivot and trend argument rejection")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("rejects wrong pivot and Supertrend result kinds or qualifiers", () => {
    for (const source of [
      "series int invalid = ta.pivothigh(close, 1, 1)",
      "simple float invalid = ta.pivotlow(close, 1, 1)",
      "[line, direction] = ta.supertrend(2, 2)\nseries bool invalid = direction",
      "[line, direction] = ta.supertrend(2, 2)\nsimple float invalid = line",
    ]) {
      const result = compileCurrent(`//@version=6\nindicator("Pivot and trend result rejection")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("rejects stronger values assigned to explicit weaker qualifiers", () => {
    const constant = compileCurrent(`//@version=6
indicator("Constant")
const float invalid = close`);
    const simple = compileCurrent(`//@version=6
indicator("Simple")
simple float invalid = close`);

    expect(constant.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    expect(simple.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    expect(simple.program).toBeUndefined();
  });

  it("prevents const reassignment while strengthening inferred variables", () => {
    const immutable = compileCurrent(`//@version=6
indicator("Const")
const float value = 1
value := 2`);
    const inferred = compileCurrent(`//@version=6
indicator("Inferred")
value = 1.0
value := close
plot(value)`);

    expect(immutable.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2104" }));
    expect(inferred.diagnostics).toEqual([]);
  });

  it("rejects void expressions in declaration and assignment value positions", () => {
    const declaration = compileCurrent(`//@version=6
indicator("Void declaration")
value = log.info("message")`);
    const tuple = compileCurrent(`//@version=6
indicator("Void tuple")
[first, second] = log.warning("message")`);
    const assignment = compileCurrent(`//@version=6
indicator("Void assignment")
value = 1
value := log.error("message")`);
    const conditional = compileCurrent(`//@version=6
indicator("Void conditional")
value = close > open ? log.info("up") : log.warning("down")`);
    const ifExpression = compileCurrent(`//@version=6
indicator("Void if expression")
value = if close > open
    log.info("up")
else
    log.warning("down")`);

    expect(declaration.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    expect(tuple.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    expect(assignment.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    expect(conditional.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    expect(ifExpression.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    expect(declaration.program).toBeUndefined();
    expect(tuple.program).toBeUndefined();
    expect(assignment.program).toBeUndefined();
    expect(conditional.program).toBeUndefined();
    expect(ifExpression.program).toBeUndefined();
  });

  it("rejects invalid float-array constructor, receiver, and index types", () => {
    const sources = [
      'values = array.new_float("bad")',
      'values = array.new_float(1, "bad")',
      'values = array.new_float()\nx = array.get(values, "bad")',
      'x = array.pop(1)',
      'x = array.size(1)',
    ];
    for (const source of sources) {
      const result = compileCurrent(`//@version=6\nindicator("Invalid array")\n${source}`);
      expect(result.diagnostics, source).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
      expect(result.program, source).toBeUndefined();
    }
  });

  it("preserves omitted and reordered named float-array constructor slots", () => {
    const result = compileCurrent(`//@version=6
indicator("Named float arrays")
initialOnly = array.new_float(initial_value = 1.5)
ordered = array.new_float(size = 2, initial_value = 2.5)
reordered = array.new_float(initial_value = 3.5, size = 2)
plot(array.size(initialOnly))
plot(array.get(ordered, 0))
plot(array.get(reordered, 1))`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"array.new_float",[undefined,1.5]');
    expect(result.program?.generatedSource).toContain('"array.new_float",[2,2.5]');
    expect(result.program?.generatedSource).toContain('"array.new_float",[2,3.5]');
  });

  it("validates typed and qualified function parameters", () => {
    const result = compileCurrent(`//@version=6
indicator("Parameters")
first(simple int length, series float source) => source[length]
plot(first(close, 2))`);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2113" }));
  });

  it("keeps enum identity and UDT fields distinct", () => {
    const result = compileCurrent(`//@version=6
indicator("Nominal types")
enum Side
    Long
    Short
enum Mode
    Long
    Short
type State
    Side side = Side.Long
State state = State.new()
state.side := Mode.Long`);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2106" }));
  });

  it("validates collection element assignments", () => {
    const result = compileCurrent(`//@version=6
indicator("Collections")
array<float> values = array.new<float>()
values.push("wrong")`);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
  });

  it("preserves collection kinds and validates method value positions", () => {
    const valid = compileCurrent(`//@version=6
indicator("Collection methods")
array<string> names = array.new<string>()
names.fill("ok", 0, 1)
map<string, float> values = map.new<string, float>()
values.put("answer", 42)
map<string, float> copied = values.copy()
string found = ""
for [key, value] in copied
    found := key`);
    const invalid = compileCurrent(`//@version=6
indicator("Collection method types")
array<string> names = array.new<string>()
names.fill(1, 0, 1)
map<string, float> values = map.new<string, float>()
values.put(1, "wrong")`);

    expect(valid.diagnostics).toEqual([]);
    expect(invalid.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2111")).toHaveLength(3);
  });

  it("types array mutation results and rejects invalid receivers, indexes, and element arrays", () => {
    const valid = compileCurrent(`//@version=6
indicator("Array mutation types")
type Item
    float value
array<int> values = array.from(1, 2, 3)
int firstValue = array.first(values)
int lastValue = array.last(values)
int shifted = array.shift(values)
array.unshift(values, shifted)
array.insert(values, 1, 4)
int removed = array.remove(values, 1)
array<int> copied = array.copy(values)
array<int> combined = array.concat(values, copied)
array<int> sliced = array.slice(values, 0, 1)
array<Item> objects = array.from(Item.new(1.0))
Item objectFirst = array.first(objects)
array.fill(values, removed, 0, 1)
array.reverse(values)
array.clear(values)`);
    expect(valid.diagnostics).toEqual([]);

    for (const expression of [
      "array.clear(1)",
      "array.fill(1, 2)",
      "value = array.first(1)",
      "value = array.last(1)",
      "array.insert(1, 0, 2)",
      "value = array.remove(1, 0)",
      "array.reverse(1)",
      "value = array.shift(1)",
      "array.unshift(1, 2)",
      "value = array.copy(1)",
      "value = array.concat(1, array.from(2))",
      "value = array.slice(1, 0, 1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid receiver")\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    const invalidIndexes = compileCurrent(`//@version=6
indicator("Invalid array mutation indexes")
values = array.from(1.0, 2.0)
array.fill(values, 3.0, 0.5, 1)
array.insert(values, "bad", 3.0)
removed = array.remove(values, 1.5)
window = array.slice(values, 0, 1.5)`);
    expect(invalidIndexes.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2117")).toHaveLength(4);

    const incompatibleConcat = compileCurrent(`//@version=6
indicator("Invalid concat elements")
floats = array.from(1.0)
strings = array.from("one")
combined = array.concat(floats, strings)`);
    expect(incompatibleConcat.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
  });

  it("applies the same array mutation contracts to positional and named method syntax", () => {
    const valid = compileCurrent(`//@version=6
indicator("Array mutation methods")
array<float> values = array.from(1.0, 2.0, 3.0)
values.fill(4.0, 0, 1)
values.fill(value = 5.0, index_from = 0, index_to = 1)
values.insert(0, 6.0)
values.insert(index = 1, value = 7.0)
float removedPositionally = values.remove(0)
float removedByName = values.remove(index = 0)
array<float> positionalSlice = values.slice(0, 1)
array<float> namedSlice = values.slice(index_from = 0, index_to = 1)
array<float> copied = values.copy()
array<float> concatenated = values.concat(id2 = copied)
float firstValue = values.first()
float lastValue = values.last()
float shifted = values.shift()
values.unshift(shifted)
values.reverse()
values.clear()`);
    expect(valid.diagnostics).toEqual([]);

    for (const expression of [
      "values.fill(2.0, 0.5, 1)",
      "values.fill(value = 2.0, index_from = \"bad\", index_to = 1)",
      "values.insert(0.5, 2.0)",
      "values.insert(index = \"bad\", value = 2.0)",
      "result = values.remove(0.5)",
      "result = values.remove(index = \"bad\")",
      "result = values.slice(0, 0.5)",
      "result = values.slice(index_from = 0, index_to = \"bad\")",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array method index")\nvalues = array.from(1.0, 2.0)\n${expression}`);
      expect(invalid.diagnostics, expression).toEqual([
        expect.objectContaining({ code: "SCRIPT2117" }),
      ]);
    }

    for (const expression of [
      "values.fill(\"bad\")",
      "values.insert(index = 0, value = \"bad\")",
      "values.unshift(\"bad\")",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array method value")\nvalues = array.from(1.0)\n${expression}`);
      expect(invalid.diagnostics, expression).toEqual([
        expect.objectContaining({ code: "SCRIPT2111" }),
      ]);
    }

    for (const expression of [
      "array.concat(values, strings)",
      "values.concat(strings)",
      "values.concat(id2 = strings)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array concat")\nvalues = array.from(1.0)\nstrings = array.from("one")\n${expression}`);
      expect(invalid.diagnostics, expression).toEqual([
        expect.objectContaining({ code: "SCRIPT2111" }),
      ]);
    }

    for (const expression of [
      "float invalid = values.clear()",
      "float invalid = values.fill(2.0)",
      "float invalid = values.insert(0, 2.0)",
      "float invalid = values.reverse()",
      "float invalid = values.unshift(2.0)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array method void")\nvalues = array.from(1.0)\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
    }

    for (const expression of [
      "string invalid = values.first()",
      "string invalid = values.last()",
      "string invalid = values.remove(0)",
      "string invalid = values.shift()",
      "array<string> invalid = values.copy()",
      "array<string> invalid = values.concat(values)",
      "array<string> invalid = values.slice(0, 1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array method result")\nvalues = array.from(1.0)\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2102" }));
    }
  });

  it("types array search, predicate, join, and order calls through namespace and method syntax", () => {
    const valid = compileCurrent(`//@version=6
indicator("Array search and order types")
array<float> numbers = array.from(-1.0, 0.0, 2.0, 2.0)
series bool includesNumber = array.includes(numbers, 2)
series int firstNumber = numbers.indexof(value = 2.0)
series int lastNumber = array.lastindexof(id = numbers, value = 2.0)
series int exactNumber = numbers.binary_search(2.0)
series int leftNumber = array.binary_search_leftmost(id = numbers, value = 1.0)
series int rightNumber = numbers.binary_search_rightmost(value = 1.0)
series bool everyNumber = array.every(numbers)
series bool someNumber = numbers.some()
series string defaultJoin = array.join(numbers)
series string namedJoin = numbers.join(separator = "|")
array<int> descending = array.sort_indices(numbers, order.descending)
array<int> ascending = numbers.sort_indices(order = order.ascending)
array.sort(numbers)
numbers.sort(order = order.descending)
array<string> words = array.from("alpha", "omega")
series bool includesWord = words.includes("omega")
series int firstWord = array.indexof(words, "alpha")
series string joinedWords = words.join("")
array<bool> flags = array.from(true, false)
series bool everyFlag = flags.every()
series bool someFlag = array.some(id = flags)`);
    expect(valid.diagnostics).toEqual([]);

    for (const expression of [
      "value = array.includes(1, 1)",
      "value = array.indexof(1, 1)",
      "value = array.lastindexof(1, 1)",
      "value = array.binary_search(1, 1)",
      "value = array.binary_search_leftmost(1, 1)",
      "value = array.binary_search_rightmost(1, 1)",
      "array.sort(1)",
      "value = array.sort_indices(1)",
      "value = array.every(1)",
      "value = array.some(1)",
      "value = array.join(1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array receiver")\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    for (const expression of [
      "value = numbers.includes(\"bad\")",
      "value = numbers.indexof(value = \"bad\")",
      "value = numbers.lastindexof(\"bad\")",
      "value = numbers.binary_search(\"bad\")",
      "value = numbers.binary_search_leftmost(value = \"bad\")",
      "value = numbers.binary_search_rightmost(\"bad\")",
      "value = numbers.join(1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array operand")\nnumbers = array.from(1.0, 2.0)\n${expression}`);
      expect(invalid.diagnostics, expression).toHaveLength(1);
      expect(invalid.diagnostics[0]!.code, expression).toMatch(/^SCRIPT21(?:11|17)$/u);
    }

    for (const expression of [
      'words = array.from("a", "b")\nvalue = words.binary_search("a")',
      'words = array.from("a", "b")\nvalue = words.every()',
      "flags = array.from(true, false)\nvalue = flags.join()",
      "flags = array.from(true, false)\nflags.sort()",
      "numbers = array.from(1.0, 2.0)\nnumbers.sort(true)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid array kind")\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2122" }));
    }

    const wrongResults = compileCurrent(`//@version=6
indicator("Invalid array results")
numbers = array.from(1.0, 2.0)
string includesResult = numbers.includes(1.0)
bool indexResult = numbers.indexof(1.0)
simple int lastResult = numbers.lastindexof(2.0)
float[] wrongIndices = array.sort_indices(numbers)
simple string joined = numbers.join()`);
    expect(wrongResults.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(5);

    const voidResult = compileCurrent(`//@version=6
indicator("Invalid sort value")
numbers = array.from(2.0, 1.0)
float invalid = numbers.sort()`);
    expect(voidResult.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2137" }));
  });

  it("types array numeric calls through namespace, positional, and named method syntax", () => {
    const valid = compileCurrent(`//@version=6
indicator("Array numeric types")
array<int> ints = array.from(-2, 0, 4)
array<float> floats = array.from(-2.5, 0.0, 4.5)
array<int> absoluteInts = array.abs(ints)
array<float> absoluteFloats = floats.abs()
series float average = ints.avg()
series int minimum = array.min(ints)
series int maximum = ints.max()
series int spread = array.range(id = ints)
series int total = ints.sum()
series float populationVariance = array.variance(ints)
series float sampleVariance = ints.variance(biased = false)
series float populationDeviation = array.stdev(id = ints)
series float sampleDeviation = ints.stdev(false)
series float mixedCovariance = array.covariance(ints, floats)
series float sampleCovariance = ints.covariance(id2 = floats, biased = false)
array<float> standardized = array.standardize(id = ints)`);
    expect(valid.diagnostics).toEqual([]);

    for (const expression of [
      "value = array.abs(1)",
      "value = array.avg(1)",
      "value = array.min(1)",
      "value = array.max(1)",
      "value = array.range(1)",
      "value = array.sum(1)",
      "value = array.variance(1)",
      "value = array.stdev(1)",
      "value = array.covariance(1, array.from(1))",
      "value = array.standardize(1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid numeric receiver")\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    for (const expression of [
      "strings.abs()",
      "array.avg(strings)",
      "strings.min()",
      "array.max(strings)",
      "strings.range()",
      "array.sum(strings)",
      "strings.variance()",
      "array.stdev(strings)",
      "strings.standardize()",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid numeric elements")\nstrings = array.from("1", "2")\nvalue = ${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2122" }));
    }

    for (const expression of [
      "array.variance(values, 1)",
      "values.variance(biased = 1)",
      "array.stdev(values, \"bad\")",
      "values.stdev(biased = 1)",
      "array.covariance(values, values, 1)",
      "values.covariance(id2 = values, biased = 1)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid numeric bias")\nvalues = array.from(1.0, 2.0)\nvalue = ${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    const invalidCovariance = compileCurrent(`//@version=6
indicator("Invalid covariance arrays")
values = array.from(1.0, 2.0)
strings = array.from("1", "2")
first = array.covariance(values, 1)
second = values.covariance(strings)`);
    expect(invalidCovariance.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    expect(invalidCovariance.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2122" }));

    const wrongResults = compileCurrent(`//@version=6
indicator("Invalid numeric results")
ints = array.from(1, 2)
floats = array.from(1.0, 2.0)
array<float> wrongAbs = ints.abs()
string wrongSum = ints.sum()
int wrongAverage = ints.avg()
int wrongVariance = ints.variance()
int wrongDeviation = ints.stdev()
int wrongCovariance = ints.covariance(floats)
array<int> wrongStandardized = ints.standardize()
simple float wrongQualifier = floats.avg()`);
    expect(wrongResults.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(8);
  });

  it("types array rank calls through namespace, positional, and named method syntax", () => {
    const valid = compileCurrent(`//@version=6
indicator("Array rank types")
array<int> ints = array.from(-2, 0, 4, 8)
array<float> floats = array.from(-2.5, 0.0, 4.5, 8.0)
series float integerMedian = array.median(ints)
series float floatMedian = floats.median()
series int integerMode = ints.mode()
series float floatMode = array.mode(id = floats)
series float integerLinear = ints.percentile_linear_interpolation(percentage = 25)
series float floatLinear = array.percentile_linear_interpolation(floats, 62.5)
series int integerNearest = array.percentile_nearest_rank(id = ints, percentage = 50)
series float floatNearest = floats.percentile_nearest_rank(50.0)
series float integerRank = ints.percentrank(index = 1)
series float floatRank = array.percentrank(floats, 2)`);
    expect(valid.diagnostics).toEqual([]);

    for (const expression of [
      "value = array.median(1)",
      "value = array.mode(1)",
      "value = array.percentile_linear_interpolation(1, 50)",
      "value = array.percentile_nearest_rank(1, 50)",
      "value = array.percentrank(1, 0)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid rank receiver")\n${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    for (const expression of [
      "strings.median()",
      "array.mode(strings)",
      "strings.percentile_linear_interpolation(50)",
      "array.percentile_nearest_rank(strings, 50)",
      "strings.percentrank(0)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid rank elements")\nstrings = array.from("1", "2")\nvalue = ${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2122" }));
    }

    for (const expression of [
      'array.percentile_linear_interpolation(values, "bad")',
      "values.percentile_linear_interpolation(percentage = true)",
      'array.percentile_nearest_rank(values, "bad")',
      "values.percentile_nearest_rank(percentage = true)",
      "array.percentrank(values, 1.5)",
      "values.percentrank(index = 1.5)",
    ]) {
      const invalid = compileCurrent(`//@version=6\nindicator("Invalid rank argument")\nvalues = array.from(1.0, 2.0)\nvalue = ${expression}`);
      expect(invalid.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    }

    const wrongResults = compileCurrent(`//@version=6
indicator("Invalid rank results")
ints = array.from(1, 2)
floats = array.from(1.0, 2.0)
int wrongMedian = ints.median()
int wrongFloatMode = floats.mode()
bool wrongIntMode = ints.mode()
int wrongLinear = ints.percentile_linear_interpolation(25)
bool wrongIntNearest = ints.percentile_nearest_rank(50)
int wrongRank = ints.percentrank(0)
simple float wrongQualifier = floats.percentrank(0)`);
    expect(wrongResults.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(7);
  });

  it("uses semantic receiver bindings for named collection arguments", () => {
    const valid = compileCurrent(`//@version=6
indicator("Named collection methods")
array<string> names = array.new<string>(1)
names.set(value = "ok", index = 0)
map<string, float> values = map.new<string, float>()
values.put(value = 1, key = "answer")`);
    const invalid = compileCurrent(`//@version=6
indicator("Named collection method types")
array<string> names = array.new<string>(1)
names.set(value = 1, index = 0)`);

    expect(valid.diagnostics).toEqual([]);
    expect(valid.program?.generatedSource).toContain('"set",[0,"ok"]');
    expect(valid.program?.generatedSource).toContain('"put",["answer",1]');
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
  });

  it("binds and validates UDT constructors and field access semantically", () => {
    const result = compileCurrent(`//@version=6
indicator("UDT binding")
type State
    float value
State invalid = State.new(value = "wrong")
State valid = State.new(value = 1)
plot(valid.missing)`);

    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2118" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2119" }));
  });

  it("requires explicit types for na and permits typed reference values", () => {
    const invalid = compileCurrent(`//@version=6
indicator("na")
value = na`);
    const valid = compileCurrent(`//@version=6
indicator("references")
line drawing = na
float value = na`);

    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2101" }));
    expect(valid.diagnostics).toEqual([]);
  });

  it("uses v6 bool conditions and retains v5 numeric coercion", () => {
    const body = `\nindicator("Conditions")\nvalue = 0.0\nif close\n    value := 1.0\nplot(value)`;
    expect(compileCurrent(`//@version=6${body}`).diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2115" }));
    expect(compileCurrent(`//@version=5${body}`).diagnostics).toEqual([]);
  });

  it("publishes typed overload metadata for every executable callable", () => {
    const complete = Object.values(PINE_CALLABLE_METADATA).filter((definition) => definition.signatureStatus === "complete");
    expect(complete.length).toBeGreaterThan(0);
    expect(complete.every((definition) => definition.typedOverloads && definition.typedOverloads.length > 0)).toBe(true);
  });

  it("uses the bound overload for emitted argument positions", () => {
    const result = compileCurrent(`//@version=6
indicator("Overloads")
plot(ta.highest(length = 2))
plot(timestamp(dateString = "2026-08-25"))`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.highest",[2]');
    expect(result.program?.generatedSource).toContain('"timestamp",["2026-08-25"]');
    expect(result.program?.generatedSource).not.toContain('"ta.highest",[undefined,2]');
  });

  it("binds typed TA history overloads, named arguments, and source-derived results", () => {
    const result = compileCurrent(`//@version=6
indicator("TA history types")
float changed = ta.change(length = 2, source = close)
bool booleanChanged = ta.change(close > open)
float momentum = ta.mom(length = 2, source = close)
float rate = ta.roc(source = close, length = 2)
float total = ta.cum(source = close)
bool crossed = ta.cross(source2 = open, source1 = close)
bool crossedOver = ta.crossover(source1 = close, source2 = open)
bool crossedUnder = ta.crossunder(source2 = open, source1 = close)
bool rising = ta.rising(length = 2, source = close)
bool falling = ta.falling(source = close, length = 2)
float implicitHigh = ta.highest(length = 2)
float explicitLow = ta.lowest(length = 2, source = close)
int implicitHighOffset = ta.highestbars(length = 2)
int explicitLowOffset = ta.lowestbars(source = close, length = 2)
float span = ta.range(length = 2, source = close)
int elapsed = ta.barssince(condition = close > open)
float captured = ta.valuewhen(occurrence = 0, source = close, condition = close > open)
string capturedLabel = ta.valuewhen(close > open, "event", 0)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.highest",[2]');
    expect(result.program?.generatedSource).toContain('"ta.valuewhen",[r.binary');
  });

  it("rejects wrong TA history argument kinds and fractional boundaries", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA history types")
a = ta.change("bad")
b = ta.mom("bad", 2)
c = ta.roc(close, 1.5)
d = ta.cum("bad")
e = ta.cross(close, "bad")
f = ta.crossover("bad", open)
g = ta.crossunder(close, "bad")
h = ta.rising(close, 1.5)
i = ta.falling("bad", 2)
j = ta.highest("bad", 2)
k = ta.lowest(1.5)
l = ta.highestbars(close, 1.5)
m = ta.lowestbars("bad", 2)
n = ta.range(close, 1.5)
o = ta.barssince(close)
p = ta.valuewhen(close, close, 0.5)`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2117");

    expect(diagnostics).toHaveLength(17);
    for (const name of [
      "ta.change", "ta.mom", "ta.roc", "ta.cum", "ta.cross", "ta.crossover", "ta.crossunder",
      "ta.rising", "ta.falling", "ta.highest", "ta.lowest", "ta.highestbars", "ta.lowestbars",
      "ta.range", "ta.barssince", "ta.valuewhen",
    ]) {
      expect(diagnostics.some(({ message }) => message.includes(name)), name).toBe(true);
    }
  });

  it("binds typed TA average and statistic arguments, qualifiers, and results", () => {
    const result = compileCurrent(`//@version=6
indicator("TA average types")
int dynamicLength = bar_index % 2 + 2
float simpleAverage = ta.sma(length = dynamicLength, source = close)
float exponential = ta.ema(source = close, length = 3)
float running = ta.rma(close, 3)
float weighted = ta.wma(length = dynamicLength, source = high)
float hull = ta.hma(close, 4)
float symmetric = ta.swma(source = close)
float arnaud = ta.alma(sigma = 6.0, offset = 0.85, length = dynamicLength, series = close)
float volumeWeighted = ta.vwma(close, dynamicLength)
float regression = ta.linreg(offset = 1, source = close, length = dynamicLength)
float populationVariance = ta.variance(close, dynamicLength)
float populationDeviation = ta.stdev(length = dynamicLength, source = close)
float meanDeviation = ta.dev(close, dynamicLength)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.alma"');
    expect(result.program?.generatedSource).toContain('"ta.linreg"');
  });

  it("rejects wrong TA average and statistic argument kinds and unsupported qualifiers", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA average types")
a = ta.sma("bad", 2)
b = ta.ema(close, 1.5)
c = ta.rma(close, bar_index + 1)
d = ta.wma(close, 1.5)
e = ta.hma(close, bar_index + 1)
f = ta.swma("bad")
g = ta.alma(close, 2, "bad", 6)
h = ta.vwma("bad", 2)
i = ta.linreg(close, 2, 0.5)
j = ta.variance(close, "bad")
k = ta.stdev("bad", 2)
l = ta.dev(close, 1.5)`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2117");

    expect(diagnostics).toHaveLength(12);
    for (const name of [
      "ta.sma", "ta.ema", "ta.rma", "ta.wma", "ta.hma", "ta.swma", "ta.alma",
      "ta.vwma", "ta.linreg", "ta.variance", "ta.stdev", "ta.dev",
    ]) {
      expect(diagnostics.some(({ message }) => message.includes(name)), name).toBe(true);
    }
  });

  it("binds typed true-range and oscillator arguments, named order, tuples, and results", () => {
    const result = compileCurrent(`//@version=6
indicator("TA oscillator types")
int dynamicLength = bar_index % 2 + 2
float trueRangeCall = ta.tr(handle_na = false)
float trueRangeVariable = ta.tr
float averageTrueRange = ta.atr(length = 3)
float strength = ta.rsi(length = 3, source = close)
float channel = ta.cci(length = dynamicLength, source = close)
float momentum = ta.cmo(source = close, length = dynamicLength)
float gravity = ta.cog(length = 3, source = close)
float stochastic = ta.stoch(period = dynamicLength, valley = low, source = close, peak = high)
float williams = ta.wpr(length = dynamicLength)
float trueStrength = ta.tsi(long_length = 3, source = close, short_length = 2)
[macdLine, macdSignal, macdHistogram] = ta.macd(signal_length = 2, slow_length = 3, source = close, fast_length = 2)
[plusDi, minusDi, adx] = ta.dmi(adxSmoothing = 2, diLength = 2)
float typedMacdLine = macdLine
float typedMacdSignal = macdSignal
float typedMacdHistogram = macdHistogram
float typedPlusDi = plusDi
float typedMinusDi = minusDi
float typedAdx = adx`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.macd"');
    expect(result.program?.generatedSource).toContain('"ta.dmi"');
  });

  it("rejects wrong true-range and oscillator argument kinds and qualifiers", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA oscillator types")
a = ta.tr(1)
b = ta.atr(1.5)
c = ta.rsi("bad", 2)
d = ta.cci(close, 1.5)
e = ta.cmo(close, 1.5)
f = ta.cog("bad", 2)
g = ta.stoch(close, "bad", low, 2)
h = ta.wpr("bad")
i = ta.tsi(close, 2, bar_index + 1)
j = ta.macd(close, 2, 3.5, 2)
k = ta.dmi(2, "bad")`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2117");

    expect(diagnostics).toHaveLength(11);
    for (const name of [
      "ta.tr", "ta.atr", "ta.rsi", "ta.cci", "ta.cmo", "ta.cog", "ta.stoch", "ta.wpr",
      "ta.tsi", "ta.macd", "ta.dmi",
    ]) {
      expect(diagnostics.some(({ message }) => message.includes(name)), name).toBe(true);
    }
  });

  it("preserves tuple component kinds and qualifiers for TA oscillators", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA oscillator tuple results")
[macdLine, macdSignal, macdHistogram] = ta.macd(close, 2, 3, 2)
[plusDi, minusDi, adx] = ta.dmi(2, 2)
series int wrongMacdKind = macdLine
simple float wrongMacdQualifier = macdSignal
series bool wrongDmiKind = plusDi
simple float wrongDmiQualifier = adx`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2102");

    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every(({ message }) => message.includes("Cannot assign series float"))).toBe(true);
  });

  it("binds typed TA band and ranked-window arguments, named order, tuples, and results", () => {
    const result = compileCurrent(`//@version=6
indicator("TA band and rank types")
int dynamicLength = bar_index % 2 + 2
int keltnerLength = input.int(3)
[bbBasis, bbUpper, bbLower] = ta.bb(mult = 2.0, series = close, length = dynamicLength)
series float typedBbBasis = bbBasis
series float typedBbUpper = bbUpper
series float typedBbLower = bbLower
float bbWidth = ta.bbw(close, dynamicLength, 2.0)
[kcBasis, kcUpper, kcLower] = ta.kc(useTrueRange = false, mult = 1.5, length = keltnerLength, series = close)
series float typedKcBasis = kcBasis
series float typedKcUpper = kcUpper
series float typedKcLower = kcLower
float kcWidth = ta.kcw(close, keltnerLength, 1.5)
float related = ta.correlation(source2 = high, source1 = close, length = dynamicLength)
float middle = ta.median(length = dynamicLength, source = close)
float frequent = ta.mode(close, dynamicLength)
float linear = ta.percentile_linear_interpolation(percentage = 25.0, source = close, length = dynamicLength)
float nearest = ta.percentile_nearest_rank(close, dynamicLength, 75.0)
float ranked = ta.percentrank(length = dynamicLength, source = close)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.bb"');
    expect(result.program?.generatedSource).toContain('"ta.percentile_nearest_rank"');
  });

  it("rejects wrong TA band and ranked-window argument kinds and qualifiers", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA band and rank types")
a = ta.bb("bad", 2, 1.5)
b = ta.bbw(close, 1.5, 2.0)
c = ta.kc(close, 2, bar_index, true)
d = ta.kcw(close, 2, 1.5, 1)
e = ta.correlation(close, "bad", 2)
f = ta.median(close, 1.5)
g = ta.mode("bad", 2)
h = ta.percentile_linear_interpolation(close, 2, bar_index)
i = ta.percentile_nearest_rank("bad", 2, 50)
j = ta.percentrank(close, 1.5)`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2117");

    expect(diagnostics).toHaveLength(10);
    for (const name of [
      "ta.bb", "ta.bbw", "ta.kc", "ta.kcw", "ta.correlation", "ta.median", "ta.mode",
      "ta.percentile_linear_interpolation", "ta.percentile_nearest_rank", "ta.percentrank",
    ]) {
      expect(diagnostics.some(({ message }) => message.includes(name)), name).toBe(true);
    }
  });

  it("preserves tuple component kinds and qualifiers for TA bands", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA band tuple results")
[bbBasis, bbUpper, bbLower] = ta.bb(close, 3, 2.0)
[kcBasis, kcUpper, kcLower] = ta.kc(close, 3, 1.5)
series int wrongBbKind = bbBasis
simple float wrongBbQualifier = bbUpper
series bool wrongKcKind = kcLower
simple float wrongKcQualifier = kcBasis`);
    const diagnostics = result.diagnostics.filter(({ code }) => code === "SCRIPT2102");

    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every(({ message }) => message.includes("Cannot assign series float"))).toBe(true);
  });

  it("binds typed TA volume calls and zero-argument variables", () => {
    const result = compileCurrent(`//@version=6
indicator("TA volume types")
int dynamicLength = bar_index % 2 + 2
series float moneyFlow = ta.mfi(length = dynamicLength, series = hlc3)
series float weighted = ta.vwap(source = close)
series float accumulation = ta.accdist
series float intensity = ta.iii
series float negative = ta.nvi
series float balance = ta.obv
series float positive = ta.pvi
series float trend = ta.pvt
series float williams = ta.wad
series float variableWilliams = ta.wvad`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"ta.mfi"');
    expect(result.program?.generatedSource).toContain('"ta.accdist"');
  });

  it("rejects wrong TA volume argument and result kinds", () => {
    const result = compileCurrent(`//@version=6
indicator("Invalid TA volume types")
a = ta.mfi("bad", 2)
b = ta.mfi(close, 1.5)
c = ta.vwap("bad")
series int wrongAccumulation = ta.accdist
series bool wrongBalance = ta.obv
simple float wrongIntensity = ta.iii`);

    expect(result.diagnostics.filter(({ code }) => code === "SCRIPT2117")).toHaveLength(3);
    expect(result.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(3);
  });

  it("shares fill overload ordering between semantic binding and lowering", () => {
    const result = compileCurrent(`//@version=6
indicator("Named fill")
first = plot(close)
second = plot(open)
fill(plot1 = first, plot2 = second, color = color.blue, title = "Band", fillgaps = false)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.fill("plot-2",r.get(0),r.get(1),"Band"');
    expect(result.program?.generatedSource).toContain('"fillgaps":false');
  });

  it("returns source-located semantic diagnostics and emits no executor", () => {
    const result = compileCurrent(`//@version=6
indicator("Location")
simple float invalid = close`);
    const diagnostic = result.diagnostics.find((candidate) => candidate.code === "SCRIPT2102");

    expect(diagnostic?.range?.start.line).toBe(3);
    expect(result.program).toBeUndefined();
  });
});
