export const PINE_STRATEGY_CALL_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  "strategy.entry": ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  "strategy.order": ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"],
  "strategy.exit": ["id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "disable_alert"],
  "strategy.close": ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert"],
  "strategy.close_all": ["comment", "alert_message", "immediately", "disable_alert"],
  "strategy.cancel": ["id", "immediately"],
  "strategy.cancel_all": [],
  "strategy.convert_to_account": ["value"],
  "strategy.convert_to_symbol": ["value"],
  "strategy.default_entry_qty": ["fill_price"],
  "strategy.risk.allow_entry_in": ["value"],
  "strategy.risk.max_cons_loss_days": ["count", "alert_message"],
  "strategy.risk.max_drawdown": ["value", "type", "alert_message"],
  "strategy.risk.max_intraday_filled_orders": ["count", "alert_message"],
  "strategy.risk.max_intraday_loss": ["value", "type", "alert_message"],
  "strategy.risk.max_position_size": ["contracts"],
};

const v5WhenCommands = new Set([
  "strategy.entry", "strategy.order", "strategy.exit", "strategy.close",
  "strategy.close_all", "strategy.cancel", "strategy.cancel_all",
]);

/** Deprecated Pine v5 command forms. Pine v6 uses PINE_STRATEGY_CALL_SIGNATURES. */
export const PINE_V5_STRATEGY_CALL_SIGNATURES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(Object.entries(PINE_STRATEGY_CALL_SIGNATURES).map(([name, signature]) => [
    name,
    Object.freeze(v5WhenCommands.has(name) ? [...signature, "when"] : [...signature]),
  ])),
);

/**
 * Current reference plot-family signatures. Both callable metadata and the
 * compiler's visual lowering consume this table so their named-argument
 * schemas cannot drift.
 */
export const PINE_PLOT_CALL_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  "plot": ["series", "title", "color", "linewidth", "style", "trackprice", "histbase", "offset", "join", "editable", "show_last", "display", "format", "precision", "force_overlay", "linestyle"],
  "plotarrow": ["series", "title", "colorup", "colordown", "offset", "minheight", "maxheight", "editable", "show_last", "display", "format", "precision", "force_overlay"],
  "plotbar": ["open", "high", "low", "close", "title", "color", "editable", "show_last", "display", "format", "precision", "force_overlay"],
  "plotcandle": ["open", "high", "low", "close", "title", "color", "wickcolor", "editable", "show_last", "bordercolor", "display", "format", "precision", "force_overlay"],
  "plotchar": ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"],
  "plotshape": ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"],
};

/**
 * Pine exposes distinct plot, hline, and gradient fill overloads. Keep their
 * order here because both semantic named-argument binding and visual lowering
 * must agree on every trailing option.
 */
export const PINE_FILL_CALL_SIGNATURES = Object.freeze({
  plot: Object.freeze(["plot1", "plot2", "color", "title", "editable", "show_last", "fillgaps", "display"]),
  hline: Object.freeze(["hline1", "hline2", "color", "title", "editable", "show_last", "fillgaps", "display"]),
  gradient: Object.freeze(["plot1", "plot2", "top_value", "bottom_value", "top_color", "bottom_color", "title", "editable", "show_last", "fillgaps", "display"]),
  gradientHline: Object.freeze(["hline1", "hline2", "top_value", "bottom_value", "top_color", "bottom_color", "title", "editable", "show_last", "fillgaps", "display"]),
} as const);

