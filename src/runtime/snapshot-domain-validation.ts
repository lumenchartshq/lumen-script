/** Restore admission schemas for mutable domain state. Numeric NaN remains Pine na. */
type Check = (value: unknown) => boolean;
const number: Check = (value) => typeof value === "number";
const string: Check = (value) => typeof value === "string";
const boolean: Check = (value) => typeof value === "boolean";
const present: Check = (value) => value !== undefined;
const count: Check = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const literal = (...values: unknown[]): Check => (value) => values.includes(value);
const optional = (check: Check): Check => (value) => value === undefined || check(value);
const nullable = (check: Check): Check => (value) => value === null || check(value);
const list = (check: Check): Check => (value) => Array.isArray(value) && Array.from(value).every(check);
const tuple = (...checks: Check[]): Check => (value) => Array.isArray(value) && value.length === checks.length && checks.every((check, index) => check(value[index]));
const shape = (fields: Readonly<Record<string, Check>>): Check => (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Map || value instanceof Set) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(fields).every(([key, check]) => check(record[key]));
};
const riskAmount = shape({ value: number, type: literal("cash", "percent_of_equity"), alertMessage: optional(string) });
const riskRules = shape({ allowEntryIn: optional(literal("long", "short", "all", "none")), maxPositionSize: optional(number), maxDrawdown: optional(riskAmount), maxDrawdownPercentRule: optional(riskAmount), maxIntradayLoss: optional(riskAmount), maxIntradayLossPercentRule: optional(riskAmount), maxIntradayFilledOrders: optional(number), maxIntradayFilledOrdersAlertMessage: optional(string), maxConsecutiveLossDays: optional(number), maxConsecutiveLossDaysAlertMessage: optional(string) });

const line = shape({
  __pineLine: literal(true),
  id: count,
  order: count,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  xloc: string,
  extend: string,
  color: present,
  style: string,
  width: number,
  forceOverlay: boolean,
  deleted: boolean,
});

const box = shape({
  __pineBox: literal(true),
  id: count,
  left: number,
  top: number,
  right: number,
  bottom: number,
  xloc: string,
  extend: string,
  borderColor: present,
  borderStyle: string,
  borderWidth: number,
  backgroundColor: present,
  text: string,
  textColor: present,
  textSize: string,
  textHorizontalAlign: string,
  textVerticalAlign: string,
  textWrap: string,
  textFontFamily: string,
  textFormatting: string,
  forceOverlay: boolean,
  deleted: boolean,
});

const label = shape({
  __pineLabel: literal(true),
  id: count,
  x: number,
  y: number,
  text: string,
  xloc: string,
  yloc: string,
  color: present,
  style: string,
  textColor: present,
  size: string,
  textAlign: string,
  tooltip: string,
  textFontFamily: string,
  forceOverlay: boolean,
  deleted: boolean,
});

const point = shape({
  __pineChartPoint: literal(true),
  time: present,
  index: present,
  price: number,
});

const polyline = shape({
  __pinePolyline: literal(true),
  id: count,
  order: count,
  points: list(point),
  curved: boolean,
  closed: boolean,
  xloc: string,
  lineColor: present,
  fillColor: present,
  lineStyle: string,
  lineWidth: number,
  forceOverlay: boolean,
  deleted: boolean,
});

const linefill = shape({
  __pineLinefill: literal(true),
  id: count,
  line1: line,
  line2: line,
  color: present,
  deleted: boolean,
});

const cell = shape({
  text: string,
  width: number,
  height: number,
  textColor: present,
  textHorizontalAlign: string,
  textVerticalAlign: string,
  textSize: present,
  backgroundColor: present,
  tooltip: string,
  textFontFamily: string,
  merged: boolean,
  mergeParent: nullable(tuple(count, count)),
});

const table = shape({
  __pineTable: literal(true),
  id: count,
  position: string,
  columns: count,
  rows: count,
  backgroundColor: present,
  frameColor: present,
  frameWidth: number,
  borderColor: present,
  borderWidth: number,
  forceOverlay: boolean,
  cells: list(list(nullable(cell))),
  merges: list(shape({ startColumn: count, startRow: count, endColumn: count, endRow: count })),
  deleted: boolean,
});

const order = shape({
  id: string,
  command: literal("entry", "order", "exit", "close", "close_all", "margin_call"),
  direction: literal(1, -1),
  quantity: number,
  type: literal("market", "limit", "stop", "stop-limit"),
  limit: optional(number),
  stop: optional(number),
  stopTriggered: optional(boolean),
  createdBarIndex: number,
  createdTime: number,
  status: literal("pending", "filled", "cancelled"),
  fillPrice: optional(number),
  fillBarIndex: optional(number),
  fillTime: optional(number),
  ocaName: optional(string),
  ocaType: optional(literal("none", "cancel", "reduce")),
  comment: optional(string),
  commentProfit: optional(string),
  commentLoss: optional(string),
  commentTrailing: optional(string),
  alertMessage: optional(string),
  alertProfit: optional(string),
  alertLoss: optional(string),
  alertTrailing: optional(string),
  disableAlert: optional(boolean),
  targetEntryId: optional(string),
  targetTradeId: optional(string),
  quantityPercent: optional(number),
  reservedQuantity: optional(number),
  reservationBasisQuantity: optional(number),
  reservationOriginBarIndex: optional(count),
  reservationOriginTime: optional(number),
  reservationIssuedBarIndex: optional(count),
  reservationIssuedTime: optional(number),
  immediately: optional(boolean),
  intendedTradeIds: optional(list(string)),
  profitTicks: optional(number),
  lossTicks: optional(number),
  trailPrice: optional(number),
  trailPoints: optional(number),
  trailOffset: optional(number),
  trailPeak: optional(number),
  trailArmed: optional(boolean),
});

