import type { SessionCheckpoint } from "../contracts/index.js";
import { expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const bars = Array.from({ length: 4 }, (_, index) => ({ openTime: index * 60_000, closeTime: (index + 1) * 60_000, open: 1, high: 2, low: 1, close: index + 1, volume: 10 }));
function program(body: string, declaration = 'indicator("Dynamic")') {
  const compiled = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\n${declaration}\n${body}` });
  expect(compiled.diagnostics).toEqual([]);
  return compiled.program!;
}
function gateway(calls: string[]) {
  return { load: async ({ symbol }: { symbol: string }) => {
    calls.push(symbol);
    return { bars: bars.map((bar) => ({ ...bar, close: bar.close * (symbol === "A" ? 10 : 100) })) };
  } };
}

it("discovers series symbol contexts and publishes one deterministic result", async () => {
  const calls: string[] = [];
  const progress: number[] = [];
  const session = new PineEngine().createSession(program('symbol = bar_index % 2 == 0 ? "A" : "B"\nvar int count = 0\ncount += 1\nvalue = request.security(symbol, "1", close)\nplot(value)\nplot(count)'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    const result = await session.runBatch(bars, { onProgress: (event) => progress.push(event.processedBars) });
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([10, 200, 30, 400]);
    expect(result.plots[1]!.points.map((point) => point.value)).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual(["A", "B"]);
    expect(progress).toEqual([4]);
  } finally { await session.close(); }
});

it("discovers loop selectors without capturing a loop-dependent expression", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('float total = 0\nfor symbol in array.from("A", "B")\n    total += request.security(symbol, "1", close)\nplot(total)'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([110, 220, 330, 440]);
    expect(calls).toEqual(["A", "B"]);
  } finally { await session.close(); }
});

it("rejects a new realtime selection before calling the provider", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('symbol = barstate.isrealtime ? "B" : "A"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 210_000, marketDataGateway: gateway(calls) });
  try {
    await expect(session.runBatch(bars)).rejects.toThrow("not accessed on historical bars");
    expect(calls).toEqual(["A"]);
  } finally { await session.close(); }
});

it("rejects dynamic selectors when explicitly disabled or in the frozen lane", () => {
  const source = '//@version=6\nindicator("Disabled", dynamic_requests=false)\nsymbol = bar_index > 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))';
  expect(compile({ source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics.some((entry) => entry.code === "SCRIPT2012")).toBe(true);
  expect(compile({ source: source.replace(', dynamic_requests=false', ''), compatibility: PINE_COMPATIBILITY.legacy }).program).toBeUndefined();
});

it("rejects captured loop bindings even when a global with that name exists", () => {
  const source = '//@version=6\nindicator("Capture")\ni = 9\nfor i = 0 to 2\n    symbol = i == 0 ? "A" : "B"\n    value = request.security(symbol, "1", close + i)\nplot(close)';
  const compiled = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(compiled.program).toBeUndefined();
  expect(compiled.diagnostics.some((entry) => entry.message.includes("local loop or block"))).toBe(true);
});

it("keeps batch, pagination and restored checkpoints equivalent", async () => {
  const compiled = program('symbol = bar_index % 2 == 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))');
  const options = { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway([]) };
  const batch = new PineEngine().createSession(compiled, options);
  const paged = new PineEngine().createSession(compiled, options);
  const restored = new PineEngine().createSession(compiled, options);
  try {
    const expected = await batch.runBatch(bars);
    let actual;
    for await (const page of paged.runPaginated(bars, 1)) actual = page;
    expect(actual!.plots).toEqual(expected.plots);
    await restored.restore(JSON.parse(JSON.stringify(paged.checkpoint())) as SessionCheckpoint);
    expect((await restored.appendBars([])).plots).toEqual(expected.plots);
  } finally { await Promise.all([batch.close(), paged.close(), restored.close()]); }
});

it("reuses a historically admitted context on realtime appends", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('symbol = bar_index % 2 == 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 150_000, marketDataGateway: gateway(calls) });
  try {
    await session.runBatch(bars.slice(0, 2));
    const result = await session.appendBars(bars.slice(2, 3));
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([10, 200, 30]);
  } finally { await session.close(); }
});

it("does not publish partial progress when a late provider fails", async () => {
  const progress: number[] = [];
  const session = new PineEngine().createSession(program('symbol = bar_index == 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: { load: async ({ symbol }) => {
    if (symbol === "B") throw new Error("provider failed");
    return { bars };
  } } });
  try {
    await expect(session.runBatch(bars, { onProgress: (event) => progress.push(event.processedBars) })).rejects.toThrow("provider failed");
    expect(progress).toEqual([]);
    expect(() => session.checkpoint()).toThrow();
  } finally { await session.close(); }
});

it("executes forty independent requests without duplicating unrelated child contexts", async () => {
  const compiled = program(Array.from({ length: 40 }, (_, index) => `plot(request.security("", "1", close + ${index}))`).join("\n"));
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  try {
    const result = await session.runBatch(bars.slice(0, 1));
    expect(result.plots).toHaveLength(40);
    expect(result.plots.map((plot) => plot.points[0]!.value)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  } finally { await session.close(); }
});

it("preserves dependent collection mutations while pruning unrelated requests", async () => {
  const compiled = program('values = array.from(close)\narray.push(values, close * 2)\nunrelated = request.security("", "1", open)\nplot(request.security("", "1", array.sum(values)))');
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([3, 6, 9, 12]);
    expect(compiled.requestPlans[1]!.program.requestPlans).toHaveLength(0);
  } finally { await session.close(); }
});

it("evaluates reassigned selector variables instead of freezing their initializer", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('string symbol = "A"\nif bar_index % 2 == 1\n    symbol := "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([10, 200, 30, 400]);
  } finally { await session.close(); }
});

it("rejects the forty-first discovered context without loading it", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('float total = 0\nfor i = 0 to 40\n    total += request.security(str.tostring(i), "1", close)\nplot(total)'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    await expect(session.runBatch(bars.slice(0, 1))).rejects.toThrow("40 unique request contexts");
    expect(calls).toHaveLength(40);
  } finally { await session.close(); }
});

it("discards a late provider response after cancellation", async () => {
  const controller = new AbortController();
  let resolve!: (value: { bars: typeof bars }) => void;
  let started!: () => void;
  const loading = new Promise<void>((done) => { started = done; });
  const pending = new Promise<{ bars: typeof bars }>((done) => { resolve = done; });
  const session = new PineEngine().createSession(program('symbol = bar_index == 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 1_000_000, signal: controller.signal, marketDataGateway: { load: async () => { started(); return pending; } } });
  const run = session.runBatch(bars);
  await loading;
  controller.abort();
  resolve({ bars });
  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  await session.close();
});

it("does not duplicate drawings or alerts across discovery retries", async () => {
  const session = new PineEngine().createSession(program('symbol = bar_index % 2 == 0 ? "A" : "B"\nlabel.new(bar_index, close, "once")\nalert("once", alert.freq_all)\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 1_000_000, alertMode: "all", marketDataGateway: gateway([]) });
  try {
    const result = await session.runBatch(bars);
    expect(result.drawings).toHaveLength(4);
    expect(result.alerts).toHaveLength(4);
  } finally { await session.close(); }
});

it("aligns dynamically selected lower-timeframe tuple arrays", async () => {
  const session = new PineEngine().createSession(program('symbol = bar_index % 2 == 0 ? "A" : "B"\n[values, volumes] = request.security_lower_tf(symbol, "1", [close, volume])\nplot(array.sum(values))\nplot(array.sum(volumes))'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway([]) });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([10, 200, 30, 400]);
    expect(result.plots[1]!.points.map((point) => point.value)).toEqual([10, 10, 10, 10]);
  } finally { await session.close(); }
});

it.each([
  {
    order: "narrow dynamic call first",
    requests: 'if bar_index >= 0\n    narrow := request.security_lower_tf("A", frame, close, calc_bars_count=3)\nif bar_index >= 0\n    wide := request.security_lower_tf("A", frame, open, calc_bars_count=8)',
    count: 3,
    sizes: [[0, 0, 1, 2], [0, 0, 1, 2]],
  },
  {
    order: "wide dynamic call executes first",
    requests: 'if bar_index > 0\n    narrow := request.security_lower_tf("A", frame, close, calc_bars_count=3)\nif bar_index >= 0\n    wide := request.security_lower_tf("A", frame, open, calc_bars_count=8)',
    count: 8,
    sizes: [[0, 2, 2, 2], [2, 2, 2, 2]],
  },
  {
    order: "static window takes priority",
    requests: 'if bar_index >= 0\n    narrow := request.security_lower_tf("A", frame, close, calc_bars_count=3)\nwide := request.security_lower_tf("A", "1", open, calc_bars_count=8)',
    count: 8,
    sizes: [[2, 2, 2, 2], [2, 2, 2, 2]],
  },
])("shares and refreshes the lower-timeframe history when $order", async ({ requests, count, sizes }) => {
  const compiled = program(`string frame = bar_index >= 0 ? "1" : "2"
array<float> narrow = array.new<float>()
array<float> wide = array.new<float>()
${requests}
plot(narrow.size())
plot(wide.size())`);
  const parents = bars.map((bar, index) => ({ ...bar, openTime: index * 120_000, closeTime: (index + 1) * 120_000 }));
  const children = parents.flatMap((bar) => [
    { ...bar, closeTime: bar.openTime + 60_000 },
    { ...bar, openTime: bar.openTime + 60_000 },
  ]);
  const loads: (number | undefined)[] = [];
  let available = 6;
  const session = new PineEngine().createSession(compiled, {
    timeframe: "2",
    now: () => 1_000_000,
    marketDataGateway: { load: async ({ calcBarsCount }) => {
      loads.push(calcBarsCount);
      return { bars: children.slice(0, available).slice(-(calcBarsCount ?? available)) };
    } },
  });
  try {
    await session.runBatch(parents.slice(0, 3));
    available = 8;
    const result = await session.appendBars(parents.slice(3));
    expect(result.plots.map((plot) => plot.points.map((point) => point.value))).toEqual(sizes);
    expect(new Set(loads)).toEqual(new Set([count]));
  } finally { await session.close(); }
});

it("selects separate contexts for repeated calls to a user function", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('fetch(string symbol) => request.security(symbol, "1", close)\nplot(fetch("A") + fetch("B"))'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([110, 220, 330, 440]);
    expect(calls).toEqual(["A", "B"]);
  } finally { await session.close(); }
});

it("does not preload a constant request in an unexecuted branch", async () => {
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('if false\n    value = request.security("B", "1", close)\nplot(close)'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    await session.runBatch(bars);
    expect(calls).toEqual([]);
  } finally { await session.close(); }
});

it("rejects observed local requests when dynamic_requests is disabled", () => {
  const source = '//@version=6\nindicator("Disabled", dynamic_requests=false)\nif close > 0\n    value = request.security("A", "1", close)\n    log.info(str.tostring(value))\nplot(close)';
  const result = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.program).toBeUndefined();
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2012")).toBe(true);
});

it("does not reuse historical admission across replacement datasets", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  const session = new PineEngine().createSession(program('symbol = bar_index >= 0 ? "A" : "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => now, marketDataGateway: gateway(calls) });
  try {
    await session.runBatch(bars);
    now = 30_000;
    await expect(session.runBatch(bars.slice(0, 1))).rejects.toThrow("not accessed on historical bars");
    expect(calls).toEqual(["A"]);
  } finally { await session.close(); }
});

it("preserves transitive global mutation dependencies in child programs", async () => {
  const compiled = program('values = array.from(close)\nhelper() => array.push(values, close * 2)\nmutate() => helper()\nmutate()\nplot(request.security("", "1", array.sum(values)))');
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([3, 6, 9, 12]);
  } finally { await session.close(); }
});


it("does not charge unexecuted dynamic callsites against the static limit", async () => {
  const calls: string[] = [];
  const requests = Array.from({ length: 41 }, (_, index) => `if false\n    value = request.security("UNUSED${String(index)}", "1", close)`).join("\n");
  const session = new PineEngine().createSession(program(`${requests}\nplot(close)`), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway(calls) });
  try {
    await session.runBatch(bars);
    expect(calls).toEqual([]);
  } finally { await session.close(); }
});


it("matches the reference platform's lower-timeframe positional ignore flags", async () => {
  const compiled = program('values = request.security_lower_tf("", "5", close, false, currency.NONE, true)\nplot(na(values) ? 17 : array.size(values))');
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([17, 17, 17, 17]);
  } finally { await session.close(); }
  const unsupported = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Flags")\nvalues = request.security_lower_tf("", "1", close, true, currency.NONE, false)\nplot(array.size(values))' });
  expect(unsupported.diagnostics.some((entry) => entry.code === "SCRIPT2018" && entry.message.includes("ignore_invalid_symbol"))).toBe(true);
});


it("limits the initial chart execution window and preserves pagination", async () => {
  const compiled = program('value = request.security("", "1", bar_index, calc_bars_count=2)\nplot(value)\nplot(na(value[2]) ? 17 : -1)');
  expect(compiled.runtimeRequirements.usesDatasetTail).toBe(true);
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  const paged = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1]);
    expect(result.plots[1]!.points.at(-1)!.value).toBe(17);
    let actual;
    for await (const page of paged.runPaginated(bars, 1)) actual = page;
    expect(actual!.plots).toEqual(result.plots);
  } finally { await Promise.all([session.close(), paged.close()]); }
});

it("resolves a simple input count at startup and rebuilds its child window after input changes", async () => {
  const compiled = program('base = input.int(2, "Bars")\nsimple int count = base\nplot(request.security("", "1", bar_index, calc_bars_count=count))');
  const options = { timeframe: "1", now: () => 1_000_000 };
  const engine = new PineEngine();
  const session = engine.createSession(compiled, options);
  const paginated = engine.createSession(compiled, options);
  const incremental = engine.createSession(compiled, options);
  try {
    const batch = await session.runBatch(bars);
    expect(batch.plots[0]!.points.map((point) => point.value)).toEqual([0, 1]);
    let final;
    for await (const page of paginated.runPaginated(bars, 1)) final = page;
    expect(final?.plots).toEqual(batch.plots);
    await incremental.runBatch(bars.slice(0, 2));
    expect((await incremental.appendBars(bars.slice(2))).plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2, 3]);
    const checkpoint = session.checkpoint();
    await session.updateInputs({ Bars: 3 });
    expect((await session.runBatch(bars)).plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
    await session.restore(checkpoint);
    expect((await session.appendBars([])).plots).toEqual(batch.plots);
    await session.updateInputs({ Bars: 0 });
    expect((await session.runBatch(bars)).plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2, 3]);
    await session.updateInputs({ Bars: -1 });
    await expect(session.runBatch(bars)).rejects.toMatchObject({
      message: "Request calc_bars_count must resolve to a nonnegative simple int",
      range: compiled.requestPlans[0]?.startupProgram?.range,
    });
  } finally { await Promise.all([session.close(), paginated.close(), incremental.close()]); }
});

it("passes the resolved input count to the gateway and trims excess child bars", async () => {
  const compiled = program('n = input.int(2, "Bars")\nplot(request.security("A", "1", bar_index, calc_bars_count=n))');
  const loads: number[] = [];
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000, marketDataGateway: {
    load: async ({ calcBarsCount }) => { loads.push(calcBarsCount ?? 0); return { bars }; },
  } });
  try {
    const result = await session.runBatch(bars);
    expect(loads).toEqual([2]);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
  } finally { await session.close(); }
});

it("uses an inline count input override without executing its option on every bar", async () => {
  const compiled = program('plot(request.security("", "1", bar_index, calc_bars_count=input.int(2, "Bars")))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", inputs: { Bars: 3 }, now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
});

it("uses chart symbol type to select a simple request count", async () => {
  const compiled = program('reqDays = syminfo.type == "crypto" ? 2 : 3\nplot(request.security("", "1", bar_index, calc_bars_count=reqDays))');
  const crypto = await new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { type: "crypto" }, now: () => 1_000_000 }).runBatch(bars);
  const equity = await new PineEngine().createSession(compiled, { timeframe: "1", symbolInfo: { type: "stock" }, now: () => 1_000_000 }).runBatch(bars);
  expect(crypto.plots[0]!.points.map((point) => point.value)).toEqual([0, 1]);
  expect(equity.plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
});

it("resolves a simple function count parameter from its one written caller", async () => {
  const compiled = program('base = input.int(2, "Bars")\nfetch(simple int count) => request.security("", "1", bar_index, calc_bars_count=count)\nplot(fetch(base))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", inputs: { Bars: 3 }, now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
});

it("keeps a simple caller parameter distinct from a same-named global input", async () => {
  const compiled = program('count = input.int(2, "Bars")\nfetch(simple int count) => request.security("", "1", bar_index, calc_bars_count=count)\nplot(fetch(count))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", inputs: { Bars: 3 }, now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
});

it("resolves an immutable simple local before a request inside one caller", async () => {
  const compiled = program('base = input.int(2, "Bars")\nfetch(simple int count) =>\n    local = count + 1\n    request.security("", "1", bar_index, calc_bars_count=local)\nplot(fetch(base))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1, 2]);
});

it("resolves a simple method count parameter from one written receiver call", async () => {
  const compiled = program('base = input.int(2, "Bars")\ntype Counter\n    int n = 0\nmethod fetch(Counter this, simple int count) => this.n + request.security("", "1", bar_index, calc_bars_count=count)\nvar Counter receiver = Counter.new()\nplot(receiver.fetch(base))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1]);
});

it("evaluates a pure simple function result once for the request window", async () => {
  const compiled = program('count() => 2\nplot(request.security("", "1", bar_index, calc_bars_count=count()))');
  const result = await new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000 }).runBatch(bars);
  expect(result.plots[0]!.points.map((point) => point.value)).toEqual([0, 1]);
});

it("enforces requested history when the provider returns extra bars", async () => {
  const compiled = program('plot(request.security("A", "1", bar_index, calc_bars_count=2))');
  const session = new PineEngine().createSession(compiled, { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway([]) });
  try {
    const result = await session.runBatch(bars);
    expect(result.plots[0]!.points.map((point) => point.value)).toEqual([NaN, NaN, 0, 1]);
  } finally { await session.close(); }
});

it.each([
  'varip int hits = 0\nhits += 1\nplot(hits)',
  'count() =>\n    varip int hits = 0\n    hits += 1\n    hits\nplot(count())',
  'varip values = array.from(0)\narray.set(values, 0, array.get(values, 0) + 1)\nplot(array.get(values, 0))',
])("does not repeat varip writes during incremental discovery: %s", async (prefix) => {
  const dynamic = new PineEngine().createSession(program(prefix + '\nsymbol = bar_index < 2 ? "A" : "B"\nplot(request.security(symbol, "1", close))'), { timeframe: "1", now: () => 1_000_000, marketDataGateway: gateway([]) });
  const control = new PineEngine().createSession(program(prefix), { timeframe: "1", now: () => 1_000_000 });
  try {
    await dynamic.runBatch(bars.slice(0, 2));
    await control.runBatch(bars.slice(0, 2));
    const expected = await control.appendBars(bars.slice(2));
    const actual = await dynamic.appendBars(bars.slice(2));
    expect(actual.plots[0]!.points).toEqual(expected.plots[0]!.points);
    const update = [{ ...bars[3]!, close: 5 }];
    const expectedTail = await control.replaceTail(update);
    const actualTail = await dynamic.replaceTail(update);
    expect(actualTail.plots[0]!.points).toEqual(expectedTail.plots[0]!.points);
  } finally { await Promise.all([dynamic.close(), control.close()]); }
});
