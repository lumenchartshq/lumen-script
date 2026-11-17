import { expect, it } from "vitest";
import { validatePineLibraryExports } from "./library-export-validation.js";

it("requires exported parameter types but permits private untyped helpers", () => {
  const source = 'helper(value) => value\nexported(value, float other) => helper(value) + other';
  const result = validatePineLibraryExports(source, [{ name: "exported", line: 2 }]);
  expect(result.map((entry) => entry.message)).toEqual(["Exported parameter 'value' requires an explicit type"]);
  expect(result[0]!.range!.start.line).toBe(2);
});

it("rejects direct and transitively called input functions", () => {
  const source = 'read() => input.int(2)\nhelper() => read()\nexported(float value) => value + helper()';
  const result = validatePineLibraryExports(source, [{ name: "exported", line: 3 }]);
  expect(result).toHaveLength(1);
  expect(result[0]!.range!.start.line).toBe(1);
});

it("rejects input calls through typed receiver methods", () => {
  const source = 'type Item\n    float value\nmethod helper(Item item) => input.float(1)\nexported(Item item) => item.helper()';
  expect(validatePineLibraryExports(source, [{ name: "Item", line: 1 }, { name: "exported", line: 4 }])).toHaveLength(1);
});

it("permits demonstration inputs outside exported execution paths", () => {
  const source = 'demo() => input.int(2)\nlength = input.int(3)\nhelper(value) => value + 1\nexported(float value) => helper(value)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 4 }])).toEqual([]);
});

it("validates exact exported overload locations", () => {
  const source = 'method read(float self, other) => other\nmethod read(int self, int other) => other';
  expect(validatePineLibraryExports(source, [{ name: "read", line: 2 }])).toEqual([]);
});

it("requires public parameter and collection return types to be exported", () => {
  const source = 'type Hidden\n    int value\naccept(Hidden item) => item.value\nproduce() => array.from(Hidden.new(1))';
  const result = validatePineLibraryExports(source, [{ name: "accept", line: 3 }, { name: "produce", line: 4 }]);
  expect(result).toHaveLength(2);
  expect(result.every((entry) => entry.message.includes("Type 'Hidden' must be exported"))).toBe(true);
});

it("requires private enums referenced by exported type fields to be exported", () => {
  const source = 'enum Mode\n    first\ntype Public\n    Mode mode';
  expect(validatePineLibraryExports(source, [{ name: "Public", line: 3 }])).toHaveLength(1);
  expect(validatePineLibraryExports(source, [{ name: "Public", line: 3 }, { name: "Mode", line: 1 }])).toEqual([]);
});

it("permits private objects used only for internal calculations", () => {
  const source = 'type Hidden\n    int value\nexported(int n) =>\n    item = Hidden.new(n)\n    item.value';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 3 }])).toEqual([]);
});

it("permits const globals and shadowed locals in exported functions", () => {
  const source = 'const int offset = 2\nlength = input.int(3)\nhelper(int length) => length + offset\nexported(int value) =>\n    length = value + 1\n    helper(length)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 4 }])).toEqual([]);
});

it("rejects direct non-const global captures at the reference", () => {
  const source = 'length = input.int(3)\nvar int count = 2\nexported(int value) => value + length + count';
  const result = validatePineLibraryExports(source, [{ name: "exported", line: 3 }]);
  expect(result.map((entry) => [entry.code, entry.message, entry.range?.start.line])).toEqual([
    ["SCRIPT2123", "Exported function 'exported' cannot use non-const global 'length'", 3],
    ["SCRIPT2123", "Exported function 'exported' cannot use non-const global 'count'", 3],
  ]);
  expect(result.map((entry) => entry.range?.start.column)).toEqual([32, 41]);
});

it("rejects a non-const global captured through transitive helpers", () => {
  const source = 'length = input.int(3)\nread() => length\nhelper() => read()\nexported(int value) => value + helper()';
  const result = validatePineLibraryExports(source, [{ name: "exported", line: 4 }]);
  expect(result.map((entry) => [entry.code, entry.message, entry.range?.start.line])).toEqual([
    ["SCRIPT2123", "Exported function 'exported' cannot use non-const global 'length' via exported -> helper -> read", 2],
  ]);
});

it("does not reject non-const globals used only in demonstration code", () => {
  const source = 'length = input.int(3)\ndemo() => length\nplot(demo())\nexported(int value) => value + 1';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 4 }])).toEqual([]);
});

it("rejects global reference collections reached through a receiver helper", () => {
  const source = 'var values = array.from(1)\ntype Item\n    float value\nmethod read(Item self) => values.size()\nexported(Item item) => item.read()';
  const result = validatePineLibraryExports(source, [{ name: "Item", line: 2 }, { name: "exported", line: 5 }]);
  expect(result.map((entry) => [entry.message, entry.range?.start.line])).toEqual([
    ["Exported function 'exported' cannot use non-const global 'values' via exported -> read", 4],
  ]);
});

it("identifies an exported method that captures a non-const global", () => {
  const source = 'var int count = 1\ntype Item\n    float value\nmethod read(Item self) => self.value + count';
  const result = validatePineLibraryExports(source, [{ name: "Item", line: 2 }, { name: "read", line: 4 }]);
  expect(result.map((entry) => [entry.message, entry.range?.start.line])).toEqual([
    ["Exported method 'read' cannot use non-const global 'count'", 4],
  ]);
});

