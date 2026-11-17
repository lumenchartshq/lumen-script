import type { PineValue } from "../contracts/index.js";
import { dateParts, isoWeek, isValidTimezone, timezoneOffsetMinutes } from "./time.js";
import { isNa, number, pineString } from "./values.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { isPineMatrix } from "./collections.js";

export function pineRound(value: number, precision = 0): number {
  const multiplier = 10 ** precision;
  const scaled = value * multiplier;
  return Math.sign(scaled) * Math.round(Math.abs(scaled)) / multiplier;
}

/**
 * Production math.round(x, precision): rounds the decimal value half away
 * from zero, so math.round(1.005, 2) is 1.01 rather than the binary 1.00.
 */
export function pineDecimalRound(value: number, precision: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(precision)) return pineRound(value, precision);
  const decimal = Math.abs(value).toExponential();
  const separator = decimal.indexOf("e");
  const digits = decimal.slice(0, separator).replace(".", "");
  const kept = Number(decimal.slice(separator + 1)) + precision + 1;
  if (kept >= digits.length) return value;
  if (kept < 0) return Math.sign(value) * 0;
  const prefix = BigInt(digits.slice(0, kept) || "0");
  const rounded = digits.charAt(kept) >= "5" ? prefix + 1n : prefix;
  return Math.sign(value) * Number(`${String(rounded)}e${String(-precision)}`);
}

export function mathCall(name: string, args: readonly PineValue[], strict = false): PineValue {
  const values = args.map(number);
  switch (name) {
    case "abs": return Math.abs(values[0] ?? Number.NaN);
    case "acos": return Math.acos(values[0] ?? Number.NaN);
    case "asin": return Math.asin(values[0] ?? Number.NaN);
    case "atan": return Math.atan(values[0] ?? Number.NaN);
    case "avg": return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "ceil": return Math.ceil(values[0] ?? Number.NaN);
    case "cos": return Math.cos(values[0] ?? Number.NaN);
    case "exp": return Math.exp(values[0] ?? Number.NaN);
    case "floor": return Math.floor(values[0] ?? Number.NaN);
    case "log": return Math.log(values[0] ?? Number.NaN);
    case "log10": return Math.log10(values[0] ?? Number.NaN);
    case "ln": return Math.log(values[0] ?? Number.NaN);
    case "max": return Math.max(...values);
    case "min": return Math.min(...values);
    case "pow": return Math.pow(values[0] ?? Number.NaN, values[1] ?? Number.NaN);
    case "round": {
      // Strict argument binding keeps omitted optional slots as `undefined`.
      // Do not turn an omitted precision into NaN before applying Pine's
      // integer-rounding overload.
      const precision = args[1] === undefined ? undefined : number(args[1]);
      if (strict && precision !== undefined) return pineDecimalRound(values[0] ?? Number.NaN, precision);
      return pineRound(values[0] ?? Number.NaN, precision);
    }
    case "sum": return values.reduce((sum, value) => sum + value, 0);
    case "sign": return Math.sign(values[0] ?? Number.NaN);
    case "sin": return Math.sin(values[0] ?? Number.NaN);
    case "sqrt": return Math.sqrt(values[0] ?? Number.NaN);
    case "tan": return Math.tan(values[0] ?? Number.NaN);
    case "todegrees": return (values[0] ?? Number.NaN) * 180 / Math.PI;
    case "toradians": return (values[0] ?? Number.NaN) * Math.PI / 180;
    default: throw new Error(`Unsupported math call math.${name}`);
  }
}

export function colorNew(value: PineValue | undefined, transparency: PineValue | undefined, strict = false): PineValue {
  if (strict) {
    const color = parseStrictColor(value);
    const alpha = transparencyByte(transparency);
    if (color === undefined || alpha === undefined) return Number.NaN;
    return formatStrictColor([color[0], color[1], color[2], alpha]);
  }
  if (typeof value !== "string") return value ?? Number.NaN;
  if (transparency === undefined || Number.isNaN(number(transparency))) return value;
  const alpha = Math.round(255 / 100 * (100 - number(transparency))).toString(16).padStart(2, "0").toUpperCase();
  if (value.startsWith("#")) return `#${value.slice(1, 7)}${alpha}`;
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value);
  if (match !== null) {
    const rgb = match.slice(1, 4).map((component) => Number(component).toString(16).padStart(2, "0")).join("");
    return `#${rgb}${alpha}`;
  }
  return `rgba(${value}, ${(100 - number(transparency)) / 100})`;
}

export function colorRgb(args: readonly PineValue[], strict = false): PineValue {
  if (strict) {
    const channels = args.slice(0, 3).map(colorChannelByte);
    const alpha = args[3] === undefined ? 255 : transparencyByte(args[3]);
    if (channels.some((channel) => channel === undefined) || alpha === undefined) return Number.NaN;
    return formatStrictColor([channels[0]!, channels[1]!, channels[2]!, alpha]);
  }
  const [red, green, blue] = args.map(number);
  if (args[3] === undefined || Number.isNaN(number(args[3]))) return `rgb(${red}, ${green}, ${blue})`;
  return `rgba(${red}, ${green}, ${blue}, ${(100 - number(args[3])) / 100})`;
}

