import { assertWritablePineArraySlice, commitPineArraySlice, pineArraySliceInfo, refreshPineArrayValue, restorePineArraySlice } from "./array-views.js";
import type { PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { decomposition, determinant, invertFloatMatrix, MatrixNumericalFailure } from "./matrix-linear-algebra.js";
import { structuralInverse, structuralPower } from "./matrix-structural.js";
import { exactIntegerInverse, type ExactMatrixInverse } from "./matrix-exact-inverse.js";
import { exactIntegerPseudoInverse } from "./matrix-exact-pinv.js";
import { exactIntegerPower } from "./matrix-exact-power.js";
import { integerLimbCount, MatrixWorkMeter } from "./matrix-work-meter.js";
import { compare, integer, isNa, number, pineString, taValue } from "./values.js";

interface MutablePineMap {
  [key: string]: PineValue;
  __pineMap: true;
  entries: [PineValue, PineValue][];
}

interface MutablePineMatrix {
  [key: string]: PineValue;
  __pineMatrix: true;
  columnCount: number;
  data: PineValue[][];
  elementKind?: MatrixElementKind;
}

type MatrixElementKind = "int" | "float" | "other";

export interface CollectionRuntimeOptions {
  /** Reference-compatible collection errors and resource ceilings. */
  readonly strict?: boolean;
  /** Pine v6 allows array indexes relative to the end of the array. */
  readonly negativeIndices?: boolean;
}

// Iterator snapshots detect structural edits when advancing to another entry.
// Weak ownership keeps this ephemeral bookkeeping out of persisted Pine values.
const mapRevisions = new WeakMap<MutablePineMap, number>();

export function pineMapIteration(value: PineValue, liveValues = false): PineValue[] {
  const map = mutablePineMap(value);
  const revision = mapRevisions.get(map) ?? 0;
  const entries = map.entries.map(([key, entry]) => [key, entry] as PineValue[]);
  return new Proxy(entries, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9][0-9]*)$/u.test(property) && Number(property) < target.length) {
        if ((mapRevisions.get(map) ?? 0) !== revision) {
          throw new PineRuntimeError(
            "Cannot modify a map while iterating over its key-value pairs with a `for...in` loop. Loop through a `copy()` of the map or its `keys()` array, or use a `for` or `while` loop instead.",
            "for...in",
          );
        }
        if (liveValues) {
          const pair = map.entries[Number(property)];
          if (pair !== undefined) return [...pair];
        }
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function recordMapMutation(map: MutablePineMap): void {
  mapRevisions.set(map, (mapRevisions.get(map) ?? 0) + 1);
}

const MAX_ARRAY_OR_MATRIX_ELEMENTS = 100_000;
const MAX_MAP_PAIRS = 50_000;
const MAX_PINE_STRING_LENGTH = 40_960;
const sliceMutations = new Set(["push", "pop", "unshift", "shift", "set", "clear", "concat", "reverse", "insert", "remove", "fill", "sort"]);
const numericArrayCalls = new Set([
  "abs", "avg", "min", "max", "range", "sum", "variance", "stdev", "covariance", "standardize",
  "median", "mode", "percentile_linear_interpolation", "percentile_nearest_rank", "percentrank",
]);

export function arrayCall(name: string, args: readonly PineValue[], options: CollectionRuntimeOptions = {}): PineValue {
  const array = Array.isArray(args[0]) ? args[0] as PineValue[] : undefined;
  const info = pineArraySliceInfo(array);
  for (const arg of args) refreshPineArrayValue(arg);
  if (info && sliceMutations.has(name)) assertWritablePineArraySlice(info);
  const result = arrayCallUnlinked(name, args, options);
  if (array && info && sliceMutations.has(name)) commitPineArraySlice(array, info);
  return result;
}

function arrayCallUnlinked(name: string, args: readonly PineValue[], options: CollectionRuntimeOptions = {}): PineValue {
  if (name === "from") {
    assertCollectionSize(args.length, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options);
    return [...args];
  }
  if (name === "new" || name.startsWith("new_")) {
    const size = options.strict
      ? strictArrayConstructorSize(args[0], name)
      : Math.max(0, integer(args[0] ?? 0));
    assertCollectionSize(size, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options);
    const initial = args[1] ?? defaultArrayValue(name, options);
    return Array.from({ length: size }, () => initial);
  }
  if (options.strict && isNa(args[0])) {
    throw new PineRuntimeError("Cannot call array methods when id of array is na.", `array.${name}`);
  }
  const array = mutableArray(args[0]);
  if (numericArrayCalls.has(name)) assertNumericArray(array, `array.${name}`, options);
  switch (name) {
    case "abs": return array.map((value) => options.strict && isNa(value) ? Number.NaN : Math.abs(number(value)));
    case "push": assertCollectionSize(array.length + 1, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options); array.push(args[1] ?? Number.NaN); return null;
    case "pop": {
      assertArrayNotEmpty(array, options);
      return array.pop() ?? Number.NaN;
    }
    case "unshift": assertCollectionSize(array.length + 1, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options); array.unshift(args[1] ?? Number.NaN); return null;
    case "shift": {
      assertArrayNotEmpty(array, options);
      return array.shift() ?? Number.NaN;
    }
    case "get": return array[arrayIndex(args[1], array.length, false, options, "array.get")] ?? Number.NaN;
    case "set": array[arrayIndex(args[1], array.length, false, options)] = args[2] ?? Number.NaN; return null;
    case "first": assertArrayNotEmpty(array, options); return array[0] ?? Number.NaN;
    case "last": assertArrayNotEmpty(array, options); return array.at(-1) ?? Number.NaN;
    case "size": return array.length;
    case "clear": array.length = 0; return null;
    case "copy": return [...array];
    case "concat": {
      const right = mutableArray(args[1]);
      assertCollectionSize(array.length + right.length, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options);
      const appended = [...right];
      for (const value of appended) array.push(value);
      return array;
    }
    case "slice": {
      const start = number(args[1] ?? 0);
      const end = number(args[2] ?? array.length);
      if (options.strict && (!Number.isInteger(start) || !Number.isInteger(end))) {
        throw new PineRuntimeError("Array slice indexes must be integers", "array.slice");
      }
      if (options.strict && start > end) throw new PineRuntimeError("Index 'from' should be less than index 'to'.", "array.slice");
      if (options.strict && (start < 0 || end > array.length)) {
        throw arrayBoundsError(start < 0 ? start : end, array.length, "array.slice");
      }
      const view = array.slice(start, end);
      restorePineArraySlice(view, array, start, view.length);
      return view;
    }
    case "includes": return array.some((value) => arraySearchEquals(value, args[1], options));
    case "indexof": return array.findIndex((value) => arraySearchEquals(value, args[1], options));
    case "lastindexof": {
      for (let index = array.length - 1; index >= 0; index -= 1) if (arraySearchEquals(array[index]!, args[1], options)) return index;
      return -1;
    }
    case "binary_search": return binarySearch(array, args[1], "any", options);
    case "binary_search_leftmost": return binarySearch(array, args[1], "left", options);
    case "binary_search_rightmost": return binarySearch(array, args[1], "right", options);
    case "reverse": array.reverse(); return null;
    case "join": return joinArray(array, args[1], args[2] === "float", options);
    case "insert": {
      assertCollectionSize(array.length + 1, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options);
      array.splice(arrayIndex(args[1], array.length, true, options, "array.insert"), 0, args[2] ?? Number.NaN);
      return null;
    }
    case "remove": return array.splice(arrayIndex(args[1], array.length, false, options, "array.remove"), 1)[0] ?? Number.NaN;
    case "fill": {
      const [from, to] = arrayRange(args[2], args[3], array.length, "array.fill", options);
      array.fill(args[1] ?? Number.NaN, from, to);
      return null;
    }
    case "sort": {
      assertSortableArray(array, args[2], options);
      const direction = sortDirection(args[1], options, "array.sort");
      array.sort((left, right) => direction * (options.strict ? compareSortValues(left, right, args[2]) : sortableNumber(left) - sortableNumber(right)));
      return null;
    }
    case "sort_indices": {
      assertSortableArray(array, args[2], options);
      const direction = sortDirection(args[1], options, "array.sort_indices");
      return array.map((_, index) => index).sort((left, right) => direction * (options.strict ? compareSortValues(array[left]!, array[right]!, args[2]) : sortableNumber(array[left]) - sortableNumber(array[right])));
    }
    case "every": return array.every((value) => !Number.isNaN(number(value)) && Boolean(value));
    case "some": return array.some((value) => !Number.isNaN(number(value)) && Boolean(value));
    case "sum": {
      const values = numericArray(array, options.strict);
      return values.length === 0 ? Number.NaN : options.strict ? compensatedSum(values) : values.reduce((sum, value) => sum + value, 0);
    }
    case "avg": {
      const values = numericArray(array, options.strict);
      if (values.length === 0) return Number.NaN;
      if (options.strict) return taValue(compensatedSum(values) / values.length);
      let average = 0;
      for (const [index, value] of values.entries()) average += (value - average) / (index + 1);
      return taValue(average);
    }
    case "min":
    case "max": {
      const values = numericArray(array, options.strict);
      if (values.length === 0) return Number.NaN;
      if (options.strict && args[1] !== undefined) return nthExtremum(values, name, args[1], array.length);
      if (name === "min") return options.strict ? numericExtrema(values).minimum : Math.min(...values);
      return options.strict ? numericExtrema(values).maximum : Math.max(...values);
    }
    case "range": {
      const values = numericArray(array, options.strict);
      if (values.length === 0) return Number.NaN;
      if (!options.strict) return Math.max(...values) - Math.min(...values);
      const { minimum, maximum } = numericExtrema(values);
      return maximum - minimum;
    }
    case "median": {
      const values = numericArray(array, options.strict).sort((left, right) => left - right);
      if (values.length === 0) return Number.NaN;
      const middle = Math.floor(values.length / 2);
      return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
    }
    case "mode": return arrayMode(options.strict ? numericArray(array, true) : array);
    case "covariance": {
      const right = mutableArray(args[1]);
      assertNumericArray(right, "array.covariance", options);
      const biased = arrayBias(args[2], "array.covariance", options);
      return taValue(options.strict ? strictArrayCovariance(array, right, biased) : arrayCovariance(array, right, biased));
    }
    case "percentile_linear_interpolation": return taValue(arrayPercentile(array, arrayPercentage(args[1], name, options), true, options));
    case "percentile_nearest_rank": return arrayPercentile(array, arrayPercentage(args[1], name, options), false, options);
    case "percentrank": return array.length === 0
      ? Number.NaN
      : arrayPercentRank(array, arrayIndex(args[1], array.length, false,
        { ...options, negativeIndices: false }, "array.percentrank"), options);
    case "standardize": {
      if (options.strict) {
        const values = numericArray(array, true);
        if (values.length === 0) return [];
        const average = compensatedSum(values) / values.length;
        const deviation = strictArrayStandardDeviation(array, true);
        if (typeof deviation !== "number" || Number.isNaN(deviation)) return [];
        if (deviation === 0) return array.map(() => 1);
        return array.map((value) => isNa(value) ? Number.NaN : (number(value) - average) / deviation);
      }
      const average = number(arrayCall("avg", [array], options));
      const deviation = number(arrayCall("stdev", [array], options));
      if (Number.isNaN(deviation)) return [];
      if (deviation === 0) return array.map(() => 1);
      return array.map((value) => (number(value) - average) / deviation);
    }
    case "variance": {
      const biased = arrayBias(args[1], "array.variance", options);
      return taValue(options.strict ? strictArrayVariance(array, biased) : arrayVariance(array, biased));
    }
    case "stdev": {
      const biased = arrayBias(args[1], "array.stdev", options);
      return taValue(options.strict ? strictArrayStandardDeviation(array, biased) : arrayStandardDeviation(array, biased));
    }
    default: throw new Error(`Unsupported array call array.${name}`);
  }
}

function binarySearch(
  array: readonly PineValue[],
  target: PineValue | undefined,
  mode: "any" | "left" | "right",
  options: CollectionRuntimeOptions,
): number {
  if (options.strict) {
    if (!isNa(target) && typeof target !== "number") throw new PineRuntimeError("Binary search requires a numeric value", `array.binary_search${mode === "any" ? "" : `_${mode}most`}`);
    if (array.some((value) => !isNa(value) && typeof value !== "number")) {
      throw new PineRuntimeError("Binary search requires int or float array elements", `array.binary_search${mode === "any" ? "" : `_${mode}most`}`);
    }
  }
  const compareValue = (value: PineValue): number => options.strict
    ? compareSortValues(value, target ?? Number.NaN, undefined)
    : compare(value, target ?? Number.NaN);
  let low = 0;
  let high = mode === "any" ? array.length - 1 : array.length;
  if (mode === "any") {
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const comparison = compareValue(array[middle]!);
      if (comparison === 0 && (!options.strict || arraySearchEquals(array[middle]!, target, options))) return middle;
      if (comparison < 0) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const comparison = compareValue(array[middle]!);
    if (comparison < 0 || (mode === "right" && comparison === 0)) low = middle + 1;
    else high = middle;
  }
  if (mode === "left") return low < array.length && arraySearchEquals(array[low]!, target, options) ? low : low - 1;
  return low > 0 && arraySearchEquals(array[low - 1]!, target, options) ? low - 1 : low;
}

function arrayMode(array: readonly PineValue[]): PineValue {
  if (array.length === 0) return Number.NaN;
  const counts = new Map<PineValue, number>();
  for (const value of array) counts.set(value, (counts.get(value) ?? 0) + 1);
  let frequency = 0;
  const modes: PineValue[] = [];
  for (const [value, count] of counts) {
    if (count > frequency) {
      frequency = count;
      modes.length = 0;
    }
    if (count === frequency) modes.push(value);
  }
  return modes.sort(compare)[0] ?? Number.NaN;
}

function arrayCovariance(left: readonly PineValue[], right: readonly PineValue[], biased: boolean): PineValue {
  if (left.length !== right.length) return Number.NaN;
  const pairs = left.map((value, index) => [number(value), number(right[index])] as const).filter(([x, y]) => !Number.isNaN(x) && !Number.isNaN(y));
  const divisor = pairs.length - (biased ? 0 : 1);
  if (divisor <= 0) return Number.NaN;
  const leftMean = pairs.reduce((sum, [value]) => sum + value, 0) / pairs.length;
  const rightMean = pairs.reduce((sum, [, value]) => sum + value, 0) / pairs.length;
  return pairs.reduce((sum, [x, y]) => sum + (x - leftMean) * (y - rightMean), 0) / divisor;
}

function arrayPercentile(
  array: readonly PineValue[],
  percentage: number,
  interpolate: boolean,
  options: CollectionRuntimeOptions,
): PineValue {
  if (array.length === 0) return Number.NaN;
  const values = numericArray(array, options.strict).sort((left, right) => left - right);
  if (values.length === 0 || (!options.strict && interpolate && values.length !== array.length)) return Number.NaN;
  const bounded = Math.max(0, Math.min(100, percentage));
  if (!interpolate) {
    const rankLength = options.strict ? values.length : array.length;
    const rank = Math.ceil(bounded / 100 * rankLength);
    return rank <= 0 ? values[0]! : values[rank - 1] ?? Number.NaN;
  }
  const position = Math.max(0, Math.min(values.length - 1, bounded / 100 * values.length - 0.5));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return values[lower]! + (position - lower) * (values[upper]! - values[lower]!);
}

function arrayPercentRank(array: readonly PineValue[], index: number, options: CollectionRuntimeOptions): PineValue {
  if (index < 0 || index >= array.length || array.length <= 1) return Number.NaN;
  const rawTarget = array[index];
  if (options.strict && isNa(rawTarget)) return Number.NaN;
  const target = number(rawTarget);
  if (Number.isNaN(target)) return Number.NaN;
  if (options.strict) {
    const values = numericArray(array, true);
    const matchingPeers = values.filter((value) => value <= target).length - 1;
    return 100 * matchingPeers / (array.length - 1);
  }
  return 100 * array.filter((value) => !Number.isNaN(number(value)) && number(value) < target).length / (array.length - 1);
}

function arrayPercentage(value: PineValue | undefined, method: string, options: CollectionRuntimeOptions): number {
  const percentage = number(value);
  if (options.strict && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)) {
    throw new PineRuntimeError(`${method} percentage must be a finite number from 0 to 100`, `array.${method}`);
  }
  return percentage;
}