it.each([
  ['exported(float value) => request.security("A", "D", value)', 1],
  ['exported(float value) =>\n    copied = value + 1\n    request.security("A", "D", copied)', 3],
  ['read(float inputValue) => request.security("A", "D", inputValue)\nexported(float value) => read(value)', 1],
])("rejects exported parameter dependence in a request expression", (source, line) => {
  const exportedLine = source.split("\n").findIndex((item) => item.startsWith("exported")) + 1;
  const result = validatePineLibraryExports(source, [{ name: "exported", line: exportedLine }]);
  const capture = result.find((item) => item.code === "SCRIPT2123");
  expect(capture?.message).toBe("A library request expression cannot depend on an exported function parameter");
  expect(capture?.range?.start.line).toBe(line);
});

it("permits exported parameters in request selectors while keeping the expression independent", () => {
  const source = 'read(float value) => request.security("A", "D", close) + value\nexported(string symbol, float value) => request.security(symbol, "D", close) + read(value)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 2 }])).toEqual([]);
});

it("rejects expression capture through a private receiver method", () => {
  const source = [
    "type Item",
    "    float value",
    'method fetch(Item self, float requested) => request.security("A", "D", requested)',
    "exported(Item item, float value) => item.fetch(value)",
  ].join("\n");
  const result = validatePineLibraryExports(source, [{ name: "Item", line: 1 }, { name: "exported", line: 4 }]);
  expect(result.find((item) => item.code === "SCRIPT2123")?.range?.start.line).toBe(3);
});

it.each([
  ["branch write", 'exported(float n) =>\n    float x = 0\n    if n > 0\n        x := n\n    request.security("A", "D", x)'],
  ["loop induction", 'exported(int n) =>\n    float x = 0\n    for i = 0 to n\n        x := i\n    request.security("A", "D", x)'],
  ["collection mutation", 'exported(float n) =>\n    values = array.new_float(1, 0)\n    values.set(0, n)\n    request.security("A", "D", values.get(0))'],
  ["collection alias mutation", 'exported(float n) =>\n    values = array.new_float(1, 0)\n    alias = values\n    alias.set(0, n)\n    request.security("A", "D", values.get(0))'],
  ["namespace collection mutation", 'exported(float n) =>\n    values = array.new_float(1, 0)\n    array.set(values, 0, n)\n    request.security("A", "D", values.get(0))'],
  ["conditional may-alias mutation", 'exported(float n) =>\n    xs = array.new_float(1, 0)\n    ys = array.new_float(1, 0)\n    alias = xs\n    if close > 0\n        alias := ys\n    alias.set(0, n)\n    request.security("A", "D", xs.get(0))'],
  ["loop-carried write", 'exported(float n) =>\n    float a = 0\n    float b = 0\n    for i = 0 to 1\n        request.security("A", "D", a)\n        a := b\n        b := n'],
])("rejects %s dependence in a library request expression", (_label, source) => {
  const result = validatePineLibraryExports(source, [{ name: "exported", line: 1 }]);
  expect(result.some((item) => item.code === "SCRIPT2123" && item.message.includes("request expression"))).toBe(true);
});

it("permits a parameter-controlled request with an independent expression", () => {
  const source = 'exported(float n) =>\n    if n > 0\n        request.security("A", "D", close)\n    else\n        close';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 1 }])).toEqual([]);
});

it("keeps a private helper's independent return separate from its unused argument", () => {
  const source = 'constant(float unused) => close\nexported(float n) => request.security("A", "D", constant(n))';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 2 }])).toEqual([]);
});

it("permits a loop-selected request whose expression uses only market data", () => {
  const source = 'exported(int n) =>\n    for i = 0 to n\n        request.security("A", "D", close)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 1 }])).toEqual([]);
});

it("uses the bound receiver overload when checking private request helpers", () => {
  const source = [
    "type Item",
    "    float value",
    'method fetch(Item self, float n) => request.security("A", "D", n)',
    'method fetch(Item self, string mode) => request.security("A", "D", close)',
    "exported(Item item, string mode) => item.fetch(mode)",
  ].join("\n");
  expect(validatePineLibraryExports(source, [{ name: "Item", line: 1 }, { name: "exported", line: 5 }])).toEqual([]);
});

it("permits an unconditional scalar overwrite before the request", () => {
  const source = 'exported(float n) =>\n    float x = n\n    x := 0\n    request.security("A", "D", x)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 1 }])).toEqual([]);
});

it("does not mistake a user method named set for a collection mutation", () => {
  const source = [
    "type Item",
    "    float value",
    "method set(Item self, float unused) => close",
    'exported(float n) =>\n    item = Item.new(1)\n    item.set(n)\n    request.security("A", "D", item.value)',
  ].join("\n");
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 4 }])).toEqual([]);
});

it("keeps an inner shadowed declaration separate from an outer request expression", () => {
  const source = 'exported(float n) =>\n    float x = 0\n    if n > 0\n        float x = 1\n    request.security("A", "D", x)';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 1 }])).toEqual([]);
});

it("permits independent arrays after an unconditional alias reassignment", () => {
  const source = 'exported(float n) =>\n    xs = array.new_float(1, 0)\n    ys = array.new_float(1, 0)\n    alias = xs\n    alias := ys\n    alias.set(0, n)\n    request.security("A", "D", xs.get(0))';
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 1 }])).toEqual([]);
});

it("propagates a bound private method's field write to its caller", () => {
  const source = [
    "type Item",
    "    float value",
    "method write(Item self, float n) =>",
    "    self.value := n",
    "    self.value",
    'exported(float n) =>\n    item = Item.new(1)\n    item.write(n)\n    request.security("A", "D", item.value)',
  ].join("\n");
  expect(validatePineLibraryExports(source, [{ name: "exported", line: 6 }])
    .some((item) => item.code === "SCRIPT2123")).toBe(true);
});