export function colorGradient(args: readonly PineValue[], strict = false): PineValue {
  if (strict) return strictColorGradient(args);
  const [value, bottom, top] = args.slice(0, 3).map(number);
  const bottomColor = parseColor(args[3]);
  const topColor = parseColor(args[4]);
  if ([value, bottom, top].some((entry) => entry === undefined || Number.isNaN(entry)) || bottomColor === undefined || topColor === undefined) return Number.NaN;
  const position = top === bottom ? 0 : Math.max(0, Math.min(1, (value! - bottom!) / (top! - bottom!)));
  const channels = bottomColor.map((channel, index) => channel + (topColor[index]! - channel) * position) as [number, number, number, number];
  const bytes = channels.slice(0, 3).map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, "0"));
  if (channels[3] >= 1) return `#${bytes.join("")}`.toUpperCase();
  const alpha = Math.round(Math.max(0, Math.min(255, channels[3] * 255))).toString(16).padStart(2, "0");
  return `#${bytes.join("")}${alpha}`.toUpperCase();
}

export function colorComponent(component: string, value: PineValue | undefined, strict = false): PineValue {
  if (strict) {
    const color = parseStrictColor(value);
    if (color === undefined) return Number.NaN;
    if (component === "r") return color[0];
    if (component === "g") return color[1];
    if (component === "b") return color[2];
    // Transparency is a whole number; the 8-bit alpha round-trips to it.
    return Math.round((255 - color[3]) * 100 / 255);
  }
  const color = parseColor(value);
  if (color === undefined) return Number.NaN;
  if (component === "r") return color[0];
  if (component === "g") return color[1];
  if (component === "b") return color[2];
  return Math.round(100 - color[3] * 100);
}

type ColorBytes = readonly [red: number, green: number, blue: number, alpha: number];

const TRANSPARENT_BLACK = "#00000000";

function strictColorGradient(args: readonly PineValue[]): PineValue {
  const values = args.slice(0, 3).map(finiteNumber);
  // The reference platform returns a fully transparent black, not na, for an na value.
  if (isNa(args[0]) && values[1] !== undefined && values[2] !== undefined) return TRANSPARENT_BLACK;
  if (values.some((value) => value === undefined)) return Number.NaN;
  const value = values[0]!;
  const bottom = values[1]!;
  const top = values[2]!;
  const parsedBottom = parseStrictColor(args[3]);
  const parsedTop = parseStrictColor(args[4]);
  if (parsedBottom === undefined && !isNa(args[3])) return Number.NaN;
  if (parsedTop === undefined && !isNa(args[4])) return Number.NaN;
  if (parsedBottom === undefined && parsedTop === undefined) return Number.NaN;
  const bottomColor = parsedBottom ?? [parsedTop![0], parsedTop![1], parsedTop![2], 0] as const;
  const topColor = parsedTop ?? [parsedBottom![0], parsedBottom![1], parsedBottom![2], 0] as const;
  const position = top === bottom ? 0 : Math.max(0, Math.min(1, (value - bottom) / (top - bottom)));
  return formatStrictColor(bottomColor.map((channel, index) => Math.round(channel + (topColor[index]! - channel) * position)) as unknown as ColorBytes);
}

function parseStrictColor(value: PineValue | undefined): ColorBytes | undefined {
  if (typeof value !== "string") return undefined;
  const hex = /^#([\dA-Fa-f]{6})([\dA-Fa-f]{2})?$/u.exec(value);
  if (hex !== null) return [
    Number.parseInt(hex[1]!.slice(0, 2), 16),
    Number.parseInt(hex[1]!.slice(2, 4), 16),
    Number.parseInt(hex[1]!.slice(4, 6), 16),
    hex[2] === undefined ? 255 : Number.parseInt(hex[2], 16),
  ];
  const functional = /^rgba?\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)(?:\s*,\s*(-?[\d.]+))?\s*\)$/u.exec(value);
  if (functional === null) return undefined;
  const channels = functional.slice(1, 4).map((entry) => colorChannelByte(Number(entry)));
  const alphaValue = functional[4] === undefined ? 255 : Math.round(Math.max(0, Math.min(1, Number(functional[4]))) * 255);
  if (channels.some((channel) => channel === undefined) || !Number.isFinite(alphaValue)) return undefined;
  return [channels[0]!, channels[1]!, channels[2]!, alphaValue];
}

function finiteNumber(value: PineValue | undefined): number | undefined {
  const resolved = number(value);
  return Number.isFinite(resolved) ? resolved : undefined;
}

function colorChannelByte(value: PineValue | undefined): number | undefined {
  const resolved = finiteNumber(value);
  return resolved === undefined ? undefined : Math.round(Math.max(0, Math.min(255, resolved)));
}

function transparencyByte(value: PineValue | undefined): number | undefined {
  const resolved = finiteNumber(value);
  if (resolved === undefined) return undefined;
  // The reference platform keeps whole-number transparency: 33.7 is stored as 33.
  const transparency = Math.trunc(Math.max(0, Math.min(100, resolved)));
  return Math.round(255 * (100 - transparency) / 100);
}

function formatStrictColor([red, green, blue, alpha]: ColorBytes): string {
  const encoded = [red, green, blue, alpha].map((channel) => channel.toString(16).padStart(2, "0").toUpperCase());
  return alpha === 255 ? `#${encoded.slice(0, 3).join("")}` : `#${encoded.join("")}`;
}

function parseColor(value: PineValue | undefined): [number, number, number, number] | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length !== 6 && hex.length !== 8) return undefined;
    return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1];
  }
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/u.exec(value);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

