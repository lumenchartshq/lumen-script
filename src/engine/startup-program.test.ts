import { expect, it } from "vitest";
import { compile, type CompiledProgram, type CompiledRequestPlan } from "../compiler/index.js";
import { PineEngine } from "./index.js";
import { requestStartupCount } from "./request-startup-count.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars = [1, 2, 3, 4].map((close, index) => ({ openTime: index * 60_000, closeTime: (index + 1) * 60_000, open: close, high: close, low: close, close, volume: 1 }));
const source = (body: string) => `//@version=6\nindicator("Startup")\n${body}\nplot(request.security("A", "1", bar_index, calc_bars_count=count()))`;

it("executes the exact P40 rounded-count shape on a fixed child window", async () => {
  const result = compile({ source: `//@version=6\nindicator("P40 residual count")\ncount = int(math.round(2.4))\nplot(request.security("A", "D", bar_index, calc_bars_count=count))`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const dailyBars = bars.map((bar, index) => ({ ...bar, openTime: index * 86_400_000, closeTime: (index + 1) * 86_400_000 }));
  const loads: (number | undefined)[] = [];
  const session = new PineEngine().createSession(result.program!, {
    timeframe: "D", now: () => 4 * 86_400_000,
    marketDataGateway: { load: async ({ calcBarsCount }) => { loads.push(calcBarsCount); return { bars: dailyBars }; } },
  });
  try {
    const output = await session.runBatch(dailyBars);
    expect(loads).toEqual([2]);
    expect(output.plots[0]?.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
  } finally { await session.close(); }
});

it.each([
  ["crypto", 2, [NaN, NaN, 0, 1]],
  ["stock", 3, [NaN, 0, 1, 2]],
] as const)("chooses the pure terminal-if child window for %s before provider load", async (symbolType, expectedCount, expectedValues) => {
  const result = compile({
    source: '//@version=6\nindicator("P40 residual count")\ncount() =>\n    if syminfo.type == "crypto"\n        2\n    else\n        3\nplot(request.security("A", "D", bar_index, calc_bars_count=count()))',
    compatibility: PINE_COMPATIBILITY.strict,
  });
  expect(result.diagnostics).toEqual([]);
  const dailyBars = bars.map((bar, index) => ({ ...bar, openTime: index * 86_400_000, closeTime: (index + 1) * 86_400_000 }));
  const loads: (number | undefined)[] = [];
  const session = new PineEngine().createSession(result.program!, {
    timeframe: "D", symbolInfo: { type: symbolType }, now: () => 4 * 86_400_000,
    marketDataGateway: { load: async ({ calcBarsCount }) => { loads.push(calcBarsCount); return { bars: dailyBars }; } },
  });
  try {
    const output = await session.runBatch(dailyBars);
    expect(loads).toEqual([expectedCount]);
    expect(output.plots[0]?.points.map((point) => point.value)).toEqual(expectedValues);
  } finally { await session.close(); }
});

it("keeps terminal-if branch-local slots and nested branch results distinct", () => {
  const result = compile({
    source: source('value = 9\ncount() =>\n    if syminfo.type == "crypto"\n        value = 2\n        if value == 2\n            value\n        else\n            7\n    else\n        value = 3\n        value'),
    compatibility: PINE_COMPATIBILITY.strict,
  });
  expect(result.diagnostics).toEqual([]);
  const plan = result.program!.requestPlans[0]!;
  expect(requestStartupCount(plan, { symbolInfo: { type: "crypto" } }, {})).toBe(2);
  expect(requestStartupCount(plan, { symbolInfo: { type: "stock" } }, {})).toBe(3);
  const restored = JSON.parse(JSON.stringify(plan)) as CompiledRequestPlan;
  expect(requestStartupCount(restored, { symbolInfo: { type: "crypto" } }, {})).toBe(2);
});

it("replays terminal-if input windows across batch, pagination, append and checkpoint restore", async () => {
  const result = compile({
    source: source('choice = input.int(0, "Choice")\ncount() =>\n    if choice == 0\n        2\n    else\n        3'),
    compatibility: PINE_COMPATIBILITY.strict,
  });
  expect(result.diagnostics).toEqual([]);
  const loads: (number | undefined)[] = [];
  const options = { timeframe: "1", now: () => 1_000_000, marketDataGateway: { load: async ({ calcBarsCount }: { calcBarsCount?: number }) => { loads.push(calcBarsCount); return { bars }; } } };
  const engine = new PineEngine();
  const batch = engine.createSession(result.program!, options);
  const paged = engine.createSession(result.program!, options);
  const append = engine.createSession(result.program!, options);
  try {
    const expected = await batch.runBatch(bars);
    expect(expected.plots[0]?.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
    let last;
    for await (const page of paged.runPaginated(bars, 1)) last = page;
    expect(last?.plots).toEqual(expected.plots);
    await append.runBatch(bars.slice(0, 2));
    expect((await append.appendBars(bars.slice(2))).plots).toEqual(expected.plots);
    const checkpoint = batch.checkpoint();
    await batch.updateInputs({ Choice: 1 });
    expect((await batch.runBatch(bars)).plots[0]?.points.map((point) => point.value)).toEqual([NaN, 0, 1, 2]);
    await batch.restore(checkpoint);
    expect((await batch.appendBars([])).plots).toEqual(expected.plots);
    expect(loads).toContain(2);
    expect(loads).toContain(3);
  } finally { await Promise.all([batch.close(), paged.close(), append.close()]); }
});

it("rejects an invalid terminal-if branch result before loading child data", async () => {
  const result = compile({
    source: source('choice = input.int(0, "Choice")\ncount() =>\n    if choice == 0\n        -1\n    else\n        2'),
    compatibility: PINE_COMPATIBILITY.strict,
  });
  expect(result.diagnostics).toEqual([]);
  let loads = 0;
  const session = new PineEngine().createSession(result.program!, {
    timeframe: "1", now: () => 1_000_000,
    marketDataGateway: { load: async () => { loads += 1; return { bars }; } },
  });
  try {
    await expect(session.runBatch(bars)).rejects.toThrow("nonnegative simple int");
    expect(loads).toBe(0);
  } finally { await session.close(); }
});

it.each([
  "int(math.round(2.5))",
  "int(math.round(-1.5)) + 5",
])("uses half-away-from-zero rounding before choosing the child window: %s", async (countExpression) => {
  const result = compile({ source: `//@version=6\nindicator("Rounded tie")\ncount = ${countExpression}\nplot(request.security("A", "1", bar_index, calc_bars_count=count))`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const loads: (number | undefined)[] = [];
  const session = new PineEngine().createSession(result.program!, {
    timeframe: "1", now: () => 1_000_000,
    marketDataGateway: { load: async ({ calcBarsCount }) => { loads.push(calcBarsCount); return { bars }; } },
  });
  try {
    const output = await session.runBatch(bars);
    expect(loads).toEqual([3]);
    expect(output.plots[0]?.points.map((point) => point.value)).toEqual([NaN, 0, 1, 2]);
  } finally { await session.close(); }
});

it.each([
  ['count() =>\n    value = 2\n    value', 2],
  ['value = 9\ncount() =>\n    value = 2\n    value', 2],
  ['add(simple int left, simple int right = 1) =>\n    value = left + right\n    value\ncount() => add(right=1, left=1)', 2],
  ['add(simple int left, simple int right = 1) =>\n    value = left + right\n    value\ncount() => add(1)', 2],
  ['inner(simple int n) =>\n    value = n + 1\n    value\ncount() =>\n    value = inner(0)\n    inner(value)', 2],
  ['inner(simple int n) =>\n    value = n\n    value\ncount() => inner(3) - inner(1)', 2],
  ['base = input.int(1 + 1, "Bars")\ncount() =>\n    value = base\n    value', 2],
] as const)("lowers pure multiline startup count: %s", async (body, expected) => {
  const result = compile({ source: source(body), compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  const loads: (number | undefined)[] = [];
  const restored = JSON.parse(JSON.stringify(result.program)) as CompiledProgram;
  const session = new PineEngine().createSession(restored, {
    timeframe: "1", now: () => 1_000_000,
    marketDataGateway: { load: async ({ calcBarsCount }) => { loads.push(calcBarsCount); return { bars }; } },
  });
  try {
    const output = await session.runBatch(bars);
    expect(loads).toEqual([expected]);
    expect(output.plots[0]?.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
  } finally { await session.close(); }
});

it.each([
  'count() =>\n    var value = 2\n    value',
  'count() =>\n    value = 2\n    value := 3\n    value',
  'count() =>\n    log.info("side effect")\n    2',
  'count() =>\n    for i = 0 to 2\n        i\n    2',
  'count() =>\n    value = bar_index\n    value',
  'count() => count()',
  `count() =>\n${Array.from({ length: 130 }, (_, index) => `    v${index} = 1`).join("\n")}\n    2`,
  `count() =>\n    value = input.int(2)\n    ${"(".repeat(40)}${"+".repeat(40)}value${")".repeat(40)}`,
])("rejects unsupported startup bodies before a provider can run: %s", (body) => {
  const result = compile({ source: source(body), compatibility: PINE_COMPATIBILITY.strict });
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.range !== undefined)).toBe(true);
});

it("replays multiline input windows across pagination, append, input updates and checkpoints", async () => {
  const result = compile({ source: source('base = input.int(2, "Bars")\ncount() =>\n    value = base\n    value'), compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const options = { timeframe: "1", now: () => 1_000_000, marketDataGateway: { load: async () => ({ bars }) } };
  const engine = new PineEngine();
  const batch = engine.createSession(result.program!, options);
  const paged = engine.createSession(result.program!, options);
  const append = engine.createSession(result.program!, options);
  try {
    const expected = await batch.runBatch(bars);
    let last;
    for await (const page of paged.runPaginated(bars, 1)) last = page;
    expect(last?.plots).toEqual(expected.plots);
    await append.runBatch(bars.slice(0, 2));
    expect((await append.appendBars(bars.slice(2))).plots).toEqual(expected.plots);
    const checkpoint = batch.checkpoint();
    await batch.updateInputs({ Bars: 3 });
    expect((await batch.runBatch(bars)).plots[0]?.points.map((point) => point.value)).toEqual([NaN, 0, 1, 2]);
    await batch.restore(checkpoint);
    expect((await batch.appendBars([])).plots).toEqual(expected.plots);
  } finally { await Promise.all([batch.close(), paged.close(), append.close()]); }
});

it("uses rounded startup counts for child windows and replays them across session modes", async () => {
  const result = compile({ source: `//@version=6\nindicator("Rounded startup")\nbase = input.int(2, "Bars")\ncount = int(math.round(base + 0.4))\nplot(request.security("A", "1", bar_index, calc_bars_count=count))`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const loads: (number | undefined)[] = [];
  const options = { timeframe: "1", now: () => 1_000_000, marketDataGateway: { load: async ({ calcBarsCount }: { calcBarsCount?: number }) => { loads.push(calcBarsCount); return { bars }; } } };
  const engine = new PineEngine();
  const batch = engine.createSession(result.program!, options);
  const paged = engine.createSession(result.program!, options);
  const append = engine.createSession(result.program!, options);
  try {
    const expected = await batch.runBatch(bars);
    expect(expected.plots[0]?.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
    let last;
    for await (const page of paged.runPaginated(bars, 1)) last = page;
    expect(last?.plots).toEqual(expected.plots);
    await append.runBatch(bars.slice(0, 2));
    expect((await append.appendBars(bars.slice(2))).plots).toEqual(expected.plots);
    const checkpoint = batch.checkpoint();
    await batch.updateInputs({ Bars: 3 });
    expect((await batch.runBatch(bars)).plots[0]?.points.map((point) => point.value)).toEqual([NaN, 0, 1, 2]);
    await batch.restore(checkpoint);
    expect((await batch.appendBars([])).plots).toEqual(expected.plots);
    expect(loads).toContain(2);
    expect(loads).toContain(3);
    expect(loads.every((count) => count === 2 || count === 3)).toBe(true);
  } finally { await Promise.all([batch.close(), paged.close(), append.close()]); }
});

it.each([-2, 1.5, Number.POSITIVE_INFINITY])("rejects invalid rounded input %s before loading child data", async (invalid) => {
  const result = compile({ source: `//@version=6\nindicator("Rounded startup")\nbase = input.int(2, "Bars")\ncount = int(math.round(base + 0.4))\nplot(request.security("A", "1", bar_index, calc_bars_count=count))`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  let loads = 0;
  const createSession = () => new PineEngine().createSession(result.program!, { timeframe: "1", inputs: { Bars: invalid }, marketDataGateway: { load: async () => { loads += 1; return { bars }; } } });
  if (!Number.isInteger(invalid)) {
    expect(createSession).toThrow("requires an integer override");
    expect(loads).toBe(0);
    return;
  }
  const session = createSession();
  try {
    await expect(session.runBatch(bars)).rejects.toThrow("nonnegative simple int");
    expect(loads).toBe(0);
  } finally { await session.close(); }
});

it("resolves startup metadata anew per symbol and rejects invalid overrides or versions", () => {
  const result = compile({ source: source('count() =>\n    value = syminfo.type == "crypto" ? 2 : 3\n    value'), compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const plan = result.program!.requestPlans[0]!;
  expect(requestStartupCount(plan, { symbolInfo: { type: "crypto" } }, {})).toBe(2);
  expect(requestStartupCount(plan, { symbolInfo: { type: "stock" } }, {})).toBe(3);
  const input = compile({ source: source('base = input.int(2, "Bars")\ncount() =>\n    value = base\n    value'), compatibility: PINE_COMPATIBILITY.strict }).program!.requestPlans[0]!;
  expect(requestStartupCount(input, {}, { Bars: 0 })).toBeUndefined();
  for (const value of [-1, 1.5, Infinity, "2"]) expect(() => requestStartupCount(input, {}, { Bars: value })).toThrow("nonnegative simple int");
  const forged: unknown = JSON.parse(JSON.stringify(input).replace('"version":1', '"version":2'));
  expect(() => requestStartupCount(forged as CompiledRequestPlan, {}, {})).toThrow("nonnegative simple int");
});

it("keeps a request-bearing method's receiver separate from named count arguments", async () => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6
indicator("Method")
base = input.int(2, "Bars")
type Counter
    int n = 0
method fetch(Counter this, simple int count, simple int ignored) => this.n + request.security("A", "1", bar_index, calc_bars_count=count)
var Counter receiver = Counter.new()
plot(receiver.fetch(ignored=9, count=base))` });
  expect(result.diagnostics).toEqual([]);
  expect(requestStartupCount(result.program!.requestPlans[0]!, {}, {})).toBe(2);
});

it("rejects two request-bearing callers and nested shadowed count captures", () => {
  for (const body of [
    'fetch(simple int count) => request.security("A", "1", close, calc_bars_count=count)\nplot(fetch(2))\nplot(fetch(3))',
    'count = input.int(8)\nfetch() =>\n    if true\n        count = 2\n        request.security("A", "1", close, calc_bars_count=count)\nplot(fetch())',
  ]) {
    const result = compile({ source: `//@version=6\nindicator("Guard")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
    expect(result.program).toBeUndefined();
    expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2018" || entry.code === "SCRIPT2012")).toBe(true);
  }
});

it("rejects an invalid count override before loading child data", async () => {
  const result = compile({ source: source('base = input.int(2, "Bars")\ncount() =>\n    value = base\n    value'), compatibility: PINE_COMPATIBILITY.strict });
  let loads = 0;
  const session = new PineEngine().createSession(result.program!, { timeframe: "1", inputs: { Bars: -1 }, marketDataGateway: { load: async () => { loads += 1; return { bars }; } } });
  try {
    await expect(session.runBatch(bars)).rejects.toThrow("nonnegative simple int");
    expect(loads).toBe(0);
  } finally { await session.close(); }
});

it("preserves legacy startupCount plan evaluation", () => {
  const result = compile({ source: source('count() => 2'), compatibility: PINE_COMPATIBILITY.strict });
  const { startupProgram, ...base } = result.program!.requestPlans[0]!;
  const range = startupProgram!.range;
  expect(requestStartupCount({ ...base, startupCount: { expression: { kind: "literal", value: 3, range }, declarations: {}, callerBindings: {}, localBindings: {}, functions: {}, inputIds: {}, inlineInputs: [], range } }, {}, {})).toBe(3);
});

it.each([
  'if barstate.isfirst\n    value = request.security("A", "1", close, calc_bars_count=count)',
  'for i = 0 to 0\n    value = request.security("A", "1", close, calc_bars_count=count)',
  'fetch(simple int count) => request.security("A", "1", close, calc_bars_count=count)\nouter(simple int count) => fetch(count)\nvalue = outer(2)',
])("preserves lexical startup counts through blocks and caller chains: %s", async (body) => {
  const result = compile({ source: `//@version=6\nindicator("Scopes", dynamic_requests=true)\ncount = input.int(2, "Global")\n${body}\nplot(close)`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(result.program).toBeDefined();
  const loads: (number | undefined)[] = [];
  const session = new PineEngine().createSession(result.program!, { timeframe: "1", inputs: { Global: 3 }, marketDataGateway: { load: async ({ calcBarsCount }) => { loads.push(calcBarsCount); return { bars }; } } });
  try {
    await session.runBatch(bars);
    expect(loads).toEqual([body.startsWith("fetch") ? 2 : 3]);
  } finally { await session.close(); }
});

it.each([
  'outer(simple int count = 2) => fetch(count)\nplot(outer())',
  'outer(simple int count) =>\n    local = count + 1\n    fetch(local)\nplot(outer(1))',
  'outer(simple int count) => fetch(count)\nwrapper(simple int value) => outer(value)\nplot(wrapper(2))',
])("keeps defaults and local aliases in transitive caller scope: %s", (body) => {
  const result = compile({ source: `//@version=6\nindicator("Caller scope")\ncount = input.int(9)\nfetch(simple int count) => request.security("A", "1", close, calc_bars_count=count)\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  expect(requestStartupCount(result.program!.requestPlans[0]!, {}, {})).toBe(2);
});

it.each([
  'if true\n    count = input.int(2)\n    value = request.security("A", "1", close, calc_bars_count=count)',
  'fetch(simple int count) => request.security("A", "1", close, calc_bars_count=count)\nouter(simple int count) => fetch(count)\nplot(outer(2))\nplot(outer(3))',
])("rejects block-local capture and ambiguous transitive callers: %s", (body) => {
  const result = compile({ source: `//@version=6\nindicator("Scope guards", dynamic_requests=true)\ncount = input.int(9)\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.severity === "error")).toBe(true);
});
