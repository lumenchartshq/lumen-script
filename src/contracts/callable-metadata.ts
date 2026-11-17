import { PINE_FILL_CALL_SIGNATURES, PINE_PLOT_CALL_SIGNATURES, PINE_STRATEGY_CALL_SIGNATURES } from "./builtin-signatures.js";
import type { PineQualifiedType } from "./index.js";
import { deriveTypedOverloads, type PineCallableDefinition, type PineCallableOverloadDefinition, type PineCallableParameterDefinition } from "./callable-schema.js";
import { PINE_CERTIFIED_STRATEGY_TRADE_CALLS } from "./strategy-trade-fields.js";
export type { PineCallableDefinition, PineCallableOverloadDefinition, PineCallableParameterDefinition } from "./callable-schema.js";

const definitions: Record<string, PineCallableDefinition> = Object.create(null) as Record<string, PineCallableDefinition>;
const seriesString = { kind: "string", qualifier: "series" } as const;
const seriesInt = { kind: "int", qualifier: "series" } as const;
const seriesBool = { kind: "bool", qualifier: "series" } as const;
const seriesFloat = { kind: "float", qualifier: "series" } as const;
const seriesColor = { kind: "color", qualifier: "series" } as const;
const seriesUnknown = { kind: "unknown", qualifier: "series" } as const;
const seriesVoid = { kind: "void", qualifier: "series" } as const;
const seriesLine = { kind: "reference", name: "line", qualifier: "series" } as const;
const seriesTable = { kind: "reference", name: "table", qualifier: "series" } as const;
const seriesBox = { kind: "reference", name: "box", qualifier: "series" } as const;
const seriesLabel = { kind: "reference", name: "label", qualifier: "series" } as const;
const seriesPoint = { kind: "reference", name: "chart.point", qualifier: "series" } as const;
const seriesLinefill = { kind: "reference", name: "linefill", qualifier: "series" } as const;
const seriesPolyline = { kind: "reference", name: "polyline", qualifier: "series" } as const;
const seriesFootprint = { kind: "reference", name: "footprint", qualifier: "series" } as const;
const seriesVolumeRow = { kind: "reference", name: "volume_row", qualifier: "series" } as const;
const seriesVolumeRows = { kind: "array", qualifier: "series", arguments: [seriesVolumeRow] } as const;
const seriesPoints = { kind: "array", qualifier: "series", arguments: [seriesPoint] } as const;
const seriesPlot = { kind: "plot", name: "plot", qualifier: "series" } as const;
const seriesHline = { kind: "hline", name: "hline", qualifier: "series" } as const;
const inputFloat = { kind: "float", qualifier: "input" } as const;
const inputColor = { kind: "color", qualifier: "input" } as const;
const inputString = { kind: "string", qualifier: "input" } as const;
const inputInt = { kind: "int", qualifier: "input" } as const;
const simpleString = { kind: "string", qualifier: "simple" } as const;
const simpleInt = { kind: "int", qualifier: "simple" } as const;
const simpleFloat = { kind: "float", qualifier: "simple" } as const;
const simpleBool = { kind: "bool", qualifier: "simple" } as const;
const constString = { kind: "string", qualifier: "const" } as const;
const constInt = { kind: "int", qualifier: "const" } as const;
const constBool = { kind: "bool", qualifier: "const" } as const;
const constFloat = { kind: "float", qualifier: "const" } as const;
const constHline = { kind: "hline", qualifier: "series" } as const;
const returnSeriesString = "series string";
const returnSeriesInt = "series int";
const returnSeriesBool = "series bool";
const returnSeriesFloat = "series float";

function define(names: readonly string[], definition: Omit<PineCallableDefinition, "documentation" | "signatureStatus"> & { documentation?: string }) {
  for (const name of names) {
    if (definitions[name]) throw new Error(`Duplicate callable metadata for ${name}`);
    definitions[name] = Object.freeze({
      ...definition,
      documentation: definition.documentation ?? `Provides the supported ${name} operation.`,
      signatureStatus: "complete",
      typedOverloads: definition.typedOverloads ?? deriveTypedOverloads(definition),
    });
  }
}

function declarationTypes(
  parameters: readonly string[],
  types: Readonly<Record<string, PineQualifiedType>>,
): readonly PineCallableOverloadDefinition[] {
  return [{
    parameters: parameters.map((name) => ({ name, type: types[name]!, ...(name === "title" ? {} : { optional: true }) })),
    returnType: seriesVoid,
  }];
}

const declarationOptionTypes: Readonly<Record<string, PineQualifiedType>> = {
  title: constString, shorttitle: constString, overlay: constBool, format: constString,
  precision: constInt, scale: constString, max_bars_back: constInt,
  timeframe: constString, timeframe_gaps: constBool, explicit_plot_zorder: constBool,
  max_lines_count: constInt, max_labels_count: constInt, max_boxes_count: constInt,
  max_polylines_count: constInt, dynamic_requests: constBool, behind_chart: constBool,
  pyramiding: constInt, calc_on_order_fills: constBool, calc_on_every_tick: constBool,
  backtest_fill_limits_assumption: constInt, default_qty_type: constString,
  default_qty_value: constFloat, initial_capital: constFloat, currency: constString,
  slippage: constInt, commission_type: constString, commission_value: constFloat,
  process_orders_on_close: constBool, close_entries_rule: constString,
  margin_long: constFloat, margin_short: constFloat, risk_free_rate: constFloat,
  use_bar_magnifier: constBool, fill_orders_on_standard_ohlc: constBool,
};

define(["alert"], { parameters: ["message", "freq"], optionalParameters: ["freq"], returnType: "void", typedOverloads: [{ parameters: [{ name: "message", type: seriesString }, { name: "freq", type: simpleString, optional: true }], returnType: seriesVoid }], documentation: "Triggers an alert event with a message." });
define(["alertcondition"], { parameters: ["condition", "title", "message"], optionalParameters: ["title", "message"], returnType: "void", typedOverloads: [{ parameters: [{ name: "condition", type: seriesBool }, { name: "title", type: constString, optional: true }, { name: "message", type: constString, optional: true }], returnType: seriesVoid }], documentation: "Declares a condition that can trigger an alert." });
define(["box"], { parameters: ["value"], returnType: "box", typedOverloads: [{ parameters: [{ name: "value", type: seriesBox }], returnType: seriesBox }], documentation: "Casts an unavailable value or box reference to box." });
define(["bool"], { parameters: ["value"], returnType: returnSeriesBool, documentation: "Casts a value to bool." });
define(["color"], { parameters: ["value"], returnType: "series color", documentation: "Casts a value to color." });
define(["float"], { parameters: ["value"], returnType: returnSeriesFloat, documentation: "Casts a value to float." });
define(["int"], { parameters: ["value"], returnType: returnSeriesInt, documentation: "Casts a value to int." });
define(["label"], { parameters: ["value"], returnType: "label", typedOverloads: [{ parameters: [{ name: "value", type: seriesLabel }], returnType: seriesLabel }], documentation: "Casts an unavailable value or label reference to label." });
define(["line"], { parameters: ["value"], returnType: "line", typedOverloads: [{ parameters: [{ name: "value", type: seriesLine }], returnType: seriesLine }], documentation: "Casts an unavailable value or line reference to line." });
define(["linefill"], { parameters: ["value"], returnType: "linefill", typedOverloads: [{ parameters: [{ name: "value", type: seriesLinefill }], returnType: seriesLinefill }], documentation: "Casts an unavailable value or linefill reference to linefill." });
define(["log.info", "log.warning", "log.error"], {
  parameters: ["message"],
  overloads: [["message"], ["formatString", "arg0"]],
  variadicParameter: "arg",
  returnType: "void",
  typedOverloads: [
    {
      parameters: [{ name: "message", type: seriesString }],
      variadicParameter: { name: "arg", type: seriesUnknown },
      returnType: seriesVoid,
    },
    {
      parameters: [
        { name: "formatString", type: seriesString },
        { name: "arg0", type: seriesUnknown },
      ],
      variadicParameter: { name: "arg", type: seriesUnknown },
      returnType: seriesVoid,
    },
  ],
  documentation: "Creates a script log message at the chosen level.",
});
define(["na"], { parameters: ["value"], returnType: returnSeriesBool, documentation: "Returns whether a value is unavailable." });
define(["polyline"], { parameters: ["value"], returnType: "polyline", documentation: "Casts an unavailable value or polyline reference to polyline." });
define(["runtime.error"], { parameters: ["message"], returnType: "void", typedOverloads: [{ parameters: [{ name: "message", type: seriesString }], returnType: seriesVoid }], documentation: "Stops script execution with the supplied runtime error message." });
define(["string"], { parameters: ["value"], returnType: returnSeriesString, documentation: "Casts a value to string." });
define(["table"], { parameters: ["value"], returnType: "table", typedOverloads: [{ parameters: [{ name: "value", type: seriesTable }], returnType: seriesTable }], documentation: "Casts an unavailable value or table reference to table." });
define(["barcolor"], { parameters: ["color", "offset", "editable", "show_last", "title", "display"], optionalParameters: ["offset", "editable", "show_last", "title", "display"], returnType: "void" });
define(["bgcolor"], { parameters: ["color", "offset", "editable", "show_last", "title", "display", "force_overlay"], optionalParameters: ["offset", "editable", "show_last", "title", "display", "force_overlay"], returnType: "void" });
define(["fill"], {
  parameters: PINE_FILL_CALL_SIGNATURES.plot,
  optionalParameters: ["color", "title", "editable", "show_last", "fillgaps", "display"],
  overloads: [PINE_FILL_CALL_SIGNATURES.plot, PINE_FILL_CALL_SIGNATURES.hline, PINE_FILL_CALL_SIGNATURES.gradient, PINE_FILL_CALL_SIGNATURES.gradientHline],
  typedOverloads: [
    [PINE_FILL_CALL_SIGNATURES.plot, seriesPlot],
    [PINE_FILL_CALL_SIGNATURES.hline, seriesHline],
    [PINE_FILL_CALL_SIGNATURES.gradient, seriesPlot],
    [PINE_FILL_CALL_SIGNATURES.gradientHline, seriesHline],
  ].map(([signature, handle]) => ({
    parameters: (signature as readonly string[]).map((name, index) => ({
      name,
      type: index < 2 ? handle as PineQualifiedType
        : name === "color" || name === "top_color" || name === "bottom_color" ? seriesColor
          : name === "top_value" || name === "bottom_value" ? seriesFloat
            : name === "title" ? constString
              : name === "editable" || name === "fillgaps" ? constBool
                : name === "show_last" ? inputInt : constInt,
      ...(["color", "title", "editable", "show_last", "fillgaps", "display"].includes(name) ? { optional: true } : {}),
    })),
    returnType: seriesVoid,
  })),
  returnType: "void",
  documentation: "Fills the area between two plot or hline identifiers.",
});
define(["fixnan"], { parameters: ["source"], returnType: "series" });
define(["hline"], { parameters: ["price", "title", "color", "linestyle", "linewidth", "editable", "display"], optionalParameters: ["title", "color", "linestyle", "linewidth", "editable", "display"], returnType: "hline",
  typedOverloads: [{ parameters: [
    { name: "price", type: inputFloat }, { name: "title", type: constString, optional: true },
    { name: "color", type: inputColor, optional: true }, { name: "linestyle", type: inputString, optional: true },
    { name: "linewidth", type: inputInt, optional: true }, { name: "editable", type: constBool, optional: true },
    { name: "display", type: constInt, optional: true },
  ], returnType: constHline }] });
