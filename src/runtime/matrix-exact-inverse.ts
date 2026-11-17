import { integerBitCount, integerLimbCount, type MatrixWorkMeter } from "./matrix-work-meter.js";

/** Exact direct inverse for a square matrix of represented integer Numbers. */
export interface ExactMatrixInverse {
  readonly numerator: readonly (readonly bigint[])[];
  readonly denominator: bigint;
  readonly release: () => void;
}

/** Optional instrumentation; no runtime admission policy is implied. */
export interface ExactInverseStats {
  primeAttempts: number;
  modularCellUpdates: number;
  crtCellUpdates: number;
  certificateProducts: number;
  estimatedBigIntLimbProducts: number;
  peakBits: number;
}

export function freshExactInverseStats(): ExactInverseStats {
  return { primeAttempts: 0, modularCellUpdates: 0, crtCellUpdates: 0,
    certificateProducts: 0, estimatedBigIntLimbProducts: 0, peakBits: 0 };
}

function bits(value: bigint): number {
  return value === 0n ? 1 : absolute(value).toString(2).length;
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcd(left: bigint, right: bigint, meter: MatrixWorkMeter): bigint {
  while (right !== 0n) {
    meter.limbs(integerLimbCount(left) * integerLimbCount(right));
    [left, right] = [right, left % right];
  }
  return left;
}

function residue(value: number, prime: number): number {
  const result = value % prime;
  return result < 0 ? result + prime : result;
}

function modularInverse(value: number, prime: number, meter: MatrixWorkMeter): number {
  let a = residue(value, prime);
  let b = prime;
  let left = 1;
  let right = 0;
  while (b !== 0) {
    meter.modular(1);
    const quotient = Math.floor(a / b);
    [a, b] = [b, a - quotient * b];
    [left, right] = [right, left - quotient * right];
  }
  if (a !== 1) throw new Error("Noninvertible prime residue");
  return residue(left, prime);
}

function nextPrime(start: number, meter: MatrixWorkMeter): number {
  for (let candidate = start | 1; ; candidate += 2) {
    let prime = true;
    for (let divisor = 3; divisor * divisor <= candidate; divisor += 2) {
      meter.modular(1);
      if (candidate % divisor === 0) { prime = false; break; }
    }
    if (prime) return candidate;
  }
}

interface PrimeInverse {
  readonly determinant: number;
  readonly inverse: readonly (readonly number[])[];
}

function inverseModulo(matrix: readonly (readonly bigint[])[], prime: number, meter: MatrixWorkMeter, stats?: ExactInverseStats): PrimeInverse | null {
  const size = matrix.length;
  const modulus = BigInt(prime);
  const maximumInputLimbs = matrix.reduce((maximum, row) => Math.max(maximum, ...row.map(integerLimbCount)), 1);
  meter.limbs(size * size * maximumInputLimbs);
  const release = meter.reserve(size * size * 32);
  try {
  const left = matrix.map((row) => row.map((value) => Number((value % modulus + modulus) % modulus)));
  const right = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => Number(row === column)));
  let determinant = 1;
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    while (pivotRow < size && left[pivotRow]![column] === 0) pivotRow += 1;
    if (pivotRow === size) return null;
    if (pivotRow !== column) {
      [left[pivotRow], left[column]] = [left[column]!, left[pivotRow]!];
      [right[pivotRow], right[column]] = [right[column]!, right[pivotRow]!];
      determinant = residue(-determinant, prime);
    }
    const pivot = left[column]![column]!;
    determinant = residue(determinant * pivot, prime);
    const inversePivot = modularInverse(pivot, prime, meter);
    meter.modular(2 * size - column);
    for (let index = column; index < size; index += 1) left[column]![index] = residue(left[column]![index]! * inversePivot, prime);
    for (let index = 0; index < size; index += 1) right[column]![index] = residue(right[column]![index]! * inversePivot, prime);
    if (stats) stats.modularCellUpdates += 2 * size - column;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = left[row]![column]!;
      if (factor === 0) continue;
      meter.modular(2 * size - column);
      for (let index = column; index < size; index += 1) left[row]![index] = residue(left[row]![index]! - factor * left[column]![index]!, prime);
      for (let index = 0; index < size; index += 1) right[row]![index] = residue(right[row]![index]! - factor * right[column]![index]!, prime);
      if (stats) stats.modularCellUpdates += 2 * size - column;
    }
  }
  return { determinant, inverse: right };
  } finally {
    release();
  }
}

function certified(matrix: readonly (readonly bigint[])[], adjugate: readonly (readonly bigint[])[], determinant: bigint, meter: MatrixWorkMeter, stats?: ExactInverseStats): boolean {
  if (determinant === 0n) return false;
  const size = matrix.length;
  let inputBits = 1;
  let adjugateBits = 1;
  for (const row of matrix) for (const value of row) inputBits = Math.max(inputBits, bits(value));
  for (const row of adjugate) for (const value of row) adjugateBits = Math.max(adjugateBits, bits(value));
  meter.limbs(size ** 3 * Math.ceil(inputBits / 32) * Math.ceil(adjugateBits / 32));
  if (stats) {
    stats.peakBits = Math.max(stats.peakBits, bits(determinant), adjugateBits, inputBits + adjugateBits + Math.ceil(Math.log2(size || 1)));
    stats.estimatedBigIntLimbProducts += size ** 3 * Math.ceil(inputBits / 32) * Math.ceil(adjugateBits / 32);
  }
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      let sum = 0n;
      for (let index = 0; index < size; index += 1) sum += matrix[row]![index]! * adjugate[index]![column]!;
      if (stats) stats.certificateProducts += size;
      if (sum !== (row === column ? determinant : 0n)) return false;
    }
  }
  return true;
}

