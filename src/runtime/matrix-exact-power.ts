import { exactIntegerInverse } from "./matrix-exact-inverse.js";
import { integerBitCount, integerLimbCount, type MatrixWorkMeter } from "./matrix-work-meter.js";

interface RationalMatrix {
  readonly numerator: bigint[][];
  readonly denominator: bigint;
  readonly release: () => void;
}

interface ReservedInteger {
  readonly value: bigint;
  readonly release: () => void;
}

function maximumBits(values: readonly (readonly bigint[])[]): number {
  let maximum = 1;
  for (const row of values) for (const value of row) maximum = Math.max(maximum, integerBitCount(value));
  return maximum;
}

function numericFill(size: number, value: number, meter: MatrixWorkMeter): number[][] {
  const release = meter.reserve(size * size * 16);
  try {
    return Array.from({ length: size }, () => Array<number>(size).fill(value));
  } finally {
    release();
  }
}

function multiply(left: RationalMatrix, right: RationalMatrix, meter: MatrixWorkMeter): RationalMatrix {
  const size = left.numerator.length;
  const outputBits = maximumBits(left.numerator) + maximumBits(right.numerator) + Math.ceil(Math.log2(size || 1)) + 1;
  const denominatorBits = integerBitCount(left.denominator) + integerBitCount(right.denominator);
  const bits = Math.max(outputBits, denominatorBits);
  const release = meter.reserve(size * size * (48 + Math.ceil(bits / 8)) + 48 + Math.ceil(bits / 8));
  try {
    const output = Array.from({ length: size }, () => Array<bigint>(size).fill(0n));
    for (let row = 0; row < size; row += 1) for (let column = 0; column < size; column += 1) {
      let sum = 0n;
      for (let index = 0; index < size; index += 1) {
        const a = left.numerator[row]![index]!;
        const b = right.numerator[index]![column]!;
        meter.limbs(integerLimbCount(a) * integerLimbCount(b));
        const product = a * b;
        meter.limbs(Math.max(integerLimbCount(sum), integerLimbCount(product)));
        sum += product;
      }
      output[row]![column] = sum;
    }
    meter.limbs(integerLimbCount(left.denominator) * integerLimbCount(right.denominator));
    const denominator = left.denominator * right.denominator;
    return { numerator: output, denominator, release };
  } catch (error) {
    release();
    throw error;
  }
}

function maximumRowNorm(numerator: readonly (readonly bigint[])[], meter: MatrixWorkMeter): ReservedInteger {
  const bits = maximumBits(numerator) + Math.ceil(Math.log2(numerator.length || 1)) + 1;
  // Keep the returned norm live and cover the row sum, absolute value, and comparison scratch.
  const release = meter.reserve(4 * (48 + Math.ceil(bits / 8)));
  try {
    let maximum = 0n;
    for (const row of numerator) {
      let sum = 0n;
      for (const value of row) {
        meter.limbs(Math.max(integerLimbCount(sum), integerLimbCount(value)));
        sum += value < 0n ? -value : value;
      }
      if (sum > maximum) maximum = sum;
    }
    return { value: maximum, release };
  } catch (error) {
    release();
    throw error;
  }
}

function provesRemainingZero(result: RationalMatrix, base: RationalMatrix, remaining: bigint, meter: MatrixWorkMeter): boolean {
  const baseNorm = maximumRowNorm(base.numerator, meter);
  try {
    if (baseNorm.value >= base.denominator) return false;
    const resultNorm = maximumRowNorm(result.numerator, meter);
    try {
      let numerator = resultNorm.value;
      let denominator = result.denominator;
      let releaseCurrent = meter.reserve(96 + Math.ceil((integerBitCount(numerator) + integerBitCount(denominator)) / 8));
      resultNorm.release();
      try {
        for (let steps = 0n; steps < remaining && steps < 64n && numerator >= denominator; steps += 1n) {
          const nextBits = integerBitCount(numerator) + integerBitCount(baseNorm.value)
            + integerBitCount(denominator) + integerBitCount(base.denominator);
          const releaseNext = meter.reserve(96 + Math.ceil(nextBits / 8));
          try {
            meter.limbs(integerLimbCount(numerator) * integerLimbCount(baseNorm.value));
            meter.limbs(integerLimbCount(denominator) * integerLimbCount(base.denominator));
            const nextNumerator = numerator * baseNorm.value;
            const nextDenominator = denominator * base.denominator;
            releaseCurrent();
            releaseCurrent = releaseNext;
            numerator = nextNumerator;
            denominator = nextDenominator;
          } catch (error) {
            releaseNext();
            throw error;
          }
        }
        return numerator < denominator;
      } finally {
        releaseCurrent();
      }
    } finally {
      resultNorm.release();
    }
  } finally {
    baseNorm.release();
  }
}

/** Exact represented integer powers with one final truncation and a proven contraction shortcut. */
export function exactIntegerPower(input: readonly (readonly number[])[], exponent: bigint, meter: MatrixWorkMeter): number[][] {
  const size = input.length;
  const releaseIdentity = meter.reserve(size * size * 49 + 49);
  let identity: bigint[][];
  try {
    identity = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => BigInt(row === column)));
  } catch (error) {
    releaseIdentity();
    throw error;
  }
  let result: RationalMatrix = { numerator: identity, denominator: 1n, release: releaseIdentity };
  let base: RationalMatrix | undefined;
  try {
    if (exponent < 0n) {
      const exact = exactIntegerInverse(input, meter);
      if (exact === null) return numericFill(size, Number.NaN, meter);
      base = { numerator: exact.numerator as bigint[][], denominator: exact.denominator, release: exact.release };
      if (provesRemainingZero(result, base, 1n, meter)) {
        return numericFill(size, 0, meter);
      }
    } else {
      const inputBits = input.reduce((maximum, row) => Math.max(maximum,
        ...row.map((value) => value === 0 ? 1 : Math.floor(Math.log2(Math.abs(value))) + 1)), 1);
      const releaseInput = meter.reserve(size * size * (48 + Math.ceil(inputBits / 8)) + 49);
      let represented: bigint[][];
      try {
        meter.limbs(size * size * Math.ceil(inputBits / 32));
        represented = input.map((row) => row.map((value) => BigInt(value)));
      } catch (error) {
        releaseInput();
        throw error;
      }
      base = { numerator: represented, denominator: 1n, release: releaseInput };
    }
    let remaining = exponent < 0n ? -exponent : exponent;
    while (remaining > 0n) {
      if (exponent < 0n && provesRemainingZero(result, base, remaining, meter)) {
        return numericFill(size, 0, meter);
      }
      if (remaining % 2n === 1n) {
        const next = multiply(result, base, meter);
        result.release();
        result = next;
      }
      remaining /= 2n;
      if (remaining > 0n) {
        const next = multiply(base, base, meter);
        base.release();
        base = next;
      }
    }
    const releaseOutput = meter.reserve(size * size * 16);
    try {
      const output = result.numerator.map((row) => row.map((value) => {
        meter.limbs(integerLimbCount(value) * integerLimbCount(result.denominator));
        return Number(value / result.denominator);
      }));
      return output;
    } finally {
      releaseOutput();
    }
  } finally {
    result.release();
    base?.release();
  }
}
