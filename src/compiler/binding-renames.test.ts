import { expect, it } from "vitest";
import { pineGlobalBindings, renamePineBindings } from "./binding-renames.js";
import { compile } from "./index.js";
import { renamePineReceiverMethods } from "./receiver-method-renames.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

function rename(body: string): string {
  const source = `//@version=6\nindicator("Bindings")\n${body}`;
  return renamePineBindings(source, pineGlobalBindings(source).map(({ name }) => ({ name, replacement: `lib_${name}` })));
}

it("resolves shadowing initializers before introducing local bindings", () => {
  const source = rename('int n = 10\nf() =>\n    int n = n + 1\n    n\nplot(f())');
  expect(source).toContain('int n = lib_n + 1');
  expect(source).toContain('\n    n\n');
  expect(compile({ source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
});

it("keeps nested local and loop shadows inside their lexical block", () => {
  const source = rename('int n = 10\nf() =>\n    if true\n        int n = 2\n        n\n    for n = 0 to 1\n        n\n    n\nplot(f())');
  expect(source).toContain('for n = 0 to 1\n        n\n    lib_n');
  expect(source).toContain('int n = 2\n        n');
});

it("renames annotation types without renaming equal field and parameter names", () => {
  const source = rename('type Item\n    int Item\ntype Holder\n    Item Item\nf(Item Item) => Item.Item\na = array.new<Item>()\nplot(f(Item.new(1)))');
  expect(source).toContain('lib_Item Item');
  expect(source).toContain('lib_f(lib_Item Item) => Item.Item');
  expect(source).toContain('array.new<lib_Item>()');
  expect(compile({ source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
});

it("renames enums and tuple globals without changing enum members", () => {
  const source = rename('enum Choice\n    first\npair() => [1, 2]\n[a, b] = pair()\nx = Choice.first\nplot(a + b)');
  expect(source).toContain('enum lib_Choice\n    first');
  expect(source).toContain('[lib_a, lib_b] = lib_pair()');
  expect(source).toContain('lib_Choice.first');
});

it("preserves strings, comments, named arguments and field names", () => {
  const source = rename('int value = 1\nf(int value) => value\n// value f\nplot(f(value = value), "value")');
  expect(source).toContain('// value f');
  expect(source).toContain('lib_f(value = lib_value), "value"');
});

it("renames tuple and for-in locals only at their binding scope", () => {
  const source = rename('int x = 1\nf() =>\n    [x, y] = [2, 3]\n    for [i, x] in array.from(4)\n        x\n    x\nplot(f())');
  expect(source).toContain('[x, y] = [2, 3]');
  expect(source).toContain('for [i, x] in array.from(4)\n        x\n    x');
});

it("resolves library qualifiers by lexical ownership, including annotated types", () => {
  const source = 'type Item\n    int value\nf(Item lib) => lib.value\ng(lib.Item item) => item.value\nx = lib.Item.new(2)\nplot(lib.get(x))';
  const used: string[] = [];
  const result = renamePineBindings(source, [], { name: "lib", resolve(member) { used.push(member); return `linked_${member}`; } });
  expect(result).toContain('f(Item lib) => lib.value');
  expect(result).toContain('g(linked_Item item)');
  expect(result).toContain('x = linked_Item.new(2)');
  expect(result).toContain('plot(linked_get(x))');
  expect(used).toEqual(['Item', 'Item', 'get']);
});

it("introduces global receiver shadows after their initializer", () => {
  const source = 'lib = lib.make()\nplot(lib.value)';
  const result = renamePineBindings(source, [], { name: "lib", resolve(member) { return `linked_${member}`; } });
  expect(result).toBe('lib = linked_make()\nplot(lib.value)');
});


it("renames resolved receiver methods without rewriting builtin methods or fields", () => {
  const source = rename('type Item\n    float get\nmethod get(Item self, int index) => self.get + index\nread(Item item) => item.get(2)\nitems = array.from(3)\nplot(read(Item.new(4)) + items.get(0))');
  expect(source).toContain('method lib_get(lib_Item self');
  expect(source).toContain('item.lib_get(2)');
  expect(source).toContain('self.get + index');
  expect(source).toContain('lib_items.get(0)');
  expect(compile({ source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
});

it("renames receiver chains and local receiver bindings by type", () => {
  const source = rename('type Item\n    float value\nmethod next(Item self) => Item.new(self.value + 1)\nread(Item item) =>\n    next = item.next()\n    next.next().value\nplot(read(Item.new(1)))');
  expect(source).toContain('next = item.lib_next()');
  expect(source).toContain('next.lib_next().value');
  expect(compile({ source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
});


it("links imported methods by receiver type while preserving private visibility", () => {
  const prelude = 'type A\n    int value\ntype B\n    int value\nmethod a_read(A self) => self.value\nmethod b_read(B self) => self.value + 1\nmethod a_private(A self) => 9\n';
  const result = renamePineReceiverMethods(prelude + 'a = A.new(1)\nb = B.new(2)\nplot(a.read() + b.read())', [{ name: "read", replacement: "a_read" }, { name: "read", replacement: "b_read" }], prelude.length);
  expect(result.source).toContain('a.a_read() + b.b_read()');
  expect(result.used).toEqual(['a_read', 'b_read']);
  expect(compile({ source: '//@version=6\nindicator("Linked")\n' + result.source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
  const hidden = renamePineReceiverMethods(prelude + 'a = A.new(1)\nplot(a.private())', [{ name: "read", replacement: "a_read" }], prelude.length);
  expect(hidden.source).toContain('a.private()');
});

it("links distinct imported signatures on one receiver without changing overload ownership", () => {
  const prelude = 'type Item\n    int value\nmethod lib_read(Item self) => self.value\nmethod lib_read(Item self, int extra) => self.value + extra\n';
  const result = renamePineReceiverMethods(prelude + 'item = Item.new(2)\nplot(item.read() + item.read(extra=3))', [{ name: "read", replacement: "lib_read" }], prelude.length);
  expect(result.source).toContain('item.lib_read() + item.lib_read(extra=3)');
  expect(result.used).toEqual(['lib_read']);
  expect(compile({ source: '//@version=6\nindicator("Linked")\n' + result.source, compatibility: PINE_COMPATIBILITY.strict }).diagnostics).toEqual([]);
});

it("keeps imported enum qualifiers distinct when the enum shadows a reference name", () => {
  const prelude = 'enum line\n    first\ntype Item\n    int value\nmethod lib_read(Item self, simple line mode) => 1\nmethod lib_read(Item self, series line mode) => 2\n';
  const result = renamePineReceiverMethods(prelude + 'item = Item.new(1)\nplot(item.read(line.first))', [{ name: "read", replacement: "lib_read" }], prelude.length);
  expect(result.source).toContain('item.lib_read(line.first)');
  const compiled = compile({ source: '//@version=6\nindicator("Linked")\n' + result.source, compatibility: PINE_COMPATIBILITY.strict });
  expect(compiled.diagnostics.some((diagnostic) => diagnostic.code === "SCRIPT2013")).toBe(false);
});


it("rejects ambiguous imported primitive methods and preserves local ownership", () => {
  const prelude = 'method first_read(float self) => self + 1\nmethod second_read(float self) => self + 2\n';
  const aliases = [{ name: "read", replacement: "first_read" }, { name: "read", replacement: "second_read" }];
  expect(() => renamePineReceiverMethods(prelude + 'plot(close.read())', aliases, prelude.length)).toThrow("Ambiguous imported receiver method");
  const local = renamePineReceiverMethods(prelude + 'method read(float self) => self + 3\nplot(close.read())', aliases, prelude.length);
  expect(local.source).toContain('plot(close.read())');
  expect(local.used).toEqual([]);
});


it("does not specialize a polymorphic receiver call to the final imported type", () => {
  const prelude = 'type A\n    int value\ntype B\n    int value\nmethod a_read(A self) => self.value\nmethod b_read(B self) => self.value\n';
  const body = 'read(item) => item.read()\nplot(read(A.new(1)) + read(B.new(2)))';
  expect(() => renamePineReceiverMethods(prelude + body, [{ name: "read", replacement: "a_read" }, { name: "read", replacement: "b_read" }], prelude.length)).toThrow("Polymorphic imported receiver method");
});


it("does not rename a polymorphic builtin receiver to an imported user method", () => {
  const prelude = 'type Item\n    float value\nmethod item_get(Item self, int index) => self.value + index\n';
  const body = 'read(item) => item.get(0)\nplot(read(Item.new(1)) + read(array.from(2)))';
  expect(() => renamePineReceiverMethods(prelude + body, [{ name: "get", replacement: "item_get" }], prelude.length)).toThrow("Polymorphic imported receiver method");
  expect(() => rename('type Item\n    float value\nmethod get(Item self, int index) => self.value + index\n' + body)).toThrow("Polymorphic builtin and user method");
});