const indicatorParameters = ["title", "shorttitle", "overlay", "format", "precision", "scale", "max_bars_back", "timeframe", "timeframe_gaps", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "max_polylines_count", "dynamic_requests", "behind_chart"] as const;
define(["indicator"], { parameters: indicatorParameters, optionalParameters: indicatorParameters.slice(1), returnType: "void", typedOverloads: declarationTypes(indicatorParameters, declarationOptionTypes), documentation: "Declares an indicator script and its chart behavior." });
define(["input"], { parameters: ["defval", "title", "tooltip", "inline", "group", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "display", "active"], returnType: "input" });
define(["input.bool"], { parameters: ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input bool" });
define(["input.color"], { parameters: ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input color" });
define(["input.enum"], { parameters: ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input enum" });
define(["input.session"], { parameters: ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input string" });
define(["input.float"], { parameters: ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active", "options"], overloads: [["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active"], ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"]], returnType: "input float" });
define(["input.int"], { parameters: ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active", "options"], overloads: [["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active"], ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"]], returnType: "input int" });
define(["input.price"], { parameters: ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input float" });
define(["input.symbol"], { parameters: ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input string" });
define(["input.source"], { parameters: ["defval", "title", "tooltip", "inline", "group", "display", "active", "confirm"], optionalParameters: ["title", "tooltip", "inline", "group", "display", "active", "confirm"], returnType: returnSeriesFloat });
define(["input.string", "input.timeframe"], { parameters: ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "options", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input string" });
define(["input.text_area"], { parameters: ["defval", "title", "tooltip", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "group", "confirm", "display", "active"], returnType: "input string" });
define(["input.time"], { parameters: ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"], optionalParameters: ["title", "tooltip", "inline", "group", "confirm", "display", "active"], returnType: "input int" });
const libraryParameters = ["title", "overlay", "dynamic_requests"] as const;
define(["library"], { parameters: libraryParameters, optionalParameters: libraryParameters.slice(1), returnType: "void", typedOverloads: declarationTypes(libraryParameters, declarationOptionTypes) });
define(["max_bars_back"], { parameters: ["var", "num"], returnType: "void", typedOverloads: [{ parameters: [{ name: "var", type: seriesUnknown }, { name: "num", type: constInt }], returnType: seriesVoid }], documentation: "Sets a minimum historical buffer size for an identified series." });
define(["nz"], { parameters: ["source", "replacement"], optionalParameters: ["replacement"], returnType: "series" });
define(["plot"], { parameters: PINE_PLOT_CALL_SIGNATURES.plot!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plot!.slice(1), returnType: "plot", documentation: "Plots a series on the chart and returns a plot identifier." });
define(["plotarrow"], { parameters: PINE_PLOT_CALL_SIGNATURES.plotarrow!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plotarrow!.slice(1), returnType: "void" });
define(["plotbar"], { parameters: PINE_PLOT_CALL_SIGNATURES.plotbar!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plotbar!.slice(4), returnType: "void" });
define(["plotcandle"], { parameters: PINE_PLOT_CALL_SIGNATURES.plotcandle!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plotcandle!.slice(4), returnType: "void" });
define(["plotchar"], { parameters: PINE_PLOT_CALL_SIGNATURES.plotchar!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plotchar!.slice(1), returnType: "void" });
define(["plotshape"], { parameters: PINE_PLOT_CALL_SIGNATURES.plotshape!, optionalParameters: PINE_PLOT_CALL_SIGNATURES.plotshape!.slice(1), returnType: "void" });
define(["request.security"], { parameters: ["symbol", "timeframe", "expression", "gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count"], optionalParameters: ["gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count"], returnType: "series", documentation: "Evaluates an expression on another symbol and timeframe." });
define(["request.security_lower_tf"], { parameters: ["symbol", "timeframe", "expression", "ignore_invalid_timeframe", "currency", "ignore_invalid_symbol", "calc_bars_count"], optionalParameters: ["ignore_invalid_timeframe", "currency", "ignore_invalid_symbol", "calc_bars_count"], returnType: "array", documentation: "Evaluates an expression on a lower timeframe." });
define(["request.footprint"], {
  parameters: ["ticks_per_row", "va_percent", "imbalance_percent"],
  optionalParameters: ["va_percent", "imbalance_percent"],
  returnType: "footprint",
  typedOverloads: [{
    parameters: [
      { name: "ticks_per_row", type: simpleInt },
      { name: "va_percent", type: simpleFloat, optional: true },
      { name: "imbalance_percent", type: simpleFloat, optional: true },
    ],
    returnType: seriesFootprint,
  }],
  documentation: "Selects the admitted volume footprint for the current chart bar.",
});
define([
  "footprint.total_volume", "footprint.buy_volume", "footprint.sell_volume", "footprint.delta",
], {
  parameters: ["id"],
  returnType: "series float",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesFootprint }], returnType: seriesFloat }],
});
define(["footprint.rows"], {
  parameters: ["id"],
  returnType: "array<volume_row>",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesFootprint }], returnType: seriesVolumeRows }],
});
define(["footprint.poc", "footprint.vah", "footprint.val"], {
  parameters: ["id"],
  returnType: "volume_row",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesFootprint }], returnType: seriesVolumeRow }],
});
define(["footprint.get_row_by_price"], {
  parameters: ["id", "price"],
  returnType: "volume_row",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesFootprint }, { name: "price", type: seriesFloat }], returnType: seriesVolumeRow }],
});
define(["volume_row.up_price", "volume_row.down_price", "volume_row.total_volume", "volume_row.buy_volume", "volume_row.sell_volume", "volume_row.delta"], {
  parameters: ["id"],
  returnType: "series float",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesVolumeRow }], returnType: seriesFloat }],
});
define(["volume_row.has_buy_imbalance", "volume_row.has_sell_imbalance"], {
  parameters: ["id"],
  returnType: "series bool",
  typedOverloads: [{ parameters: [{ name: "id", type: seriesVolumeRow }], returnType: seriesBool }],
});
define(["syminfo.prefix", "syminfo.ticker"], {
  parameters: ["symbol"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [{ name: "symbol", type: simpleString }],
    returnType: simpleString,
  }],
  documentation: "Returns the exchange prefix or unprefixed ticker from a plain or Lumen Charts extended ticker ID.",
});
define(["ticker.heikinashi"], {
  parameters: ["symbol"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [{ name: "symbol", type: simpleString }],
    returnType: simpleString,
  }],
  documentation: "Creates a versioned Lumen Charts Heikin-Ashi ticker identity.",
});
define(["ticker.inherit"], {
  parameters: ["from_tickerid", "symbol"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "from_tickerid", type: simpleString },
      { name: "symbol", type: simpleString },
    ],
    returnType: simpleString,
  }],
  documentation: "Copies Lumen Charts ticker modifiers onto another provider symbol.",
});
define(["ticker.kagi"], {
  parameters: ["symbol", "reversal"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: simpleString },
      { name: "reversal", type: simpleFloat },
    ],
    returnType: simpleString,
  }],
  documentation: "Creates a versioned Lumen Charts Kagi ticker identity.",
});
define(["ticker.linebreak"], {
  parameters: ["symbol", "number_of_lines"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: simpleString },
      { name: "number_of_lines", type: simpleInt },
    ],
    returnType: simpleString,
  }],
  documentation: "Creates a versioned Lumen Charts Line Break ticker identity.",
});
define(["ticker.new"], {
  parameters: ["prefix", "ticker", "session", "adjustment", "backadjustment", "settlement_as_close"],
  optionalParameters: ["session", "adjustment", "backadjustment", "settlement_as_close"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "prefix", type: simpleString },
      { name: "ticker", type: simpleString },
      { name: "session", type: simpleString, optional: true },
      { name: "adjustment", type: simpleString, optional: true },
      { name: "backadjustment", type: simpleString, optional: true },
      { name: "settlement_as_close", type: simpleString, optional: true },
    ],
    returnType: simpleString,
  }],
  documentation: "Creates a provider symbol with versioned Lumen Charts session and adjustment modifiers.",
});
define(["ticker.modify"], {
  parameters: ["tickerid", "session", "adjustment", "backadjustment", "settlement_as_close"],
  optionalParameters: ["session", "adjustment", "backadjustment", "settlement_as_close"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "tickerid", type: simpleString },
      { name: "session", type: simpleString, optional: true },
      { name: "adjustment", type: simpleString, optional: true },
      { name: "backadjustment", type: simpleString, optional: true },
      { name: "settlement_as_close", type: simpleString, optional: true },
    ],
    returnType: simpleString,
  }],
  documentation: "Applies versioned Lumen Charts session and adjustment modifiers to a ticker ID.",
});
define(["ticker.pointfigure"], {
  parameters: ["symbol", "source", "style", "param", "reversal"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: simpleString },
      { name: "source", type: simpleString },
      { name: "style", type: simpleString },
      { name: "param", type: simpleFloat },
      { name: "reversal", type: simpleInt },
    ],
    returnType: simpleString,
  }],
  documentation: "Creates a versioned Lumen Charts Point & Figure ticker identity.",
});
define(["ticker.renko"], {
  parameters: ["symbol", "style", "param", "request_wicks", "source"],
  optionalParameters: ["request_wicks", "source"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: simpleString },
      { name: "style", type: simpleString },
      { name: "param", type: simpleFloat },
      { name: "request_wicks", type: simpleBool, optional: true },
      { name: "source", type: simpleString, optional: true },
    ],
    returnType: simpleString,
  }],
  documentation: "Creates a versioned Lumen Charts Renko ticker identity.",
});
define(["ticker.standard"], {
  parameters: ["symbol"],
  returnType: "simple string",
  typedOverloads: [{
    parameters: [{ name: "symbol", type: simpleString }],
    returnType: simpleString,
  }],
  documentation: "Returns the provider symbol with all Lumen Charts ticker modifiers removed.",
});
const strategyParameters = ["title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding", "calc_on_order_fills", "calc_on_every_tick", "max_bars_back", "backtest_fill_limits_assumption", "default_qty_type", "default_qty_value", "initial_capital", "currency", "slippage", "commission_type", "commission_value", "process_orders_on_close", "close_entries_rule", "margin_long", "margin_short", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "risk_free_rate", "use_bar_magnifier", "fill_orders_on_standard_ohlc", "max_polylines_count", "dynamic_requests", "behind_chart"] as const;
define(["strategy"], { parameters: strategyParameters, optionalParameters: strategyParameters.slice(1), returnType: "void", typedOverloads: declarationTypes(strategyParameters, declarationOptionTypes) });
define(["strategy.cancel"], { parameters: ["id"], returnType: "void" });
define(["strategy.cancel_all"], { parameters: [], returnType: "void" });
define(["strategy.close"], {
  parameters: ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert"],
  optionalParameters: ["comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert"],
  returnType: "void",
  typedOverloads: [{
    parameters: [
      { name: "id", type: seriesString },
      { name: "comment", type: seriesString, optional: true },
      { name: "qty", type: seriesFloat, optional: true },
      { name: "qty_percent", type: seriesFloat, optional: true },
      { name: "alert_message", type: seriesString, optional: true },
      { name: "immediately", type: seriesBool, optional: true },
      { name: "disable_alert", type: seriesBool, optional: true },
    ],
    returnType: seriesVoid,
  }],
});
define(["strategy.close_all"], { parameters: ["comment", "alert_message", "immediately", "disable_alert"], optionalParameters: ["comment", "alert_message", "immediately", "disable_alert"], returnType: "void" });
define(["strategy.entry"], {
  parameters: ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  optionalParameters: ["qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  returnType: "void",
  typedOverloads: [{
    parameters: [
      { name: "id", type: seriesString },
      { name: "direction", type: seriesString },
      { name: "qty", type: seriesFloat, optional: true },
      { name: "limit", type: seriesFloat, optional: true },
      { name: "stop", type: seriesFloat, optional: true },
      { name: "oca_name", type: seriesString, optional: true },
      { name: "oca_type", type: seriesString, optional: true },
      { name: "comment", type: seriesString, optional: true },
      { name: "alert_message", type: seriesString, optional: true },
      { name: "disable_alert", type: seriesBool, optional: true },
    ],
    returnType: seriesVoid,
  }],
});
define(["strategy.order"], { parameters: ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"], optionalParameters: ["qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"], returnType: "void" });
define(["strategy.exit"], { parameters: ["id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "disable_alert"], optionalParameters: ["from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "disable_alert"], returnType: "void" });
define(["timestamp"], {
  parameters: ["year", "month", "day", "hour", "minute", "second"],
  optionalParameters: ["hour", "minute", "second"],
  overloads: [["year", "month", "day", "hour", "minute", "second"], ["timezone", "year", "month", "day", "hour", "minute", "second"], ["dateString"]],
  returnType: "int",
  typedOverloads: [
    { parameters: [
      { name: "year", type: seriesInt }, { name: "month", type: seriesInt }, { name: "day", type: seriesInt },
      { name: "hour", type: seriesInt, optional: true }, { name: "minute", type: seriesInt, optional: true },
      { name: "second", type: seriesInt, optional: true },
    ], returnType: seriesInt },
    { parameters: [
      { name: "timezone", type: seriesString }, { name: "year", type: seriesInt },
      { name: "month", type: seriesInt }, { name: "day", type: seriesInt },
      { name: "hour", type: seriesInt, optional: true }, { name: "minute", type: seriesInt, optional: true },
      { name: "second", type: seriesInt, optional: true },
    ], returnType: seriesInt },
    { parameters: [{ name: "dateString", type: constString }], returnType: constInt },
  ],
});
define(["time", "time_close"], {
  parameters: ["timeframe", "session", "timezone", "bars_back", "timeframe_bars_back"],
  optionalParameters: ["session", "timezone", "bars_back", "timeframe_bars_back"],
  overloads: [
    ["timeframe", "session", "bars_back", "timeframe_bars_back"],
    ["timeframe", "session", "timezone", "bars_back", "timeframe_bars_back"],
  ],
  returnType: returnSeriesInt,
  typedOverloads: [
    {
      parameters: [
        { name: "timeframe", type: seriesString },
        { name: "session", type: seriesString, optional: true },
        { name: "bars_back", type: seriesInt, optional: true },
        { name: "timeframe_bars_back", type: seriesInt, optional: true },
      ],
      returnType: seriesInt,
    },
    {
      parameters: [
        { name: "timeframe", type: seriesString },
        { name: "session", type: seriesString, optional: true },
        { name: "timezone", type: seriesString, optional: true },
        { name: "bars_back", type: seriesInt, optional: true },
        { name: "timeframe_bars_back", type: seriesInt, optional: true },
      ],
      returnType: seriesInt,
    },
  ],
  documentation: "Returns a bar opening or closing timestamp on a requested timeframe with chart- and requested-timeframe offsets.",
});
define(["dayofmonth", "dayofweek", "hour", "minute", "month", "second", "weekofyear", "year"], {
  parameters: ["time", "timezone"],
  optionalParameters: ["timezone"],
  overloads: [["time"], ["time", "timezone"]],
  returnType: returnSeriesInt,
  typedOverloads: [
    {
      parameters: [{ name: "time", type: seriesInt }],
      returnType: seriesInt,
    },
    {
      parameters: [
        { name: "time", type: seriesInt },
        { name: "timezone", type: seriesString, optional: true },
      ],
      returnType: seriesInt,
    },
  ],
  documentation: "Returns the requested calendar component for a UNIX timestamp in the exchange or supplied timezone.",
});

define(["array.clear"], { parameters: ["id"], returnType: "void" });
define(["array.abs"], { parameters: ["id"], returnType: "array" });
define(["array.avg", "array.sum"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["array.binary_search", "array.binary_search_leftmost", "array.binary_search_rightmost"], { parameters: ["id", "value"], returnType: returnSeriesInt });
define(["array.concat"], { parameters: ["id1", "id2"], returnType: "array" });
define(["array.copy"], { parameters: ["id"], returnType: "array" });
define(["array.covariance"], { parameters: ["id1", "id2", "biased"], optionalParameters: ["biased"], returnType: returnSeriesFloat });
define(["array.every", "array.some"], { parameters: ["id"], returnType: returnSeriesBool });
define(["array.fill"], { parameters: ["id", "value", "index_from", "index_to"], optionalParameters: ["index_from", "index_to"], returnType: "void" });
define(["array.first", "array.last"], { parameters: ["id"], returnType: "series" });
define(["array.from"], { parameters: ["arg0"], variadicParameter: "arg", returnType: "array" });
define(["array.get"], { parameters: ["id", "index"], returnType: "series" });
define(["array.includes"], { parameters: ["id", "value"], returnType: returnSeriesBool });
define(["array.indexof"], { parameters: ["id", "value"], returnType: returnSeriesInt });
define(["array.insert"], { parameters: ["id", "index", "value"], returnType: "void" });
define(["array.join"], { parameters: ["id", "separator"], returnType: returnSeriesString });
define(["array.lastindexof"], { parameters: ["id", "value"], returnType: returnSeriesInt });
define(["array.max", "array.median", "array.min", "array.mode", "array.range"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["array.new_bool", "array.new_color", "array.new_float", "array.new_int", "array.new_string"], { parameters: ["size", "initial_value"], optionalParameters: ["size", "initial_value"], returnType: "array" });
define(["array.new_box", "array.new_label", "array.new_line", "array.new_linefill", "array.new_table"], { parameters: ["size", "initial_value"], optionalParameters: ["size", "initial_value"], returnType: "array" });
define(["array.new"], { parameters: ["size", "initial_value"], optionalParameters: ["size", "initial_value"], returnType: "array" });
define(["array.pop", "array.shift"], { parameters: ["id"], returnType: "series" });
define(["array.percentile_linear_interpolation", "array.percentile_nearest_rank"], { parameters: ["id", "percentage"], returnType: returnSeriesFloat });
define(["array.percentrank"], { parameters: ["id", "index"], returnType: returnSeriesFloat });
define(["array.push", "array.unshift"], { parameters: ["id", "value"], returnType: "void" });
define(["array.remove"], { parameters: ["id", "index"], returnType: "series" });
define(["array.reverse"], { parameters: ["id"], returnType: "void" });
define(["array.set"], { parameters: ["id", "index", "value"], returnType: "void" });
define(["array.size"], { parameters: ["id"], returnType: returnSeriesInt });
define(["array.slice"], { parameters: ["id", "index_from", "index_to"], returnType: "array" });
define(["array.sort"], { parameters: ["id", "order"], optionalParameters: ["order"], returnType: "void" });
define(["array.sort_indices"], { parameters: ["id", "order"], optionalParameters: ["order"], returnType: "array<int>" });
define(["array.standardize"], { parameters: ["id"], returnType: "array<float>" });
define(["array.stdev", "array.variance"], { parameters: ["id", "biased"], optionalParameters: ["biased"], returnType: returnSeriesFloat });

define(["map.clear"], { parameters: ["id"], returnType: "void" });
define(["map.contains"], { parameters: ["id", "key"], returnType: returnSeriesBool });
define(["map.get", "map.remove"], { parameters: ["id", "key"], returnType: "series" });
define(["map.keys", "map.values"], { parameters: ["id"], returnType: "array" });
define(["map.new"], { parameters: [], returnType: "map" });
define(["map.copy"], { parameters: ["id"], returnType: "map" });
define(["map.put"], { parameters: ["id", "key", "value"], returnType: "void" });
define(["map.put_all"], { parameters: ["id", "from"], returnType: "void" });
define(["map.size"], { parameters: ["id"], returnType: returnSeriesInt });

define(["matrix.add_col"], { parameters: ["id", "column", "array_id"], optionalParameters: ["column", "array_id"], returnType: "void" });
define(["matrix.add_row"], { parameters: ["id", "row", "array_id"], optionalParameters: ["row", "array_id"], returnType: "void" });
define(["matrix.avg"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["matrix.col"], { parameters: ["id", "column"], returnType: "array" });
define(["matrix.columns", "matrix.rows"], { parameters: ["id"], returnType: returnSeriesInt });
define(["matrix.concat"], { parameters: ["id1", "id2"], returnType: "matrix" });
define(["matrix.copy"], { parameters: ["id"], returnType: "matrix" });
define(["matrix.det"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["matrix.diff"], { parameters: ["id1", "id2"], returnType: "matrix" });
define(["matrix.eigenvalues"], { parameters: ["id"], returnType: "array<float>" });
define(["matrix.eigenvectors"], { parameters: ["id"], returnType: "matrix" });
define(["matrix.elements_count"], { parameters: ["id"], returnType: returnSeriesInt });
define(["matrix.fill"], { parameters: ["id", "value", "from_row", "to_row", "from_column", "to_column"], optionalParameters: ["from_row", "to_row", "from_column", "to_column"], returnType: "void" });
define(["matrix.get"], { parameters: ["id", "row", "column"], returnType: "series" });
define(["matrix.inv"], { parameters: ["id"], returnType: "matrix" });
define(["matrix.is_antidiagonal", "matrix.is_antisymmetric"], { parameters: ["id"], returnType: returnSeriesBool });
define(["matrix.is_binary", "matrix.is_diagonal", "matrix.is_identity", "matrix.is_square", "matrix.is_stochastic", "matrix.is_symmetric", "matrix.is_triangular", "matrix.is_zero"], { parameters: ["id"], returnType: returnSeriesBool });
define(["matrix.kron"], { parameters: ["id1", "id2"], returnType: "matrix" });
define(["matrix.max"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["matrix.median", "matrix.min", "matrix.mode"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["matrix.mult"], { parameters: ["id1", "id2"], returnType: "matrix" });
define(["matrix.new"], { parameters: ["rows", "columns", "initial_value"], optionalParameters: ["initial_value"], returnType: "matrix" });
define(["matrix.pinv"], { parameters: ["id"], returnType: "matrix" });
define(["matrix.pow"], { parameters: ["id", "power"], returnType: "matrix" });
define(["matrix.rank"], { parameters: ["id"], returnType: returnSeriesInt });
define(["matrix.remove_col"], { parameters: ["id", "column"], returnType: "array" });
define(["matrix.remove_row"], { parameters: ["id", "row"], returnType: "array" });
define(["matrix.reshape"], { parameters: ["id", "rows", "columns"], returnType: "void" });
define(["matrix.reverse"], { parameters: ["id"], returnType: "void" });
define(["matrix.row"], { parameters: ["id", "row"], returnType: "array" });
define(["matrix.set"], { parameters: ["id", "row", "column", "value"], returnType: "void" });
define(["matrix.sort"], { parameters: ["id", "column", "order"], optionalParameters: ["column", "order"], returnType: "void" });
define(["matrix.submatrix"], { parameters: ["id", "from_row", "to_row", "from_column", "to_column"], optionalParameters: ["from_row", "to_row", "from_column", "to_column"], returnType: "matrix" });
define(["matrix.sum"], { parameters: ["id1", "id2"], returnType: "matrix" });
define(["matrix.swap_columns"], { parameters: ["id", "column1", "column2"], returnType: "void" });
define(["matrix.swap_rows"], { parameters: ["id", "row1", "row2"], returnType: "void" });
define(["matrix.trace"], { parameters: ["id"], returnType: returnSeriesFloat });
define(["matrix.transpose"], { parameters: ["id"], returnType: "matrix" });

define(["ta.accdist", "ta.iii", "ta.nvi", "ta.obv", "ta.pvi", "ta.pvt", "ta.wad", "ta.wvad"], {
  parameters: [],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [], returnType: seriesFloat }],
});

define(["ta.bb"], {
  parameters: ["series", "length", "mult"],
  returnType: "[series float, series float, series float]",
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "mult", type: simpleFloat },
    ],
    returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesFloat, seriesFloat] },
  }],
});
define(["ta.bbw"], {
  parameters: ["series", "length", "mult"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "mult", type: simpleFloat },
    ],
    returnType: seriesFloat,
  }],
});

