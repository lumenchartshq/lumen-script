import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";

const strict = { strict: true } as const;
function integerMatrix(values: readonly (readonly number[])[]) {
  const result = matrixCall("new_int", [values.length, values[0]?.length ?? 0, 0], strict);
  for (const [row, entries] of values.entries()) for (const [column, value] of entries.entries()) {
    matrixCall("set", [result, row, column, value], strict);
  }
  return result;
}
const data = (value: unknown) => (value as { data: number[][] }).data;

/** Independent exact inverse witness; decimal floating elimination loses these cells. */
describe("R062 integer matrix correction", () => {
  const input = [[-5, -4], [-4, -3]];
  const exactInverse = [[3, -4], [-4, 5]];
  it("inverse preserves exact integer cells", () => {
    const actual = data(matrixCall("inv", [integerMatrix(input)], strict));
    expect(actual).toEqual(exactInverse);
  });
  it("pseudoinverse preserves exact integer cells", () => {
    expect(data(matrixCall("pinv", [integerMatrix(input)], strict))).toEqual(exactInverse);
  });
  it("negative power preserves exact integer cells", () => {
    expect(data(matrixCall("pow", [integerMatrix(input), -1], strict))).toEqual(exactInverse);
  });

});
