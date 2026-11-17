/** Exact indexed strategy calls admitted by the dated production profile. */
export const PINE_CERTIFIED_STRATEGY_TRADE_FIELDS = Object.freeze({
  closedtrades: Object.freeze([
    "commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit_percent",
    "entry_bar_index", "entry_comment", "entry_id", "entry_price", "entry_time",
    "exit_bar_index", "exit_comment", "exit_id", "exit_price", "exit_time",
    "profit", "size",
  ]),
  opentrades: Object.freeze([
    "commission", "max_drawdown", "max_drawdown_percent", "max_runup", "max_runup_percent", "profit", "profit_percent",
    "entry_bar_index", "entry_comment", "entry_id", "entry_price", "entry_time", "size",
  ]),
});

export const PINE_CERTIFIED_STRATEGY_TRADE_CALLS = Object.freeze(
  Object.entries(PINE_CERTIFIED_STRATEGY_TRADE_FIELDS).flatMap(([namespace, fields]) =>
    fields.map((field) => `strategy.${namespace}.${field}`)),
);