define(["ta.atr"], {
  parameters: ["length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "length", type: simpleInt }], returnType: seriesFloat }],
});

define(["ta.sma", "ta.wma", "ta.vwma", "ta.variance", "ta.stdev", "ta.dev"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.ema", "ta.rma", "ta.hma"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: simpleInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.alma"], {
  parameters: ["series", "length", "offset", "sigma"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "offset", type: simpleFloat },
      { name: "sigma", type: simpleFloat },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.linreg"], {
  parameters: ["source", "length", "offset"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "offset", type: simpleInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.swma"], {
  parameters: ["source"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [{ name: "source", type: seriesFloat }],
    returnType: seriesFloat,
  }],
});
define(["ta.cci"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat }],
});
define(["ta.rsi"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: simpleInt }], returnType: seriesFloat }],
});
define(["ta.percentrank"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat }],
});
define(["ta.mom", "ta.range", "ta.roc"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.change"], {
  parameters: ["source", "length"],
  optionalParameters: ["length"],
  overloads: [["source", "length"], ["source", "length"]],
  returnType: "series",
  typedOverloads: [seriesFloat, seriesBool].map((source) => ({
    parameters: [
      { name: "source", type: source },
      { name: "length", type: seriesInt, optional: true },
    ],
    returnType: source,
  })),
});
define(["ta.barssince"], {
  parameters: ["condition"],
  returnType: returnSeriesInt,
  typedOverloads: [{ parameters: [{ name: "condition", type: seriesBool }], returnType: seriesInt }],
});
define(["ta.cmo", "ta.cog"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: simpleInt }], returnType: seriesFloat }],
});
define(["ta.correlation"], {
  parameters: ["source1", "source2", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source1", type: seriesFloat },
      { name: "source2", type: seriesFloat },
      { name: "length", type: seriesInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.cross"], {
  parameters: ["source1", "source2"],
  returnType: returnSeriesBool,
  typedOverloads: [{ parameters: [{ name: "source1", type: seriesFloat }, { name: "source2", type: seriesFloat }], returnType: seriesBool }],
});
define(["ta.cum"], {
  parameters: ["source"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }], returnType: seriesFloat }],
});
define(["ta.dmi"], {
  parameters: ["diLength", "adxSmoothing"],
  returnType: "[series float, series float, series float]",
  typedOverloads: [{
    parameters: [
      { name: "diLength", type: simpleInt },
      { name: "adxSmoothing", type: simpleInt },
    ],
    returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesFloat, seriesFloat] },
  }],
});
define(["ta.crossover", "ta.crossunder"], {
  parameters: ["source1", "source2"],
  returnType: returnSeriesBool,
  typedOverloads: [{ parameters: [{ name: "source1", type: seriesFloat }, { name: "source2", type: seriesFloat }], returnType: seriesBool }],
});
define(["ta.falling", "ta.rising"], {
  parameters: ["source", "length"],
  returnType: returnSeriesBool,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesBool }],
});
define(["ta.highest", "ta.lowest"], {
  parameters: ["source", "length"],
  overloads: [["length"], ["source", "length"]],
  returnType: returnSeriesFloat,
  typedOverloads: [
    { parameters: [{ name: "length", type: seriesInt }], returnType: seriesFloat },
    { parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat },
  ],
});
define(["ta.highestbars", "ta.lowestbars"], {
  parameters: ["source", "length"],
  overloads: [["length"], ["source", "length"]],
  returnType: returnSeriesInt,
  typedOverloads: [
    { parameters: [{ name: "length", type: seriesInt }], returnType: seriesInt },
    { parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesInt },
  ],
});
define(["ta.kc"], {
  parameters: ["series", "length", "mult", "useTrueRange"],
  optionalParameters: ["useTrueRange"],
  returnType: "[series float, series float, series float]",
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "mult", type: simpleFloat },
      { name: "useTrueRange", type: simpleBool, optional: true },
    ],
    returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesFloat, seriesFloat] },
  }],
});
define(["ta.kcw"], {
  parameters: ["series", "length", "mult", "useTrueRange"],
  optionalParameters: ["useTrueRange"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "mult", type: simpleFloat },
      { name: "useTrueRange", type: simpleBool, optional: true },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.macd"], {
  parameters: ["source", "fast_length", "slow_length", "signal_length"],
  returnType: "[series float, series float, series float]",
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "fast_length", type: simpleInt },
      { name: "slow_length", type: simpleInt },
      { name: "signal_length", type: simpleInt },
    ],
    returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesFloat, seriesFloat] },
  }],
});
define(["ta.median", "ta.mode"], {
  parameters: ["source", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat }],
});
define(["ta.max", "ta.min"], { parameters: ["source"], returnType: returnSeriesFloat });
define(["ta.mfi"], {
  parameters: ["series", "length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "series", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat }],
});
define(["ta.percentile_linear_interpolation", "ta.percentile_nearest_rank"], {
  parameters: ["source", "length", "percentage"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "percentage", type: simpleFloat },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.pivothigh", "ta.pivotlow"], {
  parameters: ["source", "leftbars", "rightbars"],
  overloads: [["leftbars", "rightbars"], ["source", "leftbars", "rightbars"]],
  returnType: returnSeriesFloat,
  typedOverloads: [
    {
      parameters: [
        { name: "leftbars", type: seriesInt },
        { name: "rightbars", type: seriesInt },
      ],
      returnType: seriesFloat,
    },
    {
      parameters: [
        { name: "source", type: seriesFloat },
        { name: "leftbars", type: seriesInt },
        { name: "rightbars", type: seriesInt },
      ],
      returnType: seriesFloat,
    },
  ],
});
define(["ta.pivot_point_levels"], { parameters: ["type", "anchor", "developing"], optionalParameters: ["developing"], returnType: "array<float>" });
define(["ta.rci"], { parameters: ["source", "length"], returnType: returnSeriesFloat });
define(["ta.sar"], {
  parameters: ["start", "inc", "max"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "start", type: simpleFloat },
      { name: "inc", type: simpleFloat },
      { name: "max", type: simpleFloat },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.stoch"], {
  parameters: ["source", "peak", "valley", "period"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "peak", type: seriesFloat },
      { name: "valley", type: seriesFloat },
      { name: "period", type: seriesInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.supertrend"], {
  parameters: ["factor", "atrPeriod"],
  returnType: "[series float, series int]",
  typedOverloads: [{
    parameters: [
      { name: "factor", type: seriesFloat },
      { name: "atrPeriod", type: simpleInt },
    ],
    returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesInt] },
  }],
});
define(["ta.tr"], {
  parameters: ["handle_na"],
  optionalParameters: ["handle_na"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "handle_na", type: simpleBool, optional: true }], returnType: seriesFloat }],
});
define(["ta.tsi"], {
  parameters: ["source", "short_length", "long_length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "short_length", type: simpleInt },
      { name: "long_length", type: simpleInt },
    ],
    returnType: seriesFloat,
  }],
});
define(["ta.valuewhen"], {
  parameters: ["condition", "source", "occurrence"],
  returnType: "series",
  typedOverloads: [{
    parameters: [
      { name: "condition", type: seriesBool },
      { name: "source", type: seriesUnknown },
      { name: "occurrence", type: seriesInt },
    ],
    returnType: seriesUnknown,
  }],
});
define(["ta.vwap"], {
  parameters: ["source"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }], returnType: seriesFloat }],
});
define(["ta.wpr"], {
  parameters: ["length"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "length", type: seriesInt }], returnType: seriesFloat }],
});