function mutableArray(value: PineValue | undefined): PineValue[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value as PineValue[];
}

/** `array.max(id, nth)` / `array.min(id, nth)`: the nth element counting from the extreme, duplicates included. */
function nthExtremum(values: readonly number[], direction: "max" | "min", nthValue: PineValue, size: number): PineValue {
  const nth = number(nthValue);
  if (!Number.isInteger(nth) || nth < 0 || nth >= values.length) {
    throw new PineRuntimeError(`Index ${String(nth)} is out of bounds, array size is ${String(size)}`, `array.${direction}`);
  }
  const ordered = [...values].sort((left, right) => direction === "max" ? right - left : left - right);
  return ordered[nth]!;
}

function numericArray(array: readonly PineValue[], omitMissing = false): number[] {
  return array
    .filter((value) => !omitMissing || !isNa(value))
    .map(number)
    .filter((value) => !Number.isNaN(value));
}

function assertNumericArray(array: readonly PineValue[], method: string, options: CollectionRuntimeOptions): void {
  if (!options.strict) return;
  assertCollectionSize(array.length, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Array", options);
  if (array.some((value) => !isNa(value) && typeof value !== "number")) {
    throw new PineRuntimeError(`${method} requires int or float array elements`, method);
  }
}

function arrayBias(value: PineValue | undefined, method: string, options: CollectionRuntimeOptions): boolean {
  if (value === undefined) return true;
  if (options.strict && typeof value !== "boolean") {
    throw new PineRuntimeError(`${method} biased argument must be a bool`, method);
  }
  return Boolean(value);
}

function compensatedSum(values: readonly number[]): number {
  if (values.some((value) => !Number.isFinite(value))) return values.reduce((sum, value) => sum + value, 0);
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

function numericExtrema(values: readonly number[]): { readonly minimum: number; readonly maximum: number } {
  let minimum = values[0]!;
  let maximum = values[0]!;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index]!;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return { minimum, maximum };
}

function sortableNumber(value: PineValue | undefined): number {
  const numeric = number(value);
  return Number.isNaN(numeric) ? Number.POSITIVE_INFINITY : numeric;
}

function arrayVariance(array: readonly PineValue[], biased = true): PineValue {
  const values = numericArray(array);
  if (values.length === 0) return Number.NaN;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const divisor = values.length - (biased ? 0 : 1);
  return divisor <= 0 ? Number.NaN : values.reduce((sum, value) => sum + (value - average) ** 2, 0) / divisor;
}

function strictArrayVariance(array: readonly PineValue[], biased: boolean): PineValue {
  const values = numericArray(array, true);
  const divisor = values.length - (biased ? 0 : 1);
  if (divisor <= 0) return Number.NaN;
  let mean = 0;
  let squaredDeviations = 0;
  for (const [index, value] of values.entries()) {
    const delta = value - mean;
    mean += delta / (index + 1);
    squaredDeviations += delta * (value - mean);
  }
  return squaredDeviations / divisor;
}

function arrayStandardDeviation(array: readonly PineValue[], biased: boolean): PineValue {
  const values = numericArray(array);
  if (values.length === 0) return Number.NaN;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanSquare = values.reduce((sum, value) => sum + value * value, 0) / values.length;
  let variance = meanSquare - average ** 2;
  if (variance < 0) return Number.NaN;
  if (!biased && values.length === 1) return 0;
  if (!biased) variance = variance * values.length / (values.length - 1);
  return Math.sqrt(variance);
}

function strictArrayStandardDeviation(array: readonly PineValue[], biased: boolean): PineValue {
  const variance = strictArrayVariance(array, biased);
  return typeof variance === "number" && variance >= 0 ? Math.sqrt(variance) : Number.NaN;
}

function strictArrayCovariance(left: readonly PineValue[], right: readonly PineValue[], biased: boolean): PineValue {
  if (left.length !== right.length) return Number.NaN;
  let count = 0;
  let leftMean = 0;
  let rightMean = 0;
  let coMoment = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (isNa(left[index]) || isNa(right[index])) continue;
    const leftValue = number(left[index]);
    const rightValue = number(right[index]);
    if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) continue;
    count += 1;
    const leftDelta = leftValue - leftMean;
    leftMean += leftDelta / count;
    const rightDelta = rightValue - rightMean;
    rightMean += rightDelta / count;
    coMoment += leftDelta * (rightValue - rightMean);
  }
  const divisor = count - (biased ? 0 : 1);
  return divisor <= 0 ? Number.NaN : coMoment / divisor;
}

function pineEquals(left: PineValue, right: PineValue | undefined): boolean {
  if (isNa(left) && isNa(right)) return false;
  if (typeof left === "number" && typeof right === "number") return Math.abs(left - right) < 1e-10;
  return left === right;
}

function arraySearchEquals(left: PineValue, right: PineValue | undefined, options: CollectionRuntimeOptions): boolean {
  if (options.strict && isNa(left) && isNa(right)) return true;
  return pineEquals(left, right);
}

function joinArray(array: readonly PineValue[], separatorValue: PineValue | undefined, floatElements: boolean, options: CollectionRuntimeOptions): string {
  if (!options.strict) return array.map(pineString).join(pineString(separatorValue ?? ","));
  if (separatorValue !== undefined && typeof separatorValue !== "string") {
    throw new PineRuntimeError("Array join separator must be a string", "array.join");
  }
  const separator = typeof separatorValue === "string" ? separatorValue : ",";
  let result = "";
  let resultLength = 0;
  for (let index = 0; index < array.length; index += 1) {
    const element = array[index]!;
    if (!isNa(element) && typeof element !== "number" && typeof element !== "string") {
      throw new PineRuntimeError("Array join requires int, float, or string elements", "array.join");
    }
    if (index > 0) {
      resultLength = boundedJoinedLength(resultLength, separator);
      result += separator;
    }
    const value = floatElements && typeof element === "number" ? joinFloat(element) : pineString(element);
    resultLength = boundedJoinedLength(resultLength, value);
    result += value;
  }
  return result;
}

function joinFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 10_000_000)) {
    const [mantissa = "", exponent = "0"] = value.toExponential().split("e");
    const digits = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
    return `${digits}E${Number(exponent)}`;
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function boundedJoinedLength(currentLength: number, value: string): number {
  let length = currentLength;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
    length += 1;
    if (length > MAX_PINE_STRING_LENGTH) {
      throw new PineRuntimeError(`String result exceeds the ${String(MAX_PINE_STRING_LENGTH)} character limit`, "array.join");
    }
  }
  return length;
}

