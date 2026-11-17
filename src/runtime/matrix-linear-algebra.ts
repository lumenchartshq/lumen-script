/** Strict, local matrix algorithms. Inputs are copied; callers own kind conversion. */
import type { MatrixWorkMeter } from "./matrix-work-meter.js";

export type NumericMatrix = readonly (readonly number[])[];

export class MatrixNumericalFailure extends Error {}

export interface MatrixFloatWorkStats {
  pivotScans: number;
  inverseCellUpdates: number;
  svdDotProducts: number;
  svdRotationUpdates: number;
  pseudoCellUpdates: number;
  sweeps: number;
}

export function freshMatrixFloatWorkStats(): MatrixFloatWorkStats {
  return { pivotScans: 0, inverseCellUpdates: 0, svdDotProducts: 0,
    svdRotationUpdates: 0, pseudoCellUpdates: 0, sweeps: 0 };
}

/** Exact-zero pivot policy; a caller decides the singular matrix result shape. */
export function invertFloatMatrix(input: NumericMatrix, stats?: MatrixFloatWorkStats, meter?: MatrixWorkMeter): number[][] | null {
  const size = input.length;
  const release = meter?.reserve(size * size * 32 + size * 32);
  try {
  meter?.floating(2 * size * size);
  const augmented = input.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => Number(index === column)),
  ]);
  const rowScales = augmented.map((row) => Math.max(...row.slice(0, size).map(Math.abs)));
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotRatio = 0;
    for (let row = column; row < size; row += 1) {
      meter?.floating(1);
      if (stats) stats.pivotScans += 1;
      const ratio = rowScales[row] === 0 ? 0 : Math.abs(augmented[row]![column]!) / rowScales[row]!;
      if (ratio > pivotRatio) { pivotRatio = ratio; pivotRow = row; }
    }
    if (pivotRatio === 0) pivotRow = augmented.findIndex((row, index) => index >= column && row[column] !== 0);
    if (pivotRow < column) return null;
    if (pivotRow !== column) {
      [augmented[pivotRow], augmented[column]] = [augmented[column]!, augmented[pivotRow]!];
      [rowScales[pivotRow], rowScales[column]] = [rowScales[column]!, rowScales[pivotRow]!];
    }
    const pivot = augmented[column]![column]!;
    meter?.floating(2 * size);
    for (let index = 0; index < 2 * size; index += 1) {
      augmented[column]![index] = augmented[column]![index]! / pivot;
      if (stats) stats.inverseCellUpdates += 1;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      if (factor === 0) continue;
      meter?.floating(2 * size);
      for (let index = 0; index < 2 * size; index += 1) {
        augmented[row]![index] = augmented[row]![index]! - factor * augmented[column]![index]!;
        if (stats) stats.inverseCellUpdates += 1;
      }
    }
  }
  return augmented.map((row) => row.slice(size));
  } finally {
    release?.();
  }
}

const epsilon = Number.EPSILON;

export function determinant(values: NumericMatrix): number {
  const size = values.length;
  if (size === 0) return 0; // Local empty-shape policy retained from the legacy path.
  const work = values.map((row) => [...row]);
  let sign = 1;
  let product = 1;
  let logMagnitude = 0;
  let lostProductRange = false;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row]![column]!) > Math.abs(work[pivot]![column]!)) pivot = row;
    }
    if (work[pivot]![column] === 0) return 0;
    if (pivot !== column) {
      [work[pivot], work[column]] = [work[column]!, work[pivot]!];
      sign = -sign;
    }
    const diagonal = work[column]![column]!;
    sign *= Math.sign(diagonal);
    logMagnitude += Math.log(Math.abs(diagonal));
    product *= Math.abs(diagonal);
    if (!Number.isFinite(product) || product === 0) lostProductRange = true;
    for (let row = column + 1; row < size; row += 1) {
      const factor = work[row]![column]! / diagonal;
      for (let index = column + 1; index < size; index += 1) {
        work[row]![index] = work[row]![index]! - factor * work[column]![index]!;
        if (!Number.isFinite(work[row]![index])) throw new MatrixNumericalFailure("Determinant elimination overflowed finite range");
      }
      work[row]![column] = 0;
    }
  }
  if (!lostProductRange) return sign * product;
  const recovered = Math.exp(logMagnitude);
  if (!Number.isFinite(recovered)) throw new MatrixNumericalFailure("Determinant overflowed finite range");
  return sign * recovered;
}

interface Decomposition {
  readonly rank: number;
  readonly pseudoinverse?: number[][];
}

