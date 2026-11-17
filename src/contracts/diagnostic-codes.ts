/** Convert diagnostics emitted before the Lumen Script rename to their current identifiers. */
export function normalizeScriptCode(code: string): string {
  return /^PINE(?:_[A-Z][A-Z0-9_]*|[123]\d{3})$/u.test(code)
    ? `SCRIPT${code.slice(4)}`
    : code;
}

export function isScriptCode(value: unknown, code: string): boolean {
  return typeof value === "string" && normalizeScriptCode(value) === normalizeScriptCode(code);
}
