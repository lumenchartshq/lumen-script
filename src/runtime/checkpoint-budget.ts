import type { PineCheckpointLimits } from "../contracts/index.js";

const defaults = Object.freeze({ maxBytes: 128 * 1024 * 1024, maxNodes: 500_000, maxEntries: 4_000_000 });

export function checkpointBudget(limits: PineCheckpointLimits = {}): Required<PineCheckpointLimits> {
  const result = { ...defaults, ...limits };
  for (const [name, limit] of Object.entries(result)) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`Script checkpoint ${name} must be a positive safe integer`);
  }
  return result;
}

/** Count UTF-8 without allocating a second copy of a potentially oversized body. */
export function assertCheckpointBytes(source: string, limit: number): void {
  if (source.length > limit) throw new RangeError("Script checkpoint byte budget exceeded");
  let bytes = 0;
  for (const character of source) {
    const code = character.codePointAt(0)!;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
    if (bytes > limit) throw new RangeError("Script checkpoint byte budget exceeded");
  }
}

/** Preflight the JSON-safe encoded graph without allocating its serialized body. */
export function assertCheckpointJsonBytes(graph: object, limit: number): void {
  let bytes = 0;
  const charge = (size: number): void => {
    bytes += size;
    if (bytes > limit) throw new RangeError("Script checkpoint byte budget exceeded");
  };
  const chargeString = (value: string): void => {
    charge(2); // JSON quotes.
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (code === 0x22 || code === 0x5c || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) charge(2);
      else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) charge(6);
      else if (code <= 0x7f) charge(1);
      else if (code <= 0x7ff) charge(2);
      else if (code <= 0xffff) charge(3);
      else charge(4);
    }
  };
  const pending: unknown[] = [graph];
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null) charge(4);
    else if (typeof value === "string") chargeString(value);
    else if (typeof value === "number" || typeof value === "boolean") charge(String(value).length);
    else if (Array.isArray(value)) {
      charge(2 + Math.max(0, value.length - 1));
      for (const item of value) pending.push(item);
    } else if (typeof value === "object") {
      const entries = Object.entries(value);
      charge(2 + Math.max(0, entries.length - 1));
      for (const [key, item] of entries) {
        chargeString(key);
        charge(1); // Colon.
        pending.push(item);
      }
    } else throw new TypeError("Invalid encoded checkpoint JSON value");
  }
}
