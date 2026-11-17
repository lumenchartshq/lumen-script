/**
 * Exact namespace constants implemented by RuntimeContext.constant(). Keeping
 * them in contracts lets the strict-profile compiler validate enum-style members
 * without rejecting values the runtime already supports.
 */
export const PINE_CONSTANT_NAMES = Object.freeze([
  "math.e", "math.phi", "math.pi", "math.rphi",
  "color.aqua", "color.black", "color.blue", "color.fuchsia", "color.gray", "color.green", "color.lime", "color.maroon", "color.navy", "color.olive", "color.orange", "color.purple", "color.red", "color.silver", "color.teal", "color.white", "color.yellow",
  "plot.style_area", "plot.style_areabr", "plot.style_circles", "plot.style_columns", "plot.style_cross", "plot.style_histogram", "plot.style_line", "plot.style_linebr", "plot.style_stepline", "plot.style_stepline_diamond", "plot.style_steplinebr", "plot.linestyle_solid", "plot.linestyle_dotted", "plot.linestyle_dashed",
  "location.abovebar", "location.belowbar", "location.absolute", "location.bottom", "location.top",
  "shape.flag", "shape.arrowdown", "shape.arrowup", "shape.circle", "shape.cross", "shape.diamond", "shape.labeldown", "shape.labelup", "shape.square", "shape.triangledown", "shape.triangleup", "shape.xcross",
  "size.auto", "size.tiny", "size.small", "size.normal", "size.large", "size.huge",
  "format.inherit", "format.mintick", "format.percent", "format.price", "format.volume",
  "text.align_left", "text.align_center", "text.align_right", "text.align_top", "text.align_bottom", "text.wrap_auto", "text.wrap_none",
  "text.format_none", "text.format_bold", "text.format_italic",
  "font.family_default", "font.family_monospace",
  "adjustment.none", "adjustment.splits", "adjustment.dividends",
  "backadjustment.inherit", "backadjustment.off", "backadjustment.on",
  "earnings.actual", "earnings.estimate", "earnings.standardized", "earnings.future_eps", "earnings.future_period_end_time", "earnings.future_revenue", "earnings.future_time",
  "dividends.gross", "dividends.net", "dividends.future_amount", "dividends.future_ex_date", "dividends.future_pay_date",
  "splits.denominator", "splits.numerator",
  "dayofweek.sunday", "dayofweek.monday", "dayofweek.tuesday", "dayofweek.wednesday", "dayofweek.thursday", "dayofweek.friday", "dayofweek.saturday",
  "order.ascending", "order.descending",
  "display.all", "display.data_window", "display.none", "display.pane", "display.price_scale", "display.status_line", "display.pine_screener",
  "barmerge.gaps_on", "barmerge.gaps_off", "barmerge.lookahead_on", "barmerge.lookahead_off",
  "hline.style_dashed", "hline.style_dotted", "hline.style_solid",
  "alert.freq_all", "alert.freq_once_per_bar", "alert.freq_once_per_bar_close",
  "xloc.bar_index", "xloc.bar_time",
  "extend.left", "extend.right", "extend.both", "extend.none",
  "line.style_solid", "line.style_dotted", "line.style_dashed", "line.style_arrow_left", "line.style_arrow_right", "line.style_arrow_both", "line.all",
  "yloc.price", "yloc.abovebar", "yloc.belowbar",
  "label.style_label_down", "label.style_label_up", "label.style_label_left", "label.style_label_right", "label.style_label_center", "label.style_label_lower_left", "label.style_label_lower_right", "label.style_label_upper_left", "label.style_label_upper_right", "label.style_circle", "label.style_square", "label.style_diamond", "label.style_arrowdown", "label.style_arrowup", "label.style_cross", "label.style_flag", "label.style_none", "label.style_text_outline", "label.style_triangledown", "label.style_triangleup", "label.style_xcross", "label.all",
  "scale.left", "scale.none", "scale.right",
  "settlement_as_close.inherit", "settlement_as_close.off", "settlement_as_close.on",
  "box.all", "polyline.all", "linefill.all", "table.all",
  "position.top_left", "position.top_center", "position.top_right", "position.middle_left", "position.middle_center", "position.middle_right", "position.bottom_left", "position.bottom_center", "position.bottom_right",
] as const);

/** Strategy selectors belong only to the production catalog. */
export const PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES = Object.freeze([
  "strategy.cash", "strategy.commission.cash_per_contract", "strategy.commission.cash_per_order",
  "strategy.commission.percent", "strategy.direction.all", "strategy.direction.long",
  "strategy.direction.short", "strategy.fixed", "strategy.long", "strategy.oca.cancel",
  "strategy.oca.none", "strategy.oca.reduce", "strategy.percent_of_equity", "strategy.short",
] as const);

const shadowingNamespaceRoots = new Set([
  "adjustment", "barmerge", "currency", "dayofweek", "font", "order", "position",
]);
const currencyMembers = new Set([
  "AED", "ARS", "AUD", "BHD", "BRL", "BTC", "CAD", "CHF", "CLP", "CNY", "COP", "CZK",
  "DKK", "EGP", "ETH", "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY",
  "KRW", "KWD", "MAD", "MXN", "MYR", "NGN", "NOK", "NONE", "NZD", "PEN", "PHP", "PKR",
  "PLN", "QAR", "RON", "RUB", "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "USD", "USDT",
  "VND", "ZAR",
]);
const shadowingConstantNames = new Set<string>([
  ...PINE_CONSTANT_NAMES.filter((name) => shadowingNamespaceRoots.has(name.split(".", 1)[0]!)),
  ...Array.from(currencyMembers, (member) => `currency.${member}`),
]);

/**
 * Constants from the seven namespaces that Pine resolves before colliding
 * user symbols. Unknown members still belong to the user value/type.
 */
export function isPineShadowingNamespaceConstant(name: string): boolean {
  return shadowingConstantNames.has(name);
}