function strictArrayConstructorSize(value: PineValue | undefined, name: string): number {
  if (value === undefined) return 0;
  if (isNa(value)) throw new PineRuntimeError("Array size must be a finite integer", `array.${name}`);
  const size = number(value);
  if (!Number.isFinite(size) || !Number.isInteger(size)) {
    throw new PineRuntimeError("Array size must be a finite integer", `array.${name}`);
  }
  if (size < 0) throw new PineRuntimeError("Cannot create an array with a negative size", `array.${name}`);
  return size;
}

function defaultArrayValue(name: string, options: CollectionRuntimeOptions): PineValue {
  if (name === "new_bool") return false;
  if (options.strict) {
    if (["new_box", "new_label", "new_line", "new_linefill", "new_table"].includes(name)) return null;
    return Number.NaN;
  }
  if (name === "new" || name === "new_int") return 0;
  if (name === "new_string") return "";
  if (name === "new_color" || ["new_box", "new_label", "new_line", "new_linefill", "new_table"].includes(name)) return null;
  return Number.NaN;
}

function arrayBoundsError(index: number, length: number, method: string): PineRuntimeError {
  return new PineRuntimeError(`In '${method}()' function. Index ${String(index)} is out of bounds, array size is ${String(length)}.`, method);
}

function arrayIndex(value: PineValue | undefined, length: number, allowEnd: boolean, options: CollectionRuntimeOptions, method?: string): number {
  if (!options.strict) return integer(value ?? 0);
  const numeric = number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) throw new Error("Array index must be an integer");
  const resolved = options.negativeIndices && numeric < 0 ? length + numeric : numeric;
  const maximum = allowEnd ? length : length - 1;
  if (resolved < 0 || resolved > maximum) {
    if (method !== undefined) throw arrayBoundsError(numeric, length, method);
    throw new Error(`Array index ${String(numeric)} is out of bounds for length ${String(length)}`);
  }
  return resolved;
}

function arrayRange(
  fromValue: PineValue | undefined,
  toValue: PineValue | undefined,
  length: number,
  method: string,
  options: CollectionRuntimeOptions,
): readonly [number, number] {
  if (!options.strict) return [integer(fromValue ?? 0), integer(toValue ?? length)];
  const from = number(fromValue ?? 0);
  const to = number(toValue ?? length);
  if (!Number.isFinite(from) || !Number.isInteger(from) || !Number.isFinite(to) || !Number.isInteger(to)) {
    throw new PineRuntimeError("Array range indexes must be integers", method);
  }
  if (from < 0 || to < 0 || from > length || to > length) {
    throw new PineRuntimeError("Array range index is out of bounds", method);
  }
  if (from > to) throw new PineRuntimeError("Array range start must not be greater than its end", method);
  return [from, to];
}

function assertArrayNotEmpty(array: readonly PineValue[], options: CollectionRuntimeOptions): void {
  if (options.strict && array.length === 0) throw new Error("Array is empty");
}

function assertCollectionSize(size: number, limit: number, label: string, options: CollectionRuntimeOptions): void {
  if (options.strict && size > limit) throw new Error(`${label} exceeds the maximum of ${String(limit)} elements`);
}

function strictMatrixDimension(value: PineValue | undefined, label: "row" | "column", method = "matrix.new"): number {
  const dimension = number(value);
  if (!Number.isFinite(dimension) || !Number.isInteger(dimension)) {
    throw new PineRuntimeError(`Matrix ${label} count must be a finite integer`, method);
  }
  if (dimension < 0) throw new PineRuntimeError(`Matrix ${label} count cannot be negative`, method);
  if (dimension > MAX_ARRAY_OR_MATRIX_ELEMENTS) {
    throw new PineRuntimeError(`Matrix ${label} count exceeds the maximum of ${String(MAX_ARRAY_OR_MATRIX_ELEMENTS)}`, method);
  }
  return dimension;
}

function assertMatrixCapacity(rows: number, columns: number, method: string): void {
  if (rows > 0 && columns > Math.floor(MAX_ARRAY_OR_MATRIX_ELEMENTS / rows)) {
    throw new PineRuntimeError(`Matrix exceeds the maximum of ${String(MAX_ARRAY_OR_MATRIX_ELEMENTS)} elements`, method);
  }
}

function assertRectangularMatrix(matrix: MutablePineMatrix, method: string): void {
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (matrix.data.some((row) => !Array.isArray(row) || row.length !== columns)) {
    throw new PineRuntimeError("Matrix rows must have equal column counts", `matrix.${method}`);
  }
  if (rows > MAX_ARRAY_OR_MATRIX_ELEMENTS || columns > MAX_ARRAY_OR_MATRIX_ELEMENTS) {
    throw new PineRuntimeError(`Matrix dimensions cannot exceed ${String(MAX_ARRAY_OR_MATRIX_ELEMENTS)}`, `matrix.${method}`);
  }
  assertMatrixCapacity(rows, columns, `matrix.${method}`);
}

function matrixInsertionValues(value: PineValue | undefined, method: string): PineValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new PineRuntimeError("Matrix insertion values must be an array", method);
  return [...(value as readonly PineValue[])];
}

function matrixIndex(
  value: PineValue | undefined,
  length: number,
  label: "row" | "column",
  options: CollectionRuntimeOptions,
  method = "access",
  allowEnd = false,
): number {
  if (!options.strict) return integer(value ?? 0);
  const numeric = number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 0 || numeric > length - (allowEnd ? 0 : 1)) {
    throw new PineRuntimeError(`Matrix ${label} index ${String(numeric)} is out of bounds for length ${String(length)}`, `matrix.${method}`);
  }
  return numeric;
}

function matrixRange(
  fromValue: PineValue | undefined,
  toValue: PineValue | undefined,
  length: number,
  label: "row" | "column",
  allowEmpty: boolean,
  options: CollectionRuntimeOptions,
  method: string,
): readonly [number, number] {
  if (!options.strict) {
    return [
      Math.max(0, integer(fromValue ?? 0)),
      Math.min(length, integer(toValue ?? length)),
    ];
  }
  const from = number(fromValue ?? 0);
  const to = number(toValue ?? length);
  if (!Number.isFinite(from) || !Number.isInteger(from) || !Number.isFinite(to) || !Number.isInteger(to)) {
    throw new PineRuntimeError(`Matrix ${label} range indexes must be finite integers`, `matrix.${method}`);
  }
  if (from < 0 || to < 0 || from > length || to > length) {
    throw new PineRuntimeError(`Matrix ${label} range index is out of bounds`, `matrix.${method}`);
  }
  if (from > to || (!allowEmpty && from === to)) {
    const requirement = allowEmpty ? "start must not be greater than its end" : "range must be nonempty and ordered";
    throw new PineRuntimeError(`Matrix ${label} ${requirement}`, `matrix.${method}`);
  }
  return [from, to];
}

export function mapCall(name: string, args: readonly PineValue[], options: CollectionRuntimeOptions = {}): PineValue {
  if (name === "new") return { __pineMap: true, entries: [] };
  const map = mutablePineMap(args[0]);
  if (name === "size") return map.entries.length;
  if (name === "clear") { if (map.entries.length > 0) recordMapMutation(map); map.entries.length = 0; return null; }
  if (name === "contains") return map.entries.some(([key]) => pineEquals(key, args[1]));
  if (name === "get") return map.entries.find(([key]) => pineEquals(key, args[1]))?.[1] ?? Number.NaN;
  if (name === "keys") { assertMapPairCount(map, options); return map.entries.map(([key]) => key); }
  if (name === "values") { assertMapPairCount(map, options); return map.entries.map(([, value]) => value); }
  if (name === "copy") { assertMapPairCount(map, options); return { __pineMap: true, entries: map.entries.map(([key, value]) => [key, value]) }; }
  if (name === "put") {
    const entry = map.entries.find(([key]) => pineEquals(key, args[1]));
    const previous = entry?.[1] ?? Number.NaN;
    if (entry === undefined) {
      assertCollectionSize(map.entries.length + 1, MAX_MAP_PAIRS, "Map", options);
      map.entries.push([args[1] ?? Number.NaN, args[2] ?? Number.NaN]);
      recordMapMutation(map);
    }
    else {
      entry[1] = args[2] ?? Number.NaN;
    }
    return previous;
  }
  if (name === "remove") {
    const index = map.entries.findIndex(([key]) => pineEquals(key, args[1]));
    if (index < 0) return Number.NaN;
    recordMapMutation(map);
    return map.entries.splice(index, 1)[0]![1];
  }
  if (name === "put_all") {
    const source = mutablePineMap(args[1]);
    if (source === map) return null;
    assertMapMergeCapacity(map, source, options);
    for (const [key, value] of source.entries) mapCall("put", [map, key, value], options);
    return null;
  }
  throw new Error(`Unsupported map call map.${name}`);
}

function assertMapPairCount(map: MutablePineMap, options: CollectionRuntimeOptions): void {
  assertCollectionSize(map.entries.length, MAX_MAP_PAIRS, "Map", options);
}

function assertMapMergeCapacity(target: MutablePineMap, source: MutablePineMap, options: CollectionRuntimeOptions): void {
  if (!options.strict) return;
  assertMapPairCount(target, options);
  assertMapPairCount(source, options);
  const pendingKeys: PineValue[] = [];
  for (const [key] of source.entries) {
    if (target.entries.some(([existing]) => pineEquals(existing, key)) || pendingKeys.some((existing) => pineEquals(existing, key))) continue;
    pendingKeys.push(key);
    assertCollectionSize(target.entries.length + pendingKeys.length, MAX_MAP_PAIRS, "Map", options);
  }
}

export function isPineMap(value: PineValue | undefined): value is PineValue & MutablePineMap {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, PineValue>>;
  return candidate.__pineMap === true && Array.isArray(candidate.entries);
}

