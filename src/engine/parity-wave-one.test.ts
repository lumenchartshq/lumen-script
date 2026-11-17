import { expect, it } from "vitest";
import { PineEngine, compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

async function plotValues(body: string, version: 5 | 6 = 6): Promise<unknown[]> {
  const result = compile({ source: `//@version=${version}\nindicator("Parity")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(result.program!, { timeframe: "1" });
  try {
    const output = await session.runBatch([{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    return output.plots.map((plot) => plot.points[0]?.value);
  } finally { await session.close(); }
}

it("keeps literal spaces distinct while deduplicating equivalent request tokens", async () => {
  expect(await plotValues('x = request.security("", "", str.length("A B"))\ny = request.security("", "", str.length("AB"))\nplot(x)\nplot(y)')).toEqual([3, 2]);
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Dedup")\nx = request.security("", "", close + 1)\ny = request.security("", "", close+1)' });
  expect(result.program?.requestPlans).toHaveLength(1);
});

it.each([
  'x = switch 1\n    1 => 10\n    => 20',
  'x = if true\n    10\nelse\n    20',
])("ends block expressions before a following tuple declaration: %s", async (block) => {
  expect(await plotValues(`pair() => [2, 3]\n${block}\n[a, b] = pair()\nplot(x + a + b)`)).toEqual([15]);
});

it.each(['(1 +\n    2\n)', '(\n1\n+ 2\n)', '(1 +\n        2\n    )'])('accepts parenthesized wrapping: %s', async (value) => {
  expect(await plotValues(`x = ${value}\nplot(x)`)).toEqual([3]);
});

it.each(['"""A\n  B"""', "'''A\n  B'''", '"""A\\n  B"""'])('preserves multiline strings: %s', async (value) => {
  expect(await plotValues(`string value = ${value}\nplot(str.length(value))`)).toEqual([5]);
});

it("normalizes wrapped ordinary strings without leaking indentation", async () => {
  expect(await plotValues('string value = "A\n    B"\nplot(str.length(value))')).toEqual([3]);
});

it.each([5, 6] as const)("applies initial direction to an explicit positive loop step in v%s", async (version) => {
  expect(await plotValues('int total = 0\nfor i = 5 to 1 by 2\n    total += i\nf() =>\n    int sum = 0\n    for i = 5 to 1 by 2\n        sum += i\n    sum\nx = for i = 5 to 1 by 2\n    i\nplot(total)\nplot(f())\nplot(x)', version)).toEqual([9, 9, 1]);
});

it.each(['int stop = na\nfor i = 0 to stop', 'int stop = na\nfor i = stop to 2'])('skips loops with missing bounds: %s', async (header) => {
  expect(await plotValues(`int count = 0\n${header}\n    count += 1\nplot(count)`)).toEqual([0]);
});

it.each([-1, 0])("rejects invalid loop step %s before running the body", async (step) => {
  await expect(plotValues(`int count = 0\nfor i = 0 to 2 by ${step}\n    count += 1\nplot(count)`)).rejects.toThrow("step");
});

it.each([
  'x = for i = 0 to 2\n    int value = i * 2\n    value',
  'pair(int n) => [n, n * 2]\nx = for i = 0 to 2\n    [a, b] = pair(i)\n    a + b - i',
  'x = for value in array.from(0, 2, 4)\n    int copy = value\n    copy',
  'int i = 0\nx = while i < 3\n    int value = i * 2\n    i += 1\n    value',
])("supports loop-expression locals: %s", async (body) => {
  expect(await plotValues(`${body}\nplot(x)`)).toEqual([4]);
});

it("preserves fractional counters and permits a fractional end for an int counter", async () => {
  expect(await plotValues('int n = 0\nfor i = 0.0 to 2.0 by 0.5\n    n += 1\nint m = 0\nfor i = 0 to 2.5\n    m += 1\nplot(n)\nplot(m)')).toEqual([5, 3]);
});
it.each(['for i = 0 to 2 by 0.5\n    i', 'x = for i = 0 to 2 by 0.5\n    i'])("rejects fractional increments for int counters: %s", (body) => {
  const result = compile({ source: `//@version=6\nindicator("Step")\n${body}`, compatibility: PINE_COMPATIBILITY.strict });
  expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes("float loop step"))).toBe(true);
});

