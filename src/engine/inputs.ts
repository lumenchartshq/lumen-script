import type { ProgramDescriptor, PineValue } from "../contracts/index.js";
import { cloneRuntimeGraph, parseSessionSpec, PineRuntimeError } from "../runtime/index.js";
import { requestTimeframeRank } from "./request-context-policy.js";

/** One graph copy preserves aliases/cycles while detaching all caller-owned values. */
export function admitInputs(inputs: Readonly<Record<string, PineValue>>): Readonly<Record<string, PineValue>> {
  const owned = cloneRuntimeGraph(inputs);
  const pending: unknown[] = [owned];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (value instanceof Map || value instanceof Set) throw new TypeError("Script inputs must contain scalar, array or record values");
    for (const entry of Object.values(value)) pending.push(entry);
    Object.freeze(value);
  }
  return owned;
}

export function admitProgramInputs(
  descriptor: ProgramDescriptor,
  strict: boolean,
  inputs: Readonly<Record<string, PineValue>>,
  sourceSeries: Readonly<Record<string, readonly PineValue[]>> = {},
): Readonly<Record<string, PineValue>> {
  const owned = admitInputs(inputs);
  if (!strict) return owned;
  for (const definition of descriptor.inputs) {
    const key = Object.hasOwn(owned, definition.id)
      ? definition.id
      : Object.hasOwn(owned, definition.title)
        ? definition.title
        : undefined;
    if (key === undefined) continue;
    validateInputOverride(definition, owned[key], sourceSeries);
  }
  return owned;
}

function validateInputOverride(
  definition: ProgramDescriptor["inputs"][number],
  value: PineValue | undefined,
  sourceSeries: Readonly<Record<string, readonly PineValue[]>>,
): void {
  const method = `input.${definition.type}`;
  const fail = (message: string): never => {
    throw new PineRuntimeError(`Input '${definition.id}' ${message}`, method);
  };
  if (definition.type === "bool") {
    if (typeof value !== "boolean") fail("requires a bool override");
    return;
  }
  if (["float", "price"].includes(definition.type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("requires a finite numeric override");
    validateNumericOverride(definition, value as number, fail);
    return;
  }
  if (["int", "time"].includes(definition.type)) {
    if (typeof value !== "number" || !Number.isInteger(value)) fail("requires an integer override");
    validateNumericOverride(definition, value as number, fail);
    return;
  }
  if (definition.type === "source") {
    if (typeof value !== "string") fail("requires a source-name override");
    const source = value as string;
    const builtinSources = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "hlcc4", "ohlc4"]);
    if (!builtinSources.has(source) && !Object.hasOwn(sourceSeries, source)) fail(`references unknown source '${source}'`);
    return;
  }
  if (typeof value !== "string") fail("requires a string override");
  const stringValue = value as string;
  if (definition.type === "color" && !/^#[\dA-Fa-f]{6}(?:[\dA-Fa-f]{2})?$/u.test(stringValue)) {
    fail("requires a hexadecimal color override");
  }
  if (definition.type === "session" && !parseSessionSpec(stringValue).ok) fail(`has invalid session override '${stringValue}'`);
  if (definition.type === "timeframe" && stringValue !== "" && requestTimeframeRank(stringValue, true) < 0) {
    fail(`has invalid timeframe override '${stringValue}'`);
  }
  validateOptions(definition, stringValue, fail);
}

function validateNumericOverride(
  definition: ProgramDescriptor["inputs"][number],
  value: number,
  fail: (message: string) => never,
): void {
  validateOptions(definition, value, fail);
  if (definition.minValue !== undefined && value < definition.minValue) fail(`must be at least ${String(definition.minValue)}`);
  if (definition.maxValue !== undefined && value > definition.maxValue) fail(`must not exceed ${String(definition.maxValue)}`);
  // Float steps control the editor increment. Manual values can fall between steps.
  if (definition.type === "float" || definition.step === undefined) return;
  const origin = definition.minValue ?? 0;
  const steps = (value - origin) / definition.step;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8;
  if (Math.abs(steps - Math.round(steps)) > tolerance) fail(`must align to step ${String(definition.step)}`);
}

function validateOptions(
  definition: ProgramDescriptor["inputs"][number],
  value: PineValue,
  fail: (message: string) => never,
): void {
  if (definition.options !== undefined && !definition.options.some((option) => Object.is(option, value))) {
    fail("must be one of the declared options");
  }
}