function mutablePineMap(value: PineValue | undefined): MutablePineMap {
  if (!isPineMap(value)) throw new Error("Expected a map");
  return value;
}
export function matrixCall(name: string, args: readonly PineValue[], options: CollectionRuntimeOptions = {}): PineValue {
  const method = name === "new" || name.startsWith("new_") ? "matrix.new" : `matrix.${name}`;
  if (name === "new" || name.startsWith("new_")) {
    const rows = options.strict ? strictMatrixDimension(args[0] ?? 0, "row") : Math.max(0, integer(args[0] ?? 0));
    const columns = options.strict ? strictMatrixDimension(args[1] ?? 0, "column") : Math.max(0, integer(args[1] ?? 0));
    if (options.strict) assertMatrixCapacity(rows, columns, method);
    else assertCollectionSize(rows * columns, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Matrix", options);
    const kind = options.strict ? matrixConstructorKind(name, args[3]) : undefined;
    const initial = args[2] ?? Number.NaN;
    if (options.strict) assertMatrixCell(kind!, initial, method);
    const data = Array.from({ length: rows }, () => Array.from({ length: columns }, () => initial));
    return pineMatrix(data, options.strict ? columns : undefined, kind);
  }
  const matrix = mutablePineMatrix(args[0]);
  if (options.strict) validateStrictMatrix(matrix, method);
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  switch (name) {
    case "rows": return rows;
    case "columns": return columns;
    case "elements_count": return rows * columns;
    case "get": {
      const row = matrixIndex(args[1], rows, "row", options, name);
      const column = matrixIndex(args[2], columns, "column", options, name);
      return matrix.data[row]?.[column] ?? Number.NaN;
    }
    case "set": {
      const rowIndex = matrixIndex(args[1], rows, "row", options, name);
      const column = matrixIndex(args[2], columns, "column", options, name);
      const row = matrix.data[rowIndex];
      const value = args[3] ?? Number.NaN;
      if (options.strict) assertMatrixCell(matrix.elementKind!, value, method);
      if (row !== undefined && column >= 0 && column < row.length) row[column] = value;
      return null;
    }
    case "fill": {
      const [fromRow, toRow] = matrixRange(args[2], args[3], rows, "row", true, options, name);
      const [fromColumn, toColumn] = matrixRange(args[4], args[5], columns, "column", true, options, name);
      const value = args[1] ?? Number.NaN;
      if (options.strict) assertMatrixCell(matrix.elementKind!, value, method);
      for (let row = fromRow; row < toRow; row += 1) matrix.data[row]!.fill(value, fromColumn, toColumn);
      return null;
    }
    case "row": return [...(matrix.data[matrixIndex(args[1], rows, "row", options, name)] ?? [])];
    case "col": {
      const column = matrixIndex(args[1], columns, "column", options, name);
      return !options.strict && (column < 0 || column >= columns)
        ? []
        : matrix.data.map((row) => row[column] ?? Number.NaN);
    }
    case "add_row": {
      if (options.strict) {
        const index = matrixIndex(args[1] === undefined ? rows : args[1], rows, "row", options, name, true);
        const inserted = matrixInsertionValues(args[2], method);
        const width = rows === 0 && columns === 0 && inserted !== undefined ? inserted.length : columns;
        if (inserted !== undefined && inserted.length !== width) {
          throw new PineRuntimeError("matrix.add_row requires an array matching the matrix column count", method);
        }
        if (inserted !== undefined) for (const value of inserted) assertMatrixCell(matrix.elementKind!, value, method);
        const newRows = rows + 1;
        strictMatrixDimension(newRows, "row", method);
        strictMatrixDimension(width, "column", method);
        assertMatrixCapacity(newRows, width, method);
        matrix.data.splice(index, 0, inserted ?? Array.from({ length: width }, () => Number.NaN));
        matrix.columnCount = width;
        return null;
      }
      const index = Math.max(0, Math.min(rows, integer(args[1] ?? rows)));
      const values = matrixValues(args[2]);
      const width = rows === 0 ? values.length : columns;
      assertCollectionSize((rows + 1) * width, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Matrix", options);
      matrix.data.splice(index, 0, Array.from({ length: width }, (_, column) => values[column] ?? Number.NaN));
      return null;
    }
    case "add_col": {
      if (options.strict) {
        const index = matrixIndex(args[1] === undefined ? columns : args[1], columns, "column", options, name, true);
        const inserted = matrixInsertionValues(args[2], method);
        if (rows === 0 && columns === 0 && inserted !== undefined) {
          for (const value of inserted) assertMatrixCell(matrix.elementKind!, value, method);
          strictMatrixDimension(inserted.length, "row", method);
          assertMatrixCapacity(inserted.length, 1, method);
          matrix.data = inserted.map((value) => [value]);
          matrix.columnCount = 1;
          return null;
        }
        if (inserted !== undefined && inserted.length !== rows) {
          throw new PineRuntimeError("matrix.add_col requires an array matching the matrix row count", method);
        }
        if (inserted !== undefined) for (const value of inserted) assertMatrixCell(matrix.elementKind!, value, method);
        const newColumns = columns + 1;
        strictMatrixDimension(newColumns, "column", method);
        assertMatrixCapacity(rows, newColumns, method);
        if (rows > 0) {
          for (const [rowIndex, row] of matrix.data.entries()) {
            row.splice(index, 0, inserted?.[rowIndex] ?? Number.NaN);
          }
        }
        matrix.columnCount = newColumns;
        return null;
      }
      const values = matrixValues(args[2]);
      assertCollectionSize(rows === 0 ? values.length : rows * (columns + 1), MAX_ARRAY_OR_MATRIX_ELEMENTS, "Matrix", options);
      if (rows === 0) matrix.data.push(...values.map((value) => [value]));
      else {
        const index = Math.max(0, Math.min(columns, integer(args[1] ?? columns)));
        for (const [rowIndex, row] of matrix.data.entries()) row.splice(index, 0, values[rowIndex] ?? Number.NaN);
      }
      return null;
    }
    case "remove_row": {
      if (!options.strict) return matrix.data.splice(integer(args[1] ?? 0), 1)[0] ?? [];
      const row = matrixIndex(args[1] === undefined ? rows - 1 : args[1], rows, "row", options, name);
      return matrix.data.splice(row, 1)[0]!;
    }
    case "remove_col": {
      if (options.strict) {
        const column = matrixIndex(args[1] === undefined ? columns - 1 : args[1], columns, "column", options, name);
        const removed = matrix.data.map((row) => row[column] ?? Number.NaN);
        for (const row of matrix.data) row.splice(column, 1);
        matrix.columnCount = columns - 1;
        return removed;
      }
      const column = integer(args[1] ?? 0);
      return matrix.data.map((row) => row.splice(column, 1)[0] ?? Number.NaN);
    }
    case "copy": {
      if (options.strict) assertMatrixCapacity(rows, columns, method);
      return cloneMatrix(matrix);
    }
    case "concat": {
      if (options.strict && !isPineMatrix(args[1])) throw new PineRuntimeError("matrix.concat requires a matrix operand", method);
      const other = mutablePineMatrix(args[1]);
      if (options.strict) return strictMatrixConcat(matrix, other);
      if (rows === 0 || matrixColumns(other) === columns) {
        assertCollectionSize((rows + other.data.length) * (rows === 0 ? matrixColumns(other) : columns), MAX_ARRAY_OR_MATRIX_ELEMENTS, "Matrix", options);
        matrix.data.push(...other.data.map((row) => [...row]));
      }
      return matrix;
    }
    case "reshape": {
      if (options.strict) {
        const newRows = strictMatrixDimension(args[1], "row", method);
        const newColumns = strictMatrixDimension(args[2], "column", method);
        assertMatrixCapacity(newRows, newColumns, method);
        if (newRows * newColumns !== rows * columns) {
          throw new PineRuntimeError("matrix.reshape cannot change the matrix element count", method);
        }
        const values = matrix.data.flat();
        matrix.data = Array.from(
          { length: newRows },
          (_, row) => Array.from({ length: newColumns }, (_, column) => values[row * newColumns + column]!),
        );
        matrix.columnCount = newColumns;
        return null;
      }
      const newRows = Math.max(0, integer(args[1] ?? 0));
      const newColumns = Math.max(0, integer(args[2] ?? 0));
      assertCollectionSize(newRows * newColumns, MAX_ARRAY_OR_MATRIX_ELEMENTS, "Matrix", options);
      const values = matrix.data.flat();
      matrix.data = Array.from({ length: newRows }, (_, row) => Array.from({ length: newColumns }, (_, column) => values[row * newColumns + column] ?? Number.NaN));
      return null;
    }
    case "reverse": {
      if (options.strict) {
        if (matrix.columnCount !== columns) throw new PineRuntimeError("Matrix column count is inconsistent", method);
        for (const row of matrix.data) {
          for (let column = 0; column < columns; column += 1) {
            if (!(column in row)) throw new PineRuntimeError("Matrix rows must contain every column", method);
          }
        }
      }
      matrix.data.flat().reverse().forEach((value, index) => { matrix.data[Math.floor(index / columns)]![index % columns] = value; });
      return null;
    }
    case "swap_rows": {
      const first = options.strict ? matrixIndex(args[1], rows, "row", options, name) : integer(args[1] ?? 0);
      const second = options.strict ? matrixIndex(args[2], rows, "row", options, name) : integer(args[2] ?? 0);
      if (matrix.data[first] !== undefined && matrix.data[second] !== undefined) [matrix.data[first], matrix.data[second]] = [matrix.data[second]!, matrix.data[first]!];
      return null;
    }
    case "swap_columns": {
      const first = options.strict ? matrixIndex(args[1], columns, "column", options, name) : integer(args[1] ?? 0);
      const second = options.strict ? matrixIndex(args[2], columns, "column", options, name) : integer(args[2] ?? 0);
      for (const row of matrix.data) if (row[first] !== undefined && row[second] !== undefined) [row[first], row[second]] = [row[second]!, row[first]!];
      return null;
    }
    case "transpose": return pineMatrix(
      Array.from({ length: columns }, (_, column) => matrix.data.map((row) => row[column] ?? Number.NaN)),
      options.strict ? rows : undefined,
      matrix.elementKind,
    );
    case "submatrix": {
      const [fromRow, toRow] = matrixRange(args[1], args[2], rows, "row", false, options, name);
      const [fromColumn, toColumn] = matrixRange(args[3], args[4], columns, "column", false, options, name);
      if (options.strict) assertMatrixCapacity(toRow - fromRow, toColumn - fromColumn, method);
      return pineMatrix(
        matrix.data.slice(fromRow, toRow).map((row) => row.slice(fromColumn, toColumn)),
        options.strict ? toColumn - fromColumn : undefined,
        matrix.elementKind,
      );
    }
    case "avg": return options.strict ? strictMatrixAverage(matrix) : matrixAverage(matrix);
    case "min": {
      if (options.strict) return strictMatrixAggregate(name, matrix);
      const values = matrixNumbers(matrix);
      if (values.length === 0) return Number.NaN;
      return Math.min(...values);
    }
    case "max": {
      if (options.strict) return strictMatrixAggregate(name, matrix);
      const values = matrixNumbers(matrix);
      if (values.length === 0) return Number.NaN;
      return Math.max(...values);
    }
    case "median": return options.strict ? strictMatrixMedian(matrix) : arrayCall("median", [matrixNumbers(matrix)]);
    case "mode": return options.strict ? strictMatrixAggregate(name, matrix) : arrayMode(matrixNumbers(matrix));
    case "trace": return options.strict ? strictMatrixAggregate(name, matrix) : Array.from({ length: Math.min(rows, columns) }, (_, index) => number(matrix.data[index]![index])).reduce((sum, value) => sum + value, 0);
    case "sum":
    case "diff":
    case "mult":
    case "kron": {
      if (options.strict && isPineMatrix(args[1])) validateStrictMatrix(args[1], method);
      if (name === "sum") return matrixElementwise(matrix, args[1], (left, right) => left + right, options.strict ? args[2] : undefined, options.strict);
      if (name === "diff") return matrixElementwise(matrix, args[1], (left, right) => left - right, options.strict ? args[2] : undefined, options.strict);
      if (name === "mult") return matrixMultiply(matrix, args[1], options.strict ? args[2] : undefined, options.strict);
      if (options.strict && !isPineMatrix(args[1])) throw new PineRuntimeError("matrix.kron requires a matrix operand", method);
      const right = mutablePineMatrix(args[1]);
      return matrixKronecker(matrix, right, options.strict);
    }
    case "pow": return options.strict ? strictMatrixPower(matrix, args[1]) : matrixPower(matrix, integer(args[1] ?? 0));
    case "det": return options.strict ? strictMatrixLinearAlgebra(name, matrix) : matrixDeterminant(matrix);
    case "rank": return options.strict ? strictMatrixLinearAlgebra(name, matrix) : matrixRank(matrix);
    case "inv": return options.strict ? strictMatrixInverse(matrix) : matrixInverse(matrix);
    case "pinv": return options.strict ? strictMatrixPseudoInverse(matrix) : matrixPseudoInverse(matrix);
    case "eigenvalues": return matrixEigensystem(matrix).values;
    case "eigenvectors": {
      if (!options.strict) return pineMatrix(identityMatrix(rows));
      return numericMatrixResult(matrix, matrixEigensystem(matrix).vectors, rows, "matrix.eigenvectors");
    }
    case "sort": {
      if (options.strict) return strictMatrixSort(matrix, args[1], args[2], args[3]);
      const column = integer(args[1] ?? 0);
      const direction = sortDirection(args[2]);
      matrix.data.sort((left, right) => direction * (options.strict ? compareSortValues(left[column] ?? Number.NaN, right[column] ?? Number.NaN, args[3]) : compare(left[column] ?? Number.NaN, right[column] ?? Number.NaN)));
      return null;
    }
    case "is_square": return options.strict ? rows === columns : rows > 0 && rows === columns;
    case "is_zero": return options.strict ? strictMatrixPredicate(name, matrix) : matrix.data.every((row) => row.every((value) => number(value) === 0));
    case "is_binary": return options.strict ? strictMatrixPredicate(name, matrix) : rows > 0 && matrix.data.every((row) => row.every((value) => value === 0 || value === 1));
    case "is_diagonal": return options.strict ? strictMatrixPredicate(name, matrix) : matrixPredicate(matrix, (row, column, value) => row === column || number(value) === 0);
    case "is_antidiagonal": return options.strict ? strictMatrixPredicate(name, matrix) : matrixPredicate(matrix, (row, column, value) => row + column === rows - 1 || number(value) === 0);
    case "is_identity": return options.strict ? strictMatrixPredicate(name, matrix) : matrixPredicate(matrix, (row, column, value) => number(value) === (row === column ? 1 : 0));
    case "is_symmetric": return options.strict ? strictMatrixPredicate(name, matrix) : matrixPredicate(matrix, (row, column, value) => pineEquals(value, matrix.data[column]![row]));
    case "is_antisymmetric": return options.strict ? strictMatrixPredicate(name, matrix) : matrixPredicate(matrix, (row, column, value) => number(value) === -number(matrix.data[column]![row]));
    case "is_triangular": return options.strict ? strictMatrixPredicate(name, matrix) : matrixTriangular(matrix);
    case "is_stochastic": return options.strict ? strictMatrixPredicate(name, matrix) : rows > 0 && matrix.data.every((row) => row.every((value) => number(value) >= 0) && Math.abs(row.reduce<number>((sum, value) => sum + number(value), 0) - 1) <= 1e-10);
    default: throw new Error(`Unsupported matrix call matrix.${name}`);
  }
}

function sortDirection(
  value: PineValue | undefined,
  options: CollectionRuntimeOptions = {},
  method = "collection.sort",
): 1 | -1 {
  if (value === 0) return -1;
  const order = pineString(value ?? "ascending");
  if (order === "desc" || order.endsWith("descending")) return -1;
  if (!options.strict || value === undefined || value === 1 || order === "asc" || order.endsWith("ascending")) return 1;
  throw new PineRuntimeError("Sort order must be order.ascending or order.descending", method);
}

function pineMatrix(data: PineValue[][], columnCount = data[0]?.length ?? 0, elementKind?: MatrixElementKind): MutablePineMatrix {
  return elementKind === undefined
    ? { __pineMatrix: true, columnCount, data }
    : { __pineMatrix: true, columnCount, data, elementKind };
}

/** Local strict policy for numeric algorithms whose declared int overload computes fractions. */
function numericMatrixResult(source: MutablePineMatrix, data: PineValue[][], columns: number, method: string): MutablePineMatrix {
  const normalized = source.elementKind === "int"
    ? data.map((row) => row.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return value;
      const integer = Math.trunc(value);
      return Object.is(integer, -0) ? 0 : integer;
    }))
    : data;
  const result = pineMatrix(normalized, columns, source.elementKind);
  if (source.elementKind !== undefined) validateStrictMatrix(result, method);
  return result;
}