it("returns the final assignment and retains the preceding iteration on break", async () => {
  expect(await plotValues('int n = 0\nx = for i = 0 to 2\n    n += 2\ny = for i = 0 to 2\n    i + 100\n    if i == 2\n        break\n    i\nplot(x)\nplot(y)')).toEqual([6, 1]);
});

it("sorts strings lexically and returns stable indices without mutating the input", async () => {
  expect(await plotValues('a = array.from("z", "a", "b", "a")\nindices = array.sort_indices(a)\nplot(array.get(indices, 0))\nplot(array.get(indices, 1))\nplot(array.get(a, 0) == "z" ? 1 : 0)\na.sort()\nplot(a.first() == "a" ? 1 : 0)\na.sort(order.descending)\nplot(a.first() == "z" ? 1 : 0)')).toEqual([1, 3, 1, 1, 1]);
});

it.each(['"value"', '0', '1 - 1', 'field'])('sorts UDT arrays by constant field %s', async (selector) => {
  expect(await plotValues(`type Item\n    float value\n    string name\nconst string field = "val" + "ue"\na = array.from(Item.new(2, "b"), Item.new(1, "a"))\nindices = a.sort_indices(sort_field = ${selector})\nplot(indices.first())\narray.sort(a, sort_field = ${selector})\nplot(a.first().value)\na.sort(order.descending, sort_field = "name")\nplot(a.first().name == "b" ? 1 : 0)`)).toEqual([1, 1, 1]);
});

it("sorts matrix rows by a UDT field and preserves object references", async () => {
  expect(await plotValues('type Item\n    float value\n    string name\nm = matrix.new<Item>(2, 1)\nfirst = Item.new(2, "b")\nm.set(0, 0, first)\nm.set(1, 0, Item.new(1, "a"))\nm.sort(0, order.ascending, sort_field = 0)\nplot(m.get(0, 0).value)\nfirst.value := 7\nplot(m.get(1, 0).value)')).toEqual([1, 7]);
});

it.each(['"missing"', '2', '-1', '"flag"', 'input.int(0)', '0.5', 'true'])('rejects invalid sort fields on an empty UDT array: %s', (selector) => {
  const result = compile({ compatibility: PINE_COMPATIBILITY.strict, source: `//@version=6\nindicator("Invalid sort")\ntype Item\n    float value\n    bool flag\na = array.new<Item>()\na.sort(sort_field = ${selector})` });
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2122")).toBe(true);
});

it("sorts missing UDT field values last ascending and first descending", async () => {
  expect(await plotValues('type Item\n    float value\n    bool flag\na = array.from(Item.new(2, true), Item.new(na, false), Item.new(1, false))\na.sort()\nplot(a.first().value)\na.sort(order.descending)\nplot(na(a.first().value) ? 1 : 0)\ns = array.from("z", "a", "A", "10", "2")\ns.sort()\nplot(s.first() == "10" ? 1 : 0)')).toEqual([1, 1, 1]);
});

it("isolates persistent loop-expression locals from function storage slots", async () => {
  const declarations = Array.from({ length: 200 }, (_, index) => `    int other${index} = 0`).join("\n");
  const source = `//@version=6\nindicator("Local storage")\nf() =>\n    x = for i = 0 to 2\n        var int n = 0\n        n += 1\n        n\n${declarations}\n    x\nplot(f())`;
  const compiled = compile({ source, compatibility: PINE_COMPATIBILITY.strict });
  expect(compiled.diagnostics).toEqual([]);
  const session = new PineEngine().createSession(compiled.program!);
  try {
    const result = await session.runBatch([0, 60_000].map((openTime) => ({ openTime, open: 1, high: 1, low: 1, close: 1, volume: 1 })));
    expect(result.plots[0]?.points.map((point) => point.value)).toEqual([3, 6]);
  } finally { await session.close(); }
});
