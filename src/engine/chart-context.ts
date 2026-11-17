import type { SessionOptions } from "../contracts/index.js";

const chartTypes = new Set(["standard", "heikinashi", "kagi", "linebreak", "pnf", "range", "renko"]);

/** Snapshot only explicitly supplied chart facts; legacy defaults remain runtime-owned. */
export function admitSessionChartContext(options: SessionOptions, strict: boolean): SessionOptions {
  if (!strict) return options;

  const chartType = options.chartType;
  if (chartType !== undefined && !chartTypes.has(chartType)) {
    throw new TypeError("Invalid chart type: expected a supported host chart tag");
  }

  const chartColors = options.chartColors;
  if (chartColors !== undefined) {
    for (const field of ["background", "foreground"] as const) {
      if (typeof chartColors[field] !== "string" || chartColors[field].trim().length === 0) {
        throw new TypeError(`Invalid chart color '${field}': expected a non-empty string`);
      }
    }
  }

  const visibleRange = options.visibleRange;
  if (visibleRange !== undefined) {
    if (!Number.isSafeInteger(visibleRange.left) || !Number.isSafeInteger(visibleRange.right) || visibleRange.left > visibleRange.right) {
      throw new TypeError("Invalid visible chart range: expected ordered safe integer times");
    }
  }

  if (chartColors === undefined && visibleRange === undefined) return options;
  return {
    ...options,
    ...(chartColors === undefined ? {} : { chartColors: Object.freeze({ background: chartColors.background, foreground: chartColors.foreground }) }),
    ...(visibleRange === undefined ? {} : { visibleRange: Object.freeze({ left: visibleRange.left, right: visibleRange.right }) }),
  };
}
