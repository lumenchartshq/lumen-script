import { PINE_CHART_FIELD_REQUIREMENTS } from "./runtime-requirements.js";
import { PINE_DRAWING_CALL_SIGNATURES, PINE_STRATEGY_CALL_SIGNATURES } from "./builtin-signatures.js";
import { PINE_PRODUCTION_CALLABLE_OVERRIDES, PINE_KNOWN_CALLABLE_METADATA, type PineCallableDefinition, type PineCallableOverloadDefinition } from "./callable-metadata.js";
import { freezeCallableDefinition, validateCallableDefinition } from "./callable-schema.js";
import { PINE_CONSTANT_NAMES, PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES } from "./constant-names.js";
import { PINE_CERTIFIED_STRATEGY_TRADE_CALLS } from "./strategy-trade-fields.js";
import { PINE_COMPATIBILITY, isStrictPineCompatibility, type PineCompatibility } from "./compatibility.js";

export const PINE_MARKET_FIELDS = Object.freeze([
  "open", "high", "low", "close", "volume", "time", "time_close", "hl2", "hlc3", "ohlc4", "hlcc4",
] as const);

export const PINE_TIME_COMPONENT_FIELDS = Object.freeze([
  "dayofmonth", "dayofweek", "hour", "minute", "month", "second", "weekofyear", "year",
] as const);

export const PINE_RUNTIME_FIELDS = Object.freeze(["last_bar_index", "last_bar_time", "time_tradingday"] as const);

export const PINE_PRODUCTION_RUNTIME_FIELDS = Object.freeze([
  ...PINE_RUNTIME_FIELDS,
  "timenow",
] as const);

/**
 * Canonical production plot/input display bitmask, including Pine Screener.
 * Keep these numeric values stable at the chart contract boundary.
 */
export const PINE_DISPLAY_MASKS = Object.freeze({
  none: 0,
  pane: 1,
  status_line: 2,
  price_scale: 4,
  data_window: 8,
  pine_screener: 16,
  all: 31,
} as const);

export const PINE_ZERO_ARGUMENT_CALLS = Object.freeze([
  "ta.accdist", "ta.iii", "ta.nvi", "ta.obv", "ta.pvi", "ta.pvt", "ta.tr", "ta.vwap", "ta.wad", "ta.wvad",
  "strategy.closedtrades.first_index", "strategy.opentrades.capital_held",
] as const);

export const PINE_NAMESPACE_CALL_ROOTS = Object.freeze([
  "array", "color", "map", "math", "matrix", "str", "strategy", "ta", "timeframe",
] as const);

export const PINE_PRODUCTION_NAMESPACE_CALL_ROOTS = Object.freeze([
  ...PINE_NAMESPACE_CALL_ROOTS,
  "footprint",
  "runtime",
  "syminfo",
  "ticker",
  "volume_row",
] as const);

export const PINE_BACKFILLABLE_CALLS = Object.freeze([
  "ta.sma", "ta.wma", "ta.alma", "ta.linreg", "ta.change", "ta.mom", "ta.roc", "ta.highest", "ta.lowest",
  "ta.variance", "ta.stdev", "ta.dev", "ta.median", "ta.cci",
] as const);

