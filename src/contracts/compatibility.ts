/**
 * Pine compatibility profiles. This is the only authored code that spells a
 * profile id; everything else reads `PINE_COMPATIBILITY` or the helpers below.
 * Plain Node scripts import this file directly (Node strips its types).
 * Recorded fixtures, generated reports and generated bundles carry the ids as data.
 *
 * - `legacy` is the baseline profile. Its behavior stays fixed so recorded
 *   differential outcomes remain reproducible.
 * - `strict` is the dated production profile. New Pine behavior opts into it.
 */
export const PINE_COMPATIBILITY = Object.freeze({
  legacy: "baseline-2026-08",
  strict: "production-2026-08",
} as const);

export type PineCompatibility = (typeof PINE_COMPATIBILITY)[keyof typeof PINE_COMPATIBILITY];

/** True for the dated production profile. */
export function isStrictPineCompatibility(compatibility: string | undefined): compatibility is typeof PINE_COMPATIBILITY.strict {
  return compatibility === PINE_COMPATIBILITY.strict;
}