const trade = shape({
  id: string,
  entryId: string,
  direction: literal(1, -1),
  quantity: number,
  entryPrice: number,
  entryBarIndex: number,
  entryTime: number,
  exitPrice: optional(number),
  exitBarIndex: optional(number),
  exitTime: optional(number),
  profit: optional(number),
  entryCommission: number,
  entryBasis: optional(number),
  commission: optional(number),
  entryComment: optional(string),
  exitId: optional(string),
  exitComment: optional(string),
  maxDrawdown: number,
  maxRunup: number,
  status: literal("open", "closed"),
});

const config = shape({
  initial_capital: number,
  currency: string,
  pyramiding: number,
  default_qty_type: literal("fixed", "cash", "percent_of_equity"),
  default_qty_value: number,
  slippage: number,
  commission_type: literal("percent", "cash_per_order", "cash_per_contract"),
  commission_value: number,
  process_orders_on_close: boolean,
  margin_long: number,
  margin_short: number,
  calc_on_order_fills: boolean,
  calc_on_every_tick: boolean,
  backtest_fill_limits_assumption: number,
  close_entries_rule: literal("FIFO", "ANY"),
  risk_free_rate: number,
  use_bar_magnifier: boolean,
  fill_orders_on_standard_ohlc: boolean,
});

const timeline = shape({
  barIndex: number,
  time: number,
  positionSize: number,
  positionAveragePrice: number,
  openProfit: number,
  netProfit: number,
  equity: number,
  openTrades: number,
  closedTrades: number,
  pendingOrders: number,
  filledOrders: number,
  cancelledOrders: number,
  grossProfit: number,
  grossLoss: number,
  maxDrawdown: number,
  maxRunup: number,
});

const strategy = shape({
  config: config,
  orders: list(order),
  openTrades: list(trade),
  closedTrades: list(trade),
  timeline: list(timeline),
  nextTradeId: count,
  positionSize: number,
  positionAveragePrice: number,
  openProfit: number,
  netProfit: number,
  equity: number,
  grossProfit: number,
  grossLoss: number,
  winningTrades: number,
  losingTrades: number,
  evenTrades: number,
  winningProfit: number,
  losingLoss: number,
  maxContractsHeld: number,
  maxContractsHeldLong: number,
  maxContractsHeldShort: number,
  equityPeak: number,
  equityTrough: number,
  maxDrawdown: number,
  maxDrawdownPercent: number,
  maxRunup: number,
  maxRunupPercent: number,
  firstEntryPrice: number,
  firstEntryRate: optional(number),
  firstEntryPointValue: optional(number),
  lastFxRate: optional(number),
  monthlyEquity: list(number),
  lastMonthKey: optional(number),
  riskRules: riskRules,
  riskHalted: boolean,
  riskClosedProfitPeak: optional((value) => typeof value === "number" && Number.isFinite(value) && value >= 0),
  intradayRiskHalted: optional(boolean),
  intradayFillLimitHalted: optional(boolean),
  intradayKey: string,
  intradayStartEquity: number,
  intradayPeakEquity: optional(number),
  intradayFills: number,
  currentDayRealizedProfit: number,
  consecutiveLossDays: number,
});

const alert = shape({
  type: literal("alert", "alertcondition"),
  id: string,
  message: string,
  title: optional(string),
  frequency: optional(literal("alert.freq_all", "alert.freq_once_per_bar", "alert.freq_once_per_bar_close")),
  barIndex: number,
  time: number,
  confirmed: optional(boolean),
});

export function validateStrictStrategyRiskSnapshot(value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid runtime checkpoint field strategy");
  const state = value as Record<string, unknown>;
  if (typeof state.intradayRiskHalted !== "boolean" || !Number.isFinite(state.intradayPeakEquity)) {
    throw new TypeError("Invalid runtime checkpoint field strategy risk state");
  }
}

export function validateSnapshotDomains(state: Record<string, unknown>, strictRisk = false): void {
  const families: Record<string, Check> = { lines: line, boxes: box, labels: label, polylines: polyline, linefills: linefill, tables: table, alerts: alert };
  for (const [field, check] of Object.entries(families)) {
    if (!list(check)(state[field])) throw new TypeError(`Invalid runtime checkpoint field ${field}`);
  }
  if (state.strategy !== undefined && !strategy(state.strategy)) throw new TypeError("Invalid runtime checkpoint field strategy");
  if (strictRisk) validateStrictStrategyRiskSnapshot(state.strategy);
  for (const entry of state.tables as { rows: number; columns: number; cells: ({ mergeParent: [number, number] | null } | null)[][]; merges: { startColumn: number; startRow: number; endColumn: number; endRow: number }[] }[]) {
    const invalid = () => { throw new TypeError("Invalid runtime checkpoint field tables dimensions or merge"); };
    if (entry.cells.length !== entry.rows || entry.cells.some((row) => row.length !== entry.columns)) invalid();
    for (const [row, cells] of entry.cells.entries()) for (const [column, cell] of cells.entries()) {
      const parent = cell?.mergeParent;
      if (parent && (parent[0] > column || parent[1] > row || (parent[0] === column && parent[1] === row))) invalid();
    }
    for (const merge of entry.merges) {
      if (merge.startColumn > merge.endColumn || merge.startRow > merge.endRow || merge.endColumn >= entry.columns || merge.endRow >= entry.rows) invalid();
    }
  }
}