const builtinNames = [
  "alert", "alertcondition", "barcolor", "bgcolor", "fill", "fixnan", "hline", "indicator", "input", "input.bool", "input.color", "input.enum", "input.float", "input.int", "input.price", "input.session", "input.source", "input.string", "input.symbol", "input.text_area", "input.time", "input.timeframe", "library", "nz", "plot", "plotarrow", "plotbar", "plotcandle", "plotchar", "plotshape", "request.security", "request.security_lower_tf", "strategy", "strategy.cancel", "strategy.cancel_all", "strategy.close", "strategy.close_all", "strategy.convert_to_account", "strategy.convert_to_symbol", "strategy.default_entry_qty", "strategy.entry", "strategy.exit", "strategy.order", "strategy.risk.allow_entry_in", "strategy.risk.max_cons_loss_days", "strategy.risk.max_drawdown", "strategy.risk.max_intraday_filled_orders", "strategy.risk.max_intraday_loss", "strategy.risk.max_position_size", "strategy.closedtrades.first_index", "strategy.opentrades.capital_held", "timestamp",
  "array.abs", "array.avg", "array.binary_search", "array.binary_search_leftmost", "array.binary_search_rightmost", "array.clear", "array.concat", "array.copy", "array.covariance", "array.every", "array.fill", "array.first", "array.from", "array.get", "array.includes", "array.indexof", "array.insert", "array.join", "array.last", "array.lastindexof", "array.max", "array.median", "array.min", "array.mode", "array.new", "array.new_bool", "array.new_box", "array.new_color", "array.new_float", "array.new_int", "array.new_label", "array.new_line", "array.new_linefill", "array.new_string", "array.new_table", "array.percentile_linear_interpolation", "array.percentile_nearest_rank", "array.percentrank", "array.pop", "array.push", "array.range", "array.remove", "array.reverse", "array.set", "array.shift", "array.size", "array.slice", "array.some", "array.sort", "array.sort_indices", "array.standardize", "array.stdev", "array.sum", "array.unshift", "array.variance",
  "map.clear", "map.contains", "map.copy", "map.get", "map.keys", "map.new", "map.put", "map.put_all", "map.remove", "map.size", "map.values",
  "matrix.add_col", "matrix.add_row", "matrix.avg", "matrix.col", "matrix.columns", "matrix.concat", "matrix.copy", "matrix.det", "matrix.diff", "matrix.eigenvalues", "matrix.eigenvectors", "matrix.elements_count", "matrix.fill", "matrix.get", "matrix.inv", "matrix.is_antidiagonal", "matrix.is_antisymmetric", "matrix.is_binary", "matrix.is_diagonal", "matrix.is_identity", "matrix.is_square", "matrix.is_stochastic", "matrix.is_symmetric", "matrix.is_triangular", "matrix.is_zero", "matrix.kron", "matrix.max", "matrix.median", "matrix.min", "matrix.mode", "matrix.mult", "matrix.new", "matrix.pinv", "matrix.pow", "matrix.rank", "matrix.remove_col", "matrix.remove_row", "matrix.reshape", "matrix.reverse", "matrix.row", "matrix.rows", "matrix.set", "matrix.sort", "matrix.submatrix", "matrix.sum", "matrix.swap_columns", "matrix.swap_rows", "matrix.trace", "matrix.transpose",
  "ta.accdist", "ta.alma", "ta.atr", "ta.barssince", "ta.bb", "ta.bbw", "ta.cci", "ta.change", "ta.cmo", "ta.cog", "ta.correlation", "ta.cross", "ta.crossover", "ta.crossunder", "ta.cum", "ta.dev", "ta.dmi", "ta.ema", "ta.falling", "ta.highest", "ta.highestbars", "ta.hma", "ta.iii", "ta.kc", "ta.kcw", "ta.linreg", "ta.lowest", "ta.lowestbars", "ta.macd", "ta.max", "ta.median", "ta.mfi", "ta.min", "ta.mode", "ta.mom", "ta.nvi", "ta.obv", "ta.percentile_linear_interpolation", "ta.percentile_nearest_rank", "ta.percentrank", "ta.pivot_point_levels", "ta.pivothigh", "ta.pivotlow", "ta.pvi", "ta.pvt", "ta.range", "ta.rci", "ta.rising", "ta.rma", "ta.roc", "ta.rsi", "ta.sar", "ta.sma", "ta.stdev", "ta.stoch", "ta.supertrend", "ta.swma", "ta.tr", "ta.tsi", "ta.valuewhen", "ta.variance", "ta.vwap", "ta.vwma", "ta.wad", "ta.wma", "ta.wpr", "ta.wvad",
  "math.abs", "math.acos", "math.asin", "math.atan", "math.avg", "math.ceil", "math.cos", "math.exp", "math.floor", "math.ln", "math.log", "math.log10", "math.max", "math.min", "math.pow", "math.random", "math.round", "math.round_to_mintick", "math.sign", "math.sin", "math.sqrt", "math.sum", "math.tan", "math.todegrees", "math.toradians",
  "str.contains", "str.endswith", "str.format", "str.length", "str.lower", "str.match", "str.pos", "str.replace", "str.replace_all", "str.split", "str.startswith", "str.substring", "str.tonumber", "str.tostring", "str.trim", "str.upper",
  "color.b", "color.from_gradient", "color.g", "color.new", "color.r", "color.rgb", "color.t",
  "line.new", "line.copy", "line.delete", "line.get_price", "line.get_x1", "line.get_x2", "line.get_y1", "line.get_y2", "line.set_color", "line.set_extend", "line.set_first_point", "line.set_second_point", "line.set_style", "line.set_width", "line.set_x1", "line.set_x2", "line.set_xloc", "line.set_xy1", "line.set_xy2", "line.set_y1", "line.set_y2",
  "label.new", "label.copy", "label.delete", "label.get_text", "label.get_x", "label.get_y", "label.set_color", "label.set_point", "label.set_size", "label.set_style", "label.set_text", "label.set_text_font_family", "label.set_text_formatting", "label.set_textalign", "label.set_textcolor", "label.set_tooltip", "label.set_x", "label.set_xloc", "label.set_xy", "label.set_y", "label.set_yloc",
  "box.new", "box.copy", "box.delete", "box.get_bottom", "box.get_left", "box.get_right", "box.get_top", "box.set_bgcolor", "box.set_border_color", "box.set_border_style", "box.set_border_width", "box.set_bottom", "box.set_bottom_right_point", "box.set_extend", "box.set_left", "box.set_lefttop", "box.set_right", "box.set_rightbottom", "box.set_text", "box.set_text_color", "box.set_text_font_family", "box.set_text_formatting", "box.set_text_halign", "box.set_text_size", "box.set_text_valign", "box.set_text_wrap", "box.set_top", "box.set_top_left_point", "box.set_xloc",
  "chart.point.copy", "chart.point.from_index", "chart.point.from_time", "chart.point.new", "chart.point.now", "polyline.new", "polyline.delete", "linefill.new", "linefill.delete", "linefill.get_line1", "linefill.get_line2", "linefill.set_color",
  "table.new", "table.cell", "table.cell_set_bgcolor", "table.cell_set_height", "table.cell_set_text", "table.cell_set_text_color", "table.cell_set_text_font_family", "table.cell_set_text_formatting", "table.cell_set_text_halign", "table.cell_set_text_size", "table.cell_set_text_valign", "table.cell_set_tooltip", "table.cell_set_width", "table.clear", "table.delete", "table.merge_cells", "table.set_bgcolor", "table.set_border_color", "table.set_border_width", "table.set_frame_color", "table.set_frame_width", "table.set_position",
] as const;

