import { pineChartFieldRequirement, type PineCompatibility, type PineRuntimeRequirements, isStrictPineCompatibility } from "../contracts/index.js";

const emptyRequirements: PineRuntimeRequirements = Object.freeze({
  usesDatasetTail: false,
  usesExecutionClock: false,
  usesChartType: false,
  usesVisibleRange: false,
});

/** Records resolved runtime reads only; local names and source strings do not count. */
export class RuntimeRequirementCollector {
  private readonly requirements = { ...emptyRequirements };

  constructor(private readonly compatibility: PineCompatibility) {}

  record(name: string): void {
    if (!isStrictPineCompatibility(this.compatibility)) return;
    if (name === "last_bar_index" || name === "last_bar_time") this.requirements.usesDatasetTail = true;
    if (name === "timenow") this.requirements.usesExecutionClock = true;
    const chart = pineChartFieldRequirement(name);
    if (chart === "type") this.requirements.usesChartType = true;
    if (chart === "visibleRange") this.requirements.usesVisibleRange = true;
  }

  snapshot(): PineRuntimeRequirements {
    return Object.freeze({ ...this.requirements });
  }
}

/** Child request reads can invalidate previously evaluated parent outputs. */
export function mergeRuntimeRequirements(
  compatibility: PineCompatibility,
  requirements: readonly PineRuntimeRequirements[],
): PineRuntimeRequirements {
  if (!isStrictPineCompatibility(compatibility)) return emptyRequirements;
  const merged = { ...emptyRequirements };
  for (const key of Object.keys(merged) as (keyof PineRuntimeRequirements)[]) {
    merged[key] = requirements.some((requirement) => requirement[key]);
  }
  return Object.freeze(merged);
}