function cloneMatrix(matrix: MutablePineMatrix): MutablePineMatrix {
  return pineMatrix(matrix.data.map((row) => [...row]), matrixColumns(matrix), matrix.elementKind);
}

// Estimated dominant hot-loop work, not exhaustive instruction/cell-visit
// accounting or a wall-time promise. Independent of the 100,000-cell storage
// limit and checked before numerical allocation.
const MAX_MATRIX_LINEAR_WORK = 25_000_000;

function strictMatrixLinearAlgebra(name: "det" | "rank", matrix: MutablePineMatrix): PineValue {
  const method = `matrix.${name}`;
  assertNumericMatrix(matrix, name);
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (name === "det" && rows !== columns) {
    throw new PineRuntimeError(`In the 'matrix.det()' function. Matrix determinant is not available for non-square matrices (${String(rows)}x${String(columns)}).`, method);
  }
  const smaller = Math.min(rows, columns);
  const larger = Math.max(rows, columns);
  const work = name === "rank"
    ? 50 * smaller * Math.max(0, smaller - 1) / 2 * (2 * larger + smaller) + rows * columns
    : rows * rows * rows / 3 + rows * rows;
  if (work > MAX_MATRIX_LINEAR_WORK) {
    throw new PineRuntimeError(`${method} exceeds the ${String(MAX_MATRIX_LINEAR_WORK)}-work-unit linear algebra budget`, method);
  }
  if (matrix.data.some((row) => row.some(isNa))) return Number.NaN;
  if (name === "rank" && (rows === 0 || columns === 0)) return 0;
  try {
    return name === "det" ? determinant(matrix.data as number[][]) : decomposition(matrix.data as number[][]).rank;
  } catch (error) {
    if (error instanceof MatrixNumericalFailure) throw new PineRuntimeError(error.message, method);
    throw error;
  }
}

function strictMatrixConcat(left: MutablePineMatrix, right: MutablePineMatrix): MutablePineMatrix {
  const method = "matrix.concat";
  validateStrictMatrix(right, method);
  if (left.elementKind !== right.elementKind) throw new PineRuntimeError("matrix.concat requires matching element kinds", method);
  const leftRows = left.data.length;
  const rightRows = right.data.length;
  const leftColumns = matrixColumns(left);
  const rightColumns = matrixColumns(right);
  const leftUnshaped = leftRows === 0 && leftColumns === 0;
  const rightUnshaped = rightRows === 0 && rightColumns === 0;
  if (!leftUnshaped && !rightUnshaped && leftColumns !== rightColumns) {
    throw new PineRuntimeError("matrix.concat requires matching column counts", method);
  }
  const columns = leftUnshaped ? rightColumns : leftColumns;
  const rows = strictMatrixDimension(leftRows + rightRows, "row", method);
  assertMatrixCapacity(rows, columns, method);
  const appended = right.data.map((row) => [...row]);
  left.data = [...left.data, ...appended];
  left.columnCount = columns;
  return left;
}

function strictMatrixSort(matrix: MutablePineMatrix, columnValue: PineValue | undefined, orderValue: PineValue | undefined, field: PineValue | undefined): null {
  const method = "matrix.sort";
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  let direction: 1 | -1 = 1;
  if (orderValue === 0) direction = -1;
  else if (orderValue !== undefined && orderValue !== 1) {
    throw new PineRuntimeError("Sort order must be order.ascending or order.descending", method);
  }
  if (field !== undefined && !(typeof field === "string" || typeof field === "number" && Number.isInteger(field) && field >= 0)) {
    throw new PineRuntimeError("sort_field must be a nonnegative index or field name", method);
  }
  if (rows === 0 && columns === 0 && columnValue === undefined) return null;
  const column = matrixIndex(columnValue ?? 0, columns, "column", { strict: true }, "sort");
  if (rows === 0) return null;
  const selected = matrix.data.map((row, index) => ({ row, index, key: sortValue(row[column]!, field) }));
  const udtKeys = selected.some(({ row }) => {
    const value = row[column];
    return value !== null && typeof value === "object" && !Array.isArray(value);
  });
  if (udtKeys && selected.some(({ row }) => isNa(row[column]))) {
    throw new PineRuntimeError("Cannot sort a UDT matrix with a missing object", method);
  }
  let keyType: "number" | "string" | undefined;
  for (const { key } of selected) {
    if (isNa(key) || key === "") continue;
    if ((typeof key !== "number" || !Number.isFinite(key)) && typeof key !== "string") {
      throw new PineRuntimeError("Sorting requires finite numeric or string keys", method);
    }
    if (keyType !== undefined && keyType !== typeof key) throw new PineRuntimeError("Matrix sort keys must share one type", method);
    keyType = typeof key as "number" | "string";
  }
  const missing = (key: PineValue): boolean => isNa(key) || key === "";
  selected.sort((a, b) => {
    const aMissing = missing(a.key);
    const bMissing = missing(b.key);
    if (aMissing !== bMissing) return direction * (aMissing ? 1 : -1);
    if (aMissing) return a.index - b.index;
    const aKey = a.key as number | string;
    const bKey = b.key as number | string;
    let comparison = 0;
    if (aKey < bKey) comparison = -1;
    else if (aKey > bKey) comparison = 1;
    return comparison === 0 ? a.index - b.index : direction * comparison;
  });
  matrix.data = selected.map(({ row }) => row);
  return null;
}

function matrixConstructorKind(name: string, hidden: PineValue | undefined): MatrixElementKind {
  const suffix = name.startsWith("new_") ? name.slice(4) : undefined;
  let kind = hidden;
  if (kind === undefined && suffix !== undefined) {
    kind = suffix === "int" || suffix === "float" ? suffix : "other";
  }
  if (kind !== "int" && kind !== "float" && kind !== "other") {
    throw new PineRuntimeError("Strict matrix construction requires an explicit element kind", "matrix.new");
  }
  if (suffix === "int" || suffix === "float") {
    if (kind !== suffix) throw new PineRuntimeError("Matrix constructor element kind does not match its name", "matrix.new");
  }
  return kind;
}

function assertMatrixCell(kind: MatrixElementKind, value: PineValue, method: string): void {
  if (kind === "other" || isNa(value)) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (kind === "int" && !Number.isInteger(value))) {
    throw new PineRuntimeError(`matrix ${kind} elements must be finite ${kind} values or missing`, method);
  }
}

export function validateStrictMatrix(matrix: MutablePineMatrix, method: string): void {
  if (matrix.elementKind !== "int" && matrix.elementKind !== "float" && matrix.elementKind !== "other") {
    throw new PineRuntimeError("Matrix element kind is missing or invalid", method);
  }
  if (!Number.isSafeInteger(matrix.columnCount) || matrix.columnCount < 0) {
    throw new PineRuntimeError("Matrix column count is invalid", method);
  }
  assertRectangularMatrix(matrix, method.slice(7));
  if (matrix.data.length > 0 && matrix.columnCount !== matrix.data[0]?.length) {
    throw new PineRuntimeError("Matrix column count is inconsistent", method);
  }
  for (const row of matrix.data) {
    for (let column = 0; column < matrix.columnCount; column += 1) {
      if (!(column in row)) throw new PineRuntimeError("Matrix rows must contain every column", method);
      assertMatrixCell(matrix.elementKind, row[column]!, method);
    }
  }
}

