import { pineCallableMetadata, PINE_COMPATIBILITY } from "../contracts/index.js";
import { expect, it } from "vitest";
import { compile } from "./index.js";

function run(body: string, version = 6) {
  return compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${String(version)}\nindicator("Options")\n${body}` });
}

it("folds request option aliases and arithmetic without changing their meaning", () => {
  const result = run('const int count = 2 * 3\ngaps = barmerge.gaps_on\nahead = true ? barmerge.lookahead_on : barmerge.lookahead_off\nignore = not true\nunit = currency.NONE\nplot(request.security("A", "5", close, gaps, ahead, ignore, unit, count + 1))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program!.requestPlans[0]).toMatchObject({ gaps: true, lookahead: true, calcBarsCount: 7 });
});

it("folds the corrected lower-timeframe named options", () => {
  const result = run('ignored = true\nvalues = request.security_lower_tf("A", "5", close, ignore_invalid_timeframe=ignored, calc_bars_count=math.max(2, 4))\nplot(array.size(values))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program!.requestPlans[0]).toMatchObject({ ignoreInvalidTimeframe: true, calcBarsCount: 4 });
});

it("treats zero requested bars as the default unlimited selection", () => {
  const result = run('plot(request.security("A", "5", close, calc_bars_count=0))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program!.requestPlans[0]!.calcBarsCount).toBeUndefined();
});

it.each(['-1', '1.5', '1 / 0', 'bar_index + 1'])("rejects unsupported or invalid count %s instead of ignoring it", (value) => {
  const result = run(`plot(request.security("A", "5", close, calc_bars_count=${value}))`);
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.message.includes("calc_bars_count"))).toBe(true);
});

it("compiles a v6 input-backed count for startup resolution", () => {
  const result = run('n = input.int(2, "Bars")\nplot(request.security("A", "5", close, calc_bars_count=n))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({ result: { kind: "input", id: "n" } });
});

it("exposes an inline request-count input in program metadata", () => {
  const result = run('plot(request.security("A", "5", close, calc_bars_count=input.int(2, "Bars")))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.descriptor.inputs[0]?.type).toBe("int");
  expect(result.program?.descriptor.inputs[0]?.title).toBe("Bars");
  expect(result.program?.descriptor.inputs[0]?.defaultValue).toBe(2);
  expect(result.program?.requestPlans[0]?.startupProgram?.inlineInputs).toHaveLength(1);
});

it("compiles a lower-timeframe input count through immutable arithmetic", () => {
  const result = run('base = input.int(2, "Bars")\nsimple int count = base + 1\nvalues = request.security_lower_tf("A", "1", close, calc_bars_count=count)\nplot(array.size(values))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.kind).toBe("security_lower_tf");
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({ result: { kind: "binary", operator: "+", left: { kind: "input", id: "base" } } });
});

it("rejects a negative input count default with a ranged diagnostic", () => {
  const result = run('n = input.int(-1)\nplot(request.security("A", "5", close, calc_bars_count=n))');
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.range !== undefined)).toBe(true);
});

it("compiles the documented chart-symbol simple count", () => {
  const result = run('reqDays = syminfo.type == "crypto" ? 14 : 10\nplot(request.security("A", "D", close, calc_bars_count=reqDays))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({ result: { kind: "conditional" } });
});

it.each([
  [5, "", "bar_index >= 0"],
  [6, ", dynamic_requests=false", "true"],
] as const)("compiles the observed v%s static ternary request", (version, option, test) => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${String(version)}
indicator("Conditional request"${option})
requested = ${test} ? request.security(syminfo.tickerid, timeframe.period, close) : 0.0
plot(requested)` });
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans).toHaveLength(1);
  expect(result.program?.requestPlans[0]?.dynamic).toBeUndefined();
});

it.each([
  [5, "", 'if bar_index >= 0\n    bool requested = request.security(syminfo.tickerid, timeframe.period, close > 0)\nplot(close)'],
  [6, ", dynamic_requests=false", 'requested = bar_index >= 0 ? request.security(syminfo.tickerid, timeframe.period, close) : 0.0\nplot(requested)'],
] as const)("rejects the observed v%s request in a dynamic scope without dynamic requests", (version, option, body) => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=${String(version)}
indicator("Conditional request"${option})
${body}` });
  expect(result.program).toBeUndefined();
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2012" }));
});

it.each([
  ["an unused chain", "bar_index >= 0", "close", "float discarded = requested * 2", ""],
  ["an independent log", "bar_index >= 0", "close", 'log.info("independent")', ""],
  ["a literal-dead branch", "false", "close", "log.info(str.tostring(requested))", ""],
  ["a child with a log", "bar_index >= 0", "child()", "float discarded = requested * 2", 'child() =>\n    log.info("child")\n    close'],
])("drops a v6 static request in %s before building request plans", (_label, condition, source, use, prefix) => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Dead request", dynamic_requests=false)
${prefix}
if ${condition}
    float requested = request.security(syminfo.tickerid, timeframe.period, ${source}, calc_bars_count=13)
    ${use}
plot(close)` });
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans).toEqual([]);
  expect(result.program?.generatedSource).not.toContain("r.dynamicRequest(");
});

