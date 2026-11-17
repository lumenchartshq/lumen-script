import { exactIntegerInverse } from "./matrix-exact-inverse.js";
import { integerBitCount, integerLimbCount, type MatrixWorkMeter } from "./matrix-work-meter.js";

interface PivotMinor {
  readonly rows: number[];
  readonly columns: number[];
}

function chargeProduct(meter: MatrixWorkMeter, left: bigint, right: bigint): void {
  meter.limbs(integerLimbCount(left) * integerLimbCount(right));
}

function pivotMinor(input: readonly (readonly number[])[], columns: number, meter: MatrixWorkMeter): PivotMinor {
  const rows = input.length;
  const smaller = Math.min(rows, columns);
  const rowSums: bigint[] = [];
  let inputBits = 1;
  const releaseSums = meter.reserve(rows * 192);
  try {
    for (const row of input) {
      let sum = 0n;
      for (const value of row) {
        meter.limbs(1);
        const exact = BigInt(value);
        inputBits = Math.max(inputBits, integerBitCount(exact));
        meter.limbs(integerLimbCount(sum));
        sum += exact < 0n ? -exact : exact;
      }
      rowSums.push(sum === 0n ? 1n : sum);
    }
    meter.floating(rows * Math.ceil(Math.log2(rows + 1)));
    rowSums.sort((left, right) => {
      meter.limbs(Math.max(integerLimbCount(left), integerLimbCount(right)));
      return left === right ? 0 : left > right ? -1 : 1;
    });
    let prospectiveBoundBits = 1;
    for (let index = 0; index < smaller; index += 1) prospectiveBoundBits += integerBitCount(rowSums[index]!);
    const releaseBound = meter.reserve(48 + Math.ceil(prospectiveBoundBits / 8));
    try {
    let minorBound = 1n;
    for (let index = 0; index < smaller; index += 1) {
      chargeProduct(meter, minorBound, rowSums[index]!);
      minorBound *= rowSums[index]!;
    }
    const minorBits = integerBitCount(minorBound) + 1;
    const intermediateBytes = rows * columns * (48 + Math.ceil(minorBits / 8))
      + 3 * (48 + Math.ceil((2 * minorBits + 2) / 8))
      + rows * 64 + columns * 32; // Original/pivot indices and row-array overhead.
    const releaseWork = meter.reserve(intermediateBytes);
    try {
      const work = input.map((row) => row.map((value) => {
        meter.limbs(Math.ceil(inputBits / 32));
        return BigInt(value);
      }));
      const originalRows = Array.from({ length: rows }, (_, index) => index);
      const pivotRows: number[] = [];
      const pivotColumns: number[] = [];
      let prior = 1n;
      for (let column = 0; column < columns && pivotRows.length < smaller; column += 1) {
        const rank = pivotRows.length;
        let selected = rank;
        while (selected < rows && work[selected]![column] === 0n) {
          meter.floating(1);
          selected += 1;
        }
        if (selected === rows) continue;
        if (selected !== rank) {
          [work[selected], work[rank]] = [work[rank]!, work[selected]!];
          [originalRows[selected], originalRows[rank]] = [originalRows[rank]!, originalRows[selected]!];
        }
        const pivot = work[rank]![column]!;
        for (let row = rank + 1; row < rows; row += 1) {
          const factor = work[row]![column]!;
          for (let index = column + 1; index < columns; index += 1) {
            const left = work[row]![index]!;
            const top = work[rank]![index]!;
            chargeProduct(meter, left, pivot);
            chargeProduct(meter, factor, top);
            const maximumNumeratorBits = Math.max(integerBitCount(left) + integerBitCount(pivot),
              integerBitCount(factor) + integerBitCount(top)) + 1;
            meter.limbs(Math.ceil(maximumNumeratorBits / 32) * integerLimbCount(prior));
            const numerator = left * pivot - factor * top;
            const quotient = numerator / prior;
            chargeProduct(meter, quotient, prior);
            if (quotient * prior !== numerator) throw new Error("Fraction-free matrix elimination lost exact divisibility");
            work[row]![index] = quotient;
          }
          work[row]![column] = 0n;
        }
        pivotRows.push(originalRows[rank]!);
        pivotColumns.push(column);
        prior = pivot;
      }
      return { rows: pivotRows, columns: pivotColumns };
    } finally {
      releaseWork();
    }
    } finally {
      releaseBound();
    }
  } finally {
    releaseSums();
  }
}

function gram(values: readonly (readonly bigint[])[], byColumns: boolean, meter: MatrixWorkMeter): bigint[][] {
  const dimension = byColumns ? values[0]?.length ?? 0 : values.length;
  const length = byColumns ? values.length : values[0]?.length ?? 0;
  const result = Array.from({ length: dimension }, () => Array<bigint>(dimension).fill(0n));
  for (let row = 0; row < dimension; row += 1) for (let column = 0; column < dimension; column += 1) {
    let sum = 0n;
    for (let index = 0; index < length; index += 1) {
      const left = byColumns ? values[index]![row]! : values[row]![index]!;
      const right = byColumns ? values[index]![column]! : values[column]![index]!;
      chargeProduct(meter, left, right);
      const product = left * right;
      meter.limbs(Math.max(integerLimbCount(sum), integerLimbCount(product)));
      sum += product;
    }
    result[row]![column] = sum;
  }
  return result;
}