export function isPineMatrix(value: PineValue | undefined): value is PineValue & MutablePineMatrix {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Readonly<Record<string, PineValue>>;
  return candidate.__pineMatrix === true && Array.isArray(candidate.data);
}

function mutablePineMatrix(value: PineValue | undefined): MutablePineMatrix {
  if (!isPineMatrix(value)) throw new Error("Expected a matrix");
  return value;
}

function matrixColumns(matrix: MutablePineMatrix): number {
  const populatedWidth = matrix.data[0]?.length;
  if (populatedWidth !== undefined) return populatedWidth;
  const stored = (matrix as unknown as { readonly columnCount?: unknown }).columnCount;
  return typeof stored === "number" && Number.isFinite(stored) && Number.isInteger(stored) && stored >= 0
    ? stored
    : 0;
}

function matrixValues(value: PineValue | undefined): PineValue[] {
  if (Array.isArray(value)) return [...(value as readonly PineValue[])];
  return value === undefined || value === null ? [] : [value];
}

function matrixNumbers(matrix: MutablePineMatrix): number[] {
  return matrix.data.flat().map(number).filter((value) => !Number.isNaN(value));
}

function strictMatrixAggregate(name: "min" | "max" | "mode" | "trace", matrix: MutablePineMatrix): number {
  assertNumericMatrix(matrix, name);
  let trace = 0;
  const values: number[] = [];
  for (const [rowIndex, row] of matrix.data.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      if (isNa(value)) {
        if (name === "trace" && rowIndex === columnIndex) trace = Number.NaN;
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new PineRuntimeError(`matrix.${name} requires finite int or float matrix elements`, `matrix.${name}`);
      }
      if (name === "trace") {
        if (rowIndex === columnIndex) trace += value;
      } else values.push(value);
    }
  }
  if (name === "trace") return trace;
  if (values.length === 0) return Number.NaN;
  if (name === "mode") return arrayMode(values) as number;
  const { minimum, maximum } = numericExtrema(values);
  return name === "min" ? minimum : maximum;
}

function matrixAverage(matrix: MutablePineMatrix): PineValue {
  const values = matrixNumbers(matrix);
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertNumericMatrix(matrix: MutablePineMatrix, method: string): void {
  if (matrix.elementKind !== "int" && matrix.elementKind !== "float") {
    throw new PineRuntimeError(`matrix.${method} requires an int or float matrix`, `matrix.${method}`);
  }
}

function strictMatrixScalar(value: PineValue | undefined, method: string): void {
  if (isNa(value)) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PineRuntimeError("Matrix arithmetic requires a finite numeric scalar or missing value", method);
  }
}

function strictArithmeticNumber(value: PineValue | undefined): number {
  return isNa(value) ? Number.NaN : number(value);
}

function arithmeticZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function strictMatrixAverage(matrix: MutablePineMatrix): number {
  assertNumericMatrix(matrix, "avg");
  const values = matrixNumbers(matrix);
  if (values.length === 0) return Number.NaN;
  if (matrix.elementKind === "int") {
    let sum = 0n;
    for (const value of values) sum += BigInt(value);
    return Number(sum / BigInt(values.length));
  }
  const average = compensatedSum(values.map((value) => value / values.length));
  return average;
}

function strictMatrixMedian(matrix: MutablePineMatrix): number {
  assertNumericMatrix(matrix, "median");
  const values = matrixNumbers(matrix).sort((left, right) => left - right);
  if (values.length === 0) return Number.NaN;
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? values[middle - 1]! / 2 + values[middle]! / 2 : values[middle]!;
  return matrix.elementKind === "int" ? Math.trunc(median) : median;
}

function matrixElementwise(matrix: MutablePineMatrix, operand: PineValue | undefined, operation: (left: number, right: number) => number, resultKind?: PineValue, strict = false): MutablePineMatrix {
  const other = isPineMatrix(operand) ? operand : undefined;
  if (strict) {
    assertNumericMatrix(matrix, "sum/diff");
    if (other) assertNumericMatrix(other, "sum/diff");
    else strictMatrixScalar(operand, "matrix.sum/diff");
  }
  if (other !== undefined && (matrix.data.length !== other.data.length || matrixColumns(matrix) !== matrixColumns(other))) {
    throw new PineRuntimeError("Matrix dimensions must match", "matrix.sum/diff");
  }
  let scalar = Number.NaN;
  if (other === undefined) scalar = strict ? strictArithmeticNumber(operand) : number(operand);
  const kind = matrixResultKind(matrix, other, resultKind);
  const result = pineMatrix(matrix.data.map((row, rowIndex) => row.map((value, columnIndex) => {
    const leftValue = strict ? strictArithmeticNumber(value) : number(value);
    let rightValue = scalar;
    if (other !== undefined) {
      const cell = other.data[rowIndex]?.[columnIndex];
      rightValue = strict ? strictArithmeticNumber(cell) : number(cell);
    }
    const output = operation(leftValue, rightValue);
    return strict ? arithmeticZero(output) : output;
  })), matrixColumns(matrix), kind);
  if (kind !== undefined) validateStrictMatrix(result, "matrix.sum/diff");
  return result;
}

function matrixMultiply(matrix: MutablePineMatrix, operand: PineValue | undefined, resultKind?: PineValue, strict = false): PineValue {
  if (strict) assertNumericMatrix(matrix, "mult");
  if (Array.isArray(operand)) {
    const vector = operand as readonly PineValue[];
    if (matrixColumns(matrix) !== vector.length) throw new PineRuntimeError("Matrix columns must match vector length", "matrix.mult");
    if (strict) for (const value of vector) strictMatrixScalar(value, "matrix.mult");
    const kind = strict ? matrixResultKind(matrix, undefined, resultKind) : undefined;
    const result = matrix.data.map((row) => row.reduce<number>((sum, value, index) => sum
      + (strict ? strictArithmeticNumber(value) : number(value)) * (strict ? strictArithmeticNumber(vector[index]) : number(vector[index])), 0));
    if (kind !== undefined) for (const value of result) assertMatrixCell(kind, value, "matrix.mult");
    return result;
  }
  if (!isPineMatrix(operand)) return matrixElementwise(matrix, operand, (left, right) => left * right, resultKind, strict);
  if (strict) {
    validateStrictMatrix(operand, "matrix.mult");
    assertNumericMatrix(operand, "mult");
  }
  const rightColumns = matrixColumns(operand);
  if (matrixColumns(matrix) !== operand.data.length) throw new PineRuntimeError("Matrix columns must match right matrix rows", "matrix.mult");
  if (matrix.elementKind !== undefined) assertMatrixCapacity(matrix.data.length, rightColumns, "matrix.mult");
  const kind = matrixResultKind(matrix, operand, resultKind);
  const result = pineMatrix(matrix.data.map((row) => Array.from({ length: rightColumns }, (_, column) => row.reduce<number>((sum, value, index) => sum
    + (strict ? strictArithmeticNumber(value) : number(value)) * (strict ? strictArithmeticNumber(operand.data[index]?.[column]) : number(operand.data[index]?.[column])), 0))), rightColumns, kind);
  if (kind !== undefined) validateStrictMatrix(result, "matrix.mult");
  return result;
}

function matrixResultKind(left: MutablePineMatrix, right: MutablePineMatrix | undefined, resolved: PineValue | undefined): MatrixElementKind | undefined {
  if (left.elementKind === undefined) return undefined;
  if (left.elementKind === "other") return "other";
  if (resolved === "int" || resolved === "float") {
    if (right !== undefined && (right.elementKind === "int" || right.elementKind === "float")
      && resolved !== (left.elementKind === "float" || right.elementKind === "float" ? "float" : "int")) {
      throw new PineRuntimeError("Matrix arithmetic result kind conflicts with operand kinds", "matrix.sum/diff/mult");
    }
    return resolved;
  }
  if (right !== undefined && (left.elementKind === "float" || right.elementKind === "float")) return "float";
  if (right !== undefined && left.elementKind === "int" && right.elementKind === "int") return "int";
  throw new PineRuntimeError("Matrix arithmetic requires a compiler-resolved result kind", "matrix.sum/diff/mult");
}

function matrixKronecker(left: MutablePineMatrix, right: MutablePineMatrix, strict = false): MutablePineMatrix {
  if (strict) {
    assertNumericMatrix(left, "kron");
    assertNumericMatrix(right, "kron");
  }
  const rightRows = right.data.length;
  const rightColumns = matrixColumns(right);
  const rows = left.data.length * rightRows;
  const columns = matrixColumns(left) * rightColumns;
  if (left.elementKind !== undefined) {
    strictMatrixDimension(rows, "row", "matrix.kron");
    strictMatrixDimension(columns, "column", "matrix.kron");
    assertMatrixCapacity(rows, columns, "matrix.kron");
  }
  const kind = kroneckerResultKind(left, right);
  const result = pineMatrix(Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const output = (strict ? strictArithmeticNumber(left.data[Math.floor(row / rightRows)]?.[Math.floor(column / rightColumns)]) : number(left.data[Math.floor(row / rightRows)]?.[Math.floor(column / rightColumns)]))
      * (strict ? strictArithmeticNumber(right.data[row % rightRows]?.[column % rightColumns]) : number(right.data[row % rightRows]?.[column % rightColumns]));
    return strict ? arithmeticZero(output) : output;
  })), columns, kind);
  if (kind !== undefined) validateStrictMatrix(result, "matrix.kron");
  return result;
}

function kroneckerResultKind(left: MutablePineMatrix, right: MutablePineMatrix): MatrixElementKind | undefined {
  if (left.elementKind === undefined) return undefined;
  if (left.elementKind === "other" || right.elementKind === "other") return "other";
  if (left.elementKind === "float" || right.elementKind === "float") return "float";
  return "int";
}

function matrixPower(matrix: MutablePineMatrix, exponent: number): MutablePineMatrix {
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix) || exponent < 0) {
    throw new PineRuntimeError("matrix.pow requires a square matrix and nonnegative power", "matrix.pow");
  }
  let result = pineMatrix(Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0)), size, matrix.elementKind);
  let base = cloneMatrix(matrix);
  for (let power = exponent; power > 0; power = Math.floor(power / 2)) {
    if (power % 2 === 1) result = mutablePineMatrix(matrixMultiply(result, base));
    if (power > 1) base = mutablePineMatrix(matrixMultiply(base, base));
  }
  return result;
}

