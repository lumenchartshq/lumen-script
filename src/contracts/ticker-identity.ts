export const LUMEN_CHARTS_TICKER_IDENTITY_PREFIX = "lumencharts:v1:";

export type LumenChartsTickerTransform =
  | { readonly kind: "heikinashi" }
  | { readonly kind: "renko"; readonly style: "atr" | "traditional"; readonly param: number; readonly requestWicks: boolean; readonly source: "close" | "ohlc" }
  | { readonly kind: "kagi"; readonly reversal: number }
  | { readonly kind: "linebreak"; readonly lines: number }
  | { readonly kind: "pointfigure"; readonly source: "close" | "hl"; readonly style: "atr" | "traditional"; readonly param: number; readonly reversal: number };

export interface LumenChartsTickerIdentityV1 {
  readonly version: 1;
  readonly symbol: string;
  readonly session?: string;
  readonly adjustment?: "none" | "splits" | "dividends";
  readonly backadjustment?: "inherit" | "off" | "on";
  readonly settlementAsClose?: "inherit" | "off" | "on";
  readonly transform?: LumenChartsTickerTransform;
}

type EncodedTransform =
  | readonly ["heikinashi"]
  | readonly ["renko", "atr" | "traditional", number, boolean, "close" | "ohlc"]
  | readonly ["kagi", number]
  | readonly ["linebreak", number]
  | readonly ["pointfigure", "close" | "hl", "atr" | "traditional", number, number];

type EncodedTickerIdentity = readonly [
  1,
  string,
  string | null,
  "none" | "splits" | "dividends" | null,
  "inherit" | "off" | "on" | null,
  "inherit" | "off" | "on" | null,
  EncodedTransform | null,
];

const MAX_TICKER_IDENTITY_LENGTH = 4_096;
const MAX_SYMBOL_LENGTH = 512;
const MAX_PARAMETER = 1_000_000;

/** Canonical, versioned identity used only inside the Lumen Charts Pine host. */
export function encodeLumenChartsTickerIdentity(identity: LumenChartsTickerIdentityV1): string {
  const normalized = normalizeIdentity(identity);
  if (!hasModifiers(normalized)) return normalized.symbol;
  const encoded: EncodedTickerIdentity = [
    1,
    normalized.symbol,
    normalized.session ?? null,
    normalized.adjustment ?? null,
    normalized.backadjustment ?? null,
    normalized.settlementAsClose ?? null,
    normalized.transform === undefined ? null : encodeTransform(normalized.transform),
  ];
  const value = `${LUMEN_CHARTS_TICKER_IDENTITY_PREFIX}${encodeURIComponent(JSON.stringify(encoded))}`;
  if (value.length > MAX_TICKER_IDENTITY_LENGTH) throw new Error("Lumen Charts ticker identity exceeds its size limit");
  return value;
}

/** Returns undefined for ordinary provider symbols and rejects malformed owned IDs. */
export function decodeLumenChartsTickerIdentity(value: string): LumenChartsTickerIdentityV1 | undefined {
  if (!value.startsWith(LUMEN_CHARTS_TICKER_IDENTITY_PREFIX)) return undefined;
  const prefix = LUMEN_CHARTS_TICKER_IDENTITY_PREFIX;
  if (value.length > MAX_TICKER_IDENTITY_LENGTH) throw new Error("Lumen Charts ticker identity exceeds its size limit");
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeURIComponent(value.slice(prefix.length)));
  } catch {
    throw new Error("Invalid Lumen Charts ticker identity encoding");
  }
  if (!Array.isArray(decoded) || decoded.length !== 7 || decoded[0] !== 1) {
    throw new Error("Invalid Lumen Charts ticker identity schema");
  }
  const symbol: unknown = decoded[1];
  const session: unknown = decoded[2];
  const adjustment: unknown = decoded[3];
  const backadjustment: unknown = decoded[4];
  const settlementAsClose: unknown = decoded[5];
  const transform: unknown = decoded[6];
  return normalizeIdentity({
    version: 1,
    symbol: text(symbol, "symbol"),
    ...(session === null ? {} : { session: text(session, "session") }),
    ...(adjustment === null ? {} : { adjustment: enumValue(adjustment, ["none", "splits", "dividends"], "adjustment") }),
    ...(backadjustment === null ? {} : { backadjustment: enumValue(backadjustment, ["inherit", "off", "on"], "backadjustment") }),
    ...(settlementAsClose === null ? {} : { settlementAsClose: enumValue(settlementAsClose, ["inherit", "off", "on"], "settlement_as_close") }),
    ...(transform === null ? {} : { transform: decodeTransform(transform) }),
  });
}

