import type { PineValue } from "../contracts/index.js";
import { describe, expect, it } from "vitest";

import { matrixCall } from "./collections.js";
import { structuralInverse, structuralPower } from "./matrix-structural.js";
import { MatrixWorkMeter } from "./matrix-work-meter.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

function integerMatrix(data: number[][]): PineValue {
  return { __pineMatrix: true, columnCount: data[0]?.length ?? 0, elementKind: "int", data } as unknown as PineValue;
}

const cells = (matrix: unknown): number[][] => (matrix as { data: number[][] }).data;

describe("M4B reviewed strict work contract", () => {
  it("keeps structural output and sparse-map reservations live until the caller releases them", () => {
    const availableAfterFullReservation = 64 * 1024 * 1024 - 639;
    const inverseMeter = new MatrixWorkMeter("matrix.inv");
    const inverse = structuralInverse([[1, 0], [0, 1]], 2, "int", false, inverseMeter);
    expect(inverse?.data).toEqual([[1, 0], [0, 1]]);
    expect(() => inverseMeter.reserve(availableAfterFullReservation)).toThrow("matrix.inv exceeds its temporary storage budget");
    inverse?.release();
    inverseMeter.reserve(availableAfterFullReservation)();

    const powerMeter = new MatrixWorkMeter("matrix.pow");
    const power = structuralPower([[0, -1], [1, 0]], "int", 2n, powerMeter);
    expect(power?.data).toEqual([[-1, 0], [0, -1]]);
    expect(() => powerMeter.reserve(availableAfterFullReservation)).toThrow("matrix.pow exceeds its temporary storage budget");
    power?.release();
    powerMeter.reserve(availableAfterFullReservation)();
  });

  it("admits a measured 69-square exact inverse within the shared budget", () => {
    const size = 69;
    const input = integerMatrix(Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => {
      const base = row === column ? size * 3 : ((row * 17 + column * 19) % 3) - 1;
      return base * (row % 2 === 0 ? 2 ** 20 : 1) * (column % 2 === 0 ? 2 ** 20 : 1);
    })));
    const inverse = cells(matrixCall("inv", [input], { strict: true }));
    expect(inverse).toHaveLength(size);
    expect(inverse.every((row) => row.length === size && row.every((value) => value === 0))).toBe(true);
  }, 20_000);

  it("fails the dense 316-square exact inverse with a typed atomic resource error", () => {
    const size = 316;
    // A = J - 2I. Its inverse is -I/2 + J/[2(n-2)]; every final int cell is 0.
    const data = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? -1 : 1));
    const before = data.map((row) => [...row]);
    const input = integerMatrix(data);
    let failure: unknown;
    try { matrixCall("inv", [input], { strict: true }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PineRuntimeError);
    expect((failure as Error).message).toContain("matrix.inv exceeds its modular work budget");
    expect(data).toEqual(before);
  }, 20_000);

  it("keeps a maximum-capacity identity cheap and exact", () => {
    const size = 316;
    const data = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => Number(row === column)));
    const inverse = cells(matrixCall("inv", [integerMatrix(data)], { strict: true }));
    expect(inverse).toEqual(data);
  });
});