export function stringCall(name: string, args: readonly PineValue[], defaultTimezone = "UTC", mintick = 0.01, strict = false): PineValue {
  const source = pineString(args[0] ?? "");
  if (!strict && legacyStringCallNames.has(name)) return legacyStringCall(name, args);
  if (strict) assertPineStringLength(source, name);
  switch (name) {
    case "format": return strict ? formatStringStrict(source, args.slice(1)) : formatString(source, args.slice(1));
    case "format_time": return formatTime(args[0], args[1], args[2], defaultTimezone, strict);
    case "match": {
      const pattern = strict ? checkedStringArgument(args[1], name) : pineString(args[1] ?? "");
      const match = source.match(pineRegExp(pattern, strict));
      return match?.[0] ?? "";
    }
    case "tostring": return strict ? strictStringFromValue(args[0], args[1], mintick) : stringFromValue(args[0], args[1], mintick);
    case "tonumber": return pineNumber(source);
    case "lower": return source.replace(/[A-Z]/gu, (character) => character.toLowerCase());
    case "upper": return source.replace(/[a-z]/gu, (character) => character.toUpperCase());
    case "trim": return trimAsciiWhitespace(source);
    case "repeat": return repeatString(source, args[1], pineString(args[2] ?? ""));
    case "replace_all": return replaceAllOccurrences(source, pineString(args[1] ?? ""), pineString(args[2] ?? ""));
    case "replace": return replaceOccurrence(source, pineString(args[1] ?? ""), pineString(args[2] ?? ""), occurrence(args[3]));
    case "contains": return source.includes(checkedStringArgument(args[1], name));
    case "endswith": return source.endsWith(checkedStringArgument(args[1], name));
    case "startswith": return source.startsWith(checkedStringArgument(args[1], name));
    case "pos": {
      const index = source.indexOf(checkedStringArgument(args[1], name));
      return index < 0 ? Number.NaN : Array.from(source.slice(0, index)).length;
    }
    case "length": return Array.from(source).length;
    case "split": {
      const separator = checkedStringArgument(args[1], name);
      return separator.length === 0 ? Array.from(source) : source.split(separator);
    }
    case "substring": {
      const characters = Array.from(source);
      const begin = stringIndex(args[1], 0, name);
      const end = isNa(args[2]) ? characters.length : stringIndex(args[2], characters.length, name);
      if (begin < 0 || end < begin) {
        throw new PineRuntimeError(
          `Invalid value '${begin}' for 'begin_pos' parameter of the 'str.substring' function. It must be >= 0 or lower than the 'end_pos': (${end}).`,
          `str.${name}`,
        );
      }
      if (begin > characters.length) {
        throw new PineRuntimeError("The 'begin_pos' argument is outside the source string", `str.${name}`);
      }
      return characters.slice(begin, Math.min(end, characters.length)).join("");
    }
    default: throw new Error(`Unsupported string call str.${name}`);
  }
}

const MAX_PINE_STRING_LENGTH = 40_960;
const pineNumberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const legacyStringCallNames = new Set([
  "contains", "endswith", "length", "lower", "pos", "repeat", "replace", "replace_all", "split", "startswith",
  "substring", "tonumber", "trim", "upper",
]);

function legacyStringCall(name: string, args: readonly PineValue[]): PineValue {
  const source = pineString(args[0] ?? "");
  switch (name) {
    case "tonumber": {
      if (source.trim().length === 0) return Number.NaN;
      const value = Number(source);
      return Number.isFinite(value) ? value : Number.NaN;
    }
    case "lower": return source.toLowerCase();
    case "upper": return source.toUpperCase();
    case "trim": return source.trim();
    case "repeat": return Array(Math.max(0, legacyInteger(args[1]))).fill(source).join(pineString(args[2] ?? ""));
    case "replace_all": return source.replaceAll(pineString(args[1] ?? ""), pineString(args[2] ?? ""));
    case "replace": return legacyReplaceOccurrence(source, pineString(args[1] ?? ""), pineString(args[2] ?? ""), legacyInteger(args[3]));
    case "contains": return source.includes(pineString(args[1] ?? ""));
    case "endswith": return source.endsWith(pineString(args[1] ?? ""));
    case "startswith": return source.startsWith(pineString(args[1] ?? ""));
    case "pos": {
      const index = source.indexOf(pineString(args[1] ?? ""));
      return index < 0 ? Number.NaN : Array.from(source.slice(0, index)).length;
    }
    case "length": return Array.from(source).length;
    case "split": {
      const separator = pineString(args[1] ?? "");
      return separator.length === 0 ? Array.from(source) : source.split(separator);
    }
    case "substring": {
      const characters = Array.from(source);
      return characters.slice(legacyInteger(args[1]), legacyInteger(args[2], characters.length)).join("");
    }
    default: throw new Error(`Unsupported legacy string call str.${name}`);
  }
}

function legacyInteger(value: PineValue | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const numeric = number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.trunc(numeric)) : 0;
}

function trimAsciiWhitespace(source: string): string {
  return source.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, "");
}

function pineNumber(source: string): number {
  const trimmed = trimAsciiWhitespace(source);
  if (!pineNumberPattern.test(trimmed)) return Number.NaN;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : Number.NaN;
}

