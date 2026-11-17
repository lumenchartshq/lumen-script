import type { PineValue } from "../contracts/index.js";
import { isPineFootprintHandle, isPineVolumeRowHandle } from "./footprint.js";

export function isNa(value: PineValue | undefined): boolean {
  return value === null || value === undefined || (typeof value === "number" && Number.isNaN(value));
}

export function normalize(value: PineValue): PineValue {
  return value === null ? Number.NaN : value;
}

export function taValue(value: PineValue): PineValue {
  const normalized = normalize(value);
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) return normalized;
  return Math.round(normalized * 10_000_000_000) / 10_000_000_000;
}

export function number(value: PineValue | undefined): number {
  return typeof value === "number" ? value : Number(value);
}

export function pineString(value: PineValue | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(pineString).join(",");
  if (isPineFootprintHandle(value)) return "footprint";
  if (isPineVolumeRowHandle(value)) return "volume_row";
  return JSON.stringify(value);
}

export function integer(value: PineValue): number {
  const numeric = number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

export function compare(left: PineValue, right: PineValue): number {
  if (typeof left === "string" && typeof right === "string") return left.localeCompare(right);
  return number(left) - number(right);
}
