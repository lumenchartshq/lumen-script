/** Exact supported chart fields, shared with the host's conservative source scanner. */
export const PINE_CHART_FIELD_REQUIREMENTS = Object.freeze({
  "chart.bg_color": "colors",
  "chart.fg_color": "colors",
  "chart.is_heikinashi": "type",
  "chart.is_kagi": "type",
  "chart.is_linebreak": "type",
  "chart.is_pnf": "type",
  "chart.is_range": "type",
  "chart.is_renko": "type",
  "chart.is_standard": "type",
  "chart.left_visible_bar_time": "visibleRange",
  "chart.right_visible_bar_time": "visibleRange",
} as const);

export type PineChartFieldRequirement = typeof PINE_CHART_FIELD_REQUIREMENTS[keyof typeof PINE_CHART_FIELD_REQUIREMENTS];

export function pineChartFieldRequirement(name: string): PineChartFieldRequirement | undefined {
  if (!Object.hasOwn(PINE_CHART_FIELD_REQUIREMENTS, name)) return undefined;
  return PINE_CHART_FIELD_REQUIREMENTS[name as keyof typeof PINE_CHART_FIELD_REQUIREMENTS];
}

/** Compiler output consumed by engine replay policy and chart context validation. */
export interface PineRuntimeRequirements {
  readonly usesDatasetTail: boolean;
  readonly usesExecutionClock: boolean;
  readonly usesChartType: boolean;
  readonly usesVisibleRange: boolean;
}
