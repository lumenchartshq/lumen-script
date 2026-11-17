import { describe, expect, it } from "vitest";

import { compile } from "./index.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const compileStrict = (body: string) => compile({
  compatibility: PINE_COMPATIBILITY.strict,
  source: `//@version=6\nindicator("Map semantics")\n${body}`,
});

describe("map semantic contracts", () => {
  it("preserves exact key/value types through namespace and method calls", () => {
    const result = compileStrict(`enum Signal
    buy
    sell
type Item
    float value
map<string, float> source = map.new<string, float>()
map<string, float> target = map.new<string, float>()
map.put(source, "one", 1)
target.put(key = "two", value = 2.0)
map.put_all(target, source)
target.put_all(from = source)
series float fetched = map.get(target, "one")
series float removed = target.remove("two")
series bool present = target.contains("one")
series int count = map.size(target)
array<string> keys = target.keys()
array<float> values = map.values(target)
map<string, float> copied = map.copy(target)
map.clear(copied)
map<int, Item> objects = map.new<int, Item>()
map<int, line> handles = map.new<int, line>()
map<bool, string> boolKeys = map.new<bool, string>()
map<color, int> colorKeys = map.new<color, int>()
map<float, bool> floatKeys = map.new<float, bool>()
map<Signal, int> enumKeys = map.new<Signal, int>()
map.put(enumKeys, Signal.buy, 1)
enumKeys.put(Signal.sell, 2)
series int enumValue = enumKeys.get(Signal.buy)
plot(fetched + removed + count + enumValue + (present ? 1 : 0) + keys.size() + values.size() + objects.size() + handles.size() + boolKeys.size() + colorKeys.size() + floatKeys.size())`);

    expect(result.diagnostics).toEqual([]);
    expect(result.program?.generatedSource).toContain('"map.new"');
    expect(result.program?.generatedSource).toContain('"put_all"');
  });

  it("keeps commas inside map types on parameters and method receivers", () => {
    const result = compileStrict(`readValue(map<string, int> values, string key) =>
    values.get(key)
method readDefault(map<string, int> values, string key = "b") =>
    values.get(key)
map<string, int> source = map.new<string, int>()
source.put("b", 5)
series int fromFunction = readValue(source, "b")
series int fromMethod = source.readDefault()
plot(fromFunction + fromMethod)`);
    expect(result.diagnostics).toEqual([]);
    expect(result.program).toBeDefined();
  });

  it("rejects unsupported constructor key/value types and arity", () => {
    const cases = [
      ["missing types", "value = map.new()", "SCRIPT2014", "exactly two type parameters"],
      ["one type", "value = map.new<string>()", "SCRIPT2014", "exactly two type parameters"],
      ["three types", "value = map.new<string, float, int>()", "SCRIPT2014", "exactly two type parameters"],
      ["collection key", "value = map.new<array<int>, float>()", "SCRIPT2117", "requires a primitive or enum key type"],
      ["object key", "type Item\n    float value\nvalue = map.new<Item, float>()", "SCRIPT2117", "requires a primitive or enum key type"],
      ["collection value", "value = map.new<string, array<int>>()", "SCRIPT2117", "requires a primitive, enum, UDT, or object reference value type"],
    ] as const;

    for (const [label, source, code, message] of cases) {
      const result = compileStrict(source);
      const diagnostic = result.diagnostics.find((candidate) => candidate.code === code);
      expect(diagnostic, label).toBeDefined();
      expect(diagnostic?.message, label).toContain(message);
      expect(result.program, label).toBeUndefined();
    }
  });

  it("preserves exact enum key identity for namespace and method calls", () => {
    const prelude = `enum Signal
    buy
    sell
enum Other
    buy
    sell
map<Signal, int> values = map.new<Signal, int>()`;
    for (const expression of [
      "map.put(values, Other.buy, 1)",
      "values.put(Other.buy, 1)",
      "map.get(values, Other.buy)",
      "values.get(Other.buy)",
      'map.put(values, "buy", 1)',
      'values.get("buy")',
    ]) {
      const result = compileStrict(`${prelude}\n${expression}`);
      expect(result.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
      expect(result.program, expression).toBeUndefined();
    }
  });

  it("makes namespace and method type failures agree", () => {
    const pairs = [
      ["map.get(values, 1)", "values.get(1)"],
      ["map.contains(values, 1)", "values.contains(1)"],
      ["map.put(values, 1, 2.0)", "values.put(1, 2.0)"],
      ["map.put(values, \"ok\", \"wrong\")", "values.put(\"ok\", \"wrong\")"],
    ] as const;
    for (const [namespaceCall, methodCall] of pairs) {
      for (const expression of [namespaceCall, methodCall]) {
        const result = compileStrict(`map<string, float> values = map.new<string, float>()\n${expression}`);
        expect(result.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
        expect(result.program, expression).toBeUndefined();
      }
    }

    for (const expression of [
      "map.put_all(strings, integers)",
      "strings.put_all(integers)",
    ]) {
      const result = compileStrict(`map<string, float> strings = map.new<string, float>()
map<int, float> integers = map.new<int, float>()
${expression}`);
      expect(result.diagnostics, expression).toContainEqual(expect.objectContaining({ code: "SCRIPT2111" }));
      expect(result.program, expression).toBeUndefined();
    }
  });

  it("types values, arrays, copies and void effects exactly", () => {
    const invalid = compileStrict(`map<string, float> values = map.new<string, float>()
int wrongGet = values.get("one")
simple float wrongQualifier = map.remove(values, "one")
array<int> wrongKeys = values.keys()
array<string> wrongValues = map.values(values)
map<int, float> wrongCopy = values.copy()
int wrongContains = values.contains("one")
bool wrongSize = values.size()
assignedClear = values.clear()
int wrongPut = map.put(values, "one", 1.0)
assignedMerge = values.put_all(values)`);

    expect(invalid.diagnostics.filter(({ code }) => code === "SCRIPT2102")).toHaveLength(8);
    // map.put returns the replaced value, so only clear and put_all are void.
    expect(invalid.diagnostics.filter(({ code }) => code === "SCRIPT2137")).toHaveLength(2);
    expect(invalid.program).toBeUndefined();
  });

  it("rejects non-map namespace receivers only in the strict profile", () => {
    const source = `//@version=6
indicator("Map receiver boundary")
value = map.get(1, "key")`;
    const strict = compile({ compatibility: PINE_COMPATIBILITY.strict, source });
    const sealed = compile({ compatibility: PINE_COMPATIBILITY.legacy, source });

    expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: "SCRIPT2117" }));
    expect(strict.program).toBeUndefined();
    expect(sealed.diagnostics).toEqual([]);
    expect(sealed.program).toBeDefined();
  });
});