define(["strategy.closedtrades.first_index"], { parameters: [], returnType: returnSeriesInt });
define(["strategy.opentrades.capital_held"], { parameters: [], returnType: returnSeriesFloat });
for (const [names, returnType, qualifiedType] of [
  [
    ["commission", "entry_price", "exit_price", "profit", "profit_percent", "size", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent"],
    returnSeriesFloat, seriesFloat,
  ],
  [
    ["entry_bar_index", "entry_time", "exit_bar_index", "exit_time"],
    returnSeriesInt, seriesInt,
  ],
  [
    ["entry_comment", "entry_id", "exit_comment", "exit_id"],
    returnSeriesString, seriesString,
  ],
] as const) {
  const calls = PINE_CERTIFIED_STRATEGY_TRADE_CALLS.filter((name) =>
    names.some((field) => name.endsWith(`.${field}`)));
  define(calls, {
    parameters: ["trade_num"],
    returnType,
    typedOverloads: [{ parameters: [{ name: "trade_num", type: seriesInt }], returnType: qualifiedType }],
  });
}

define(["math.abs", "math.ceil", "math.exp", "math.floor", "math.ln", "math.log", "math.log10", "math.round_to_mintick", "math.sign", "math.sqrt"], { parameters: ["number"], returnType: returnSeriesFloat });
define(["math.acos", "math.asin", "math.atan", "math.cos", "math.sin", "math.tan"], { parameters: ["angle"], returnType: returnSeriesFloat });
define(["math.todegrees"], { parameters: ["radians"], returnType: returnSeriesFloat });
define(["math.toradians"], { parameters: ["degrees"], returnType: returnSeriesFloat });
define(["math.avg", "math.max", "math.min"], { parameters: ["number0", "number1"], variadicParameter: "number", returnType: returnSeriesFloat });
define(["math.pow"], { parameters: ["base", "exponent"], returnType: returnSeriesFloat });
define(["math.random"], { parameters: ["min", "max"], optionalParameters: ["min", "max"], returnType: returnSeriesFloat });
define(["math.round"], { parameters: ["number", "precision"], optionalParameters: ["precision"], returnType: returnSeriesFloat });
define(["math.sum"], { parameters: ["source", "length"], returnType: returnSeriesFloat });

define(["str.contains", "str.endswith", "str.startswith"], {
  parameters: ["source", "str"],
  returnType: returnSeriesBool,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "str", type: seriesString },
    ],
    returnType: seriesBool,
  }],
});
define(["str.format"], {
  parameters: ["formatString", "arg0"],
  optionalParameters: ["arg0"],
  variadicParameter: "arg",
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "formatString", type: seriesString },
      { name: "arg0", type: seriesUnknown, optional: true },
    ],
    variadicParameter: { name: "arg", type: seriesUnknown },
    returnType: seriesString,
  }],
});
define(["str.format_time"], {
  parameters: ["time", "format", "timezone"],
  optionalParameters: ["format", "timezone"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "time", type: seriesInt },
      { name: "format", type: seriesString, optional: true },
      { name: "timezone", type: seriesString, optional: true },
    ],
    returnType: seriesString,
  }],
});
define(["str.length"], {
  parameters: ["string"],
  returnType: returnSeriesInt,
  typedOverloads: [{ parameters: [{ name: "string", type: seriesString }], returnType: seriesInt }],
});
define(["str.lower", "str.trim", "str.upper"], {
  parameters: ["string"],
  returnType: "string",
  typedOverloads: [{ parameters: [{ name: "string", type: seriesString }], returnType: seriesString }],
});
define(["str.match"], {
  parameters: ["source", "regex"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "regex", type: seriesString },
    ],
    returnType: seriesString,
  }],
});
define(["str.pos"], {
  parameters: ["source", "str"],
  returnType: returnSeriesInt,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "str", type: seriesString },
    ],
    returnType: seriesInt,
  }],
});
define(["str.repeat"], {
  parameters: ["source", "repeat", "separator"],
  optionalParameters: ["separator"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "repeat", type: seriesInt },
      { name: "separator", type: seriesString, optional: true },
    ],
    returnType: seriesString,
  }],
});
define(["str.replace"], {
  parameters: ["source", "target", "replacement", "occurrence"],
  optionalParameters: ["occurrence"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "target", type: seriesString },
      { name: "replacement", type: seriesString },
      { name: "occurrence", type: seriesInt, optional: true },
    ],
    returnType: seriesString,
  }],
});
define(["str.replace_all"], {
  parameters: ["source", "target", "replacement"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "target", type: seriesString },
      { name: "replacement", type: seriesString },
    ],
    returnType: seriesString,
  }],
});
define(["str.split"], {
  parameters: ["string", "separator"],
  returnType: "array<string>",
  typedOverloads: [{
    parameters: [
      { name: "string", type: seriesString },
      { name: "separator", type: seriesString },
    ],
    returnType: { kind: "array", qualifier: "series", arguments: [seriesString] },
  }],
});
define(["str.substring"], {
  parameters: ["source", "begin_pos", "end_pos"],
  optionalParameters: ["end_pos"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesString },
      { name: "begin_pos", type: seriesInt },
      { name: "end_pos", type: seriesInt, optional: true },
    ],
    returnType: seriesString,
  }],
});
define(["str.tonumber"], {
  parameters: ["string"],
  returnType: returnSeriesFloat,
  typedOverloads: [{ parameters: [{ name: "string", type: seriesString }], returnType: seriesFloat }],
});
define(["str.tostring"], {
  parameters: ["value", "format"],
  optionalParameters: ["format"],
  returnType: returnSeriesString,
  typedOverloads: [{
    parameters: [
      { name: "value", type: seriesUnknown },
      { name: "format", type: seriesString, optional: true },
    ],
    returnType: seriesString,
  }],
});

define(["timeframe.change"], { parameters: ["timeframe"], returnType: returnSeriesBool });
define(["timeframe.from_seconds"], { parameters: ["seconds"], returnType: returnSeriesString });
define(["timeframe.in_seconds"], { parameters: ["timeframe"], optionalParameters: ["timeframe"], returnType: returnSeriesFloat });

define(["color.b", "color.g", "color.r", "color.t"], { parameters: ["color"], returnType: returnSeriesInt });
define(["color.from_gradient"], { parameters: ["value", "bottom_value", "top_value", "bottom_color", "top_color"], returnType: "series color" });
define(["color.new"], { parameters: ["color", "transp"], returnType: "series color" });
define(["color.rgb"], { parameters: ["red", "green", "blue", "transp"], optionalParameters: ["transp"], returnType: "series color" });