const builtinVariables = [
  ...PINE_CONSTANT_NAMES,
  "bar_index", "barstate.isconfirmed", "barstate.isfirst", "barstate.ishistory", "barstate.islast", "barstate.islastconfirmedhistory", "barstate.isnew", "barstate.isrealtime", "close", "dayofmonth", "dayofweek", "high", "hour", "last_bar_index", "last_bar_time", "low", "math.e", "math.phi", "math.pi", "math.rphi", "minute", "month", "open", "second", "strategy.account_currency", "strategy.avg_losing_trade", "strategy.avg_losing_trade_percent", "strategy.avg_trade", "strategy.avg_trade_percent", "strategy.avg_winning_trade", "strategy.avg_winning_trade_percent", "strategy.cash", "strategy.closedtrades", "strategy.equity", "strategy.eventrades", "strategy.fixed", "strategy.grossloss", "strategy.grossloss_percent", "strategy.grossprofit", "strategy.grossprofit_percent", "strategy.initial_capital", "strategy.long", "strategy.losstrades", "strategy.margin_liquidation_price", "strategy.max_contracts_held_all", "strategy.max_contracts_held_long", "strategy.max_contracts_held_short", "strategy.max_drawdown", "strategy.max_drawdown_percent", "strategy.max_runup", "strategy.max_runup_percent", "strategy.netprofit", "strategy.netprofit_percent", "strategy.openprofit", "strategy.openprofit_percent", "strategy.opentrades", "strategy.percent_of_equity", "strategy.position_avg_price", "strategy.position_entry_name", "strategy.position_size", "strategy.risk", "strategy.short", "strategy.wintrades", "syminfo.currency", "syminfo.description", "syminfo.mintick", "syminfo.prefix", "syminfo.root", "syminfo.session", "syminfo.ticker", "syminfo.tickerid", "syminfo.timezone", "ta.vwap", "time", "time_close", "time_tradingday", "timeframe.isdaily", "timeframe.isintraday", "timeframe.ismonthly", "timeframe.isweekly", "timeframe.main_period", "timeframe.multiplier", "timeframe.period", "volume", "weekofyear", "year",
] as const;