/**
 * All primes are distinct. A singular prime divides det(A); their product
 * exceeding the row-L1 determinant bound proves det(A)=0. For invertible A,
 * CRT reconstructs det and every cofactor, followed by an exact A adj(A)=det I
 * certificate. BigInt(Number) captures the represented integer exactly,
 * including finite integral Numbers beyond MAX_SAFE_INTEGER.
 */
export function exactIntegerInverse(input: readonly (readonly (number | bigint)[])[], meter: MatrixWorkMeter, stats?: ExactInverseStats): ExactMatrixInverse | null {
  const size = input.length;
  if (input.some((row) => row.length !== size)) throw new Error("Exact inverse requires a square matrix");
  if (size === 0) return { numerator: [], denominator: 1n, release: () => {} };
  let inputBits = 1;
  for (const row of input) for (const value of row) {
    if (typeof value === "number" && (!Number.isFinite(value) || !Number.isInteger(value))) {
      throw new Error("Exact inverse requires finite integer cells");
    }
    inputBits = Math.max(inputBits, typeof value === "bigint"
      ? integerBitCount(value)
      : value === 0 ? 1 : Math.floor(Math.log2(Math.abs(value))) + 1);
  }
  const originalBytes = size * size * (48 + Math.ceil(inputBits / 8));
  const releaseOriginal = meter.reserve(originalBytes);
  try {
  const original = input.map((row) => row.map((value) => {
    meter.limbs(Math.ceil(inputBits / 32));
    return typeof value === "bigint" ? value : BigInt(value);
  }));
  let content = 0n;
  for (const row of original) for (const value of row) content = gcd(content, absolute(value), meter);
  if (content === 0n) return null;
  const releasePrimitive = meter.reserve(originalBytes);
  try {
  meter.limbs(size * size * Math.ceil(inputBits / 32) * integerLimbCount(content));
  const primitive = original.map((row) => row.map((value) => value / content));
  let bound = 1n;
  for (const row of primitive) {
    meter.limbs(row.length * Math.ceil(inputBits / 32));
    const rowSum = row.reduce((sum, value) => sum + absolute(value), 0n);
    if (rowSum === 0n) return null;
    meter.limbs(integerLimbCount(bound) * integerLimbCount(rowSum));
    bound *= rowSum;
  }
  // CRT stops after modulus > 2H, with at most one final 20-bit prime.
  const maximumCrtBits = integerBitCount(bound) + 22;
  const crtBytes = size * size * (48 + Math.ceil(maximumCrtBits / 8));
  const releaseAdjugate = meter.reserve(crtBytes);
  try {
  let primeStart = 1_000_003;
  let singularProduct = 1n;
  let modulus = 1n;
  let determinant = 0n;
  const adjugate = Array.from({ length: size }, () => Array<bigint>(size).fill(0n));
  for (;;) {
    const prime = nextPrime(primeStart, meter);
    if (stats) stats.primeAttempts += 1;
    primeStart = prime + 2;
    const solved = inverseModulo(primitive, prime, meter, stats);
    const primeBig = BigInt(prime);
    if (solved === null) {
      meter.limbs(integerLimbCount(singularProduct));
      singularProduct *= primeBig;
      if (singularProduct > bound) return null;
      continue;
    }
    meter.limbs(integerLimbCount(modulus));
    const step = BigInt(modularInverse(Number(modulus % primeBig), prime, meter));
    const merge = (previous: bigint, value: number): bigint => previous
      + modulus * (((BigInt(value) - previous) * step % primeBig + primeBig) % primeBig);
    meter.limbs((size * size + 1) * 4 * integerLimbCount(modulus));
    determinant = merge(determinant, solved.determinant);
    if (stats) {
      stats.crtCellUpdates += size * size + 1;
      stats.peakBits = Math.max(stats.peakBits, bits(modulus) + bits(primeBig));
      stats.estimatedBigIntLimbProducts += (size * size + 1) * 4 * Math.ceil(bits(modulus) / 32);
    }
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        adjugate[row]![column] = merge(adjugate[row]![column]!, residue(solved.inverse[row]![column]! * solved.determinant, prime));
      }
    }
    modulus *= primeBig;
    if (modulus <= 2n * bound) continue;
    const releaseCertificate = meter.reserve(crtBytes);
    let handedOff = false;
    let releaseDenominator: (() => void) | undefined;
    try {
    const signed = (value: bigint): bigint => value > modulus / 2n ? value - modulus : value;
    const exactDeterminant = signed(determinant);
    const exactAdjugate = adjugate.map((row) => row.map(signed));
    if (!certified(primitive, exactAdjugate, exactDeterminant, meter, stats)) {
      throw new Error("Exact inverse reconstruction failed its determinant bound");
    }
    releaseDenominator = meter.reserve(48 + Math.ceil((integerBitCount(exactDeterminant) + integerBitCount(content)) / 8));
    meter.limbs(integerLimbCount(exactDeterminant) * integerLimbCount(content));
    const denominator = exactDeterminant * content;
    const releaseResult = () => { releaseDenominator?.(); releaseCertificate(); };
    if (denominator < 0n) {
      meter.limbs(size * size * Math.ceil(maximumCrtBits / 32));
      for (const row of exactAdjugate) for (let column = 0; column < size; column += 1) row[column] = -row[column]!;
      handedOff = true;
      return { numerator: exactAdjugate, denominator: -denominator, release: releaseResult };
    }
    handedOff = true;
    return { numerator: exactAdjugate, denominator, release: releaseResult };
    } finally {
      if (!handedOff) { releaseDenominator?.(); releaseCertificate(); }
    }
  }
  } finally {
    releaseAdjugate();
  }
  } finally {
    releasePrimitive();
  }
  } finally {
    releaseOriginal();
  }
}