define(["line.new"], { parameters: ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width", "force_overlay"], optionalParameters: ["xloc", "extend", "color", "style", "width", "force_overlay"], returnType: "line" });
define(["line.copy"], { parameters: ["id"], returnType: "line" });
define(["line.delete"], { parameters: ["id"], returnType: "void" });
define(["line.set_color"], { parameters: ["id", "color"], returnType: "void" });
define(["line.set_style"], { parameters: ["id", "style"], returnType: "void" });
define(["line.set_extend"], { parameters: ["id", "extend"], returnType: "void" });
define(["line.set_width"], { parameters: ["id", "width"], returnType: "void" });
define(["line.set_x1", "line.set_x2"], { parameters: ["id", "x"], returnType: "void" });
define(["line.set_y1", "line.set_y2"], { parameters: ["id", "y"], returnType: "void" });
define(["line.set_first_point", "line.set_second_point"], { parameters: ["id", "point"], returnType: "void" });
define(["line.set_xy1", "line.set_xy2"], { parameters: ["id", "x", "y"], returnType: "void" });

define(["label.new"], { parameters: ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"], optionalParameters: ["text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"], returnType: "label" });
define(["label.copy"], { parameters: ["id"], returnType: "label" });
define(["label.delete"], { parameters: ["id"], returnType: "void" });
define(["label.set_color"], { parameters: ["id", "color"], returnType: "void" });
define(["label.set_point"], { parameters: ["id", "point"], returnType: "void" });
define(["label.set_size"], { parameters: ["id", "size"], returnType: "void" });
define(["label.set_style"], { parameters: ["id", "style"], returnType: "void" });
define(["label.set_text"], { parameters: ["id", "text"], returnType: "void" });
define(["label.set_text_formatting"], { parameters: ["id", "text_formatting"], returnType: "void" });
define(["label.set_textcolor"], { parameters: ["id", "textcolor"], returnType: "void" });
define(["label.set_tooltip"], { parameters: ["id", "tooltip"], returnType: "void" });
define(["label.set_x"], { parameters: ["id", "x"], returnType: "void" });
define(["label.set_y"], { parameters: ["id", "y"], returnType: "void" });
define(["label.set_xy"], { parameters: ["id", "x", "y"], returnType: "void" });

define(["box.new"], { parameters: ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"], optionalParameters: ["border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"], returnType: "box" });
define(["box.copy"], { parameters: ["id"], returnType: "box" });
define(["box.delete"], { parameters: ["id"], returnType: "void" });
define(["box.get_left", "box.get_right"], { parameters: ["id"], returnType: "int" });
define(["box.get_top", "box.get_bottom"], { parameters: ["id"], returnType: "float" });
define(["box.set_bgcolor"], { parameters: ["id", "color"], returnType: "void" });
define(["box.set_border_color"], { parameters: ["id", "color"], returnType: "void" });
define(["box.set_bottom"], { parameters: ["id", "bottom"], returnType: "void" });
define(["box.set_left"], { parameters: ["id", "left"], returnType: "void" });
define(["box.set_right"], { parameters: ["id", "right"], returnType: "void" });
define(["box.set_text"], { parameters: ["id", "text"], returnType: "void" });
define(["box.set_text_color"], { parameters: ["id", "text_color"], returnType: "void" });
define(["box.set_top"], { parameters: ["id", "top"], returnType: "void" });
define(["box.set_lefttop"], { parameters: ["id", "left", "top"], returnType: "void" });
define(["box.set_rightbottom"], { parameters: ["id", "right", "bottom"], returnType: "void" });
define(["box.set_border_style"], { parameters: ["id", "style"], returnType: "void" });
define(["box.set_border_width"], { parameters: ["id", "width"], returnType: "void" });
define(["box.set_bottom_right_point"], { parameters: ["id", "point"], returnType: "void" });
define(["box.set_extend"], { parameters: ["id", "extend"], returnType: "void" });
define(["box.set_text_font_family"], { parameters: ["id", "family"], returnType: "void" });
define(["box.set_text_formatting"], { parameters: ["id", "formatting"], returnType: "void" });
define(["box.set_text_halign"], { parameters: ["id", "align"], returnType: "void" });
define(["box.set_text_size"], { parameters: ["id", "size"], returnType: "void" });
define(["box.set_text_valign"], { parameters: ["id", "align"], returnType: "void" });
define(["box.set_text_wrap"], { parameters: ["id", "wrap"], returnType: "void" });
define(["box.set_top_left_point"], { parameters: ["id", "point"], returnType: "void" });
define(["box.set_xloc"], { parameters: ["id", "left", "right", "xloc"], returnType: "void" });

define(["polyline.new"], { parameters: ["points", "curved", "closed", "xloc", "line_color", "fill_color", "line_style", "line_width", "force_overlay"], optionalParameters: ["curved", "closed", "xloc", "line_color", "fill_color", "line_style", "line_width", "force_overlay"], returnType: "polyline" });
define(["polyline.delete"], { parameters: ["id"], returnType: "void" });
define(["linefill.new"], { parameters: ["line1", "line2", "color"], returnType: "linefill" });
define(["linefill.delete"], { parameters: ["id"], returnType: "void" });
define(["linefill.set_color"], { parameters: ["id", "color"], returnType: "void" });
define(["linefill.get_line1", "linefill.get_line2"], { parameters: ["id"], returnType: "line" });

define(["table.new"], { parameters: ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"], optionalParameters: ["bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"], returnType: "table" });
define(["table.cell"], { parameters: ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"], optionalParameters: ["text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"], returnType: "void" });
define(["table.cell_set_bgcolor"], { parameters: ["table_id", "column", "row", "bgcolor"], returnType: "void" });
define(["table.cell_set_height"], { parameters: ["table_id", "column", "row", "height"], returnType: "void" });
define(["table.cell_set_text"], { parameters: ["table_id", "column", "row", "text"], returnType: "void" });
define(["table.cell_set_text_color"], { parameters: ["table_id", "column", "row", "text_color"], returnType: "void" });
define(["table.cell_set_text_formatting"], { parameters: ["table_id", "column", "row", "text_formatting"], returnType: "void" });
define(["table.cell_set_text_halign"], { parameters: ["table_id", "column", "row", "text_halign"], returnType: "void" });
define(["table.cell_set_text_size"], { parameters: ["table_id", "column", "row", "text_size"], returnType: "void" });
define(["table.cell_set_text_valign"], { parameters: ["table_id", "column", "row", "text_valign"], returnType: "void" });
define(["table.cell_set_tooltip"], { parameters: ["table_id", "column", "row", "tooltip"], returnType: "void" });
define(["table.cell_set_width"], { parameters: ["table_id", "column", "row", "width"], returnType: "void" });
define(["table.clear"], { parameters: ["table_id", "start_column", "start_row", "end_column", "end_row"], optionalParameters: ["end_column", "end_row"], returnType: "void" });
define(["table.delete"], { parameters: ["table_id"], returnType: "void" });
define(["table.merge_cells"], { parameters: ["table_id", "start_column", "start_row", "end_column", "end_row"], returnType: "void" });
define(["table.set_bgcolor"], { parameters: ["table_id", "bgcolor"], returnType: "void" });
define(["table.set_border_color"], { parameters: ["table_id", "border_color"], returnType: "void" });
define(["table.set_border_width"], { parameters: ["table_id", "border_width"], returnType: "void" });
define(["table.set_frame_color"], { parameters: ["table_id", "frame_color"], returnType: "void" });
define(["table.set_frame_width"], { parameters: ["table_id", "frame_width"], returnType: "void" });
define(["table.set_position"], { parameters: ["table_id", "position"], returnType: "void" });

export const PINE_KNOWN_CALLABLE_METADATA: Readonly<Record<string, PineCallableDefinition>> = Object.freeze(definitions);

const productionLowerRequest = {
  ...definitions["request.security_lower_tf"]!,
  parameters: ["symbol", "timeframe", "expression", "ignore_invalid_symbol", "currency", "ignore_invalid_timeframe", "calc_bars_count"],
  optionalParameters: ["ignore_invalid_symbol", "currency", "ignore_invalid_timeframe", "calc_bars_count"],
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: seriesString },
      { name: "timeframe", type: seriesString },
      { name: "expression", type: seriesUnknown },
      { name: "ignore_invalid_symbol", type: simpleBool, optional: true },
      // currency.NONE is represented as an opaque builtin constant in the
      // binder; request-plan validation owns its exact admitted value.
      { name: "currency", type: seriesUnknown, optional: true },
      { name: "ignore_invalid_timeframe", type: simpleBool, optional: true },
      { name: "calc_bars_count", type: simpleInt, optional: true },
    ],
    // The binder derives array<T> (or a tuple of arrays) from expression.
    returnType: seriesUnknown,
  }],
};

const productionSecurityRequest = {
  ...definitions["request.security"]!,
  typedOverloads: [{
    parameters: [
      { name: "symbol", type: seriesString },
      { name: "timeframe", type: seriesString },
      { name: "expression", type: seriesUnknown },
      // Gaps and lookahead accept both enum strings and the admitted constant
      // booleans; request-plan validation checks their exact values.
      { name: "gaps", type: seriesUnknown, optional: true },
      { name: "lookahead", type: seriesUnknown, optional: true },
      { name: "ignore_invalid_symbol", type: simpleBool, optional: true },
      { name: "currency", type: seriesUnknown, optional: true },
      { name: "calc_bars_count", type: simpleInt, optional: true },
    ],
    returnType: seriesUnknown,
  }],
};

const productionMathRandom = {
  ...definitions["math.random"]!,
  parameters: ["min", "max", "seed"],
  optionalParameters: ["min", "max", "seed"],
  typedOverloads: [{
    parameters: [
      { name: "min", type: seriesFloat, optional: true },
      { name: "max", type: seriesFloat, optional: true },
      { name: "seed", type: seriesInt, optional: true },
    ],
    returnType: seriesFloat,
  }],
} satisfies PineCallableDefinition;

const productionMathRoundToMintick = {
  ...definitions["math.round_to_mintick"]!,
  returnType: "float",
  typedOverloads: [{
    parameters: [{ name: "number", type: seriesFloat }],
    returnType: seriesFloat,
  }],
} satisfies PineCallableDefinition;

const productionMathSum = {
  ...definitions["math.sum"]!,
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
    ],
    returnType: seriesFloat,
  }],
} satisfies PineCallableDefinition;

/** `nth` selects the nth-greatest (max) or nth-smallest (min) element, 0 by default. */
const productionArrayExtremum = (name: "array.max" | "array.min") => {
  const definition = { ...definitions[name]!, parameters: ["id", "nth"], optionalParameters: ["nth"] };
  const [overload] = deriveTypedOverloads(definition);
  return {
    ...definition,
    typedOverloads: [{
      ...overload!,
      parameters: [overload!.parameters[0]!, { name: "nth", type: seriesInt, optional: true }],
    }],
  } satisfies PineCallableDefinition;
};

/** `biased` selects the population (true, default) or sample (false) estimate. */
const productionBiasedDispersion = (name: "ta.stdev" | "ta.variance") => ({
  ...definitions[name]!,
  parameters: ["source", "length", "biased"],
  optionalParameters: ["biased"],
  typedOverloads: [{
    parameters: [
      { name: "source", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "biased", type: seriesBool, optional: true },
    ],
    returnType: seriesFloat,
  }],
}) satisfies PineCallableDefinition;

const productionKeltner = (name: "ta.kc" | "ta.kcw"): PineCallableDefinition => {
  const definition = definitions[name]!;
  return {
    ...definition,
    typedOverloads: definition.typedOverloads!.map((overload) => ({
      ...overload,
      parameters: overload.parameters.map((parameter) => parameter.name === "length" ? { ...parameter, type: simpleInt } : parameter),
    })),
  };
};

const productionAlma = {
  ...definitions["ta.alma"]!,
  parameters: ["series", "length", "offset", "sigma", "floor"],
  optionalParameters: ["floor"],
  typedOverloads: [{
    parameters: [
      { name: "series", type: seriesFloat },
      { name: "length", type: seriesInt },
      { name: "offset", type: simpleFloat },
      { name: "sigma", type: simpleFloat },
      { name: "floor", type: simpleBool, optional: true },
    ],
    returnType: seriesFloat,
  }],
} satisfies PineCallableDefinition;

const vwapSource = { name: "source", type: seriesFloat };
const vwapAnchor = { name: "anchor", type: seriesBool };
const productionVwap = {
  ...definitions["ta.vwap"]!,
  parameters: ["source", "anchor", "stdev_mult"],
  overloads: [["source"], ["source", "anchor"], ["source", "anchor", "stdev_mult"]],
  typedOverloads: [
    { parameters: [vwapSource], returnType: seriesFloat },
    { parameters: [vwapSource, vwapAnchor], returnType: seriesFloat },
    {
      parameters: [vwapSource, vwapAnchor, { name: "stdev_mult", type: seriesFloat }],
      returnType: { kind: "tuple", qualifier: "series", arguments: [seriesFloat, seriesFloat, seriesFloat] },
    },
  ],
} satisfies PineCallableDefinition;

const productionArrayJoin = {
  ...definitions["array.join"]!,
  optionalParameters: ["separator"],
  typedOverloads: deriveTypedOverloads({
    ...definitions["array.join"]!,
    optionalParameters: ["separator"],
  }),
} satisfies PineCallableDefinition;

const productionMatrixRemove = (name: "matrix.remove_col" | "matrix.remove_row", index: "column" | "row") => {
  const definition = {
    ...definitions[name]!,
    optionalParameters: [index],
  };
  return {
    ...definition,
    typedOverloads: deriveTypedOverloads(definition),
  } satisfies PineCallableDefinition;
};

const matrixPredicateNames = [
  "is_antidiagonal", "is_antisymmetric", "is_binary", "is_diagonal", "is_identity",
  "is_square", "is_stochastic", "is_symmetric", "is_triangular", "is_zero",
] as const;

const productionMatrixPredicates = Object.fromEntries(matrixPredicateNames.map((method) => {
  const name = `matrix.${method}`;
  const numeric = method !== "is_square";
  return [name, {
    ...definitions[name]!,
    documentation: numeric
      ? `Inspects a matrix<int> or matrix<float> with ${name} and returns series bool.`
      : "Checks whether any matrix element type has equal row and column counts; returns series bool.",
    // Generic matrix alternatives are checked by the predicate-only binder path.
    typedOverloads: [{ parameters: [{ name: "id", type: seriesUnknown }], returnType: seriesBool }],
  } satisfies PineCallableDefinition];
}));

const productionMatrixNumeric = Object.fromEntries(["min", "max", "mode", "trace"].map((method) => {
  const name = `matrix.${method}`;
  return [name, {
    ...definitions[name]!,
    documentation: `Returns a series int for matrix<int> or series float for matrix<float> with ${name}.`,
    // The binder checks the receiver's generic element and derives the result type.
    typedOverloads: [{ parameters: [{ name: "id", type: seriesUnknown }], returnType: seriesUnknown }],
  } satisfies PineCallableDefinition];
}));

const productionMatrixLinearAlgebra = Object.fromEntries(["det", "rank"].map((method) => {
  const name = `matrix.${method}`;
  const returnType = method === "det" ? seriesFloat : seriesInt;
  return [name, {
    ...definitions[name]!,
    documentation: `${name} accepts matrix<int> or matrix<float> and returns series ${method === "det" ? "float" : "int"}.`,
    typedOverloads: [{
      parameters: [
        { name: "id", type: seriesUnknown },
      ],
      returnType,
    }],
  } satisfies PineCallableDefinition];
}));

const productionMatrixInversePower = Object.fromEntries(["inv", "pinv", "pow"].map((method) => {
  const name = `matrix.${method}`;
  return [name, {
    ...definitions[name]!,
    documentation: `${name} accepts matrix<int> or matrix<float>; the strict binder preserves the matrix element kind${method === "pow" ? " and requires a series int power" : ""}.`,
    typedOverloads: [{
      parameters: method === "pow"
        ? [{ name: "id", type: seriesUnknown }, { name: "power", type: seriesInt }]
        : [{ name: "id", type: seriesUnknown }],
      returnType: seriesUnknown,
    }],
  } satisfies PineCallableDefinition];
}));

const productionMatrixArithmetic = Object.fromEntries(["concat", "diff", "kron", "mult", "sum"].map((method) => {
  const name = `matrix.${method}`;
  const definition = definitions[name]!;
  return [name, {
    ...definition,
    documentation: `Applies ${name} to typed matrix operands; the strict binder resolves compatible element and result types.`,
    typedOverloads: [{
      parameters: definition.parameters.map((parameter) => ({ name: parameter, type: seriesUnknown })),
      returnType: seriesUnknown,
    }],
  } satisfies PineCallableDefinition];
}));

const productionMatrixSort = {
  ...definitions["matrix.sort"]!,
  parameters: ["id", "column", "order", "sort_field"],
  optionalParameters: ["column", "order", "sort_field"],
  documentation: "Stably sorts matrix rows by a selected column and optional UDT field.",
  typedOverloads: [{
    parameters: [
      { name: "id", type: seriesUnknown },
      { name: "column", type: seriesInt, optional: true },
      { name: "order", type: constInt, optional: true },
      { name: "sort_field", type: seriesUnknown, optional: true },
    ],
    returnType: seriesVoid,
  }],
} satisfies PineCallableDefinition;

const productionColorComponent = (name: "color.b" | "color.g" | "color.r" | "color.t") => ({
  ...definitions[name]!,
  returnType: returnSeriesFloat,
  typedOverloads: [{
    parameters: [{ name: "color", type: seriesColor }],
    returnType: seriesFloat,
  }],
}) satisfies PineCallableDefinition;

const productionColorGradient = {
  ...definitions["color.from_gradient"]!,
  typedOverloads: [{
    parameters: [
      { name: "value", type: seriesFloat },
      { name: "bottom_value", type: seriesFloat },
      { name: "top_value", type: seriesFloat },
      { name: "bottom_color", type: seriesColor },
      { name: "top_color", type: seriesColor },
    ],
    returnType: seriesColor,
  }],
} satisfies PineCallableDefinition;

const productionColorNew = {
  ...definitions["color.new"]!,
  typedOverloads: [{
    parameters: [
      { name: "color", type: seriesColor },
      { name: "transp", type: seriesFloat },
    ],
    returnType: seriesColor,
  }],
} satisfies PineCallableDefinition;

const productionColorRgb = {
  ...definitions["color.rgb"]!,
  typedOverloads: [{
    parameters: [
      { name: "red", type: seriesFloat },
      { name: "green", type: seriesFloat },
      { name: "blue", type: seriesFloat },
      { name: "transp", type: seriesFloat, optional: true },
    ],
    returnType: seriesColor,
  }],
} satisfies PineCallableDefinition;

const lineSetterOverrides = (names: readonly string[], coordinates: readonly PineCallableParameterDefinition[]) =>
  Object.fromEntries(names.map((name) => [name, {
    ...definitions[name]!,
    typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }, ...coordinates], returnType: seriesVoid }],
  } satisfies PineCallableDefinition]));