const productionBuiltinNames = [
  ...builtinNames,
  ...PINE_CERTIFIED_STRATEGY_TRADE_CALLS,
  ...PINE_TIME_COMPONENT_FIELDS,
  "box",
  "bool",
  "color",
  "float",
  "int",
  "label",
  "line",
  "linefill",
  "log.error",
  "log.info",
  "log.warning",
  "max_bars_back",
  "na",
  "request.footprint",
  "footprint.total_volume",
  "footprint.buy_volume",
  "footprint.sell_volume",
  "footprint.delta",
  "footprint.rows",
  "footprint.poc",
  "footprint.vah",
  "footprint.val",
  "footprint.get_row_by_price",
  "volume_row.up_price",
  "volume_row.down_price",
  "volume_row.total_volume",
  "volume_row.buy_volume",
  "volume_row.sell_volume",
  "volume_row.delta",
  "volume_row.has_buy_imbalance",
  "volume_row.has_sell_imbalance",
  "polyline",
  "runtime.error",
  "str.format_time",
  "str.repeat",
  "string",
  "syminfo.prefix",
  "syminfo.ticker",
  "table",
  "ticker.heikinashi",
  "ticker.inherit",
  "ticker.kagi",
  "ticker.linebreak",
  "ticker.modify",
  "ticker.new",
  "ticker.pointfigure",
  "ticker.renko",
  "ticker.standard",
  "time",
  "time_close",
  "timeframe.change",
  "timeframe.from_seconds",
  "timeframe.in_seconds",
] as const;
const productionBuiltinVariables = [
  ...builtinVariables,
  "strategy.closedtrades.first_index",
  "strategy.opentrades.capital_held",
  ...PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES,
  ...Object.keys(PINE_CHART_FIELD_REQUIREMENTS),
  "session.extended",
  "session.isfirstbar",
  "session.isfirstbar_regular",
  "session.islastbar",
  "session.islastbar_regular",
  "session.ismarket",
  "session.ispostmarket",
  "session.ispremarket",
  "session.regular",
  "syminfo.basecurrency",
  "syminfo.country",
  "syminfo.current_contract",
  "syminfo.employees",
  "syminfo.industry",
  "syminfo.isin",
  "syminfo.main_tickerid",
  "syminfo.mincontract",
  "syminfo.minmove",
  "syminfo.pointvalue",
  "syminfo.pricescale",
  "syminfo.sector",
  "syminfo.shareholders",
  "syminfo.type",
  "syminfo.volumetype",
  "timenow",
  "timeframe.isdwm",
  "timeframe.isminutes",
  "timeframe.isseconds",
  "timeframe.isticks",
] as const;

