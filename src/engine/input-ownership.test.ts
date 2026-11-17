import { expect, it } from "vitest";
import type { PineValue } from "../contracts/index.js";
import { compile, PineEngine } from "./index.js";
import { admitInputs } from "./inputs.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

const program = compile({ compatibility: PINE_COMPATIBILITY.strict, source: '//@version=6\nindicator("Inputs")\nfactor = input.float(1, "Factor")\nvalue = close * factor' }).program!;
const bars = [{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];

it("isolates constructor, update, checkpoint and restored input graphs", async () => {
  const initial = { Factor: 2, nested: { value: [1] } };
  const session = new PineEngine().createSession(program, { inputs: initial });
  try {
    initial.Factor = 99;
    initial.nested.value[0] = 99;
    expect((await session.runBatch(bars)).returned.value).toEqual([2]);
    const checkpoint = session.checkpoint();
    expect(checkpoint.inputs.nested).toEqual({ value: [1] });
    expect(() => (checkpoint.inputs.nested as { value: number[] }).value.push(2)).toThrow();
    const update = { Factor: 3 };
    await session.updateInputs(update);
    update.Factor = 99;
    expect((await session.runBatch(bars)).returned.value).toEqual([3]);
    const portable = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint;
    await session.restore(portable);
    (portable.inputs as { Factor: number }).Factor = 99;
    expect((await session.runBatch(bars)).returned.value).toEqual([2]);
  } finally { await session.close(); }
});

it("preserves cyclic/shared input identity, signed zero and deep graphs", () => {
  const shared: Record<string, PineValue> = { zero: -0 };
  shared.self = shared;
  const owned = admitInputs({ a: shared, b: shared });
  expect(owned.a).toBe(owned.b);
  expect((owned.a as typeof shared).self).toBe(owned.a);
  expect(Object.is((owned.a as typeof shared).zero, -0)).toBe(true);
  expect(owned.a).not.toBe(shared);
  let deep: PineValue = 1;
  for (let index = 0; index < 20_000; index++) deep = { child: deep };
  expect(() => admitInputs({ deep })).not.toThrow();
});