function repeatString(source: string, rawCount: PineValue | undefined, separator: string): string {
  assertPineStringLength(separator, "repeat");
  const count = number(rawCount);
  if (!Number.isInteger(count) || count < 0) {
    throw new PineRuntimeError("The 'repeat' argument must be a nonnegative integer", "str.repeat");
  }
  const sourceLength = codePointLength(source);
  const separatorLength = codePointLength(separator);
  const length = sourceLength * count + separatorLength * Math.max(0, count - 1);
  assertPineStringResultLength(length, "repeat");
  if (count === 0 || (sourceLength === 0 && separatorLength === 0)) return "";
  if (count === 1) return source;
  return Array(count).fill(source).join(separator);
}

function replaceAllOccurrences(source: string, target: string, replacement: string): string {
  assertPineStringLength(target, "replace_all");
  assertPineStringLength(replacement, "replace_all");
  if (target.length === 0) {
    const characters = Array.from(source);
    assertPineStringResultLength(characters.length + (characters.length + 1) * codePointLength(replacement), "replace_all");
    return [replacement, ...characters.flatMap((character) => [character, replacement])].join("");
  }
  const parts = source.split(target);
  assertPineStringResultLength(
    codePointLength(source) - (parts.length - 1) * codePointLength(target) + (parts.length - 1) * codePointLength(replacement),
    "replace_all",
  );
  return parts.join(replacement);
}

function checkedStringArgument(value: PineValue | undefined, name: string): string {
  const result = pineString(value ?? "");
  assertPineStringLength(result, name);
  return result;
}

function stringIndex(value: PineValue | undefined, fallback: number, name: string): number {
  if (isNa(value)) return fallback;
  const result = number(value);
  if (!Number.isInteger(result)) throw new PineRuntimeError("String positions must be integers", `str.${name}`);
  return result;
}

function occurrence(value: PineValue | undefined): number {
  if (value === undefined) return 0;
  const result = number(value);
  return Number.isInteger(result) ? result : -1;
}

function assertPineStringLength(value: string, name: string): void {
  assertPineStringResultLength(codePointLength(value), name);
}

