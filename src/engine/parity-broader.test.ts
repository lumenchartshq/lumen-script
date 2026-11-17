import { expect, it } from "vitest";
import { compile, PineEngine } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function current(body: string, version: 5 | 6 = 6) {
  return compile({ source: `//@version=${version}\nindicator("Broader parity")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
}
async function values(body: string, count = 1, version: 5 | 6 = 6) {
  const compiled = current(body, version);
  expect(compiled.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compiled.program!);
  try {
    const result = await session.runBatch(Array.from({ length: count }, (_, index) => ({ openTime: index * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 })));
    return result.plots.map((plot) => plot.points.map((point) => point.value));
  } finally { await session.close(); }
}

it.each([
  'f(int x) =>\n    x += 1\n    x\nplot(f(1))',
  'method bump(array<int> x) =>\n    x := array.new_int()\n    x\na = array.new_int()\na.bump()',
  'int global = 0\nf() =>\n    x = if true\n        global := 2\n        global\n    x\nplot(f())',
])('rejects protected binding writes: %s', (body) => {
  expect(current(body).diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
});

it("permits mutation of objects referenced by function arguments", async () => {
  expect(await values('f(array<int> a) =>\n    a.push(2)\n    a.size()\na = array.new_int()\nplot(f(a))')).toEqual([[1]]);
});

it.each([
  'pair() => [2, 3]\nx = if true\n    [a, b] = pair()\n    a + b\nplot(x)',
  'pair() => [2, 3]\nx = switch\n    true =>\n        [a, b] = pair()\n        a + b\nplot(x)',
  'int n = 1\nx = if true\n    n += 4\nplot(x)',
  'x = if true\n    int n = 5\nplot(x)',
  'x = if true\n    if true\n        100\n    5\nplot(x)',
  'x = if true\n    int n = 0\n    for i = 2 to 3\n        n += i\n    n\nplot(x)',
  'f() =>\n    int n = 1\n    n += 4\nplot(f())',
  'f() =>\n    int n = 5\nplot(f())',
  'f() =>\n    for i = 0 to 5\n        i\nplot(f())',
])('returns the final value of nested blocks: %s', async (body) => {
  expect(await values(body)).toEqual([[5]]);
});

it.each([5, 6] as const)("includes conditional selectors in result qualifiers in v%s", (version) => {
  for (const expression of [
    "if bar_index == 0\n    1\nelse\n    2",
    "switch bar_index\n    0 => 1\n    => 2",
    "bar_index == 0 ? 1 : 2",
    ...(version === 6 ? ["switch\n    bar_index == 0 => 1\n    => 2"] : []),
  ]) {
    const { diagnostics } = current(`simple int result = ${expression}\nplot(result)`, version);
    expect(diagnostics.some(({ code, message }) => code === "SCRIPT2102" && message.includes("series int"))).toBe(true);
  }
});

it.each([5, 6] as const)("uses versioned bool defaults for unmatched if and switch expressions in v%s", async (version) => {
  const compiled = current(`bool byIf = if bar_index == 0
    true
bool bySwitch = switch bar_index
    0 => true
    2 => false
float numeric = if bar_index == 0
    1.5
plot(numeric)`, version);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.program).toBeDefined();
  if (compiled.program === undefined) return;
  const session = new PineEngine().createSession(compiled.program);
  try {
    const result = await session.runBatch([0, 60_000, 120_000].map((openTime) => ({
      openTime, open: 1, high: 1, low: 1, close: 1, volume: 1,
    })));
    const absent = version === 6 ? false : Number.NaN;
    expect(result.returned.byIf).toEqual([true, absent, absent]);
    expect(result.returned.bySwitch).toEqual([true, absent, false]);
    expect(result.returned.numeric).toEqual([1.5, Number.NaN, Number.NaN]);
  } finally {
    await session.close();
  }
});

it("preserves the constant if fallback while defaulting v6 bool switches to false", async () => {
  expect(await values(`bool constIf = if false
    close > 0
bool inputIf = if input.bool(false)
    true
bool simpleIf = if syminfo.mintick < 0
    true
bool constSwitch = switch 0
    1 => true
plot(constIf == false ? 1 : 0)
plot(inputIf == false ? 1 : 0)
plot(simpleIf == false ? 1 : 0)
plot(constSwitch == false ? 1 : 0)
bool constantIf = if false
    true
plot(str.tostring(constantIf) == "false" ? 1 : 0)`)).toEqual([[0], [1], [1], [1], [1]]);
});

it.each([5, 6] as const)("copies objects shallowly and defaults omitted fields in v%s", async (version) => {
  expect(await values(`type Payload
    int n = 7
    bool flag
    array<int> members
Payload original = Payload.new()
bool absent = na(original.members)
original.members := array.from(1, 2)
Payload copied = original.copy()
copied.n := 10
copied.members.push(3)
plot(original.n)
plot(original.flag ? 1 : 0)
plot(absent ? 1 : 0)
plot(copied.n)
plot(original.members.size())
plot(copied.members.size())`, 1, version)).toEqual([[7], [0], [1], [10], [3], [3]]);
});

it.each([5, 6] as const)("raises the missing first-field error when copying an absent object in v%s", async (version) => {
  await expect(values(`type Payload
    int n
Payload absent = na
Payload copied = absent.copy()
plot(copied.n)`, 1, version)).rejects.toThrow("Cannot access the 'Payload.n' field of an undefined object. The object is 'na'.");
});

it.each([5, 6] as const)("initializes omitted bool array values to false in v%s", async (version) => {
  expect(await values(`a = array.new<bool>(1)
b = array.new_bool(1)
plot(a.get(0) == false ? 1 : 0)
plot(b.get(0) == false ? 1 : 0)`, 1, version)).toEqual([[1], [1]]);
});

it("dispatches methods through statically typed v6 enum values", async () => {
  expect(await values(`enum Signal
    buy = "Long entry"
    sell = "Short entry"
    hold
method score(Signal s) =>
    switch s
        Signal.buy => 10
        Signal.sell => -10
        => 0
Signal selected = input.enum(Signal.buy)
plot(selected.score())
plot(Signal.hold.score())`)).toEqual([[10], [0]]);
});

it("evaluates a shadowing initializer in the outer scope", async () => {
  expect(await values('int n = 10\nx = if true\n    int n = n + 1\n    n\nplot(x)\nplot(n)')).toEqual([[11], [10]]);
});

it.each([
  'x = for i = 0 to 2\n    int n = 0\n    for j = 0 to i\n        n += j\n    n',
  'x = for i = 0 to 2\n    int n = 0\n    while n < 3\n        n += 1\n    n',
  'x = for i = 0 to 2\n    int n = 0\n    for j in array.from(1, 2)\n        n += j\n    n',
])('supports nested loops in expression blocks: %s', async (body) => {
  expect(await values(`${body}\nplot(x)`)).toEqual([[3]]);
});

it.each(['var', 'varip'])("limits direct %s loop initialization to one iteration", async (persistence) => {
  expect(await values(`${persistence} int x = for i = 0 to 3\n    i\nf() =>\n    for i = 0 to 3\n        i\n${persistence} int y = f()\nint n = 0\n${persistence} int z = while n < 3\n    n += 1\n    n\nplot(x)\nplot(y)\nplot(z)`, 2)).toEqual([[0, 0], [3, 3], [1, 1]]);
});

it("iterates matrix rows with array element types", async () => {
  expect(await values('m = matrix.new<int>(2, 2, 1)\nint total = 0\nfor row in m\n    total += row.sum()\nplot(total)')).toEqual([[4]]);
});


it("reads live matrix rows while copying primitives and retaining object references", async () => {
  expect(await values(`m = matrix.new<int>(1, 1, 2)
int total = 0
for [i, row] in m
    total += row.get(0)
    row.set(0, 9)
    if i == 0
        m.add_row(m.rows(), array.from(3))
type Item
    int value
objects = matrix.new<Item>(1, 1, Item.new(4))
for row in objects
    item = row.get(0)
    item.value := 7
plot(total)
plot(m.get(0, 0))
plot(objects.get(0, 0).value)`)).toEqual([[5], [2], [7]]);
});


it("reads map replacements during iteration when later plots also read the map", async () => {
  expect(await values(`m = map.new<string, int>()
m.put("a", 1)
m.put("b", 2)
overlap = map.new<string, int>()
overlap.put("a", 10)
overlap.put("b", 20)
int total = 0
for [key, value] in m
    if key == "a"
        map.put(m, "b", 5)
        m.put("a", 4)
        map.put_all(m, overlap)
    else
        m.put_all(overlap)
    total += value
plot(total)
plot(m.get("a"))
plot(m.get("b"))`)).toEqual([[21], [10], [20]]);
});

it.each(['m.put("b", 2)', 'map.put_all(m, additions)', 'm.put_all(additions)', 'm.remove("c")', 'm.clear()', 'm.remove("c")\n        m.put("b", 2)'])("rejects structural map edits when advancing: %s", async (edit) => {
  await expect(values(`m = map.new<string, int>()
m.put("a", 1)
m.put("c", 3)
additions = map.new<string, int>()
additions.put("b", 2)
for [key, value] in m
    if key == "a"
        ${edit}
plot(m.size())`)).rejects.toThrow("Cannot modify a map");
});

it.each(['    break\n', ''])("allows map edits when no further entry is read: %s", async (exit) => {
  expect(await values(`m = map.new<string, int>()
m.put("a", 1)
for [key, value] in m
    m.put("b", 2)
${exit}plot(m.size())`)).toEqual([[2]]);
});


it("returns false for absent v6 boolean history across global, local and expression paths", async () => {
  expect(await values('bool flag = true\nf(bool arg) =>\n    bool local = arg\n    [arg[1] == false, local[1] == false]\n[a, b] = f(flag)\nplot(flag[1] == false ? 1 : 0)\nplot(a ? 1 : 0)\nplot(b ? 1 : 0)\nplot((close > 0)[1] == false ? 1 : 0)', 2)).toEqual([[1, 0], [1, 0], [1, 0], [1, 0]]);
});

it("preserves missing v5 boolean history", async () => {
  expect(await values('bool flag = true\nplot(na(flag[1]) ? 1 : 0)', 2, 5)).toEqual([[1, 0]]);
});

it("treats missing history offsets as zero", async () => {
  expect(await values('int offset = na\nbool flag = true\nplot(flag[offset] ? 1 : 0)\nplot(close[offset])')).toEqual([[1], [1]]);
});

it.each(['close', 'flag', '(close > 0)', 'f(close)'])("rejects negative history offsets with source locations: %s", async (source) => {
  await expect(values(`f(float x) => x
bool flag = true
int offset = -1
plot(${source}[offset] == ${source} ? 1 : 0)`)).rejects.toMatchObject({ name: "PineRuntimeError", method: "[]", range: { start: { line: 6 } } });
});

it.each(['plot(1[1])', 'type Item\n    int value\nitem = Item.new(1)\nplot(item.value[1])'])("rejects removed v6 history syntax: %s", (body) => {
  expect(current(body).diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2107")).toBe(true);
  expect(current(body, 5).diagnostics).toEqual([]);
});


it.each(['str.lower("VALUE")', 'str.trim(" value ")', 'int(math.abs(-0))', 'math.min(0, 1)', 'math.max(-1, 0)', 'math.floor(0.9)', 'math.ceil(-0.9)', '(true and not false) ? "value" : "name"'])("folds safe constant sort selectors: %s", async (selector) => {
  expect(await values(`type Item
    float value
    string name
a = array.from(Item.new(2, "b"), Item.new(1, "a"))
a.sort(sort_field = ${selector})
plot(a.first().value)`)).toEqual([[1]]);
});


it("rejects field assignments directly through a function result", () => {
  const result = current('type Item\n    int value\na = array.from(Item.new(1))\na.get(0).value := 2');
  expect(result.diagnostics.find((diagnostic) => diagnostic.code === "SCRIPT2106")?.range?.start.line).toBe(6);
});

it.each(['continue', 'break'])("keeps the last completed trailing-loop value across %s", async (exit) => {
  expect(await values(`f() =>
    for i = 0 to 2
        if i == 2
            ${exit}
        i
plot(f())`)).toEqual([[1]]);
});

it("returns tuples through nested conditional and loop blocks", async () => {
  expect(await values('f() =>\n    for i = 0 to 2\n        if i >= 0\n            [i, i + 1]\n[a, b] = f()\nplot(a)\nplot(b)')).toEqual([[2], [3]]);
});

it("limits direct persistent for-in initialization but allows reassigned loops to finish", async () => {
  expect(await values('var int a = for i in array.from(1, 2, 3)\n    i\nvar int b = 0\nb := for i = 1 to 3\n    i\nplot(a)\nplot(b)', 2)).toEqual([[1, 1], [3, 3]]);
});

it("keeps array for-in iteration live", async () => {
  expect(await values('a = array.from(1)\nint sum = 0\nfor [i, value] in a\n    sum += value\n    if i == 0\n        a.push(2)\nplot(sum)')).toEqual([[3]]);
});


it("distinguishes series namespace history from constant history", async () => {
  expect(await values('plot(barstate.isfirst[1] ? 1 : 0)', 2)).toEqual([[0, 1]]);
  expect(current('color previous = color.red[1]').diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2107")).toBe(true);
  expect(current('color previous = color.red[1]', 5).diagnostics).toEqual([]);
});

it("does not execute user functions to resolve constant selectors", () => {
  expect(current('type Item\n    int value\nf() => "value"\na = array.new<Item>()\na.sort(sort_field = f())').diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2122")).toBe(true);
});

it.each([false, true])("keeps generic boolean and numeric history calls independent (reverse=%s)", async (reverse) => {
  const plots = ['plot(f(close))', 'plot(f(true) == false ? 1 : 0)'];
  if (reverse) plots.reverse();
  const expected = [[Number.NaN, 1], [1, 0]];
  if (reverse) expected.reverse();
  expect(await values(`f(x) => x[1]\n${plots.join("\n")}`, 2)).toEqual(expected);
});
