/** Compare runtime input graphs without losing signed zero, aliases or cycles. */
export function structurallyEqual(left: unknown, right: unknown): boolean {
  const pending: [unknown, unknown][] = [[left, right]];
  const leftToRight = new Map<object, object>();
  const rightToLeft = new Map<object, object>();
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (!Object.is(a, b)) return false;
      continue;
    }
    if (leftToRight.has(a) || rightToLeft.has(b)) {
      if (leftToRight.get(a) !== b || rightToLeft.get(b) !== a) return false;
      continue;
    }
    leftToRight.set(a, b);
    rightToLeft.set(b, a);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
    if (a instanceof Map || b instanceof Map) {
      if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
      const entries = [...b];
      let index = 0;
      for (const [key, value] of a) {
        const other = entries[index++]!;
        pending.push([key, other[0]], [value, other[1]]);
      }
      continue;
    }
    if (a instanceof Set || b instanceof Set) {
      if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
      const entries = [...b];
      let index = 0;
      for (const value of a) pending.push([value, entries[index++]]);
      continue;
    }
    const source = a as Record<string, unknown>, target = b as Record<string, unknown>;
    const keys = Object.keys(source);
    if (keys.length !== Object.keys(target).length) return false;
    for (const key of keys) {
      if (!Object.hasOwn(target, key)) return false;
      pending.push([source[key], target[key]]);
    }
  }
  return true;
}
