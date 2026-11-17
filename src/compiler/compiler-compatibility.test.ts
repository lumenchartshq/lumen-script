import { PINE_BUILTIN_CATALOG,
  PINE_CALLABLE_METADATA,
  PINE_PRODUCTION_BUILTIN_CATALOG,
  PINE_PRODUCTION_CALLABLE_METADATA,
  pineBuiltinCatalog,
  pineBuiltinRegistry,
  PINE_COMPATIBILITY,
} from "../contracts/index.js";
import { describe, expect, it } from "vitest";
import { compile } from "./index.js";

const compileCurrent = (source: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source,
});

describe("Lumen Script compiler compatibility", () => {
  it("keeps the sealed catalog frozen and exposes additions only in the production catalog", () => {
    const calendarCallables = ["dayofmonth", "dayofweek", "hour", "minute", "month", "second", "weekofyear", "year"];
    const productionOnlyCoreCallables = [
      "bool", "box", "color", "float", "int", "label", "line", "linefill", "na", "polyline", "str.format_time", "str.repeat", "string", "table",
      "time", "time_close", "timeframe.change", "timeframe.from_seconds", "timeframe.in_seconds",
    ];
    expect(PINE_BUILTIN_CATALOG.compatibility).toBe(PINE_COMPATIBILITY.legacy);
    expect(PINE_BUILTIN_CATALOG.builtins).not.toContain("runtime.error");
    expect(PINE_BUILTIN_CATALOG.variables).not.toContain("timenow");
    expect(PINE_BUILTIN_CATALOG.variables).not.toContain("session.ismarket");
    expect(PINE_CALLABLE_METADATA).not.toHaveProperty("runtime.error");
    for (const callable of calendarCallables) {
      expect(PINE_BUILTIN_CATALOG.builtins).not.toContain(callable);
      expect(PINE_CALLABLE_METADATA).not.toHaveProperty(callable);
    }
    for (const callable of productionOnlyCoreCallables) {
      expect(PINE_BUILTIN_CATALOG.builtins).not.toContain(callable);
      expect(PINE_CALLABLE_METADATA).not.toHaveProperty(callable);
    }

    expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toContain("runtime.error");
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.variables).toContain("timenow");
    expect(PINE_PRODUCTION_BUILTIN_CATALOG.variables).toContain("session.ismarket");
    expect(PINE_PRODUCTION_CALLABLE_METADATA["runtime.error"]).toMatchObject({
      parameters: ["message"],
      returnType: "void",
      signatureStatus: "complete",
    });
    for (const callable of calendarCallables) {
      expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toContain(callable);
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({
        parameters: ["time", "timezone"],
        optionalParameters: ["timezone"],
        overloads: [["time"], ["time", "timezone"]],
        returnType: "series int",
        signatureStatus: "complete",
      });
    }
    for (const callable of productionOnlyCoreCallables) {
      expect(PINE_PRODUCTION_BUILTIN_CATALOG.builtins).toContain(callable);
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({
        signatureStatus: "complete",
      });
    }
    expect(pineBuiltinCatalog(PINE_COMPATIBILITY.legacy)).toBe(PINE_BUILTIN_CATALOG);
    expect(pineBuiltinCatalog(PINE_COMPATIBILITY.strict)).toBe(PINE_PRODUCTION_BUILTIN_CATALOG);
    expect(pineBuiltinRegistry(PINE_COMPATIBILITY.legacy)).toHaveLength(
      PINE_BUILTIN_CATALOG.builtins.length + PINE_BUILTIN_CATALOG.variables.length,
    );
    expect(pineBuiltinRegistry(PINE_COMPATIBILITY.strict)).toHaveLength(
      PINE_PRODUCTION_BUILTIN_CATALOG.builtins.length + PINE_PRODUCTION_BUILTIN_CATALOG.variables.length,
    );
  });

  it("binds the production core casts, string helpers, and timeframe change", () => {
    const result = compileCurrent(`//@version=6
indicator("Core callable contract")
asBool = bool(close)
asColor = color(#112233)
asFloat = float(close)
asInt = int(close)
isMissing = na(close)
asString = string(close)
formatted = str.format("{0,number,#.##}", close)
matched = str.match("NASDAQ:AAPL", "[A-Z]+:[A-Z]+")
repeated = str.repeat("ab", 3, "-")
changed = timeframe.change("D")`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of ["bool", "color", "float", "int", "na", "string", "str.format", "str.match", "str.repeat", "timeframe.change"]) {
      expect(result.program?.generatedSource).toContain(JSON.stringify(callable));
    }
  });

  it("binds complete named signatures for high-use math and TA calls", () => {
    const callables = [
      "math.ln", "math.round_to_mintick", "ta.barssince", "ta.cmo", "ta.cog",
      "ta.correlation", "ta.cross", "ta.cum", "ta.dmi", "ta.hma",
    ];
    const result = compileCurrent(`//@version=6
indicator("Named math and TA signatures")
logValue = math.ln(number = close)
rounded = math.round_to_mintick(number = close)
elapsed = ta.barssince(condition = close > open)
momentum = ta.cmo(source = close, length = 14)
gravity = ta.cog(source = close, length = 10)
correlated = ta.correlation(source1 = close, source2 = open, length = 20)
crossed = ta.cross(source1 = close, source2 = open)
total = ta.cum(source = volume)
[plus, minus, adx] = ta.dmi(diLength = 14, adxSmoothing = 14)
hull = ta.hma(source = close, length = 9)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
      expect(result.program?.generatedSource).toContain(JSON.stringify(callable));
    }

    const invalid = compileCurrent(`//@version=6
indicator("Invalid named signatures")
missingNumber = math.ln()
unknownName = ta.cmo(source = close, missing = 14)`);
    expect(invalid.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2014")).toHaveLength(3);
  });

  it("enforces zero-argument and windowed TA signatures", () => {
    const zeroArgument = ["ta.accdist", "ta.iii", "ta.nvi", "ta.obv", "ta.pvi", "ta.pvt", "ta.wad", "ta.wvad"];
    const result = compileCurrent(`//@version=6
indicator("TA signature contract")
accdistValue = ta.accdist
intensity = ta.iii
negativeVolume = ta.nvi
balanceVolume = ta.obv
positiveVolume = ta.pvi
priceVolume = ta.pvt
accumulation = ta.wad
variableAccumulation = ta.wvad
medianValue = ta.median(source = close, length = 5)
modeValue = ta.mode(source = close, length = 5)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of [...zeroArgument, "ta.median", "ta.mode"]) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }

    const invalid = compileCurrent(`//@version=6
indicator("Invalid TA signatures")
wrongZeroArg = ta.obv(123)
missingLength = ta.median(source = close)`);
    expect(invalid.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2014")).toHaveLength(2);
  });

  it("enforces remaining TA, generic collection, map, and strategy signatures", () => {
    const callables = [
      "array.new", "map.copy", "map.put_all", "strategy.closedtrades.first_index",
      "strategy.opentrades.capital_held", "ta.kc", "ta.kcw", "ta.mfi", "ta.vwap", "ta.wpr",
    ];
    const result = compileCurrent(`//@version=6
strategy("Mixed signature contract")
values = array.new<float>(size = 2, initial_value = 1.0)
sourceMap = map.new<string, float>()
targetMap = map.copy(id = sourceMap)
map.put_all(id = targetMap, from = sourceMap)
firstClosed = strategy.closedtrades.first_index
heldCapital = strategy.opentrades.capital_held
[basis, upper, lower] = ta.kc(series = close, length = 20, mult = 2.0, useTrueRange = true)
channelWidth = ta.kcw(series = close, length = 20, mult = 2.0)
moneyFlow = ta.mfi(series = hlc3, length = 14)
dailyVwap = ta.vwap(source = hlc3)
series float anchoredVwap = ta.vwap(anchor = timeframe.change("D"), source = hlc3)
[vwapBasis, vwapUpper, vwapLower] = ta.vwap(hlc3, timeframe.change("D"), 2.0)
series float typedVwapUpper = vwapUpper
williams = ta.wpr(length = 14)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }

    const invalid = compileCurrent(`//@version=6
indicator("VWAP requires an anchor for bands")
anchored = ta.vwap(source = hlc3, stdev_mult = 2.0)`);
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({
      code: "SCRIPT2014",
      message: "Missing required argument 'anchor' for 'ta.vwap'",
    }));
  });

  it("enforces array transform and reducer signatures", () => {
    const callables = [
      "array.abs", "array.avg", "array.concat", "array.covariance", "array.every",
      "array.first", "array.last", "array.reverse", "array.some", "array.sum",
    ];
    const result = compileCurrent(`//@version=6
indicator("Array reducer signatures")
left = array.from(-1.0, 2.0)
right = array.from(3.0, 4.0)
absolute = array.abs(id = left)
average = array.avg(id = left)
combined = array.concat(id1 = left, id2 = right)
covariance = array.covariance(id1 = left, id2 = right)
allTrue = array.every(id = left)
firstValue = array.first(id = left)
lastValue = array.last(id = left)
array.reverse(id = left)
anyTrue = array.some(id = left)
total = array.sum(id = left)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }

    const invalid = compileCurrent(`//@version=6
indicator("Invalid array reducer")
values = array.from(1.0)
firstValue = array.first(id = values, ignored = 1)`);
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2014" }));
  });

  it("enforces array search, range, and mutation signatures", () => {
    const callables = [
      "array.binary_search", "array.binary_search_leftmost", "array.binary_search_rightmost",
      "array.fill", "array.insert", "array.join", "array.lastindexof", "array.remove",
      "array.slice", "array.sort",
    ];
    const result = compileCurrent(`//@version=6
indicator("Array search signatures")
values = array.from(1.0, 2.0, 3.0)
found = array.binary_search(id = values, value = 2.0)
left = array.binary_search_leftmost(id = values, value = 2.0)
right = array.binary_search_rightmost(id = values, value = 2.0)
array.fill(id = values, value = 4.0, index_from = 0, index_to = 1)
array.insert(id = values, index = 1, value = 2.0)
joined = array.join(id = values, separator = ",")
lastFound = array.lastindexof(id = values, value = 2.0)
removed = array.remove(id = values, index = 0)
window = array.slice(id = values, index_from = 0, index_to = 2)
array.sort(id = values, order = order.ascending)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }
  });

  it("enforces array statistic and percentile signatures", () => {
    const callables = [
      "array.max", "array.median", "array.min", "array.mode",
      "array.percentile_linear_interpolation", "array.percentile_nearest_rank",
      "array.percentrank", "array.range", "array.sort_indices", "array.standardize",
    ];
    const result = compileCurrent(`//@version=6
indicator("Array statistic signatures")
values = array.from(1.0, 2.0, 3.0)
maximum = array.max(id = values)
median = array.median(id = values)
minimum = array.min(id = values)
mode = array.mode(id = values)
linear = array.percentile_linear_interpolation(id = values, percentage = 50)
nearest = array.percentile_nearest_rank(id = values, percentage = 50)
rank = array.percentrank(id = values, index = 1)
spread = array.range(id = values)
indices = array.sort_indices(id = values, order = order.descending)
standardized = array.standardize(id = values)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }

    const nth = compileCurrent(`//@version=6
indicator("Nth extreme")
values = array.from(1.0, 2.0)
second = array.max(id = values, nth = 1)`);
    expect(nth.diagnostics).toEqual([]);
  });

  it("enforces reference-array and initial matrix signatures", () => {
    const callables = [
      "array.new_box", "array.new_label", "array.new_line", "array.new_linefill",
      "array.new_table", "array.stdev", "array.variance", "matrix.avg", "matrix.col", "matrix.copy",
    ];
    const result = compileCurrent(`//@version=6
indicator("Reference array and matrix signatures")
boxes = array.new_box(size = 1, initial_value = box(na))
labels = array.new_label(size = 1, initial_value = label(na))
lines = array.new_line(size = 1, initial_value = line(na))
fills = array.new_linefill(size = 1, initial_value = linefill(na))
tables = array.new_table(size = 1, initial_value = table(na))
values = array.from(1.0, 2.0, 3.0)
deviation = array.stdev(id = values, biased = false)
variance = array.variance(id = values)
grid = matrix.new<float>(rows = 2, columns = 2, initial_value = 1.0)
average = matrix.avg(id = grid)
column = matrix.col(id = grid, column = 0)
cloned = matrix.copy(id = grid)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of callables) {
      expect(PINE_PRODUCTION_CALLABLE_METADATA[callable]).toMatchObject({ signatureStatus: "complete" });
    }
  });

  it("binds timeframe conversion, timestamp offsets, and drawing reference casts", () => {
    const result = compileCurrent(`//@version=6
indicator("Time and reference callable contract")
chartSeconds = timeframe.in_seconds()
daySeconds = timeframe.in_seconds("D")
dayFrame = timeframe.from_seconds(86400)
dayOpen = time("D", timeframe_bars_back = 1)
dayClose = time_close("D", timeframe_bars_back = 1)
chartOpen = time("", bars_back = 1)
asBox = box(na)
asLabel = label(na)
asLine = line(na)
asLinefill = linefill(na)
asPolyline = polyline(na)
asTable = table(na)`);

    expect(result.diagnostics).toEqual([]);
    for (const callable of [
      "timeframe.in_seconds", "timeframe.from_seconds", "time", "time_close",
      "box", "label", "line", "linefill", "polyline", "table",
    ]) {
      expect(result.program?.generatedSource).toContain(JSON.stringify(callable));
    }
  });

  it("binds the production timeframe flags and extended symbol information", () => {
    const result = compileCurrent(`//@version=6
indicator("Chart context contract")
ticks = timeframe.isticks
seconds = timeframe.isseconds
minutes = timeframe.isminutes
dwm = timeframe.isdwm
base = syminfo.basecurrency
country = syminfo.country
mainTicker = syminfo.main_tickerid
minimumMove = syminfo.minmove
pointValue = syminfo.pointvalue
priceScale = syminfo.pricescale`);

    expect(result.diagnostics).toEqual([]);
    for (const variable of [
      "timeframe.isticks", "timeframe.isseconds", "timeframe.isminutes", "timeframe.isdwm",
      "syminfo.basecurrency", "syminfo.country", "syminfo.main_tickerid", "syminfo.minmove", "syminfo.pointvalue", "syminfo.pricescale",
    ]) {
      expect(result.program?.generatedSource).toContain(`r.constant(${JSON.stringify(variable)})`);
    }
  });

  it("binds str.format_time positional and named optional arguments", () => {
    const result = compileCurrent(`//@version=6
indicator("Time strings")
defaultTime = str.format_time(time)
namedTime = str.format_time(time, timezone="UTC+0", format="yyyy-MM-dd HH:mm:ss")`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.call(0,"str.format_time",[r.data("time"),undefined,undefined])');
    expect(result.program?.generatedSource).toContain('r.call(1,"str.format_time",[r.data("time"),"yyyy-MM-dd HH:mm:ss","UTC+0"])');
  });

  it("binds typed chart flags and the remaining host-backed symbol fields", () => {
    const result = compileCurrent(`//@version=6
indicator("Chart and symbol contract")
bool standard = chart.is_standard
bool heikinAshi = chart.is_heikinashi
bool kagi = chart.is_kagi
bool lineBreak = chart.is_linebreak
bool pointAndFigure = chart.is_pnf
bool rangeBars = chart.is_range
bool renko = chart.is_renko
float minimumContract = syminfo.mincontract
string symbolType = syminfo.type
string volumeType = syminfo.volumetype`);

    expect(result.diagnostics).toEqual([]);
    for (const variable of [
      "chart.is_standard", "chart.is_heikinashi", "chart.is_kagi", "chart.is_linebreak",
      "chart.is_pnf", "chart.is_range", "chart.is_renko", "syminfo.mincontract",
      "syminfo.type", "syminfo.volumetype",
    ]) {
      expect(result.program?.generatedSource).toContain(`r.constant(${JSON.stringify(variable)})`);
    }
  });

  it("binds typed chart presentation context and company symbol facts", () => {
    const result = compileCurrent(`//@version=6
indicator("Chart presentation contract")
color background = chart.bg_color
color foreground = chart.fg_color
int leftVisible = chart.left_visible_bar_time
int rightVisible = chart.right_visible_bar_time
string currentContract = syminfo.current_contract
int employees = syminfo.employees
string industry = syminfo.industry
string isin = syminfo.isin
string sector = syminfo.sector
int shareholders = syminfo.shareholders`);

    expect(result.diagnostics).toEqual([]);
    for (const variable of [
      "chart.bg_color", "chart.fg_color", "chart.left_visible_bar_time", "chart.right_visible_bar_time",
      "syminfo.current_contract", "syminfo.employees", "syminfo.industry", "syminfo.isin",
      "syminfo.sector", "syminfo.shareholders",
    ]) {
      expect(result.program?.generatedSource).toContain(`r.constant(${JSON.stringify(variable)})`);
    }
  });

  it("binds every calendar component in function form", () => {
    const result = compileCurrent(`//@version=6
indicator("Calendar callables")
plot(dayofmonth(time, "UTC"))
plot(dayofweek(time, "UTC"))
plot(hour(time, "UTC"))
plot(minute(time, "UTC"))
plot(month(time, "UTC"))
plot(second(time, "UTC"))
plot(weekofyear(time, "UTC"))
plot(year(time, "UTC"))`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/r\.call\([^,]+,"(?:dayofmonth|dayofweek|hour|minute|month|second|weekofyear|year)"/gu)).toHaveLength(8);
  });

  it("enforces matrix algebra and predicate signatures", () => {
    const result = compileCurrent(`//@version=6
indicator("Matrix algebra contracts")
left = matrix.new<float>(2, 2, 1.0)
right = matrix.new<float>(2, 2, 2.0)
matrix.concat(id1=left, id2=right)
determinant = matrix.det(id=left)
difference = matrix.diff(id1=left, id2=1.0)
count = matrix.elements_count(id=left)
matrix.fill(id=left, value=2.0, from_row=0, to_row=1, from_column=0, to_column=1)
inverse = matrix.inv(id=left)
antiDiagonal = matrix.is_antidiagonal(id=left)
antiSymmetric = matrix.is_antisymmetric(id=left)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/"matrix\.(?:concat|det|diff|elements_count|fill|inv|is_antidiagonal|is_antisymmetric)"/gu)).toHaveLength(8);
  });

  it("enforces matrix structural predicates and Kronecker signatures", () => {
    const result = compileCurrent(`//@version=6
indicator("Matrix structure contracts")
left = matrix.new<float>(2, 2, 1.0)
right = matrix.new<float>(2, 2, 2.0)
binary = matrix.is_binary(id=left)
diagonal = matrix.is_diagonal(id=left)
identity = matrix.is_identity(id=left)
square = matrix.is_square(id=left)
stochastic = matrix.is_stochastic(id=left)
symmetric = matrix.is_symmetric(id=left)
triangular = matrix.is_triangular(id=left)
zero = matrix.is_zero(id=left)
product = matrix.kron(id1=left, id2=right)
maximum = matrix.max(id=left)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/"matrix\.(?:is_binary|is_diagonal|is_identity|is_square|is_stochastic|is_symmetric|is_triangular|is_zero|kron|max)"/gu)).toHaveLength(10);
  });

  it("rejects the unsupported matrix.max nth-order overload", () => {
    const result = compileCurrent(`//@version=6
indicator("Unsupported matrix maximum")
grid = matrix.new<float>(2, 2, 1.0)
maximum = matrix.max(id=grid, nth=2)`);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2014" })]);
  });

  it("enforces matrix statistics, transformation, and removal signatures", () => {
    const result = compileCurrent(`//@version=6
indicator("Matrix transformation contracts")
grid = matrix.new<float>(2, 2, 1.0)
median = matrix.median(id=grid)
minimum = matrix.min(id=grid)
mode = matrix.mode(id=grid)
product = matrix.mult(id1=grid, id2=2.0)
pseudoInverse = matrix.pinv(id=grid)
power = matrix.pow(id=grid, power=2)
rank = matrix.rank(id=grid)
removedColumn = matrix.remove_col(id=grid, column=0)
removedRow = matrix.remove_row(id=grid, row=0)
matrix.reshape(id=grid, rows=1, columns=1)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/"matrix\.(?:median|min|mode|mult|pinv|pow|rank|remove_col|remove_row|reshape)"/gu)).toHaveLength(10);
  });

  it("rejects the unsupported matrix.min nth-order overload", () => {
    const result = compileCurrent(`//@version=6
indicator("Unsupported matrix minimum")
grid = matrix.new<float>(2, 2, 1.0)
minimum = matrix.min(id=grid, nth=2)`);

    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2014" })]);
  });

  it("admits the production random seed while keeping the sealed signature frozen", () => {
    const source = `//@version=6
indicator("Unsupported seeded random")
value = math.random(min=0, max=1, seed=42)`;
    const result = compileCurrent(source);
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"math.random",[0,1,42]');
    expect(sealed.diagnostics).toEqual([]);
    expect(PINE_PRODUCTION_CALLABLE_METADATA["math.random"]?.parameters).toEqual(["min", "max", "seed"]);
    expect(PINE_CALLABLE_METADATA["math.random"]?.parameters).toEqual(["min", "max"]);
  });

  it("binds official named numeric, covariance, matrix, and string parameters", () => {
    const result = compileCurrent(`//@version=6
indicator("Named production contracts")
a = array.from(1.0, 2.0)
b = array.from(2.0, 3.0)
covariance = array.covariance(id1=a, id2=b, biased=false)
maximum = math.max(number0=1, number1=2)
minimum = math.min(number0=1, number1=2)
average = math.avg(number0=1, number1=2)
sine = math.sin(angle=0)
degrees = math.todegrees(radians=math.pi)
radians = math.toradians(degrees=180)
text = str.repeat(source="x", repeat=2, separator="-")
m1 = matrix.new<float>(2, 2, 1.0)
m2 = matrix.new<float>(2, 2, 2.0)
difference = matrix.diff(id1=m1, id2=m2)
product = matrix.mult(id1=m1, id2=m2)
total = matrix.sum(id1=m1, id2=m2)
combined = matrix.concat(id1=m1, id2=m2)`);

    expect(result.diagnostics).toEqual([]);
  });

  it("advertises bounded matrix eigensystem operations", () => {
    for (const method of ["eigenvalues", "eigenvectors"]) {
      const result = compileCurrent(`//@version=6\nindicator("Bounded eigensystem")\nm = matrix.new<float>(3, 3, 1.0)\nvalue = matrix.${method}(m)`);
      expect(result.diagnostics).toEqual([]);
    }
  });

  it("infers direct collection return kinds and numeric element types", () => {
    const valid = compileCurrent(`//@version=6
indicator("Collection result types")
a = array.from(1, 2)
int total = array.sum(a)
float deviation = array.stdev(a)
m = matrix.new<int>(1, 1, 1)
int average = matrix.avg(m)
array<int> row = matrix.row(m, 0)
array<int> vector = matrix.mult(m, array.from(2))
matrix<int> joined = matrix.concat(m, matrix.new<int>(1, 1, 2))
int offset = ta.highestbars(5)`);
    expect(valid.diagnostics).toEqual([]);

    const invalid = compileCurrent(`//@version=6
indicator("Invalid collection result types")
m = matrix.new<int>(1, 1, 1)
matrix<int> row = matrix.row(m, 0)
matrix<int> vector = matrix.mult(m, array.from(2))
bad = matrix.sum(m, "wrong")`);
    expect(invalid.diagnostics.filter((diagnostic) => diagnostic.code === "SCRIPT2102")).toHaveLength(2);
    expect(invalid.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2117")).toBe(true);
  });

  it("requires two arguments for variadic math extrema and average", () => {
    for (const name of ["avg", "max", "min"]) {
      const result = compileCurrent(`//@version=6\nindicator("Arity")\nvalue = math.${name}(1)`);
      expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2014" })]);
    }
  });

  it("enforces the remaining matrix access and mutation signatures", () => {
    const result = compileCurrent(`//@version=6
indicator("Remaining matrix contracts")
grid = matrix.new<float>(2, 2, 1.0)
other = matrix.new<float>(2, 2, 2.0)
matrix.reverse(id=grid)
firstRow = matrix.row(id=grid, row=0)
matrix.sort(id=grid, column=0, order=order.descending)
window = matrix.submatrix(id=grid, from_row=0, to_row=1, from_column=0, to_column=1)
total = matrix.sum(id1=grid, id2=other)
matrix.swap_columns(id=grid, column1=0, column2=1)
matrix.swap_rows(id=grid, row1=0, row2=1)
diagonalTotal = matrix.trace(id=grid)
transposed = matrix.transpose(id=grid)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource.match(/"matrix\.(?:reverse|row|sort|submatrix|sum|swap_columns|swap_rows|trace|transpose)"/gu)).toHaveLength(9);
  });

  it("rejects invalid calendar callable arity in the production profile", () => {
    const missing = compileCurrent(`//@version=6
indicator("Missing time")
plot(hour())`);
    const extra = compileCurrent(`//@version=6
indicator("Extra time")
plot(minute(time, "UTC", 1))`);

    expect(missing.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2014" })]);
    expect(extra.diagnostics).toEqual([expect.objectContaining({ code: "SCRIPT2014" })]);
  });

  it("recognizes the production runtime, clock, and session surfaces", () => {
    const result = compileCurrent(`//@version=6
indicator("Production builtins")
if session.ismarket and timenow > 0
    runtime.error("stop")
plot(session.isfirstbar ? 1 : 0)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('r.constant("timenow")');
    expect(result.program?.generatedSource).toContain('r.constant("session.ismarket")');
    expect(result.program?.generatedSource).toContain('"runtime.error"');
    expect(result.program?.runtimeRequirements).toEqual({
      usesDatasetTail: false,
      usesExecutionClock: true,
      usesChartType: false,
      usesVisibleRange: false,
    });
  });

  it("merges structured runtime requirements from request children", () => {
    const result = compileCurrent(`//@version=6
indicator("Child requirements")
tail = last_bar_time
childClock = request.security(syminfo.tickerid, timeframe.period, timenow)`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.runtimeRequirements).toEqual({
      usesDatasetTail: true,
      usesExecutionClock: true,
      usesChartType: false,
      usesVisibleRange: false,
    });
    expect(result.program?.generatedSource).not.toContain('r.constant("timenow")');
    // Unrelated root declarations are no longer copied into the child context.
    expect(result.program?.requestPlans[0]?.program.runtimeRequirements).toEqual({
      usesDatasetTail: false,
      usesExecutionClock: true,
      usesChartType: false,
      usesVisibleRange: false,
    });
  });

  it("marks chart presentation fields as host-backed execution requirements", () => {
    const result = compileCurrent(`//@version=6
indicator("Chart requirements")
isHa = chart.is_heikinashi
first = chart.left_visible_bar_time
last = chart.right_visible_bar_time`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.runtimeRequirements).toMatchObject({ usesChartType: true, usesVisibleRange: true });
  });

  it("rejects unadvertised chart namespace fields", () => {
    const result = compileCurrent('//@version=6\nindicator("Unknown chart field")\nplot(chart.is_missing)');
    expect(result.program).toBeUndefined();
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2015")).toBe(true);
  });

  it("merges chart requirements used only inside request.security children", () => {
    const result = compileCurrent(`//@version=6
indicator("Child chart requirements")
child = request.security(syminfo.tickerid, timeframe.period, chart.is_heikinashi ? chart.left_visible_bar_time : chart.right_visible_bar_time)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.runtimeRequirements).toMatchObject({ usesChartType: true, usesVisibleRange: true });
    expect(result.program?.requestPlans[0]?.program.runtimeRequirements).toMatchObject({ usesChartType: true, usesVisibleRange: true });
  });

  it("resolves constant namespaces before colliding local variables", () => {
    const result = compileCurrent(`//@version=6
indicator("Constant collisions")
position = 1
font = 1
order = 1
currency = 1
dayofweek = 1
adjustment = 1
barmerge = 1
a = position.top_right
b = font.family_monospace
c = order.ascending
d = currency.USD
e = dayofweek.monday
f = adjustment.splits
g = barmerge.gaps_off`);

    expect(result.diagnostics).toEqual([]);
    for (const name of [
      "position.top_right",
      "font.family_monospace",
      "order.ascending",
      "currency.USD",
      "dayofweek.monday",
      "adjustment.splits",
      "barmerge.gaps_off",
    ]) {
      expect(result.program?.generatedSource).toContain(`r.constant(${JSON.stringify(name)})`);
    }
    expect(result.program?.generatedSource).not.toContain("r.property(r.get(0)");
  });

  it("falls back to local UDT fields for unknown and non-shadowing namespace members", () => {
    const result = compileCurrent(`//@version=6
indicator("Namespace fallback")
type PositionBox
    int value
type ColorBox
    int red
PositionBox position = PositionBox.new(5)
ColorBox color = ColorBox.new(7)
unknownMember = position.value / 2
outsideSeven = color.red / 2
recognizedMember = position.top_right`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toMatch(/r\.objectField\(\d+,r\.get\(0\),"PositionBox","value"\)/);
    expect(result.program?.generatedSource).toMatch(/r\.objectField\(\d+,r\.get\(1\),"ColorBox","red"\)/);
    expect(result.program?.generatedSource).toContain('r.constant("position.top_right")');
    expect(result.program?.generatedSource).not.toContain('r.constant("position.value")');
    expect(result.program?.generatedSource).not.toContain('r.constant("color.red")');
  });

  it("truncates only const-int division in v5 production programs", () => {
    const result = compileCurrent(`//@version=5
indicator("Qualified division")
literal = 3 / 2
mutable = 3
mutable := 3
fromMutable = mutable / 2
configured = input.int(3)
fromInput = configured / 2
var int persistent = 3
fromPersistent = persistent / 2`);

    expect(result.diagnostics).toEqual([]);
    const source = result.program?.generatedSource ?? "";
    expect(source.match(/"__idiv"/gu)).toHaveLength(1);
    expect(source.match(/r\.binary\("\/"/gu)).toHaveLength(3);
  });

  it("keeps all integer division fractional in v6 production programs", () => {
    const result = compileCurrent(`//@version=6
indicator("v6 division")
literal = 3 / 2
mutable = 3
mutable := 3
fromMutable = mutable / 2`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).not.toContain('"__idiv"');
    expect(result.program?.generatedSource.match(/r\.binary\("\/"/gu)).toHaveLength(2);
  });
});