const tableParameterTypes: Readonly<Record<string, PineCallableParameterDefinition["type"]>> = {
  table_id: seriesTable, id: seriesTable, position: seriesString,
  columns: seriesInt, rows: seriesInt, column: seriesInt, row: seriesInt,
  start_column: seriesInt, start_row: seriesInt, end_column: seriesInt, end_row: seriesInt,
  text: seriesString, tooltip: seriesString, text_halign: seriesString, text_valign: seriesString,
  text_font_family: seriesString, text_formatting: seriesString, text_size: seriesString,
  width: seriesFloat, height: seriesFloat,
  bgcolor: seriesColor, text_color: seriesColor, frame_color: seriesColor, border_color: seriesColor,
  frame_width: seriesInt, border_width: seriesInt, force_overlay: constBool,
};

function tableProductionDefinition(name: string, fallback?: PineCallableDefinition): PineCallableDefinition {
  const definition = definitions[name] ?? fallback;
  if (!definition) throw new Error(`Missing table callable metadata for ${name}`);
  const parameters = definition.parameters.map((parameter) => {
    const type = tableParameterTypes[parameter];
    if (!type) throw new Error(`Missing production table parameter type for ${name}.${parameter}`);
    return { name: parameter, type, ...(definition.optionalParameters?.includes(parameter) ? { optional: true } : {}) };
  });
  const hasTextSize = name === "table.cell" || name === "table.cell_set_text_size";
  return {
    ...definition,
    ...(hasTextSize ? { overloads: [definition.parameters, definition.parameters] } : {}),
    typedOverloads: [
      { parameters, returnType: name === "table.new" ? seriesTable : seriesVoid },
      ...(hasTextSize ? [{
        parameters: parameters.map((parameter) => parameter.name === "text_size" ? { ...parameter, type: seriesInt } : parameter),
        returnType: seriesVoid,
      }] : []),
    ],
  };
}

const certifiedTableCallNames = [
  "table.new", "table.cell", "table.cell_set_bgcolor", "table.cell_set_height", "table.cell_set_text",
  "table.cell_set_text_color", "table.cell_set_text_font_family", "table.cell_set_text_halign",
  "table.cell_set_text_size", "table.cell_set_text_valign", "table.cell_set_tooltip", "table.cell_set_width",
  "table.clear", "table.delete", "table.merge_cells", "table.set_bgcolor", "table.set_border_color",
  "table.set_border_width", "table.set_frame_color", "table.set_frame_width", "table.set_position",
] as const;
const tableFontFamilyDefinition: PineCallableDefinition = {
  parameters: ["table_id", "column", "row", "text_font_family"],
  returnType: "void", documentation: "Sets a table cell font family.", signatureStatus: "complete",
};
const tableProductionOverrides = Object.fromEntries(certifiedTableCallNames.map((name) => [
  name, tableProductionDefinition(name, name === "table.cell_set_text_font_family" ? tableFontFamilyDefinition : undefined),
])) as Record<(typeof certifiedTableCallNames)[number], PineCallableDefinition>;
const boxSetterOverrides = (names: readonly string[], values: readonly PineCallableParameterDefinition[]) =>
  Object.fromEntries(names.map((name) => [name, {
    ...definitions[name]!,
    typedOverloads: [{ parameters: [{ name: "id", type: seriesBox }, ...values.map((value, index) => ({ ...value, name: definitions[name]!.parameters[index + 1]! }))], returnType: seriesVoid }],
  } satisfies PineCallableDefinition]));

const labelCallOverride = (
  name: string,
  parameters: readonly PineCallableParameterDefinition[],
  returnType: PineQualifiedType,
): PineCallableDefinition => ({
  parameters: parameters.map((parameter) => parameter.name),
  returnType: returnType.kind === "reference" ? "series label" : returnType.kind === "void" ? "void" : `series ${returnType.kind}`,
  documentation: `Provides the supported ${name} operation.`,
  signatureStatus: "complete",
  typedOverloads: [{ parameters, returnType }],
});

const labelSetterOverrides = (names: readonly string[], values: readonly PineCallableParameterDefinition[]) =>
  Object.fromEntries(names.map((name) => [name, labelCallOverride(name, [{ name: "id", type: seriesLabel }, ...values], seriesVoid)]));

const labelNewOverload = (point: boolean, sizeType: typeof seriesString | typeof seriesInt): PineCallableOverloadDefinition => ({
  parameters: [
    ...(point ? [{ name: "point", type: seriesPoint }] : [{ name: "x", type: seriesInt }, { name: "y", type: seriesFloat }]),
    { name: "text", type: seriesString, optional: true }, { name: "xloc", type: seriesString, optional: true },
    { name: "yloc", type: seriesString, optional: true }, { name: "color", type: seriesColor, optional: true },
    { name: "style", type: seriesString, optional: true }, { name: "textcolor", type: seriesColor, optional: true },
    { name: "size", type: sizeType, optional: true }, { name: "textalign", type: seriesString, optional: true },
    { name: "tooltip", type: seriesString, optional: true }, { name: "text_font_family", type: seriesString, optional: true },
    { name: "force_overlay", type: constBool, optional: true }, { name: "text_formatting", type: seriesString, optional: true },
  ],
  returnType: seriesLabel,
});