export interface PineBuiltinSpec {
  readonly name: string;
  readonly namespace: string | undefined;
  readonly form: "call" | "variable";
  readonly zeroArgument: boolean;
  readonly backfillable: boolean;
  readonly category: string;
  readonly callable?: PineCallableDefinition;
}

export interface PineBuiltinCatalog {
  readonly compatibility: PineCompatibility;
  readonly version: string;
  readonly builtins: readonly string[];
  readonly variables: readonly string[];
}

export const PINE_BUILTIN_CATALOG: PineBuiltinCatalog = Object.freeze({
  compatibility: PINE_COMPATIBILITY.legacy,
  version: "v5.2",
  builtins: Object.freeze([...new Set(builtinNames)].sort()),
  variables: Object.freeze([...new Set(builtinVariables)].sort()),
});

export const PINE_PRODUCTION_BUILTIN_CATALOG: PineBuiltinCatalog = Object.freeze({
  compatibility: PINE_COMPATIBILITY.strict,
  version: "v5.28",
  builtins: Object.freeze([...new Set(productionBuiltinNames)].sort()),
  variables: Object.freeze([...new Set(productionBuiltinVariables)].sort()),
});

export const PINE_BUILTIN_CATALOGS = Object.freeze({
  [PINE_COMPATIBILITY.legacy]: PINE_BUILTIN_CATALOG,
  [PINE_COMPATIBILITY.strict]: PINE_PRODUCTION_BUILTIN_CATALOG,
});

export function pineBuiltinCatalog(
  compatibility: keyof typeof PINE_BUILTIN_CATALOGS,
): PineBuiltinCatalog {
  return PINE_BUILTIN_CATALOGS[compatibility];
}

export function pineRuntimeFields(
  compatibility: keyof typeof PINE_BUILTIN_CATALOGS,
): readonly string[] {
  return isStrictPineCompatibility(compatibility) ? PINE_PRODUCTION_RUNTIME_FIELDS : PINE_RUNTIME_FIELDS;
}

export function pineNamespaceCallRoots(
  compatibility: keyof typeof PINE_BUILTIN_CATALOGS,
): readonly string[] {
  return isStrictPineCompatibility(compatibility) ? PINE_PRODUCTION_NAMESPACE_CALL_ROOTS : PINE_NAMESPACE_CALL_ROOTS;
}

const zeroArgumentNames = new Set<string>(PINE_ZERO_ARGUMENT_CALLS);
const backfillableNames = new Set<string>(PINE_BACKFILLABLE_CALLS);
const callSignatures: Readonly<Record<string, readonly string[]>> = { ...PINE_DRAWING_CALL_SIGNATURES, ...PINE_STRATEGY_CALL_SIGNATURES };

function buildCallableMetadata(catalog: PineBuiltinCatalog): Readonly<Record<string, PineCallableDefinition>> {
  return Object.freeze(Object.fromEntries(catalog.builtins.map((name) => {
    const known = (isStrictPineCompatibility(catalog.compatibility) ? PINE_PRODUCTION_CALLABLE_OVERRIDES[name] : undefined) ?? PINE_KNOWN_CALLABLE_METADATA[name];
    // Production has one signature owner. The historical overlay belongs only
    // to the sealed compatibility profile.
    const production = isStrictPineCompatibility(catalog.compatibility);
    if (production && known !== undefined) {
      validateCallableDefinition(name, known);
      return [name, freezeCallableDefinition(known)];
    }
    const parameters = callSignatures[name] ?? known?.parameters ?? [];
    const additionalOptional = known === undefined ? [] : parameters.filter((parameter) => !known.parameters.includes(parameter));
    const optionalParameters = [...new Set([...(known?.optionalParameters ?? []), ...additionalOptional])];
    const definition = {
      parameters: Object.freeze([...parameters]),
      ...(optionalParameters.length === 0 ? {} : { optionalParameters: Object.freeze(optionalParameters) }),
      ...(known?.overloads === undefined ? {} : { overloads: known.overloads }),
      ...(known?.variadicParameter === undefined ? {} : { variadicParameter: known.variadicParameter }),
      ...(known?.typedOverloads !== undefined
        ? { typedOverloads: known.typedOverloads }
        : callSignatures[name] === undefined ? {} : { typedOverloads: genericTypedOverload(parameters, optionalParameters) }),
      returnType: known?.returnType ?? "unknown",
      documentation: known?.documentation ?? `Provides the supported ${name} operation; its overload metadata is not yet specialized.`,
      signatureStatus: known !== undefined || callSignatures[name] !== undefined ? "complete" as const : "unspecified" as const,
    } satisfies PineCallableDefinition;
    if (production) validateCallableDefinition(name, definition);
    return [name, freezeCallableDefinition(definition)];
  })));
}