function multiply(left: readonly (readonly bigint[])[], right: readonly (readonly bigint[])[], meter: MatrixWorkMeter): bigint[][] {
  const rows = left.length;
  const inner = right.length;
  const columns = right[0]?.length ?? 0;
  const result = Array.from({ length: rows }, () => Array<bigint>(columns).fill(0n));
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    let sum = 0n;
    for (let index = 0; index < inner; index += 1) {
      const a = left[row]![index]!;
      const b = right[index]![column]!;
      chargeProduct(meter, a, b);
      const product = a * b;
      meter.limbs(Math.max(integerLimbCount(sum), integerLimbCount(product)));
      sum += product;
    }
    result[row]![column] = sum;
  }
  return result;
}

/** Exact integer Moore–Penrose result, truncated only at the final public boundary. */
export function exactIntegerPseudoInverse(input: readonly (readonly number[])[], columns: number, meter: MatrixWorkMeter): number[][] {
  const rows = input.length;
  const minor = pivotMinor(input, columns, meter);
  const rank = minor.rows.length;
  if (rank === 0) {
    const releaseZero = meter.reserve(rows * columns * 16);
    try {
      return Array.from({ length: columns }, () => Array<number>(rows).fill(0));
    } finally {
      releaseZero();
    }
  }
  let inputBits = 1;
  for (const row of input) for (const value of row) inputBits = Math.max(inputBits, integerBitCount(BigInt(value)));
  const releaseFactors = meter.reserve((rows * rank + rank * columns + rank * rank) * (48 + Math.ceil(inputBits / 8)));
  try {
    meter.limbs((rows * rank + rank * columns + rank * rank) * Math.ceil(inputBits / 32));
    const c = input.map((row) => minor.columns.map((column) => BigInt(row[column]!)));
    const r = minor.rows.map((row) => input[row]!.map(BigInt));
    const m = minor.rows.map((row) => minor.columns.map((column) => BigInt(input[row]![column]!)));
    const gramBits = 2 * inputBits + Math.ceil(Math.log2(Math.max(rows, columns) + 1)) + 1;
    // Four scalar slots cover sum, product, operands and division scratch in each Gram dot product.
    const gramCellBytes = 48 + Math.ceil(gramBits / 8);
    const releaseGram = meter.reserve((2 * rank * rank + 4) * gramCellBytes);
    let rGram: bigint[][];
    let cGram: bigint[][];
    try {
      rGram = gram(r, false, meter);
      cGram = gram(c, true, meter);
      const rInverse = exactIntegerInverse(rGram, meter);
      if (rInverse === null) throw new Error("Independent row Gram matrix is singular");
      const releaseRInverse = rInverse.release;
      try {
        const cInverse = exactIntegerInverse(cGram, meter);
        if (cInverse === null) throw new Error("Independent column Gram matrix is singular");
        const releaseCInverse = cInverse.release;
        try {
          const denominatorBits = integerBitCount(rInverse.denominator) + integerBitCount(cInverse.denominator);
          const releaseDenominator = meter.reserve(48 + Math.ceil(denominatorBits / 8));
          try {
          chargeProduct(meter, rInverse.denominator, cInverse.denominator);
          const denominator = rInverse.denominator * cInverse.denominator;
          const maximumBits = (matrix: readonly (readonly bigint[])[]): number => {
            let result = 1;
            for (const row of matrix) for (const value of row) result = Math.max(result, integerBitCount(value));
            return result;
          };
          const firstBits = maximumBits(rInverse.numerator) + maximumBits(m) + Math.ceil(Math.log2(rank + 1)) + 1;
          const middleBits = firstBits + maximumBits(cInverse.numerator) + Math.ceil(Math.log2(rank + 1)) + 1;
          const leftBits = maximumBits(r) + middleBits + Math.ceil(Math.log2(rank + 1)) + 1;
          const outputBits = leftBits + inputBits + Math.ceil(Math.log2(rank + 1)) + 1;
          const scratchBytes = 48 + Math.ceil(Math.max(firstBits, middleBits, leftBits, outputBits, denominatorBits) / 8);
          const releaseProduct = meter.reserve(rank * rank * (48 + Math.ceil(firstBits / 8))
            + rank * rank * (48 + Math.ceil(middleBits / 8))
            + rank * (48 + Math.ceil(leftBits / 8))
            + 8 * scratchBytes);
          try {
            const middle = multiply(multiply(rInverse.numerator, m, meter), cInverse.numerator, meter);
            const releaseResult = meter.reserve(rows * columns * 16);
            try {
            const result = Array.from({ length: columns }, () => Array<number>(rows).fill(0));
            for (let column = 0; column < columns; column += 1) {
              const left: bigint[] = [];
              for (let index = 0; index < rank; index += 1) {
                let sum = 0n;
                for (let inner = 0; inner < rank; inner += 1) {
                  const a = r[inner]![column]!;
                  const b = middle[inner]![index]!;
                  chargeProduct(meter, a, b);
                  const product = a * b;
                  meter.limbs(Math.max(integerLimbCount(sum), integerLimbCount(product)));
                  sum += product;
                }
                left.push(sum);
              }
              for (let row = 0; row < rows; row += 1) {
                let numerator = 0n;
                for (let index = 0; index < rank; index += 1) {
                  chargeProduct(meter, left[index]!, c[row]![index]!);
                  const product = left[index]! * c[row]![index]!;
                  meter.limbs(Math.max(integerLimbCount(numerator), integerLimbCount(product)));
                  numerator += product;
                }
                meter.limbs(integerLimbCount(numerator) * integerLimbCount(denominator));
                result[column]![row] = Number(numerator / denominator);
              }
            }
            return result;
            } finally {
              releaseResult();
            }
          } finally {
            releaseProduct();
          }
          } finally {
            releaseDenominator();
          }
        } finally {
          releaseCInverse();
        }
      } finally {
        releaseRInverse();
      }
    } finally {
      releaseGram();
    }
  } finally {
    releaseFactors();
  }
}