// Production-only additions must not widen the sealed compatibility signatures.
const riskOverride = (name: string, optionalParameters: readonly string[] = []): PineCallableDefinition => ({
  parameters: PINE_STRATEGY_CALL_SIGNATURES[name]!,
  optionalParameters,
  returnType: "void",
  documentation: `Applies the supported ${name} strategy risk rule.`,
  signatureStatus: "complete",
  typedOverloads: [],
});
export const PINE_PRODUCTION_CALLABLE_OVERRIDES: Readonly<Record<string, PineCallableDefinition>> = Object.freeze(
  {
    "strategy.convert_to_account": {
      parameters: ["value"], optionalParameters: [], returnType: "series float",
      documentation: "Converts symbol-currency value to the strategy account currency using the selected supplied daily rate.",
      signatureStatus: "complete",
      typedOverloads: [{ parameters: [{ name: "value", type: seriesFloat }], returnType: seriesFloat }],
    },
    "strategy.convert_to_symbol": {
      parameters: ["value"], optionalParameters: [], returnType: "series float",
      documentation: "Converts account-currency value to the chart symbol currency using the selected supplied daily rate.",
      signatureStatus: "complete",
      typedOverloads: [{ parameters: [{ name: "value", type: seriesFloat }], returnType: seriesFloat }],
    },
    "strategy.default_entry_qty": {
      parameters: ["fill_price"],
      optionalParameters: [],
      returnType: "series float",
      documentation: "Previews the default strategy order quantity at the supplied price.",
      signatureStatus: "complete",
      typedOverloads: [{ parameters: [{ name: "fill_price", type: seriesFloat }], returnType: seriesFloat }],
    },
    "strategy.risk.allow_entry_in": {
      ...riskOverride("strategy.risk.allow_entry_in"),
      typedOverloads: [{ parameters: [{ name: "value", type: seriesString }], returnType: seriesVoid }],
    },
    "strategy.risk.max_cons_loss_days": {
      ...riskOverride("strategy.risk.max_cons_loss_days", ["alert_message"]),
      typedOverloads: [{ parameters: [{ name: "count", type: seriesInt }, { name: "alert_message", type: seriesString, optional: true }], returnType: seriesVoid }],
    },
    "strategy.risk.max_drawdown": {
      ...riskOverride("strategy.risk.max_drawdown", ["alert_message"]),
      typedOverloads: [{ parameters: [{ name: "value", type: seriesFloat }, { name: "type", type: seriesString }, { name: "alert_message", type: seriesString, optional: true }], returnType: seriesVoid }],
    },
    "strategy.risk.max_intraday_filled_orders": {
      ...riskOverride("strategy.risk.max_intraday_filled_orders", ["alert_message"]),
      typedOverloads: [{ parameters: [{ name: "count", type: seriesInt }, { name: "alert_message", type: seriesString, optional: true }], returnType: seriesVoid }],
    },
    "strategy.risk.max_intraday_loss": {
      ...riskOverride("strategy.risk.max_intraday_loss", ["alert_message"]),
      typedOverloads: [{ parameters: [{ name: "value", type: seriesFloat }, { name: "type", type: seriesString }, { name: "alert_message", type: seriesString, optional: true }], returnType: seriesVoid }],
    },
    "strategy.risk.max_position_size": {
      ...riskOverride("strategy.risk.max_position_size"),
      typedOverloads: [{ parameters: [{ name: "contracts", type: seriesFloat }], returnType: seriesVoid }],
    },
    "strategy.close_all": {
      ...definitions["strategy.close_all"]!,
      typedOverloads: [{ parameters: [
        { name: "comment", type: seriesString, optional: true },
        { name: "alert_message", type: seriesString, optional: true },
        { name: "immediately", type: seriesBool, optional: true },
        { name: "disable_alert", type: seriesBool, optional: true },
      ], returnType: seriesVoid }],
    },
    "strategy.order": {
      ...definitions["strategy.order"]!,
      typedOverloads: [{ parameters: [
        { name: "id", type: seriesString },
        { name: "direction", type: seriesString },
        { name: "qty", type: seriesFloat, optional: true },
        { name: "limit", type: seriesFloat, optional: true },
        { name: "stop", type: seriesFloat, optional: true },
        { name: "oca_name", type: seriesString, optional: true },
        { name: "oca_type", type: seriesString, optional: true },
        { name: "comment", type: seriesString, optional: true },
        { name: "alert_message", type: seriesString, optional: true },
        { name: "disable_alert", type: seriesBool, optional: true },
      ], returnType: seriesVoid }],
    },
    "strategy.exit": {
      ...definitions["strategy.exit"]!,
      typedOverloads: [{ parameters: [
        { name: "id", type: seriesString },
        { name: "from_entry", type: seriesString, optional: true },
        { name: "qty", type: seriesFloat, optional: true },
        { name: "qty_percent", type: seriesFloat, optional: true },
        { name: "profit", type: seriesFloat, optional: true },
        { name: "limit", type: seriesFloat, optional: true },
        { name: "loss", type: seriesFloat, optional: true },
        { name: "stop", type: seriesFloat, optional: true },
        { name: "trail_price", type: seriesFloat, optional: true },
        { name: "trail_points", type: seriesFloat, optional: true },
        { name: "trail_offset", type: seriesFloat, optional: true },
        { name: "oca_name", type: seriesString, optional: true },
        { name: "comment", type: seriesString, optional: true },
        { name: "comment_profit", type: seriesString, optional: true },
        { name: "comment_loss", type: seriesString, optional: true },
        { name: "comment_trailing", type: seriesString, optional: true },
        { name: "alert_message", type: seriesString, optional: true },
        { name: "alert_profit", type: seriesString, optional: true },
        { name: "alert_loss", type: seriesString, optional: true },
        { name: "alert_trailing", type: seriesString, optional: true },
        { name: "disable_alert", type: seriesBool, optional: true },
      ], returnType: seriesVoid }],
    },
    "strategy.cancel": {
      ...definitions["strategy.cancel"]!,
      typedOverloads: [{ parameters: [{ name: "id", type: seriesString }], returnType: seriesVoid }],
    },
    ...tableProductionOverrides,
    "linefill.new": { ...definitions["linefill.new"]!, returnType: "series linefill", typedOverloads: [{ parameters: [{ name: "line1", type: seriesLine }, { name: "line2", type: seriesLine }, { name: "color", type: seriesColor }], returnType: seriesLinefill }] },
    "linefill.delete": { ...definitions["linefill.delete"]!, returnType: "void", typedOverloads: [{ parameters: [{ name: "id", type: seriesLinefill }], returnType: seriesVoid }] },
    "linefill.set_color": { ...definitions["linefill.set_color"]!, returnType: "void", typedOverloads: [{ parameters: [{ name: "id", type: seriesLinefill }, { name: "color", type: seriesColor }], returnType: seriesVoid }] },
    "linefill.get_line1": { ...definitions["linefill.get_line1"]!, returnType: "series line", typedOverloads: [{ parameters: [{ name: "id", type: seriesLinefill }], returnType: seriesLine }] },
    "linefill.get_line2": { ...definitions["linefill.get_line2"]!, returnType: "series line", typedOverloads: [{ parameters: [{ name: "id", type: seriesLinefill }], returnType: seriesLine }] },
    "polyline.new": { ...definitions["polyline.new"]!, returnType: "series polyline", typedOverloads: [{ parameters: [
      { name: "points", type: seriesPoints }, { name: "curved", type: seriesBool, optional: true },
      { name: "closed", type: seriesBool, optional: true }, { name: "xloc", type: seriesString, optional: true },
      { name: "line_color", type: seriesColor, optional: true }, { name: "fill_color", type: seriesColor, optional: true },
      { name: "line_style", type: seriesString, optional: true }, { name: "line_width", type: seriesInt, optional: true },
      { name: "force_overlay", type: constBool, optional: true },
    ], returnType: seriesPolyline }] },
    "polyline.delete": { ...definitions["polyline.delete"]!, returnType: "void", typedOverloads: [{ parameters: [{ name: "id", type: seriesPolyline }], returnType: seriesVoid }] },
    "line.new": { ...definitions["line.new"]!, overloads: [["first_point", "second_point", "xloc", "extend", "color", "style", "width", "force_overlay"], definitions["line.new"]!.parameters], typedOverloads: [
      { parameters: [{ name: "first_point", type: seriesPoint }, { name: "second_point", type: seriesPoint }, { name: "xloc", type: seriesString, optional: true }, { name: "extend", type: seriesString, optional: true }, { name: "color", type: seriesColor, optional: true }, { name: "style", type: seriesString, optional: true }, { name: "width", type: seriesInt, optional: true }, { name: "force_overlay", type: constBool, optional: true }], returnType: seriesLine },
      { parameters: [{ name: "x1", type: seriesInt }, { name: "y1", type: seriesFloat }, { name: "x2", type: seriesInt }, { name: "y2", type: seriesFloat }, { name: "xloc", type: seriesString, optional: true }, { name: "extend", type: seriesString, optional: true }, { name: "color", type: seriesColor, optional: true }, { name: "style", type: seriesString, optional: true }, { name: "width", type: seriesInt, optional: true }, { name: "force_overlay", type: constBool, optional: true }], returnType: seriesLine },
    ] },
    ...lineSetterOverrides(["line.set_xy2", "line.set_xy1"], [{ name: "x", type: seriesInt }, { name: "y", type: seriesFloat }]),
    ...lineSetterOverrides(["line.set_x1", "line.set_x2"], [{ name: "x", type: seriesInt }]),
    ...lineSetterOverrides(["line.set_y1", "line.set_y2"], [{ name: "y", type: seriesFloat }]),
    ...lineSetterOverrides(["line.set_color"], [{ name: "color", type: seriesColor }]),
    ...lineSetterOverrides(["line.set_width"], [{ name: "width", type: seriesInt }]),
    ...lineSetterOverrides(["line.set_style"], [{ name: "style", type: seriesString }]),
    ...lineSetterOverrides(["line.set_extend"], [{ name: "extend", type: seriesString }]),
    ...lineSetterOverrides(["line.set_first_point", "line.set_second_point"], [{ name: "point", type: seriesPoint }]),
    "line.set_xloc": { parameters: ["id", "x1", "x2", "xloc"], returnType: "void", signatureStatus: "complete", documentation: "Changes a line's coordinate mode and both x anchors.", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }, { name: "x1", type: seriesInt }, { name: "x2", type: seriesInt }, { name: "xloc", type: seriesString }], returnType: seriesVoid }] },
    "chart.point.new": { parameters: ["time", "index", "price"], returnType: "series chart.point", signatureStatus: "complete", documentation: "Constructs a chart point from time, index and price.", typedOverloads: [{ parameters: [{ name: "time", type: seriesInt }, { name: "index", type: seriesInt }, { name: "price", type: seriesFloat }], returnType: seriesPoint }] },
    "chart.point.from_index": { parameters: ["index", "price"], returnType: "series chart.point", signatureStatus: "complete", documentation: "Constructs a chart point with an index and price.", typedOverloads: [{ parameters: [{ name: "index", type: seriesInt }, { name: "price", type: seriesFloat }], returnType: seriesPoint }] },
    "chart.point.from_time": { parameters: ["time", "price"], returnType: "series chart.point", signatureStatus: "complete", documentation: "Constructs a chart point with a time and price.", typedOverloads: [{ parameters: [{ name: "time", type: seriesInt }, { name: "price", type: seriesFloat }], returnType: seriesPoint }] },
    "chart.point.now": { parameters: ["price"], returnType: "series chart.point", signatureStatus: "complete", documentation: "Constructs a point at the current bar.", typedOverloads: [{ parameters: [{ name: "price", type: seriesFloat }], returnType: seriesPoint }] },
    "chart.point.copy": { parameters: ["point"], returnType: "series chart.point", signatureStatus: "complete", documentation: "Copies a chart point into an independent reference.", typedOverloads: [{ parameters: [{ name: "point", type: seriesPoint }], returnType: seriesPoint }] },
    "line.copy": { parameters: ["id"], returnType: "series line", documentation: "Clones a line with independent identity and properties.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }], returnType: seriesLine }] },
    "line.get_x1": { parameters: ["id"], returnType: "series int", documentation: "Returns a line's first x coordinate.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }], returnType: seriesInt }] },
    "line.get_y1": { parameters: ["id"], returnType: "series float", documentation: "Returns a line's first y coordinate.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }], returnType: seriesFloat }] },
    "line.get_x2": { parameters: ["id"], returnType: "series int", documentation: "Returns a line's second x coordinate.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }], returnType: seriesInt }] },
    "line.get_y2": { parameters: ["id"], returnType: "series float", documentation: "Returns a line's second y coordinate.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }], returnType: seriesFloat }] },
    "line.get_price": { parameters: ["id", "x"], returnType: "series float", documentation: "Returns the line price at a bar index.", signatureStatus: "complete", typedOverloads: [{ parameters: [{ name: "id", type: seriesLine }, { name: "x", type: seriesInt }], returnType: seriesFloat }] },
    ...lineSetterOverrides(["line.delete"], []),
    "box.new": { ...definitions["box.new"]!, overloads: [["top_left", "bottom_right", ...definitions["box.new"]!.parameters.slice(4)], ["top_left", "bottom_right", ...definitions["box.new"]!.parameters.slice(4)], definitions["box.new"]!.parameters, definitions["box.new"]!.parameters], typedOverloads: [
      { parameters: [{ name: "top_left", type: seriesPoint }, { name: "bottom_right", type: seriesPoint }, { name: "border_color", type: seriesColor, optional: true }, { name: "border_width", type: seriesInt, optional: true }, { name: "border_style", type: seriesString, optional: true }, { name: "extend", type: seriesString, optional: true }, { name: "xloc", type: seriesString, optional: true }, { name: "bgcolor", type: seriesColor, optional: true }, { name: "text", type: seriesString, optional: true }, { name: "text_size", type: seriesString, optional: true }, { name: "text_color", type: seriesColor, optional: true }, { name: "text_halign", type: seriesString, optional: true }, { name: "text_valign", type: seriesString, optional: true }, { name: "text_wrap", type: seriesString, optional: true }, { name: "text_font_family", type: seriesString, optional: true }, { name: "force_overlay", type: constBool, optional: true }, { name: "text_formatting", type: seriesString, optional: true }], returnType: seriesBox },
      { parameters: [{ name: "left", type: seriesInt }, { name: "top", type: seriesFloat }, { name: "right", type: seriesInt }, { name: "bottom", type: seriesFloat }, { name: "border_color", type: seriesColor, optional: true }, { name: "border_width", type: seriesInt, optional: true }, { name: "border_style", type: seriesString, optional: true }, { name: "extend", type: seriesString, optional: true }, { name: "xloc", type: seriesString, optional: true }, { name: "bgcolor", type: seriesColor, optional: true }, { name: "text", type: seriesString, optional: true }, { name: "text_size", type: seriesString, optional: true }, { name: "text_color", type: seriesColor, optional: true }, { name: "text_halign", type: seriesString, optional: true }, { name: "text_valign", type: seriesString, optional: true }, { name: "text_wrap", type: seriesString, optional: true }, { name: "text_font_family", type: seriesString, optional: true }, { name: "force_overlay", type: constBool, optional: true }, { name: "text_formatting", type: seriesString, optional: true }], returnType: seriesBox },
    ].flatMap((overload) => [overload, {
      ...overload,
      parameters: overload.parameters.map((parameter) => parameter.name === "text_size" ? { ...parameter, type: seriesInt } : parameter),
    }]) },
    "box.copy": { ...definitions["box.copy"]!, returnType: "series box", typedOverloads: [{ parameters: [{ name: "id", type: seriesBox }], returnType: seriesBox }] },
    ...Object.fromEntries(["get_left", "get_right", "get_top", "get_bottom"].map((method) => [`box.${method}`, { ...definitions[`box.${method}`]!, returnType: method === "get_left" || method === "get_right" ? "series int" : "series float", typedOverloads: [{ parameters: [{ name: "id", type: seriesBox }], returnType: method === "get_left" || method === "get_right" ? seriesInt : seriesFloat }] }])),
    ...boxSetterOverrides(["box.delete"], []),
    ...boxSetterOverrides(["box.set_left", "box.set_right"], [{ name: "left", type: seriesInt }]),
    ...boxSetterOverrides(["box.set_top", "box.set_bottom"], [{ name: "top", type: seriesFloat }]),
    ...boxSetterOverrides(["box.set_lefttop", "box.set_rightbottom"], [{ name: "left", type: seriesInt }, { name: "top", type: seriesFloat }]),
    ...boxSetterOverrides(["box.set_top_left_point", "box.set_bottom_right_point"], [{ name: "point", type: seriesPoint }]),
    ...boxSetterOverrides(["box.set_bgcolor", "box.set_border_color", "box.set_text_color"], [{ name: "color", type: seriesColor }]),
    ...boxSetterOverrides(["box.set_border_width"], [{ name: "width", type: seriesInt }]),
    ...boxSetterOverrides(["box.set_border_style", "box.set_extend", "box.set_text_halign", "box.set_text_valign", "box.set_text_wrap", "box.set_text_font_family", "box.set_text_formatting", "box.set_text"], [{ name: "value", type: seriesString }]),
    "box.set_text_size": { ...definitions["box.set_text_size"]!, overloads: [definitions["box.set_text_size"]!.parameters, definitions["box.set_text_size"]!.parameters], typedOverloads: [
      { parameters: [{ name: "id", type: seriesBox }, { name: "size", type: seriesString }], returnType: seriesVoid },
      { parameters: [{ name: "id", type: seriesBox }, { name: "size", type: seriesInt }], returnType: seriesVoid },
    ] },
    "box.set_xloc": { ...definitions["box.set_xloc"]!, typedOverloads: [{ parameters: [{ name: "id", type: seriesBox }, { name: "left", type: seriesInt }, { name: "right", type: seriesInt }, { name: "xloc", type: seriesString }], returnType: seriesVoid }] },
    "label.new": { ...definitions["label.new"]!, overloads: [["point", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"], definitions["label.new"]!.parameters, ["point", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"], definitions["label.new"]!.parameters], typedOverloads: [
      labelNewOverload(true, seriesString), labelNewOverload(false, seriesString),
      labelNewOverload(true, seriesInt), labelNewOverload(false, seriesInt),
    ] },
    "label.copy": labelCallOverride("label.copy", [{ name: "id", type: seriesLabel }], seriesLabel),
    "label.get_text": labelCallOverride("label.get_text", [{ name: "id", type: seriesLabel }], seriesString),
    "label.get_x": labelCallOverride("label.get_x", [{ name: "id", type: seriesLabel }], seriesInt),
    "label.get_y": labelCallOverride("label.get_y", [{ name: "id", type: seriesLabel }], seriesFloat),
    ...labelSetterOverrides(["label.delete"], []),
    ...labelSetterOverrides(["label.set_x"], [{ name: "x", type: seriesInt }]),
    ...labelSetterOverrides(["label.set_y"], [{ name: "y", type: seriesFloat }]),
    ...labelSetterOverrides(["label.set_xy"], [{ name: "x", type: seriesInt }, { name: "y", type: seriesFloat }]),
    ...labelSetterOverrides(["label.set_color"], [{ name: "color", type: seriesColor }]),
    ...labelSetterOverrides(["label.set_point"], [{ name: "point", type: seriesPoint }]),
    "label.set_size": { ...labelCallOverride("label.set_size", [{ name: "id", type: seriesLabel }, { name: "size", type: seriesString }], seriesVoid), overloads: [["id", "size"], ["id", "size"]], typedOverloads: [
      { parameters: [{ name: "id", type: seriesLabel }, { name: "size", type: seriesString }], returnType: seriesVoid },
      { parameters: [{ name: "id", type: seriesLabel }, { name: "size", type: seriesInt }], returnType: seriesVoid },
    ] },
    ...labelSetterOverrides(["label.set_style"], [{ name: "style", type: seriesString }]),
    ...labelSetterOverrides(["label.set_text"], [{ name: "text", type: seriesString }]),
    ...labelSetterOverrides(["label.set_text_font_family"], [{ name: "family", type: seriesString }]),
    ...labelSetterOverrides(["label.set_textalign"], [{ name: "textalign", type: seriesString }]),
    ...labelSetterOverrides(["label.set_textcolor"], [{ name: "textcolor", type: seriesColor }]),
    ...labelSetterOverrides(["label.set_tooltip"], [{ name: "tooltip", type: seriesString }]),
    "label.set_xloc": labelCallOverride("label.set_xloc", [
      { name: "id", type: seriesLabel }, { name: "x", type: seriesInt }, { name: "xloc", type: seriesString },
    ], seriesVoid),
    ...labelSetterOverrides(["label.set_yloc"], [{ name: "yloc", type: seriesString }]),
    "barcolor": { ...definitions["barcolor"]!, typedOverloads: [{ parameters: [
  { name: "color", type: seriesColor },
  { name: "offset", type: simpleInt, optional: true },
  { name: "editable", type: constBool, optional: true },
  { name: "show_last", type: simpleInt, optional: true },
  { name: "title", type: constString, optional: true },
  { name: "display", type: constInt, optional: true },
], returnType: seriesVoid }] },
    "bgcolor": { ...definitions["bgcolor"]!, typedOverloads: [{ parameters: [
  { name: "color", type: seriesColor },
  { name: "offset", type: simpleInt, optional: true },
  { name: "editable", type: constBool, optional: true },
  { name: "show_last", type: simpleInt, optional: true },
  { name: "title", type: constString, optional: true },
  { name: "display", type: constInt, optional: true },
  { name: "force_overlay", type: constBool, optional: true },
], returnType: seriesVoid }] },
    "plotbar": { ...definitions["plotbar"]!, typedOverloads: [{ parameters: [
  { name: "open", type: seriesFloat }, { name: "high", type: seriesFloat },
  { name: "low", type: seriesFloat }, { name: "close", type: seriesFloat },
  { name: "title", type: constString, optional: true },
  { name: "color", type: seriesColor, optional: true },
  { name: "editable", type: constBool, optional: true },
  { name: "show_last", type: simpleInt, optional: true },
  { name: "display", type: constInt, optional: true },
  { name: "format", type: inputString, optional: true },
  { name: "precision", type: constInt, optional: true },
  { name: "force_overlay", type: constBool, optional: true },
], returnType: seriesVoid }] },
    "plotcandle": { ...definitions["plotcandle"]!, typedOverloads: [{ parameters: [
  { name: "open", type: seriesFloat }, { name: "high", type: seriesFloat },
  { name: "low", type: seriesFloat }, { name: "close", type: seriesFloat },
  { name: "title", type: constString, optional: true },
  { name: "color", type: seriesColor, optional: true },
  { name: "wickcolor", type: seriesColor, optional: true },
  { name: "editable", type: constBool, optional: true },
  { name: "show_last", type: simpleInt, optional: true },
  { name: "bordercolor", type: seriesColor, optional: true },
  { name: "display", type: constInt, optional: true },
  { name: "format", type: inputString, optional: true },
  { name: "precision", type: constInt, optional: true },
  { name: "force_overlay", type: constBool, optional: true },
], returnType: seriesVoid }] },
    ...Object.fromEntries(["array.sort", "array.sort_indices"].map((name) => {
      const base = definitions[name]!;
      const definition = {
        ...base,
        parameters: [...base.parameters, "sort_field"],
        optionalParameters: [...(base.optionalParameters ?? []), "sort_field"],
      };
      return [name, { ...definition, typedOverloads: deriveTypedOverloads(definition) }];
    })),
    "array.join": productionArrayJoin,
    "map.put": (() => {
      // Returns the key's previous value, or na for a new key.
      const definition = { ...definitions["map.put"]!, returnType: "series" };
      return { ...definition, typedOverloads: deriveTypedOverloads(definition) } satisfies PineCallableDefinition;
    })(),
    "array.max": productionArrayExtremum("array.max"),
    "array.min": productionArrayExtremum("array.min"),
    "color.b": productionColorComponent("color.b"),
    "color.from_gradient": productionColorGradient,
    "color.g": productionColorComponent("color.g"),
    "color.new": productionColorNew,
    "color.r": productionColorComponent("color.r"),
    "color.rgb": productionColorRgb,
    "color.t": productionColorComponent("color.t"),
    "math.random": productionMathRandom,
    "math.round_to_mintick": productionMathRoundToMintick,
    "math.sum": productionMathSum,
    ...productionMatrixPredicates,
    ...productionMatrixNumeric,
    ...productionMatrixLinearAlgebra,
    ...productionMatrixInversePower,
    ...productionMatrixArithmetic,
    "matrix.sort": productionMatrixSort,
    "matrix.remove_col": productionMatrixRemove("matrix.remove_col", "column"),
    "matrix.remove_row": productionMatrixRemove("matrix.remove_row", "row"),
    "matrix.reverse": {
      ...definitions["matrix.reverse"]!,
      typedOverloads: [{
        parameters: [{ name: "id", type: seriesUnknown }],
        returnType: seriesVoid,
      }],
    },
    "request.security": productionSecurityRequest,
    "request.security_lower_tf": productionLowerRequest,
    "ta.stdev": productionBiasedDispersion("ta.stdev"),
    "ta.variance": productionBiasedDispersion("ta.variance"),
    "ta.alma": productionAlma,
    "ta.kc": productionKeltner("ta.kc"),
    "ta.kcw": productionKeltner("ta.kcw"),
    "ta.cmo": {
      ...definitions["ta.cmo"]!,
      typedOverloads: [{ parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }], returnType: seriesFloat }],
    },
    "ta.cog": {
      ...definitions["ta.cog"]!,
      typedOverloads: [{
        parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: seriesInt }],
        returnType: seriesFloat,
      }],
    },
    "ta.vwap": productionVwap,
    "ta.rci": {
      ...definitions["ta.rci"]!,
      typedOverloads: [{
        parameters: [{ name: "source", type: seriesFloat }, { name: "length", type: simpleInt }],
        returnType: seriesFloat,
      }],
    },
  },
);