export function lumenChartsTickerBaseSymbol(value: string): string {
  return decodeLumenChartsTickerIdentity(value)?.symbol ?? normalizeSymbol(value);
}

export function lumenChartsTickerParts(value: string): { readonly prefix: string; readonly ticker: string } {
  const symbol = lumenChartsTickerBaseSymbol(value);
  const separator = symbol.indexOf(":");
  return separator < 0
    ? { prefix: "", ticker: symbol }
    : { prefix: symbol.slice(0, separator), ticker: symbol.slice(separator + 1) };
}

export function normalizeLumenChartsTickerStyle(value: unknown): "atr" | "traditional" {
  const style = text(value, "style").trim().toLowerCase();
  if (style === "atr") return "atr";
  if (style === "traditional") return "traditional";
  throw new Error(`Unsupported synthetic ticker style '${style}'`);
}

export function normalizeLumenChartsTickerNumber(value: unknown, field: string, integerValue = false, maximum = MAX_PARAMETER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum || (integerValue && !Number.isInteger(value))) {
    throw new Error(`${field} must be a positive${integerValue ? " integer" : " finite number"} no greater than ${String(maximum)}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function normalizeLumenChartsTickerSource(value: unknown, kind: "renko" | "pointfigure"): "close" | "ohlc" | "hl" {
  const source = text(value, "source").trim().toLowerCase().replaceAll("_", "");
  if (source === "close") return "close";
  if (kind === "renko" && (source === "ohlc" || source === "highlow" || source === "hl")) return "ohlc";
  if (kind === "pointfigure" && (source === "hl" || source === "highlow" || source === "ohlc")) return "hl";
  throw new Error(`Unsupported ${kind} source '${source}'`);
}

function normalizeIdentity(identity: LumenChartsTickerIdentityV1): LumenChartsTickerIdentityV1 {
  if (identity.version !== 1) throw new Error("Unsupported Lumen Charts ticker identity version");
  const symbol = normalizeSymbol(identity.symbol);
  if (symbol.length === 0) throw new Error("Ticker symbol cannot be empty");
  return Object.freeze({
    version: 1,
    symbol,
    ...(identity.session === undefined ? {} : { session: normalizeSession(identity.session) }),
    ...(identity.adjustment === undefined ? {} : { adjustment: enumValue(identity.adjustment, ["none", "splits", "dividends"], "adjustment") }),
    ...(identity.backadjustment === undefined ? {} : { backadjustment: enumValue(identity.backadjustment, ["inherit", "off", "on"], "backadjustment") }),
    ...(identity.settlementAsClose === undefined ? {} : { settlementAsClose: enumValue(identity.settlementAsClose, ["inherit", "off", "on"], "settlement_as_close") }),
    ...(identity.transform === undefined ? {} : { transform: normalizeTransform(identity.transform) }),
  });
}

function normalizeSymbol(value: string): string {
  const symbol = text(value, "symbol").trim();
  if (symbol.length > MAX_SYMBOL_LENGTH) throw new Error("Ticker symbol exceeds its size limit");
  return symbol;
}

function normalizeSession(value: string): string {
  const session = text(value, "session").trim();
  if (session.length === 0) throw new Error("Ticker session cannot be empty");
  if (session.length > 128) throw new Error("Ticker session exceeds its size limit");
  return session.toLowerCase();
}

function hasModifiers(identity: LumenChartsTickerIdentityV1): boolean {
  return identity.session !== undefined
    || (identity.adjustment !== undefined && identity.adjustment !== "none")
    || (identity.backadjustment !== undefined && identity.backadjustment !== "inherit" && identity.backadjustment !== "off")
    || (identity.settlementAsClose !== undefined && identity.settlementAsClose !== "inherit" && identity.settlementAsClose !== "off")
    || identity.transform !== undefined;
}

function normalizeTransform(transform: LumenChartsTickerTransform): LumenChartsTickerTransform {
  switch (transform.kind) {
    case "heikinashi": return Object.freeze({ kind: "heikinashi" });
    case "renko": {
      const style = normalizeLumenChartsTickerStyle(transform.style);
      if (typeof transform.requestWicks !== "boolean") throw new Error("Renko request_wicks must be a boolean");
      return Object.freeze({
        kind: "renko",
        style,
        param: normalizeLumenChartsTickerNumber(transform.param, "Renko param", style === "atr", style === "atr" ? 10_000 : MAX_PARAMETER),
        requestWicks: transform.requestWicks,
        source: normalizeLumenChartsTickerSource(transform.source, "renko") as "close" | "ohlc",
      });
    }
    case "kagi": return Object.freeze({ kind: "kagi", reversal: normalizeLumenChartsTickerNumber(transform.reversal, "Kagi reversal") });
    case "linebreak": return Object.freeze({ kind: "linebreak", lines: normalizeLumenChartsTickerNumber(transform.lines, "Line Break lines", true, 1_000) });
    case "pointfigure": {
      const style = normalizeLumenChartsTickerStyle(transform.style);
      return Object.freeze({
        kind: "pointfigure",
        source: normalizeLumenChartsTickerSource(transform.source, "pointfigure") as "close" | "hl",
        style,
        param: normalizeLumenChartsTickerNumber(transform.param, "Point & Figure param", style === "atr", style === "atr" ? 10_000 : MAX_PARAMETER),
        reversal: normalizeLumenChartsTickerNumber(transform.reversal, "Point & Figure reversal", true, 1_000),
      });
    }
  }
}

function encodeTransform(transform: LumenChartsTickerTransform): EncodedTransform {
  switch (transform.kind) {
    case "heikinashi": return ["heikinashi"];
    case "renko": return ["renko", transform.style, transform.param, transform.requestWicks, transform.source];
    case "kagi": return ["kagi", transform.reversal];
    case "linebreak": return ["linebreak", transform.lines];
    case "pointfigure": return ["pointfigure", transform.source, transform.style, transform.param, transform.reversal];
  }
}

function decodeTransform(value: unknown): LumenChartsTickerTransform {
  if (!Array.isArray(value) || typeof value[0] !== "string") throw new Error("Invalid Lumen Charts ticker transform");
  if (value[0] === "heikinashi" && value.length === 1) return { kind: "heikinashi" };
  if (value[0] === "renko" && value.length === 5 && typeof value[3] === "boolean") {
    const style = normalizeLumenChartsTickerStyle(value[1]);
    return {
      kind: "renko",
      style,
      param: normalizeLumenChartsTickerNumber(value[2], "Renko param", style === "atr", style === "atr" ? 10_000 : MAX_PARAMETER),
      requestWicks: value[3],
      source: normalizeLumenChartsTickerSource(value[4], "renko") as "close" | "ohlc",
    };
  }
  if (value[0] === "kagi" && value.length === 2) return { kind: "kagi", reversal: normalizeLumenChartsTickerNumber(value[1], "Kagi reversal") };
  if (value[0] === "linebreak" && value.length === 2) return { kind: "linebreak", lines: normalizeLumenChartsTickerNumber(value[1], "Line Break lines", true, 1_000) };
  if (value[0] === "pointfigure" && value.length === 5) {
    const style = normalizeLumenChartsTickerStyle(value[2]);
    return {
      kind: "pointfigure",
      source: normalizeLumenChartsTickerSource(value[1], "pointfigure") as "close" | "hl",
      style,
      param: normalizeLumenChartsTickerNumber(value[3], "Point & Figure param", style === "atr", style === "atr" ? 10_000 : MAX_PARAMETER),
      reversal: normalizeLumenChartsTickerNumber(value[4], "Point & Figure reversal", true, 1_000),
    };
  }
  throw new Error("Invalid Lumen Charts ticker transform");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Ticker ${field} must be a string`);
  return value;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`Invalid ticker ${field}`);
  return value as T;
}
