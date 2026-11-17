import { normalizeFxRateBook, selectFxRate, type FxRateSelection, type FxRateSelectionResult, type MarketBar, type NormalizedFxRateBookV1, type SessionOptions, type StrategyConfig } from "../contracts/index.js";
import { PineRuntimeError } from "./pine-runtime-error.js";
import { timeframeEnd, timeframeSeconds } from "./time.js";

export interface StrategyFxContext {
  readonly book: NormalizedFxRateBookV1 | undefined;
  readonly symbolCurrency: string | undefined;
  readonly accountCurrency: string | undefined;
  /** Exact normalized content and selection context, including the resolved pair. */
  readonly identity: string | undefined;
}

export function admitStrategyFxContext(config: StrategyConfig | undefined, options: SessionOptions, strict = false,
  requestAccountCurrency?: string): StrategyFxContext {
  if (!strict) return Object.freeze({ book: undefined, symbolCurrency: options.symbolInfo?.currency,
    accountCurrency: config?.currency, identity: undefined });
  let book: NormalizedFxRateBookV1 | undefined;
  try { book = options.fxRateBook === undefined ? undefined : normalizeFxRateBook(options.fxRateBook); }
  catch (error) { throw new PineRuntimeError(error instanceof Error ? error.message : "Invalid supplied FX book", "strategy.fxRateBook"); }
  const symbolCurrency = typeof options.symbolInfo?.currency === "string"
    ? options.symbolInfo.currency.trim().toUpperCase() : undefined;
  const accountCurrency = requestAccountCurrency ?? (config?.currency.toUpperCase() === "NONE" ? symbolCurrency : config?.currency.toUpperCase());
  const explicit = config !== undefined && config.currency.toUpperCase() !== "NONE";
  if (explicit && symbolCurrency !== undefined && symbolCurrency !== "" && symbolCurrency !== accountCurrency) {
    const match = selectFxRate(book, symbolCurrency, accountCurrency, {
      mode: "historical", timeframe: "daily", barOpen: 0, barEndExclusive: 1,
    });
    if (match.kind === "missing-pair" || match.kind === "missing-currency") {
      throw new PineRuntimeError("Explicit strategy currency requires a matching supplied FX pair", "strategy");
    }
  } else if (explicit && (symbolCurrency === undefined || symbolCurrency === "")) {
    throw new PineRuntimeError("Explicit strategy currency requires a known chart symbol currency", "strategy");
  }
  const identity = book === undefined ? undefined : JSON.stringify([book.fingerprint, symbolCurrency ?? null, accountCurrency ?? null,
    options.timeframe ?? "", options.timezone ?? options.symbolInfo?.timezone ?? "UTC"]);
  return Object.freeze({ book, symbolCurrency, accountCurrency, identity });
}

export function selectStrategyFxRate(context: StrategyFxContext, selection: FxRateSelection): FxRateSelectionResult {
  return selectFxRate(context.book, context.symbolCurrency, context.accountCurrency, selection);
}

export function selectStrategyFxBar(context: StrategyFxContext, bar: MarketBar, timeframe: string, timezone: string,
  evaluatedAt: number, realtime: boolean): { readonly result: FxRateSelectionResult; readonly identity?: string } {
  const seconds = timeframeSeconds(timeframe);
  if (context.book !== undefined && context.symbolCurrency !== context.accountCurrency && seconds <= 0) {
    throw new PineRuntimeError("A supported primary timeframe is required for FX selection", "strategy.fxRateBook");
  }
  const selection: FxRateSelection = realtime
    ? { mode: "realtime", evaluatedAt }
    : { mode: "historical", timeframe: seconds > 86_400 ? "higher" : seconds === 86_400 ? "daily" : "intraday",
      barOpen: bar.openTime, barEndExclusive: seconds > 0 ? timeframeEnd(bar.openTime, timeframe, timezone) : bar.openTime + 1 };
  const result = selectStrategyFxRate(context, selection);
  const identity = result.kind === "identity" || result.kind === "missing-currency"
    ? JSON.stringify(result) : JSON.stringify([selection.mode, result]);
  return { result, ...(context.identity === undefined ? {} : { identity }) };
}