it.each([
  ["an observed request", "syminfo.tickerid", "log.info(str.tostring(requested))"],
  ["a series selector", 'bar_index % 2 == 0 ? syminfo.tickerid : "FX:GBPUSD"', "float discarded = requested * 2"],
])("keeps static request restrictions for %s", (_label, symbol, use) => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Static request", dynamic_requests=false)
if bar_index >= 0
    float requested = request.security(${symbol}, timeframe.period, close)
    ${use}
plot(close)` });
  expect(result.program).toBeUndefined();
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2012" }));
});

it("binds a simple count parameter to one written caller", () => {
  const result = run('base = input.int(2, "Bars")\nfetch(simple int count) => request.security("A", "5", close, calc_bars_count=count)\nplot(fetch(base))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({ result: { kind: "input", id: "base" } });
});

it("retains a pure simple function result for the startup count", () => {
  const result = run('count() => 2\nplot(request.security("A", "5", close, calc_bars_count=count()))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({ result: { kind: "let", result: { kind: "literal", value: 2 } } });
});

it("lowers the exact P40 terminal multiline if count into the pure startup program", () => {
  const result = compile({
    compatibility: PINE_COMPATIBILITY.strict,
    source: '//@version=6\nindicator("P40 residual count")\ncount() =>\n    if syminfo.type == "crypto"\n        2\n    else\n        3\nplot(request.security("A", "D", close, calc_bars_count=count()))',
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram).toMatchObject({
    version: 1,
    expression: { result: { kind: "let", result: { kind: "conditional" } } },
  });
});

it("keeps terminal-if startup lowering out of the sealed v5 profile", () => {
  const result = run('count() =>\n    if syminfo.type == "crypto"\n        2\n    else\n        3\nplot(request.security("A", "D", close, calc_bars_count=count()))', 5);
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.range !== undefined)).toBe(true);
});

it.each([
  'count() =>\n    if syminfo.type == "crypto"\n        2',
  'count() =>\n    if close > 0\n        2\n    else\n        3',
  'count() =>\n    if syminfo.type == "crypto"\n        log.info("unsafe")\n        2\n    else\n        3',
  'count() =>\n    if syminfo.type == "crypto"\n        var value = 2\n        value\n    else\n        3',
  'count() =>\n    if syminfo.type == "crypto"\n        value = 2\n        value := 3\n        value\n    else\n        3',
  `count() =>\n    if syminfo.type == "crypto"\n${Array.from({ length: 130 }, (_, index) => `        v${index} = 1`).join("\n")}\n        2\n    else\n        3`,
])("rejects unsupported terminal-if startup body before provider admission: %s", (body) => {
  const result = run(`${body}\nplot(request.security("A", "D", close, calc_bars_count=count()))`);
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.severity === "error" && entry.range !== undefined)).toBe(true);
});

it("lowers the exact P40 one-argument rounded count through the pure startup program", () => {
  const result = run('count = int(math.round(2.4))\nplot(request.security("A", "5", close, calc_bars_count=count))');
  expect(result.diagnostics).toEqual([]);
  expect(result.program?.requestPlans[0]?.startupProgram?.expression).toMatchObject({
    result: { kind: "call", name: "int", arguments: [{ kind: "call", name: "math.round", arguments: [{ kind: "literal", value: 2.4 }] }] },
  });
});

it("keeps the rounded startup count's precision overload fail-closed", () => {
  const result = run('count = int(math.round(2.4, 1))\nplot(request.security("A", "5", close, calc_bars_count=count))');
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.range !== undefined)).toBe(true);
});

it("keeps input-backed counts rejected in v5 until their versioned contract is assessed", () => {
  const result = run('n = input.int(2)\nplot(request.security("A", "5", close, calc_bars_count=n))', 5);
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.message.includes("calc_bars_count"))).toBe(true);
});

it("does not substitute a global option for a same-named local", () => {
  const result = run('count = 7\nif close > 0\n    count = 2\n    value = request.security("A", "5", close, calc_bars_count=count)\nplot(close)');
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018")).toBe(true);
});

it("rejects runtime option selections rather than using their defaults", () => {
  const result = run('ahead = close > 0 ? barmerge.lookahead_on : barmerge.lookahead_off\nplot(request.security("A", "5", close, lookahead=ahead))');
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.message.includes("lookahead"))).toBe(true);
});

it("preserves v5 constant integer division in option folding", () => {
  const result = run('plot(request.security("A", "5", close, calc_bars_count=5 / 2))', 5);
  expect(result.diagnostics).toEqual([]);
  expect(result.program!.requestPlans[0]!.calcBarsCount).toBe(2);
});


it("keeps the sealed lower-timeframe signature unchanged", () => {
  const current = pineCallableMetadata(PINE_COMPATIBILITY.strict)["request.security_lower_tf"]!;
  const frozen = pineCallableMetadata(PINE_COMPATIBILITY.legacy)["request.security_lower_tf"]!;
  expect(current.parameters[3]).toBe("ignore_invalid_symbol");
  expect(current.parameters[5]).toBe("ignore_invalid_timeframe");
  expect(frozen.parameters[3]).toBe("ignore_invalid_timeframe");
  expect(frozen.parameters[5]).toBe("ignore_invalid_symbol");
});

it("does not fold reassigned option aliases to their initial value", () => {
  const result = run('count = 2\ncount := 4\nplot(request.security("A", "5", close, calc_bars_count=count))');
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018")).toBe(true);
});