export function decomposition(input: NumericMatrix, withPseudoinverse = false, stats?: MatrixFloatWorkStats, meter?: MatrixWorkMeter): Decomposition {
  const inputRows = input.length;
  const inputColumns = input[0]?.length ?? 0;
  const transposed = inputRows < inputColumns;
  const rows = transposed ? inputColumns : inputRows;
  const columns = transposed ? inputRows : inputColumns;
  const release = meter?.reserve(rows * columns * 16 + columns * columns * 16 + (withPseudoinverse ? rows * columns * 16 : 0));
  try {
  meter?.floating(rows * columns + columns * columns);
  let scale = 0;
  for (const row of input) for (const value of row) scale = Math.max(scale, Math.abs(value));
  const orthogonalColumns = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (transposed ? input[column]![row]! : input[row]![column]!) / (scale || 1)));
  const rightVectors = Array.from({ length: columns }, (_, row) =>
    Array.from({ length: columns }, (_, column) => Number(row === column)));
  // One-sided Jacobi SVD: bounded sweeps and scale-free column correlation.
  let converged = columns < 2;
  for (let sweep = 0; sweep < 50 && !converged; sweep += 1) {
    if (stats) stats.sweeps += 1;
    converged = true;
    for (let left = 0; left < columns; left += 1) for (let right = left + 1; right < columns; right += 1) {
      let alpha = 0;
      let beta = 0;
      let gamma = 0;
      meter?.floating(3 * rows);
      for (let row = 0; row < rows; row += 1) {
        const a = orthogonalColumns[row]![left]!;
        const b = orthogonalColumns[row]![right]!;
        alpha += a * a;
        beta += b * b;
        gamma += a * b;
        if (stats) stats.svdDotProducts += 3;
      }
      if (alpha === 0 || beta === 0 || Math.abs(gamma) <= epsilon * Math.sqrt(alpha) * Math.sqrt(beta)) continue;
      converged = false;
      const zeta = (beta - alpha) / (2 * gamma);
      const tangent = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.hypot(1, zeta));
      const cosine = 1 / Math.sqrt(1 + tangent * tangent);
      const sine = cosine * tangent;
      meter?.floating(2 * rows + 2 * columns);
      for (let row = 0; row < rows; row += 1) {
        const a = orthogonalColumns[row]![left]!;
        const b = orthogonalColumns[row]![right]!;
        orthogonalColumns[row]![left] = cosine * a - sine * b;
        orthogonalColumns[row]![right] = sine * a + cosine * b;
        if (stats) stats.svdRotationUpdates += 2;
      }
      for (let row = 0; row < columns; row += 1) {
        const a = rightVectors[row]![left]!;
        const b = rightVectors[row]![right]!;
        rightVectors[row]![left] = cosine * a - sine * b;
        rightVectors[row]![right] = sine * a + cosine * b;
        if (stats) stats.svdRotationUpdates += 2;
      }
    }
  }
  if (!converged) throw new MatrixNumericalFailure("Jacobi SVD did not converge within 50 sweeps");
  const singularValues = Array.from({ length: columns }, (_, column) => {
    let magnitude = 0;
    meter?.floating(rows);
    for (const row of orthogonalColumns) magnitude = Math.hypot(magnitude, row[column]!);
    return magnitude;
  });
  let maximum = 0;
  for (const value of singularValues) maximum = Math.max(maximum, value);
  const threshold = Math.max(inputRows, inputColumns) * epsilon * maximum;
  const rank = singularValues.filter((value) => value > threshold).length;
  if (!withPseudoinverse) return { rank };
  const inverse = Array.from({ length: columns }, () => Array<number>(rows).fill(0));
  for (let component = 0; component < columns; component += 1) {
    const magnitude = singularValues[component]!;
    if (magnitude <= threshold) continue;
    const singular = scale * magnitude;
    for (let row = 0; row < columns; row += 1) {
      for (let column = 0; column < rows; column += 1) {
        const numerator = rightVectors[row]![component]! * orthogonalColumns[column]![component]!;
        if (numerator === 0) continue;
        meter?.floating(1);
        let contribution: number;
        if (!Number.isFinite(singular)) contribution = ((numerator / scale) / magnitude) / magnitude;
        else if (singular === 0) contribution = ((numerator / magnitude) / magnitude) / scale;
        else contribution = (numerator / magnitude) / singular;
        inverse[row]![column] = inverse[row]![column]! + contribution;
        if (stats) stats.pseudoCellUpdates += 1;
      }
    }
  }
  const pseudoinverse = transposed
    ? Array.from({ length: inputColumns }, (_, row) => Array.from({ length: inputRows }, (_, column) => inverse[column]![row]!))
    : inverse;
  for (const row of pseudoinverse) for (const value of row) {
    if (!Number.isFinite(value)) throw new MatrixNumericalFailure("Pseudoinverse overflowed finite range");
  }
  return { rank, pseudoinverse };
  } finally {
    release?.();
  }
}
