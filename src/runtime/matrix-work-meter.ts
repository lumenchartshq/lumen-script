import { PineRuntimeError } from "./pine-runtime-error.js";

const MAX_MODULAR_UPDATES = 80_000_000;
const MAX_LIMB_PRODUCTS = 160_000_000;
const MAX_FLOAT_UPDATES = 1_500_000_000;
const MAX_TEMPORARY_BYTES = 64 * 1024 * 1024;

/** One meter belongs to one strict public matrix call, including its helpers. */
export class MatrixWorkMeter {
  private modularUpdates = 0;
  private limbProducts = 0;
  private floatUpdates = 0;
  private temporaryBytes = 0;

  constructor(private readonly method: string) {}

  modular(count: number): void {
    this.modularUpdates = this.charge(this.modularUpdates, count, MAX_MODULAR_UPDATES, "modular work");
  }

  limbs(count: number): void {
    this.limbProducts = this.charge(this.limbProducts, count, MAX_LIMB_PRODUCTS, "exact-arithmetic work");
  }

  floating(count: number): void {
    this.floatUpdates = this.charge(this.floatUpdates, count, MAX_FLOAT_UPDATES, "floating work");
  }

  /** Reservations must be released when the corresponding local copies die. */
  reserve(bytes: number): () => void {
    this.temporaryBytes = this.charge(this.temporaryBytes, bytes, MAX_TEMPORARY_BYTES, "temporary storage");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.temporaryBytes -= bytes;
    };
  }

  private charge(current: number, count: number, ceiling: number, label: string): number {
    if (!Number.isSafeInteger(count) || count < 0 || current + count > ceiling) {
      throw new PineRuntimeError(`${this.method} exceeds its ${label} budget`, this.method);
    }
    return current + count;
  }
}

export function integerLimbCount(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return Math.max(1, Math.ceil(magnitude.toString(2).length / 32));
}

export function integerBitCount(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 1 : magnitude.toString(2).length;
}