function strictMatrixPower(matrix: MutablePineMatrix, exponentValue: PineValue | undefined): MutablePineMatrix {
  const method = "matrix.pow";
  const meter = new MatrixWorkMeter(method);
  assertNumericMatrix(matrix, "pow");
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix)) throw new PineRuntimeError("matrix.pow requires a square matrix", method);
  if (typeof exponentValue !== "number" || !Number.isFinite(exponentValue) || !Number.isInteger(exponentValue)) {
    throw new PineRuntimeError("matrix.pow requires a finite integer power", method);
  }
  if (matrix.data.some((row) => row.some(isNa))) {
    return numericMatrixResult(matrix, matrix.data.map((row) => row.map(() => Number.NaN)), size, method);
  }
  const exponent = BigInt(exponentValue);
  const fast = structuralPower(matrix.data as number[][], matrix.elementKind as "int" | "float", exponent, meter);
  if (fast !== undefined) {
    try { return numericMatrixResult(matrix, fast.data, size, method); }
    finally { fast.release(); }
  }
  if (matrix.elementKind === "int") {
    return numericMatrixResult(matrix, exactIntegerPower(matrix.data as number[][], exponent, meter), size, method);
  }
  let base = matrix.data as number[][];
  let power = exponent;
  if (exponent < 0n) {
    const inverse = strictFloatMatrixInverse(matrix, meter);
    if (inverse.data.some((row) => row.some(isNa))) return inverse;
    base = inverse.data as number[][];
    power = -exponent;
  }
  const release = meter.reserve(3 * size * size * 16);
  try {
    let result = identityMatrix(size);
    let factor = base.map((row) => [...row]);
    while (power > 0n) {
      if (power % 2n === 1n) result = strictFloatMatrixProduct(result, factor, meter);
      power /= 2n;
      if (power > 0n) factor = strictFloatMatrixProduct(factor, factor, meter);
    }
    return numericMatrixResult(matrix, result, size, method);
  } finally {
    release();
  }
}

function strictFloatMatrixProduct(left: readonly (readonly number[])[], right: readonly (readonly number[])[], meter: MatrixWorkMeter): number[][] {
  const size = left.length;
  meter.floating(size ** 3);
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => {
    let value = 0;
    for (let index = 0; index < size; index += 1) value += left[row]![index]! * right[index]![column]!;
    if (!Number.isFinite(value)) throw new PineRuntimeError("matrix.pow overflowed finite range", "matrix.pow");
    return value;
  }));
}

function singularMatrixInverseError(): PineRuntimeError {
  return new PineRuntimeError(
    "In the 'matrix.inv()' function. Cannot inverse a singular matrix (matrix determinant is zero).",
    "matrix.inv",
  );
}

function strictMatrixInverse(matrix: MutablePineMatrix): MutablePineMatrix {
  const method = "matrix.inv";
  const meter = new MatrixWorkMeter(method);
  assertNumericMatrix(matrix, "inv");
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix)) throw new PineRuntimeError("matrix.inv requires a square matrix", method);
  if (size === 0) return numericMatrixResult(matrix, [], 0, method);
  if (matrix.data.some((row) => row.some(isNa))) throw singularMatrixInverseError();
  const input = matrix.data as number[][];
  const fast = structuralInverse(input, size, matrix.elementKind as "int" | "float", false, meter);
  if (fast !== undefined) {
    try {
      if (fast.singular) throw singularMatrixInverseError();
      return numericMatrixResult(matrix, fast.data, size, method);
    } finally {
      fast.release();
    }
  }
  if (matrix.elementKind === "float") {
    const inverse = invertFloatMatrix(input, undefined, meter);
    if (inverse === null) throw singularMatrixInverseError();
    return numericMatrixResult(matrix, inverse, size, method);
  }
  const inverse = exactIntegerInverse(input, meter);
  if (inverse === null) throw singularMatrixInverseError();
  return exactIntegerMatrixResult(matrix, inverse, size, method, meter);
}

function strictMatrixPseudoInverse(matrix: MutablePineMatrix): MutablePineMatrix {
  const method = "matrix.pinv";
  const meter = new MatrixWorkMeter(method);
  assertNumericMatrix(matrix, "pinv");
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (rows === 0 || columns === 0) {
    return numericMatrixResult(matrix, Array.from({ length: columns }, () => Array<number>(rows)), rows, method);
  }
  if (matrix.data.some((row) => row.some(isNa))) {
    return numericMatrixResult(matrix, Array.from({ length: columns }, () => Array<number>(rows).fill(Number.NaN)), rows, method);
  }
  const fast = structuralInverse(matrix.data as number[][], columns, matrix.elementKind as "int" | "float", true, meter);
  if (fast !== undefined) {
    try { return numericMatrixResult(matrix, fast.data, rows, method); }
    finally { fast.release(); }
  }
  if (matrix.elementKind === "float") return strictFloatMatrixPseudoInverse(matrix, meter);
  if (rows === columns) {
    const inverse = exactIntegerInverse(matrix.data as number[][], meter);
    if (inverse !== null) return exactIntegerMatrixResult(matrix, inverse, rows, method, meter);
  }
  return numericMatrixResult(matrix, exactIntegerPseudoInverse(matrix.data as number[][], columns, meter), rows, method);
}

function exactIntegerMatrixResult(
  source: MutablePineMatrix, exact: ExactMatrixInverse, columns: number, method: string, meter: MatrixWorkMeter,
): MutablePineMatrix {
  const cells = exact.numerator.length * columns;
  try {
    const releaseResult = meter.reserve(cells * 16);
    try {
      const denominatorLimbs = integerLimbCount(exact.denominator);
      const result = exact.numerator.map((row) => row.map((value) => {
        meter.limbs(integerLimbCount(value) * denominatorLimbs);
        return Number(value / exact.denominator);
      }));
      return numericMatrixResult(source, result, columns, method);
    } finally {
      releaseResult();
    }
  } finally {
    exact.release();
  }
}

function matrixInverse(matrix: MutablePineMatrix): MutablePineMatrix {
  const size = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (size !== columns) throw new PineRuntimeError("matrix.inv requires a square matrix", "matrix.inv");
  if (size === 0) return numericMatrixResult(matrix, [], 0, "matrix.inv");
  const augmented = matrix.data.map((row, rowIndex) => [
    ...row.map(number),
    ...Array.from({ length: size }, (_, column) => rowIndex === column ? 1 : 0),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    let pivotMagnitude = Math.abs(augmented[column]![column]!);
    for (let row = column + 1; row < size; row += 1) {
      const magnitude = Math.abs(augmented[row]![column]!);
      if (magnitude > pivotMagnitude) { pivotMagnitude = magnitude; pivotRow = row; }
    }
    if (pivotMagnitude < 1e-14) return numericMatrixResult(matrix, matrix.data.map((row) => row.map(() => Number.NaN)), size, "matrix.inv");
    if (pivotRow !== column) [augmented[pivotRow], augmented[column]] = [augmented[column]!, augmented[pivotRow]!];
    const pivot = augmented[column]![column]!;
    for (let index = column; index < size * 2; index += 1) augmented[column]![index] = augmented[column]![index]! / pivot;
    for (let row = 0; row < size; row += 1) if (row !== column) {
      const factor = augmented[row]![column]!;
      if (factor === 0) continue;
      for (let index = column; index < size * 2; index += 1) augmented[row]![index] = augmented[row]![index]! - factor * augmented[column]![index]!;
    }
  }
  return numericMatrixResult(matrix, augmented.map((row) => row.slice(size)), size, "matrix.inv");
}

function strictFloatMatrixInverse(matrix: MutablePineMatrix, meter?: MatrixWorkMeter): MutablePineMatrix {
  const method = "matrix.inv";
  assertNumericMatrix(matrix, "inv");
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix)) throw new PineRuntimeError("matrix.inv requires a square matrix", method);
  if (size === 0) return numericMatrixResult(matrix, [], 0, method);
  if (matrix.data.some((row) => row.some(isNa))) {
    return numericMatrixResult(matrix, matrix.data.map((row) => row.map(() => Number.NaN)), size, method);
  }
  const inverse = invertFloatMatrix(matrix.data as number[][], undefined, meter);
  return numericMatrixResult(matrix, inverse ?? matrix.data.map((row) => row.map(() => Number.NaN)), size, method);
}

function strictFloatMatrixPseudoInverse(matrix: MutablePineMatrix, meter?: MatrixWorkMeter): MutablePineMatrix {
  const method = "matrix.pinv";
  assertNumericMatrix(matrix, "pinv");
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (rows === 0 || columns === 0) {
    return numericMatrixResult(matrix, Array.from({ length: columns }, () => Array<number>(rows)), rows, method);
  }
  if (matrix.data.some((row) => row.some(isNa))) {
    return numericMatrixResult(matrix, Array.from({ length: columns }, () => Array<number>(rows).fill(Number.NaN)), rows, method);
  }
  try {
    const result = decomposition(matrix.data as number[][], true, undefined, meter).pseudoinverse!;
    return numericMatrixResult(matrix, result, rows, method);
  } catch (error) {
    if (error instanceof MatrixNumericalFailure) throw new PineRuntimeError(error.message, method);
    throw error;
  }
}

function matrixPseudoInverse(matrix: MutablePineMatrix): MutablePineMatrix {
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  if (rows === 0) return numericMatrixResult(matrix, [], 0, "matrix.pinv");
  // Work in float space, then apply the declared int overload at the final
  // boundary. Truncating an intermediate inverse changes the pseudoinverse.
  const working = matrix.elementKind === "int"
    ? pineMatrix(matrix.data.map((row) => [...row]), columns, "float") : matrix;
  if (rows === columns) {
    const inverse = matrixInverse(working);
    return numericMatrixResult(matrix, inverse.data, matrixColumns(inverse), "matrix.pinv");
  }
  const transpose = mutablePineMatrix(matrixCall("transpose", [working]));
  if (rows > columns) {
    const gram = mutablePineMatrix(matrixMultiply(transpose, working));
    const result = mutablePineMatrix(matrixMultiply(matrixInverse(gram), transpose));
    return numericMatrixResult(matrix, result.data, matrixColumns(result), "matrix.pinv");
  }
  const gram = mutablePineMatrix(matrixMultiply(working, transpose));
  const result = mutablePineMatrix(matrixMultiply(transpose, matrixInverse(gram)));
  return numericMatrixResult(matrix, result.data, matrixColumns(result), "matrix.pinv");
}

interface MatrixEigensystem {
  readonly values: number[];
  readonly vectors: number[][];
}

const MAX_EIGENSYSTEM_SIZE = 16;
const EIGENSYSTEM_TOLERANCE = 1e-12;

function matrixEigensystem(matrix: MutablePineMatrix): MatrixEigensystem {
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix)) throw new PineRuntimeError("Matrix must be square", "matrix.eigenvalues/eigenvectors");
  if (size > MAX_EIGENSYSTEM_SIZE) {
    throw new PineRuntimeError(`Matrix eigensystem is limited to ${String(MAX_EIGENSYSTEM_SIZE)} rows`, "matrix.eigenvalues/eigenvectors");
  }
  if (size === 0) return { values: [], vectors: [] };
  const values = matrix.data.map((row) => row.map(number));
  if (values.flat().some((value) => !Number.isFinite(value))) {
    throw new PineRuntimeError("Matrix eigensystem requires finite numeric elements", "matrix.eigenvalues/eigenvectors");
  }
  if (size === 1) return { values: [values[0]![0]!], vectors: [[1]] };
  if (isSymmetricMatrix(values)) return symmetricEigensystem(values);
  if (size !== 2) {
    throw new PineRuntimeError("Lumen Charts eigensystems require a symmetric matrix when size exceeds 2", "matrix.eigenvalues/eigenvectors");
  }
  return twoByTwoEigensystem(values);
}

