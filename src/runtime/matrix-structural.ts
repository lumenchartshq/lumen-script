import type { NumericMatrix } from "./matrix-linear-algebra.js";
import type { MatrixWorkMeter } from "./matrix-work-meter.js";

type Kind = "int" | "float";

interface StructuralResult {
  readonly data: number[][];
  readonly singular?: true;
  /** The caller releases the live output after final result normalization. */
  readonly release: () => void;
}

const noRelease = (): void => {};

interface SparseRow {
  readonly column: number;
  readonly value: number;
}

function partialMonomial(input: NumericMatrix, columns: number, meter?: MatrixWorkMeter): SparseRow[] | undefined {
  const used = new Set<number>();
  const entries: SparseRow[] = [];
  for (const row of input) {
    let entry: SparseRow = { column: -1, value: 0 };
    for (let column = 0; column < columns; column += 1) {
      meter?.floating(1);
      const value = row[column]!;
      if (value === 0) continue;
      if (entry.column >= 0 || used.has(column)) return undefined;
      entry = { column, value };
    }
    if (entry.column >= 0) used.add(entry.column);
    entries.push(entry);
  }
  return entries;
}

function reciprocal(value: number, kind: Kind): number {
  if (kind === "int") return value === 1 ? 1 : value === -1 ? -1 : 0;
  return 1 / value;
}

/** Exact-cell structural path; undefined means the general numerical path owns the input. */
export function structuralInverse(input: NumericMatrix, columns: number, kind: Kind, pseudo: boolean, meter?: MatrixWorkMeter): StructuralResult | undefined {
  const rows = input.length;
  // Covers the returned grid, strict-int normalization copy, sparse rows, and Set buckets.
  const release = meter?.reserve(rows * columns * (kind === "int" ? 32 : 16) + (rows + columns) * 128);
  try {
    const entries = partialMonomial(input, columns, meter);
    if (entries === undefined) {
      release?.();
      return undefined;
    }
    if (!pseudo && entries.some((entry) => entry.column < 0)) {
      return { data: [], singular: true, release: release ?? noRelease };
    }
    const result = Array.from({ length: columns }, () => Array<number>(rows).fill(0));
    const largest = pseudo && kind === "float"
      ? entries.reduce((maximum, entry) => Math.max(maximum, Math.abs(entry.value)), 0) : 0;
    const threshold = Math.max(rows, columns) * Number.EPSILON * largest;
    for (const [row, entry] of entries.entries()) {
      if (entry.column >= 0 && (!pseudo || kind !== "float" || Math.abs(entry.value) > threshold)) {
        result[entry.column]![row] = reciprocal(entry.value, kind);
      }
    }
    return { data: result, release: release ?? noRelease };
  } catch (error) {
    release?.();
    throw error;
  }
}

function exactIntegerPower(value: number, exponent: bigint, meter?: MatrixWorkMeter): number {
  if (exponent === 0n) return 1;
  if (value === 0) return 0;
  if (value === 1) return 1;
  if (value === -1) return exponent % 2n === 0n ? 1 : -1;
  if (exponent < 0n) return 0;
  // Any |integer| >= 2 raised to exponent >= 1024 exceeds finite Number range.
  if (exponent >= 1024n) return Number.POSITIVE_INFINITY;
  const valueBits = Math.floor(Math.log2(Math.abs(value))) + 1;
  if (BigInt(valueBits - 1) * exponent > 1024n) return Number.POSITIVE_INFINITY;
  const prospectiveBits = valueBits * Number(exponent) + 1;
  const release = meter?.reserve(48 + Math.ceil(prospectiveBits / 8));
  try {
    meter?.limbs(Number(exponent) * Math.ceil(valueBits / 32) * Math.ceil(prospectiveBits / 32));
    return Number(BigInt(value) ** exponent);
  } finally {
    release?.();
  }
}

function diagonalPower(input: NumericMatrix, kind: Kind, exponent: bigint, meter?: MatrixWorkMeter): number[][] | undefined {
  const size = input.length;
  for (let row = 0; row < size; row += 1) for (let column = 0; column < size; column += 1) {
    meter?.floating(1);
    if (row !== column && input[row]![column] !== 0) return undefined;
  }
  if (exponent < 0n && input.some((row, index) => row[index] === 0)) {
    return Array.from({ length: size }, () => Array<number>(size).fill(Number.NaN));
  }
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => {
    if (row !== column) return 0;
    const value = input[row]![row]!;
    if (kind === "int") return exactIntegerPower(value, exponent, meter);
    meter?.floating(1);
    return Math.pow(value, Number(exponent));
  }));
}

function signedPermutationPower(input: NumericMatrix, exponent: bigint, meter?: MatrixWorkMeter): number[][] | undefined {
  const size = input.length;
  const entries = partialMonomial(input, size, meter);
  if (entries === undefined || entries.some((entry) => entry.column < 0 || Math.abs(entry.value) !== 1)) return undefined;
  meter?.floating(size * size);
  const next = entries.map((entry) => entry.column);
  const weight = entries.map((entry) => entry.value);
  if (exponent < 0n) {
    const originalNext = [...next];
    for (let row = 0; row < size; row += 1) {
      next[originalNext[row]!] = row;
      weight[originalNext[row]!] = entries[row]!.value;
    }
  }
  const steps = exponent < 0n ? -exponent : exponent;
  const result = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    let at = row;
    let cycleSign = 1;
    let cycleLength = 0;
    do {
      cycleSign *= weight[at]!;
      at = next[at]!;
      cycleLength += 1;
    } while (at !== row);
    const rounds = steps / BigInt(cycleLength);
    const remainder = Number(steps % BigInt(cycleLength));
    let sign = cycleSign === -1 && rounds % 2n === 1n ? -1 : 1;
    for (let step = 0; step < remainder; step += 1) {
      sign *= weight[at]!;
      at = next[at]!;
    }
    result[row]![at] = sign;
  }
  return result;
}

/** Exact diagonal and signed-permutation powers, including represented huge exponents. */
export function structuralPower(input: NumericMatrix, kind: Kind, exponent: bigint, meter?: MatrixWorkMeter): StructuralResult | undefined {
  const size = input.length;
  // Includes output, strict-int normalization copy, sparse entries, permutation maps, and cycle copies.
  const release = meter?.reserve(size * size * (kind === "int" ? 32 : 16) + size * 256);
  try {
    const diagonal = diagonalPower(input, kind, exponent, meter);
    const data = diagonal ?? signedPermutationPower(input, exponent, meter);
    if (data === undefined) {
      release?.();
      return undefined;
    }
    return { data, release: release ?? noRelease };
  } catch (error) {
    release?.();
    throw error;
  }
}