function assertPineStringResultLength(length: number, name: string): void {
  if (length > MAX_PINE_STRING_LENGTH) {
    throw new PineRuntimeError(`String result exceeds the ${String(MAX_PINE_STRING_LENGTH)} character limit`, `str.${name}`);
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

const logEncoder = new TextEncoder();
const MAX_LOG_MESSAGE_BYTES = 8 * 1024;
const MAX_LOG_FORMAT_ARGUMENTS = 64;

function clipLogText(value: string): { readonly text: string; readonly truncated: boolean } {
  let byteCount = 0;
  let end = 0;
  for (const character of value) {
    const size = logEncoder.encode(character).length;
    if (byteCount + size > MAX_LOG_MESSAGE_BYTES) return { text: value.slice(0, end), truncated: true };
    byteCount += size;
    end += character.length;
  }
  return { text: value, truncated: false };
}

/** Bound every formatter input before interpolation, then bound the result. */
export function formatBoundedLogMessage(args: readonly PineValue[]): { readonly message: string; readonly truncated: boolean } {
  if (typeof args[0] !== "string") throw new PineRuntimeError("Log message must be a string", "log");
  const template = clipLogText(pineString(args[0] ?? ""));
  if (args.length <= 1) return { message: template.text, truncated: template.truncated };
  let truncated = template.truncated || args.length > MAX_LOG_FORMAT_ARGUMENTS + 1;
  const values = args.slice(1, MAX_LOG_FORMAT_ARGUMENTS + 1).map((value) => {
    if (value !== null && typeof value === "object") throw new PineRuntimeError("Log formatting requires scalar arguments", "log");
    if (typeof value !== "string") return value;
    const clipped = clipLogText(value);
    truncated ||= clipped.truncated;
    return clipped.text;
  });
  const placeholder = /\{(\d+)(?:,\s*(number|date|time)\s*,\s*([^}]+))?\}/gu;
  let message = "";
  let cursor = 0;
  for (const match of template.text.matchAll(placeholder)) {
    const literal = clipLogText(message + template.text.slice(cursor, match.index));
    if (literal.truncated) return { message: literal.text, truncated: true };
    const replaced = clipLogText(literal.text + formatString(match[0], values));
    if (replaced.truncated) return { message: replaced.text, truncated: true };
    message = replaced.text;
    cursor = match.index + match[0].length;
  }
  const final = clipLogText(message + template.text.slice(cursor));
  return { message: final.text, truncated: truncated || final.truncated };
}

function formatTime(
  time: PineValue | undefined,
  rawFormat: PineValue | undefined,
  rawTimezone: PineValue | undefined,
  defaultTimezone: string,
  strict = false,
): string {
  const numericTime = number(time);
  const timestamp = Number.isNaN(numericTime) ? 0 : numericTime;
  if (strict && !Number.isFinite(timestamp)) throw new PineRuntimeError("Time must be finite or na", "str.format_time");
  const format = rawFormat === undefined
    ? "yyyy-MM-dd'T'HH:mm:ssZ"
    : strict ? requiredStringArgument(rawFormat, "format_time", "format") : pineString(rawFormat);
  const timezone = rawTimezone === undefined
    ? defaultTimezone
    : strict ? requiredStringArgument(rawTimezone, "format_time", "timezone") : pineString(rawTimezone);
  if (strict) {
    assertPineStringLength(format, "format_time");
    assertPineStringLength(timezone, "format_time");
  }
  if (!isValidTimezone(timezone)) throw new PineRuntimeError(`Invalid timezone: "${timezone}"`, "str.format_time");
  const parts = dateParts(timestamp, timezone);
  const milliseconds = new Date(timestamp).getUTCMilliseconds();
  const localDay = Date.UTC(parts.year, parts.month - 1, parts.day);
  const dayOfYear = Math.floor((localDay - Date.UTC(parts.year, 0, 1)) / 86_400_000) + 1;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const offset = timezoneOffsetAt(timestamp, timezone, parts);
  const zoneName = timeZoneName(timestamp, timezone, false, strict);
  const longZoneName = timeZoneName(timestamp, timezone, true, strict);
  const hour12 = parts.hour % 12 || 12;
  const tokens: Readonly<Record<string, string>> = {
    yyyy: String(parts.year).padStart(4, "0"), yy: String(parts.year % 100).padStart(2, "0"), y: String(parts.year),
    MMMM: months[parts.month - 1]!, MMM: months[parts.month - 1]!.slice(0, 3), MM: String(parts.month).padStart(2, "0"), M: String(parts.month),
    dd: String(parts.day).padStart(2, "0"), d: String(parts.day),
    DDD: String(dayOfYear).padStart(3, "0"), DD: String(dayOfYear).padStart(2, "0"), D: String(dayOfYear),
    EEEE: weekdays[parts.dayOfWeek]!, E: weekdays[parts.dayOfWeek]!.slice(0, 3),
    ww: String(isoWeek(parts.year, parts.month, parts.day)).padStart(2, "0"), w: String(isoWeek(parts.year, parts.month, parts.day)),
    W: String(Math.ceil(parts.day / 7)), a: parts.hour < 12 ? "AM" : "PM",
    hh: String(hour12).padStart(2, "0"), h: String(hour12), HH: String(parts.hour).padStart(2, "0"), H: String(parts.hour),
    mm: String(parts.minute).padStart(2, "0"), m: String(parts.minute), ss: String(parts.second).padStart(2, "0"), s: String(parts.second),
    SSS: String(milliseconds).padStart(3, "0"),
    SS: strict ? String(Math.floor(milliseconds / 10)).padStart(2, "0") : String(milliseconds).padStart(2, "0"),
    S: strict ? String(Math.floor(milliseconds / 100)) : String(milliseconds),
    Z: `${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}${String(Math.abs(offset) % 60).padStart(2, "0")}`,
    zzzz: longZoneName, z: zoneName,
  };
  const result = strict ? replaceTimeTokensStrict(format, tokens) : replaceTimeTokens(format, tokens);
  if (strict) assertPineStringLength(result, "format_time");
  return result;
}

function replaceTimeTokens(format: string, tokens: Readonly<Record<string, string>>): string {
  let result = "";
  for (let index = 0; index < format.length;) {
    if (format[index] === "'") {
      const end = format.indexOf("'", index + 1);
      if (end < 0) return result + format.slice(index + 1);
      result += format.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    const token = Object.keys(tokens).find((candidate) => format.startsWith(candidate, index));
    if (token === undefined) {
      result += format[index]!;
      index += 1;
      continue;
    }
    result += tokens[token]!;
    index += token.length;
  }
  return result;
}

function replaceTimeTokensStrict(format: string, tokens: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  let resultLength = 0;
  let quoted = false;
  const append = (value: string) => {
    resultLength += codePointLength(value);
    assertPineStringResultLength(resultLength, "format_time");
    parts.push(value);
  };
  const tokenNames = Object.keys(tokens);
  for (let index = 0; index < format.length;) {
    if (format[index] === "'") {
      if (format[index + 1] === "'") {
        append("'");
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    const character = format[index];
    if (!quoted && (character === "E" || character === "z")) {
      let end = index + 1;
      while (format[end] === character) end += 1;
      append(tokens[end - index >= 4 ? character.repeat(4) : character]!);
      index = end;
      continue;
    }
    const token = quoted ? undefined : tokenNames.find((candidate) => format.startsWith(candidate, index));
    if (token === undefined) {
      const character = String.fromCodePoint(format.codePointAt(index)!);
      append(character);
      index += character.length;
      continue;
    }
    append(tokens[token]!);
    index += token.length;
  }
  if (quoted) throw new PineRuntimeError("Unterminated quote in time format", "str.format_time");
  return parts.join("");
}

function timezoneOffsetAt(timestamp: number, timezone: string, parts: ReturnType<typeof dateParts>): number {
  const fixed = timezoneOffsetMinutes(timezone);
  if (fixed !== undefined) return fixed;
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((localAsUtc - timestamp) / 60_000);
}

function timeZoneName(timestamp: number, timezone: string, long: boolean, strict: boolean): string {
  const fixed = timezoneOffsetMinutes(timezone);
  if (fixed !== undefined) {
    if (fixed === 0) {
      if (!strict) return "UTC";
      if (timezone === "Etc/UTC") return long ? "Coordinated Universal Time" : "UTC";
      return long ? "Greenwich Mean Time" : "GMT";
    }
    const magnitude = Math.abs(fixed);
    return `GMT${fixed < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: long ? "long" : "short" })
    .formatToParts(new Date(timestamp)).find((part) => part.type === "timeZoneName")?.value ?? timezone;
}

function formatString(template: string, args: readonly PineValue[]): string {
  return template.replace(/\{(\d+)(?:,\s*(number|date|time)\s*,\s*([^}]+))?\}/gu, (match, rawIndex: string, modifier: string | undefined, pattern: string | undefined) => {
    const index = Number.parseInt(rawIndex, 10);
    if (index >= args.length) return match;
    const value = args[index];
    if (modifier === "date" || modifier === "time") return formatTime(value, pattern, "UTC", "UTC");
    if (modifier !== "number") return pineString(value);
    if (typeof value !== "number" || Number.isNaN(value)) return pineString(value);
    return formatNumber(value, pattern ?? "#,###.###");
  });
}

const MAX_STRING_FORMAT_ARGUMENTS = 64;
const MAX_NUMBER_FORMAT_FRACTION_DIGITS = 20;

function formatStringStrict(template: string, args: readonly PineValue[]): string {
  if (args.length > MAX_STRING_FORMAT_ARGUMENTS) {
    throw new PineRuntimeError(`String formatting supports at most ${String(MAX_STRING_FORMAT_ARGUMENTS)} arguments`, "str.format");
  }
  const values = args.map((value) => checkedFormatArgument(value));
  const parts: string[] = [];
  let resultLength = 0;
  let quoted = false;
  const append = (value: string) => {
    resultLength += codePointLength(value);
    assertPineStringResultLength(resultLength, "format");
    parts.push(value);
  };

  for (let index = 0; index < template.length;) {
    const character = String.fromCodePoint(template.codePointAt(index)!);
    if (character === "'") {
      if (template[index + 1] === "'") {
        append("'");
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (!quoted && character === "{") {
      const end = formatPlaceholderEnd(template, index + 1);
      if (end < 0) throw new PineRuntimeError("Unclosed placeholder in format string", "str.format");
      const placeholder = template.slice(index + 1, end);
      append(formatStrictPlaceholder(placeholder, values));
      index = end + 1;
      continue;
    }
    if (!quoted && character === "}") throw new PineRuntimeError("Unmatched closing brace in format string", "str.format");
    append(character);
    index += character.length;
  }
  if (quoted) throw new PineRuntimeError("Unterminated quote in format string", "str.format");
  return parts.join("");
}

function formatPlaceholderEnd(template: string, start: number): number {
  let depth = 1;
  let quoted = false;
  for (let index = start; index < template.length; index += 1) {
    const character = template[index];
    if (character === "'") {
      if (template[index + 1] === "'") index += 1;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function formatStrictPlaceholder(placeholder: string, args: readonly PineValue[]): string {
  const parsed = /^(\d+)(?:,\s*(number|date|time)\s*,\s*(.+))?$/u.exec(placeholder);
  if (parsed === null) {
    const argument = placeholder.split(",", 1)[0] ?? "";
    if (!/^\d+$/u.test(argument)) throw new PineRuntimeError(`can't parse argument number: ${argument}`, "str.format");
    throw new PineRuntimeError(`Unsupported format placeholder: {${placeholder}}`, "str.format");
  }
  const index = Number.parseInt(parsed[1]!, 10);
  if (index >= args.length) return `{${placeholder}}`;
  const value = args[index];
  const modifier = parsed[2];
  const pattern = parsed[3];
  if (modifier === "date" || modifier === "time") return formatTime(value, pattern, "UTC", "UTC", true);
  if (modifier !== "number") return pineString(value);
  if (typeof value !== "number" || Number.isNaN(value)) return pineString(value);
  return formatNumberStrict(value, pattern ?? "#,###.###", "format");
}

function formatNumber(value: number, rawPattern: string): string {
  const preset = rawPattern.trim();
  const pattern = preset === "integer" ? "#,###"
    : preset === "currency" ? "'$'#,###.00"
      : preset === "percent" ? "#,###%"
        : preset;
  const expanded = pattern.replace(/'([^']*)'/gu, "$1");
  const firstToken = expanded.search(/[#0]/u);
  const lastToken = Math.max(expanded.lastIndexOf("#"), expanded.lastIndexOf("0"));
  if (firstToken < 0 || lastToken < firstToken) return String(value);

  const prefix = expanded.slice(0, firstToken);
  const suffix = expanded.slice(lastToken + 1);
  const numericPattern = expanded.slice(firstToken, lastToken + 1);
  const decimalIndex = numericPattern.indexOf(".");
  const integerPattern = decimalIndex < 0 ? numericPattern : numericPattern.slice(0, decimalIndex);
  const fractionPattern = decimalIndex < 0 ? "" : numericPattern.slice(decimalIndex + 1);
  const minimumIntegerDigits = (integerPattern.match(/0/gu) ?? []).length;
  const maximumFractionDigits = (fractionPattern.match(/[#0]/gu) ?? []).length;
  const minimumFractionDigits = (fractionPattern.match(/0/gu) ?? []).length;
  const scaled = suffix.includes("%") ? value * 100 : value;
  const absolute = Math.abs(scaled).toFixed(maximumFractionDigits);
  let [whole = "", fraction = ""] = absolute.split(".");
  while (fraction.length > minimumFractionDigits && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  whole = whole.padStart(minimumIntegerDigits, "0");
  if (integerPattern.includes(",")) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const sign = scaled < 0 ? "-" : "";
  return `${sign}${prefix}${whole}${fraction.length > 0 ? `.${fraction}` : ""}${suffix}`;
}

function formatNumberStrict(value: number, rawPattern: string, owner: "format" | "tostring"): string {
  assertPineStringLength(rawPattern, owner);
  const preset = rawPattern.trim();
  const pattern = preset === "integer" ? "#,###"
    : preset === "currency" ? "'$'#,###.00"
      : preset === "percent" ? "#,###%"
        : preset;
  const tokens = parseStrictNumberPattern(pattern, owner);
  const decimalSeparators = tokens.filter((token) => !token.quoted && token.character === ".");
  if (decimalSeparators.length > 1) {
    throw new PineRuntimeError("Number format contains more than one decimal separator", `str.${owner}`);
  }
  const decimalIndex = tokens.findIndex((token) => !token.quoted && token.character === ".");
  const fractionDigits = decimalIndex < 0
    ? 0
    : tokens.slice(decimalIndex + 1).filter((token) => !token.quoted && (token.character === "#" || token.character === "0")).length;
  if (fractionDigits > MAX_NUMBER_FORMAT_FRACTION_DIGITS) {
    throw new PineRuntimeError(`Number format supports at most ${String(MAX_NUMBER_FORMAT_FRACTION_DIGITS)} fractional digits`, `str.${owner}`);
  }
  // A literal str.tostring prefix uses an implicit integer slot.
  const literalPrefix = owner === "tostring" && tokens.length > 0
    && tokens.every((token) => token.quoted || /^[a-z]$/iu.test(token.character));
  const result = formatStrictNumberPattern(value, literalPrefix ? [...tokens, { character: "#", quoted: false }] : tokens);
  assertPineStringLength(result, owner);
  return result;
}

interface StrictNumberPatternToken {
  readonly character: string;
  readonly quoted: boolean;
}

function parseStrictNumberPattern(pattern: string, owner: "format" | "tostring"): readonly StrictNumberPatternToken[] {
  const tokens: StrictNumberPatternToken[] = [];
  let quoted = false;
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === "'") {
      if (pattern[index + 1] === "'") {
        tokens.push({ character: "'", quoted: true });
        index += 2;
        continue;
      }
      quoted = !quoted;
      index += 1;
      continue;
    }
    const character = String.fromCodePoint(pattern.codePointAt(index)!);
    tokens.push({ character, quoted });
    index += character.length;
  }
  if (quoted) throw new PineRuntimeError("Unterminated quote in number format", `str.${owner}`);
  return tokens;
}

function formatStrictNumberPattern(value: number, tokens: readonly StrictNumberPatternToken[]): string {
  const isDigitToken = (token: StrictNumberPatternToken): boolean => !token.quoted && (token.character === "#" || token.character === "0");
  const firstToken = tokens.findIndex(isDigitToken);
  let lastToken = -1;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (isDigitToken(tokens[index]!)) {
      lastToken = index;
      break;
    }
  }
  if (firstToken < 0 || lastToken < firstToken) return String(value);

  const prefix = tokens.slice(0, firstToken).map((token) => token.character).join("");
  const suffix = tokens.slice(lastToken + 1).map((token) => token.character).join("");
  const numericTokens = tokens.slice(firstToken, lastToken + 1);
  const decimalIndex = numericTokens.findIndex((token) => !token.quoted && token.character === ".");
  const integerTokens = decimalIndex < 0 ? numericTokens : numericTokens.slice(0, decimalIndex);
  const fractionTokens = decimalIndex < 0 ? [] : numericTokens.slice(decimalIndex + 1);
  const minimumIntegerDigits = integerTokens.filter((token) => !token.quoted && token.character === "0").length;
  const maximumFractionDigits = fractionTokens.filter(isDigitToken).length;
  const minimumFractionDigits = fractionTokens.filter((token) => !token.quoted && token.character === "0").length;
  const scaled = tokens.some((token) => !token.quoted && token.character === "%") ? value * 100 : value;
  const absolute = Math.abs(scaled).toFixed(maximumFractionDigits);
  let [whole = "", fraction = ""] = absolute.split(".");
  while (fraction.length > minimumFractionDigits && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  whole = whole.padStart(minimumIntegerDigits, "0");
  if (integerTokens.some((token) => !token.quoted && token.character === ",")) {
    whole = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  }
  const sign = scaled < 0 ? "-" : "";
  return `${sign}${prefix}${whole}${fraction.length > 0 ? `.${fraction}` : ""}${suffix}`;
}

function stringFromValue(value: PineValue | undefined, format: PineValue | undefined, mintick: number): string {
  if (typeof value !== "number" || Number.isNaN(value) || typeof format !== "string" || format.length === 0) return pineString(value);
  if (format === "integer") return formatNumber(value, "#");
  if (format === "volume") return formatVolume(value);
  if (format === "percent") return formatNumber(value, "#.00%");
  if (format === "mintick" || format === "price") return formatToMintick(value, mintick);
  return formatNumber(value, format);
}

function strictStringFromValue(value: PineValue | undefined, format: PineValue | undefined, mintick: number): string {
  if (format !== undefined && typeof format !== "string") {
    throw new PineRuntimeError("The 'format' argument for str.tostring must be a string", "str.tostring");
  }
  if (typeof format === "string") assertPineStringLength(format, "tostring");
  if (isPineMatrix(value) && (value.elementKind === "float" || value.elementKind === "int")) {
    const parts: string[] = [];
    let length = 0;
    const append = (part: string): void => {
      length += codePointLength(part);
      assertPineStringResultLength(length, "tostring");
      parts.push(part);
    };
    for (const [rowIndex, row] of value.data.entries()) {
      append(rowIndex === 0 ? "[" : "\n[");
      for (const [column, cell] of row.entries()) {
        if (column !== 0) append(", ");
        append(strictScalarString(cell, format, mintick));
      }
      append("]");
    }
    return parts.join("");
  }
  if (value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
    throw new PineRuntimeError("str.tostring requires a scalar, array or numeric matrix value", "str.tostring");
  }
  const result = Array.isArray(value) ? `[${value.map(pineString).join(", ")}]` : strictScalarString(value, format, mintick);
  assertPineStringLength(result, "tostring");
  return result;
}

function strictScalarString(value: PineValue | undefined, format: string | undefined, mintick: number): string {
  if (typeof value === "number" && !Number.isFinite(value)) return "NaN";
  if (typeof value !== "number" || format === undefined || format.length === 0) return pineString(value);
  if (format === "integer") return formatNumberStrict(value, "#", "tostring");
  if (format === "volume") return formatVolume(value, true);
  // format.percent appends % to the value with two decimals; it does not scale by 100.
  if (format === "percent") return `${formatNumberStrict(value, "0.00", "tostring")}%`;
  if (format === "mintick") return formatToMintick(value, mintick);
  return formatNumberStrict(value, format, "tostring");
}

function checkedFormatArgument(value: PineValue): PineValue {
  if (value !== null && typeof value === "object") {
    throw new PineRuntimeError("str.format requires scalar arguments", "str.format");
  }
  if (typeof value === "string") assertPineStringLength(value, "format");
  return value;
}

function requiredStringArgument(value: PineValue | undefined, owner: string, parameter: string): string {
  if (typeof value !== "string") {
    throw new PineRuntimeError(`The '${parameter}' argument for str.${owner} must be a string`, `str.${owner}`);
  }
  return value;
}

function formatToMintick(value: number, rawMintick: number): string {
  const tick = Number.isFinite(rawMintick) && rawMintick > 0 ? rawMintick : 0.01;
  const scaled = value / tick;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled)) * tick;
  return rounded.toFixed(decimalPlaces(tick));
}

function decimalPlaces(value: number): number {
  const normalized = value.toString().toLowerCase();
  const exponentIndex = normalized.indexOf("e-");
  if (exponentIndex >= 0) return Number.parseInt(normalized.slice(exponentIndex + 2), 10);
  const decimalIndex = normalized.indexOf(".");
  return decimalIndex < 0 ? 0 : normalized.length - decimalIndex - 1;
}

function formatVolume(value: number, strict = false): string {
  const absolute = Math.abs(value);
  const units: readonly [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  const unit = units.find(([threshold]) => absolute >= threshold);
  if (unit === undefined) return formatNumber(value, strict ? "#" : "#,###");
  return `${formatNumber(value / unit[0], "#.###")}${unit[1]}`;
}

function pineRegExp(rawPattern: string, strict = false): RegExp {
  let pattern = rawPattern;
  const flags = new Set<string>();
  for (;;) {
    const modifier = /^\(\?([imsU]+)\)/u.exec(pattern);
    if (modifier === null) break;
    for (const flag of modifier[1] ?? "") {
      if (flag !== "U") flags.add(flag);
    }
    pattern = pattern.slice(modifier[0].length);
  }

  pattern = quoteRegexLiterals(pattern)
    .replace(/\\A/gu, "(?<![\\s\\S])")
    .replace(/\\Z/gu, "(?=\\n?(?![\\s\\S]))")
    .replace(/\\z/gu, "(?![\\s\\S])");
  if (strict) flags.add("u");
  try {
    return new RegExp(pattern, [...flags].join(""));
  } catch (error) {
    if (!strict) throw error;
    throw new PineRuntimeError("Invalid regex pattern in the 'str.match' function.", "str.match", undefined, "SCRIPT_RUNTIME_ERROR", error);
  }
}

function quoteRegexLiterals(pattern: string): string {
  return pattern.replace(/\\Q([\s\S]*?)\\E/gu, (_match, literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
}

function replaceOccurrence(source: string, target: string, replacement: string, occurrence: number): string {
  assertPineStringLength(target, "replace");
  assertPineStringLength(replacement, "replace");
  if (occurrence < 0) return source;
  if (target.length === 0) {
    const characters = Array.from(source);
    if (occurrence > characters.length) return source;
    assertPineStringResultLength(characters.length + codePointLength(replacement), "replace");
    return `${characters.slice(0, occurrence).join("")}${replacement}${characters.slice(occurrence).join("")}`;
  }
  let position = 0;
  for (let found = 0; ; found += 1) {
    const index = source.indexOf(target, position);
    if (index < 0) return source;
    if (found === occurrence) {
      const result = source.slice(0, index) + replacement + source.slice(index + target.length);
      assertPineStringLength(result, "replace");
      return result;
    }
    position = index + target.length;
  }
}

function legacyReplaceOccurrence(source: string, target: string, replacement: string, occurrence: number): string {
  if (target.length === 0) return source;
  let position = 0;
  for (let found = 0; ; found += 1) {
    const index = source.indexOf(target, position);
    if (index < 0) return source;
    if (found === occurrence) return source.slice(0, index) + replacement + source.slice(index + target.length);
    position = index + target.length;
  }
}