function twoByTwoEigensystem(matrix: readonly (readonly number[])[]): MatrixEigensystem {
  const topLeft = matrix[0]![0]!;
  const topRight = matrix[0]![1]!;
  const bottomLeft = matrix[1]![0]!;
  const bottomRight = matrix[1]![1]!;
  const trace = topLeft + bottomRight;
  const determinant = topLeft * bottomRight - topRight * bottomLeft;
  const discriminant = trace * trace - 4 * determinant;
  if (discriminant < -EIGENSYSTEM_TOLERANCE) {
    throw new PineRuntimeError("Matrix has complex eigenvalues outside the Lumen Charts real eigensystem profile", "matrix.eigenvalues/eigenvectors");
  }
  const root = Math.sqrt(Math.max(0, discriminant));
  const values = [(trace + root) / 2, (trace - root) / 2];
  const columns = values.map((value) => twoByTwoEigenvector(topLeft, topRight, bottomLeft, bottomRight, value));
  return { values, vectors: columnsToRows(columns) };
}

function twoByTwoEigenvector(topLeft: number, topRight: number, bottomLeft: number, bottomRight: number, value: number): number[] {
  let vector = Math.abs(topRight) + Math.abs(value - topLeft) >= Math.abs(bottomLeft) + Math.abs(value - bottomRight)
    ? [topRight, value - topLeft]
    : [value - bottomRight, bottomLeft];
  if (Math.hypot(...vector) <= EIGENSYSTEM_TOLERANCE) vector = [1, 0];
  return normalizeVector(vector);
}

function symmetricEigensystem(source: readonly (readonly number[])[]): MatrixEigensystem {
  const size = source.length;
  const matrix = source.map((row) => [...row]);
  const vectors = identityMatrix(size);
  const scale = Math.max(1, ...matrix.flat().map(Math.abs));
  const tolerance = EIGENSYSTEM_TOLERANCE * scale;
  const iterations = 64 * size * size;
  let converged = false;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const pivot = largestOffDiagonal(matrix);
    if (pivot.magnitude <= tolerance) {
      converged = true;
      break;
    }
    applyJacobiRotation(matrix, vectors, pivot.row, pivot.column);
  }
  if (!converged && largestOffDiagonal(matrix).magnitude > tolerance) {
    throw new PineRuntimeError("Matrix eigensystem did not converge within the Lumen Charts iteration budget", "matrix.eigenvalues/eigenvectors");
  }
  const order = Array.from({ length: size }, (_, index) => index).sort((left, right) => matrix[right]![right]! - matrix[left]![left]!);
  return {
    values: order.map((index) => matrix[index]![index]!),
    vectors: vectors.map((row) => order.map((index) => row[index]!)),
  };
}

function isSymmetricMatrix(matrix: readonly (readonly number[])[]): boolean {
  const scale = Math.max(1, ...matrix.flat().map(Math.abs));
  for (let row = 0; row < matrix.length; row += 1) {
    for (let column = row + 1; column < matrix.length; column += 1) {
      if (Math.abs(matrix[row]![column]! - matrix[column]![row]!) > EIGENSYSTEM_TOLERANCE * scale) return false;
    }
  }
  return true;
}

function identityMatrix(size: number): number[][] {
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? 1 : 0));
}

function largestOffDiagonal(matrix: readonly (readonly number[])[]): { readonly row: number; readonly column: number; readonly magnitude: number } {
  let row = 0;
  let column = 1;
  let magnitude = 0;
  for (let candidateRow = 0; candidateRow < matrix.length; candidateRow += 1) {
    for (let candidateColumn = candidateRow + 1; candidateColumn < matrix.length; candidateColumn += 1) {
      const candidate = Math.abs(matrix[candidateRow]![candidateColumn]!);
      if (candidate > magnitude) {
        row = candidateRow;
        column = candidateColumn;
        magnitude = candidate;
      }
    }
  }
  return { row, column, magnitude };
}

function applyJacobiRotation(matrix: number[][], vectors: number[][], row: number, column: number): void {
  const diagonalRow = matrix[row]![row]!;
  const diagonalColumn = matrix[column]![column]!;
  const offDiagonal = matrix[row]![column]!;
  const angle = 0.5 * Math.atan2(2 * offDiagonal, diagonalColumn - diagonalRow);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  for (let index = 0; index < matrix.length; index += 1) {
    if (index === row || index === column) continue;
    const rowValue = matrix[index]![row]!;
    const columnValue = matrix[index]![column]!;
    matrix[index]![row] = cosine * rowValue - sine * columnValue;
    matrix[row]![index] = matrix[index]![row]!;
    matrix[index]![column] = sine * rowValue + cosine * columnValue;
    matrix[column]![index] = matrix[index]![column]!;
  }
  matrix[row]![row] = cosine ** 2 * diagonalRow - 2 * sine * cosine * offDiagonal + sine ** 2 * diagonalColumn;
  matrix[column]![column] = sine ** 2 * diagonalRow + 2 * sine * cosine * offDiagonal + cosine ** 2 * diagonalColumn;
  matrix[row]![column] = 0;
  matrix[column]![row] = 0;
  for (let index = 0; index < vectors.length; index += 1) {
    const rowValue = vectors[index]![row]!;
    const columnValue = vectors[index]![column]!;
    vectors[index]![row] = cosine * rowValue - sine * columnValue;
    vectors[index]![column] = sine * rowValue + cosine * columnValue;
  }
}

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.hypot(...vector);
  if (magnitude <= EIGENSYSTEM_TOLERANCE) return vector.map(() => 0);
  const normalized = vector.map((value) => value / magnitude);
  const leading = normalized.find((value) => Math.abs(value) > EIGENSYSTEM_TOLERANCE);
  return leading !== undefined && leading < 0 ? normalized.map((value) => -value) : normalized;
}

function columnsToRows(columns: readonly (readonly number[])[]): number[][] {
  return Array.from({ length: columns[0]?.length ?? 0 }, (_, row) => columns.map((column) => column[row]!));
}

function matrixDeterminant(matrix: MutablePineMatrix): PineValue {
  const size = matrix.data.length;
  if (size !== matrixColumns(matrix)) throw new PineRuntimeError("matrix.det requires a square matrix", "matrix.det");
  if (size === 0) return 0;
  const values = matrix.data.map((row) => row.map(number));
  let result = 1;
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    while (pivot < size && values[pivot]![column] === 0) pivot += 1;
    if (pivot === size) return 0;
    if (pivot !== column) { [values[pivot], values[column]] = [values[column]!, values[pivot]!]; result *= -1; }
    const diagonal = values[column]![column]!;
    result *= diagonal;
    for (let row = column + 1; row < size; row += 1) {
      const factor = values[row]![column]! / diagonal;
      for (let index = column; index < size; index += 1) values[row]![index] = values[row]![index]! - factor * values[column]![index]!;
    }
  }
  return result;
}

function matrixRank(matrix: MutablePineMatrix): number {
  const values = matrix.data.map((row) => row.map(number));
  const columns = matrixColumns(matrix);
  let rank = 0;
  for (let column = 0; column < columns && rank < values.length; column += 1) {
    let pivot = rank;
    while (pivot < values.length && Math.abs(values[pivot]![column]!) < 1e-10) pivot += 1;
    if (pivot === values.length) continue;
    [values[pivot], values[rank]] = [values[rank]!, values[pivot]!];
    const diagonal = values[rank]![column]!;
    for (let index = column; index < columns; index += 1) values[rank]![index] = values[rank]![index]! / diagonal;
    for (let row = 0; row < values.length; row += 1) if (row !== rank) {
      const factor = values[row]![column]!;
      for (let index = column; index < columns; index += 1) values[row]![index] = values[row]![index]! - factor * values[rank]![index]!;
    }
    rank += 1;
  }
  return rank;
}

function matrixPredicate(matrix: MutablePineMatrix, predicate: (row: number, column: number, value: PineValue) => boolean): boolean {
  const rows = matrix.data.length;
  if (rows === 0 || rows !== matrixColumns(matrix)) return false;
  return matrix.data.every((row, rowIndex) => row.every((value, columnIndex) => predicate(rowIndex, columnIndex, value)));
}

function matrixTriangular(matrix: MutablePineMatrix): boolean {
  return matrixPredicate(matrix, () => true) && (matrix.data.every((row, rowIndex) => row.every((value, columnIndex) => rowIndex <= columnIndex || number(value) === 0)) || matrix.data.every((row, rowIndex) => row.every((value, columnIndex) => rowIndex >= columnIndex || number(value) === 0)));
}

/** Exact numeric inspection; only stochastic row sums admit an absolute tolerance. */
function strictMatrixPredicate(name: string, matrix: MutablePineMatrix): boolean {
  const rows = matrix.data.length;
  const columns = matrixColumns(matrix);
  const squareOnly = !["is_binary", "is_stochastic", "is_zero"].includes(name);
  if (squareOnly && (rows === 0 || rows !== columns)) return false;
  if (name === "is_binary" || name === "is_stochastic") {
    if (rows === 0 || columns === 0) return false;
  }
  let upperTriangular = true;
  let lowerTriangular = true;
  for (let row = 0; row < rows; row += 1) {
    let rowSum = 0;
    for (let column = 0; column < columns; column += 1) {
      const value = matrix.data[row]![column];
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (name === "is_zero" && value !== 0) return false;
      if (name === "is_binary" && value !== 0 && value !== 1) return false;
      if (name === "is_diagonal" && row !== column && value !== 0) return false;
      if (name === "is_antidiagonal" && row + column !== rows - 1 && value !== 0) return false;
      if (name === "is_identity" && value !== (row === column ? 1 : 0)) return false;
      if (name === "is_symmetric" && value !== matrix.data[column]![row]) return false;
      if (name === "is_antisymmetric" && value !== -(matrix.data[column]![row] as number)) return false;
      if (name === "is_triangular") {
        if (row > column && value !== 0) upperTriangular = false;
        if (row < column && value !== 0) lowerTriangular = false;
      }
      if (name === "is_stochastic") {
        if (value < 0) return false;
        rowSum += value;
      }
    }
    if (name === "is_stochastic" && (!Number.isFinite(rowSum) || Math.abs(rowSum - 1) > 1e-10)) return false;
  }
  return name !== "is_triangular" || upperTriangular || lowerTriangular;
}

/** Locale-independent sorting, including the selected field of a UDT reference. */
function compareSortValues(left: PineValue, right: PineValue, field: PineValue | undefined): number {
  const a = sortValue(left, field);
  const b = sortValue(right, field);
  if (isNa(a)) return isNa(b) ? 0 : 1;
  if (isNa(b)) return -1;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return number(a) - number(b);
}

function assertSortableArray(
  array: readonly PineValue[],
  field: PineValue | undefined,
  options: CollectionRuntimeOptions,
): void {
  if (!options.strict) return;
  for (const value of array) {
    if (isNa(value) || typeof value === "number" || typeof value === "string") continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      compareSortValues(value, value, field);
      continue;
    }
    throw new PineRuntimeError("Sorting requires int, float, string, or UDT elements", "array.sort");
  }
}

function sortValue(value: PineValue, field: PineValue | undefined): PineValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, PineValue>>;
  if (typeof record.__pineType !== "string") throw new PineRuntimeError("Sorting requires numbers, strings, or a sortable UDT field");
  const selector = field ?? 0;
  const keys = Object.keys(record).filter((key) => key !== "__pineType");
  const key = typeof selector === "string" ? selector : typeof selector === "number" && Number.isInteger(selector) ? keys[selector] : undefined;
  if (key === undefined || key === "__pineType" || !Object.hasOwn(record, key)) throw new PineRuntimeError("Unknown sort_field");
  const selected = record[key]!;
  if (!isNa(selected) && typeof selected !== "number" && typeof selected !== "string") throw new PineRuntimeError("sort_field must select an int, float, or string field");
  return selected;
}
