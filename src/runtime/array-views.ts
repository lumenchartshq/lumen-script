import type { PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";

const pineArraySlice = Symbol("pineArraySlice");

interface PineArraySlice extends Array<PineValue> {
  [pineArraySlice]: { parent: PineValue[]; start: number; length: number };
}

export function pineArraySliceInfo(value: unknown): { parent: PineValue[]; start: number; length: number } | undefined {
  return Array.isArray(value) ? (value as PineArraySlice)[pineArraySlice] : undefined;
}

export function restorePineArraySlice(value: PineValue[], parent: PineValue[], start: number, length: number): void {
  Object.defineProperty(value, pineArraySlice, { value: { parent, start, length }, configurable: true });
}

export function refreshPineArraySlice(value: PineValue[], info: NonNullable<ReturnType<typeof pineArraySliceInfo>>): void {
  const parentInfo = pineArraySliceInfo(info.parent);
  if (parentInfo) refreshPineArraySlice(info.parent, parentInfo);
  if (info.start < info.parent.length && info.start + info.length > info.parent.length) {
    throw new PineRuntimeError("Slice is out of bounds of the parent array", "array.slice");
  }
  value.splice(0, value.length, ...info.parent.slice(info.start, info.start + info.length));
}

export function commitPineArraySlice(value: PineValue[], info: NonNullable<ReturnType<typeof pineArraySliceInfo>>): void {
  info.parent.splice(info.start, info.length, ...value);
  info.length = value.length;
  const parentInfo = pineArraySliceInfo(info.parent);
  if (parentInfo) commitPineArraySlice(info.parent, parentInfo);
}

export function assertWritablePineArraySlice(info: NonNullable<ReturnType<typeof pineArraySliceInfo>>): void {
  const parentInfo = pineArraySliceInfo(info.parent);
  if (parentInfo) assertWritablePineArraySlice(parentInfo);
  if (info.parent.length < info.start) {
    throw new PineRuntimeError("Slice is out of bounds of the parent array", "array.slice");
  }
}

/** Materialize a linked view at a Pine read boundary, preserving its identity. */
export function refreshPineArrayValue(value: PineValue): PineValue {
  const info = pineArraySliceInfo(value);
  if (info) refreshPineArraySlice(value as PineValue[], info);
  return value;
}