export const PINE_DRAWING_CALL_SIGNATURES: Readonly<Record<string, readonly string[]>> = {
  "line.new": ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width", "force_overlay"],
  "line.set_x1": ["id", "x"], "line.set_y1": ["id", "y"], "line.set_x2": ["id", "x"], "line.set_y2": ["id", "y"],
  "line.set_xy1": ["id", "x", "y"], "line.set_xy2": ["id", "x", "y"], "line.set_color": ["id", "color"],
  "line.set_width": ["id", "width"], "line.set_style": ["id", "style"], "line.set_extend": ["id", "extend"],
  "line.set_xloc": ["id", "x1", "x2", "xloc"], "line.get_x1": ["id"], "line.get_y1": ["id"],
  "line.set_first_point": ["id", "point"], "line.set_second_point": ["id", "point"],
  "line.get_x2": ["id"], "line.get_y2": ["id"], "line.get_price": ["id", "x"], "line.copy": ["id"], "line.delete": ["id"],
  "box.new": ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"],
  "box.set_left": ["id", "left"], "box.set_right": ["id", "right"], "box.set_top": ["id", "top"], "box.set_bottom": ["id", "bottom"],
  "box.set_lefttop": ["id", "left", "top"], "box.set_rightbottom": ["id", "right", "bottom"], "box.set_xloc": ["id", "left", "right", "xloc"],
  "box.set_top_left_point": ["id", "point"], "box.set_bottom_right_point": ["id", "point"],
  "box.set_bgcolor": ["id", "color"], "box.set_border_color": ["id", "color"], "box.set_border_width": ["id", "width"],
  "box.set_border_style": ["id", "style"], "box.set_extend": ["id", "extend"], "box.set_text": ["id", "text"],
  "box.set_text_color": ["id", "color"], "box.set_text_size": ["id", "size"], "box.set_text_halign": ["id", "align"],
  "box.set_text_valign": ["id", "align"], "box.set_text_wrap": ["id", "wrap"], "box.set_text_font_family": ["id", "family"],
  "box.set_text_formatting": ["id", "formatting"], "box.get_left": ["id"], "box.get_right": ["id"], "box.get_top": ["id"],
  "box.get_bottom": ["id"], "box.copy": ["id"], "box.delete": ["id"],
  "label.new": ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"],
  "label.set_x": ["id", "x"], "label.set_y": ["id", "y"], "label.set_xy": ["id", "x", "y"], "label.set_text": ["id", "text"],
  "label.set_color": ["id", "color"], "label.set_textcolor": ["id", "textcolor"], "label.set_size": ["id", "size"],
  "label.set_style": ["id", "style"], "label.set_textalign": ["id", "textalign"], "label.set_tooltip": ["id", "tooltip"],
  "label.set_xloc": ["id", "xloc"], "label.set_yloc": ["id", "yloc"], "label.set_text_font_family": ["id", "family"],
  "label.set_text_formatting": ["id", "text_formatting"],
  "label.set_point": ["id", "point"],
  "label.get_x": ["id"], "label.get_y": ["id"], "label.get_text": ["id"], "label.copy": ["id"], "label.delete": ["id"],
  "chart.point.new": ["time", "index", "price"], "chart.point.from_index": ["index", "price"],
  "chart.point.from_time": ["time", "price"], "chart.point.copy": ["point"], "chart.point.now": ["price"],
  "polyline.new": ["points", "curved", "closed", "xloc", "line_color", "fill_color", "line_style", "line_width", "force_overlay"],
  "polyline.delete": ["id"],
  "linefill.new": ["line1", "line2", "color"], "linefill.set_color": ["id", "color"],
  "linefill.get_line1": ["id"], "linefill.get_line2": ["id"], "linefill.delete": ["id"],
  "table.new": ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"],
  "table.cell": ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"],
  "table.clear": ["table_id", "start_column", "start_row", "end_column", "end_row"],
  "table.merge_cells": ["table_id", "start_column", "start_row", "end_column", "end_row"],
  "table.cell_set_text": ["table_id", "column", "row", "text"], "table.cell_set_bgcolor": ["table_id", "column", "row", "bgcolor"],
  "table.cell_set_text_color": ["table_id", "column", "row", "text_color"], "table.cell_set_text_size": ["table_id", "column", "row", "text_size"],
  "table.cell_set_height": ["table_id", "column", "row", "height"], "table.cell_set_width": ["table_id", "column", "row", "width"],
  "table.cell_set_tooltip": ["table_id", "column", "row", "tooltip"], "table.cell_set_text_halign": ["table_id", "column", "row", "text_halign"],
  "table.cell_set_text_valign": ["table_id", "column", "row", "text_valign"], "table.cell_set_text_font_family": ["table_id", "column", "row", "text_font_family"],
  "table.cell_set_text_formatting": ["table_id", "column", "row", "text_formatting"],
  "table.set_position": ["table_id", "position"], "table.set_bgcolor": ["table_id", "bgcolor"],
  "table.set_border_color": ["table_id", "border_color"], "table.set_border_width": ["table_id", "border_width"],
  "table.set_frame_color": ["table_id", "frame_color"], "table.set_frame_width": ["table_id", "frame_width"], "table.delete": ["id"],
};
