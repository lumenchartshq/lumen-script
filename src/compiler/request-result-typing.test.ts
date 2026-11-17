import { pineCallableMetadata, PINE_COMPATIBILITY, type PineCompatibility } from "../contracts/index.js";
import { expect, it } from "vitest";
import { compile } from "./index.js";

function check(body: string, compatibility: PineCompatibility = PINE_COMPATIBILITY.strict) {
  return compile({ compatibility, source: `//@version=6\nindicator("Request types")\n${body}` });
}

it.each([
  ["float", "close"],
  ["int", "bar_index"],
  ["bool", "close > open"],
  ["string", "syminfo.ticker"],
])("infers security %s from the child expression", (kind, expression) => {
  const accepted = check(`${kind} value = request.security("NASDAQ:MSFT", "60", ${expression})`);
  expect(accepted.diagnostics).toEqual([]);
  expect(accepted.program).toBeDefined();

  const wrong = check(`string value = request.security("NASDAQ:MSFT", "60", ${expression})`);
  if (kind !== "string") expect(wrong.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
  const weak = check(`simple ${kind} value = request.security("NASDAQ:MSFT", "60", ${expression})`);
  expect(weak.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
});

it("keeps tuple component types through security and lower-timeframe arrays", () => {
  const secure = check('[price, index, rising, ticker] = request.security("NASDAQ:MSFT", "60", [close, bar_index, close > open, syminfo.ticker])\nfloat a = price\nint b = index\nbool c = rising\nstring d = ticker');
  expect(secure.diagnostics).toEqual([]);

  const lower = check('[prices, indexes, flags, names] = request.security_lower_tf("NASDAQ:MSFT", "15", [close, bar_index, close > open, syminfo.ticker])\narray<float> a = prices\narray<int> b = indexes\narray<bool> c = flags\narray<string> d = names\nfloat first = array.get(a, 0)');
  expect(lower.diagnostics).toEqual([]);

  const wrongScalar = check('[price, index] = request.security("NASDAQ:MSFT", "60", [close, bar_index])\nstring bad = price');
  expect(wrongScalar.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
  const wrongArray = check('[prices, indexes] = request.security_lower_tf("NASDAQ:MSFT", "15", [close, bar_index])\narray<string> bad = prices');
  expect(wrongArray.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
});

it("types lower-timeframe scalar arrays and rejects invalid downstream uses", () => {
  expect(check('array<float> values = request.security_lower_tf("NASDAQ:MSFT", "15", close)\nfloat first = array.get(values, 0)').diagnostics).toEqual([]);
  expect(check('array<int> values = request.security_lower_tf("NASDAQ:MSFT", "15", close)').diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
  expect(check('array<float> values = request.security_lower_tf("NASDAQ:MSFT", "15", close)\nstring bad = array.get(values, 0)').diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
});

it("preserves reference and nested collection expressions admitted by requests", () => {
  expect(check('array<float> child = request.security("NASDAQ:MSFT", "60", array.from(close))\nfloat first = array.get(child, 0)').diagnostics).toEqual([]);
  expect(check('array<array<float>> groups = request.security_lower_tf("NASDAQ:MSFT", "15", array.from(close))\narray<float> first = array.get(groups, 0)').diagnostics).toEqual([]);
  expect(check('array<string> wrong = request.security("NASDAQ:MSFT", "60", array.from(close))').diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
});

it("keeps the sealed request result boundary unchanged", () => {
  const sealed = check('string value = request.security("NASDAQ:MSFT", "60", close)', PINE_COMPATIBILITY.legacy);
  expect(sealed.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(false);
  const strict = check('string value = request.security("NASDAQ:MSFT", "60", close)');
  expect(strict.diagnostics.some((entry) => entry.code === "SCRIPT2102")).toBe(true);
});

it("publishes ordered production request signatures without changing sealed metadata", () => {
  const strict = pineCallableMetadata(PINE_COMPATIBILITY.strict);
  const sealed = pineCallableMetadata(PINE_COMPATIBILITY.legacy);
  expect(strict["request.security"]?.typedOverloads?.[0]?.parameters.map((parameter) => parameter.name)).toEqual([
    "symbol", "timeframe", "expression", "gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count",
  ]);
  expect(strict["request.security_lower_tf"]?.typedOverloads?.[0]?.parameters.map((parameter) => parameter.name)).toEqual([
    "symbol", "timeframe", "expression", "ignore_invalid_symbol", "currency", "ignore_invalid_timeframe", "calc_bars_count",
  ]);
  expect(sealed["request.security_lower_tf"]?.typedOverloads?.[0]?.parameters[3]?.name).toBe("ignore_invalid_timeframe");
});

it.each([
  'request.security(42, "60", close)',
  'request.security("NASDAQ:MSFT", 60, close)',
])("rejects wrong request selector kinds: %s", (call) => {
  const result = check(`value = ${call}`);
  expect(result.diagnostics.some((entry) => entry.code === "SCRIPT2117" && entry.range !== undefined)).toBe(true);
});