export const PINE_CALLABLE_METADATA = buildCallableMetadata(PINE_BUILTIN_CATALOG);
export const PINE_PRODUCTION_CALLABLE_METADATA = buildCallableMetadata(PINE_PRODUCTION_BUILTIN_CATALOG);

export const PINE_CALLABLE_METADATA_BY_PROFILE = Object.freeze({
  [PINE_COMPATIBILITY.legacy]: PINE_CALLABLE_METADATA,
  [PINE_COMPATIBILITY.strict]: PINE_PRODUCTION_CALLABLE_METADATA,
});

export function pineCallableMetadata(
  compatibility: keyof typeof PINE_CALLABLE_METADATA_BY_PROFILE,
): Readonly<Record<string, PineCallableDefinition>> {
  return PINE_CALLABLE_METADATA_BY_PROFILE[compatibility];
}

function genericTypedOverload(parameters: readonly string[], optionalParameters: readonly string[]): readonly PineCallableOverloadDefinition[] {
  const optional = new Set(optionalParameters);
  return [{
    parameters: parameters.map((name) => ({
      name,
      type: { kind: "unknown", qualifier: "series" },
      ...(optional.has(name) ? { optional: true } : {}),
    })),
    returnType: { kind: "unknown", qualifier: "series" },
  }];
}

function buildBuiltinRegistry(
  catalog: PineBuiltinCatalog,
  callableMetadata: Readonly<Record<string, PineCallableDefinition>>,
): readonly PineBuiltinSpec[] {
  return Object.freeze([
    ...catalog.builtins.map((name) => Object.freeze({
      name,
      namespace: name.includes(".") ? name.slice(0, name.indexOf(".")) : undefined,
      form: "call" as const,
      zeroArgument: zeroArgumentNames.has(name),
      backfillable: backfillableNames.has(name),
      category: name.includes(".") ? name.slice(0, name.indexOf(".")) : "global",
      callable: callableMetadata[name]!,
    })),
    ...catalog.variables.map((name) => Object.freeze({
      name,
      namespace: name.includes(".") ? name.slice(0, name.indexOf(".")) : undefined,
      form: "variable" as const,
      zeroArgument: false,
      backfillable: false,
      category: name.includes(".") ? name.slice(0, name.indexOf(".")) : "global",
    })),
  ]);
}

export const PINE_BUILTIN_REGISTRY = buildBuiltinRegistry(PINE_BUILTIN_CATALOG, PINE_CALLABLE_METADATA);
export const PINE_PRODUCTION_BUILTIN_REGISTRY = buildBuiltinRegistry(PINE_PRODUCTION_BUILTIN_CATALOG, PINE_PRODUCTION_CALLABLE_METADATA);

export const PINE_BUILTIN_REGISTRIES = Object.freeze({
  [PINE_COMPATIBILITY.legacy]: PINE_BUILTIN_REGISTRY,
  [PINE_COMPATIBILITY.strict]: PINE_PRODUCTION_BUILTIN_REGISTRY,
});

export function pineBuiltinRegistry(
  compatibility: keyof typeof PINE_BUILTIN_REGISTRIES,
): readonly PineBuiltinSpec[] {
  return PINE_BUILTIN_REGISTRIES[compatibility];
}
