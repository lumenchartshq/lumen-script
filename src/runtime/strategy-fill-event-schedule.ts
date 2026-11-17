import type { MarketBar } from "../contracts/index.js";

export type HistoricalFillPointKind = "open" | "high" | "low" | "close";

export interface SyntheticHistoricalFillPointV1 {
  readonly sequence: number;
  readonly timestamp: number;
  readonly kind: HistoricalFillPointKind;
  readonly price: number;
  /** Volume observed by this event, not the final parent-bar volume. */
  readonly cumulativeVolume: number;
}

export interface SyntheticHistoricalFillFeedV1 {
  readonly version: 1;
  readonly source: "synthetic";
  readonly sourceId: string;
  readonly revision: string;
  readonly parentOpenTime: number;
  readonly points: readonly SyntheticHistoricalFillPointV1[];
}

export interface HistoricalFillEventV1 {
  readonly point: SyntheticHistoricalFillPointV1;
  readonly asOfBar: MarketBar;
  readonly confirmed: boolean;
}

export interface HistoricalOrderCreationCursorV1 {
  readonly barIndex: number;
  /** Omitted for an order created on a previous bar. */
  readonly pointIndex?: number;
  /** Globally unique and increasing within this synthetic schedule. */
  readonly ordinal: number;
}

export interface HistoricalOrderCandidateV1 {
  /** Stable index of this order instance in StrategyRuntime's append-only array. */
  readonly orderIndex: number;
  /** Pine's logical order ID may be reused by a later instance. */
  readonly id: string;
  readonly status: "pending" | "filled" | "cancelled";
  readonly created: HistoricalOrderCreationCursorV1;
}

/**
 * Stage-1 admission only. No runtime/executor calls or public profile changes.
 * An external feed cannot claim this synthetic identity without a later adapter.
 */
export function admitSyntheticHistoricalFillFeed(
  parent: MarketBar,
  feed: SyntheticHistoricalFillFeedV1,
): readonly HistoricalFillEventV1[] {
  const closeTime = parent.closeTime;
  if (feed.version !== 1 || feed.source !== "synthetic" || !validIdentity(feed.sourceId) || !validIdentity(feed.revision)) {
    throw new Error("Historical fill feed identity is invalid");
  }
  if (!Number.isSafeInteger(parent.openTime) || closeTime === undefined || !Number.isSafeInteger(closeTime) || closeTime <= parent.openTime || feed.parentOpenTime !== parent.openTime) {
    throw new Error("Historical fill feed parent time is invalid");
  }
  if (![parent.open, parent.high, parent.low, parent.close, parent.volume].every(Number.isFinite) || parent.high < Math.max(parent.open, parent.close) || parent.low > Math.min(parent.open, parent.close) || parent.volume < 0) {
    throw new Error("Historical fill feed parent bar is invalid");
  }
  if (feed.points.length !== 4) throw new Error("Historical fill feed requires exactly four points");
  const kinds = feed.points.map((point) => point.kind);
  if (kinds[0] !== "open" || kinds[3] !== "close" || !kinds.includes("high") || !kinds.includes("low") || kinds[1] === kinds[2]) {
    throw new Error("Historical fill feed point path is invalid");
  }
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let previousTime = parent.openTime;
  let previousVolume = 0;
  const events: HistoricalFillEventV1[] = [];
  for (const [index, point] of feed.points.entries()) {
    if (point.sequence !== index || !Number.isSafeInteger(point.timestamp) || point.timestamp < previousTime || point.timestamp > closeTime || !Number.isFinite(point.price) || !Number.isFinite(point.cumulativeVolume) || point.cumulativeVolume < previousVolume || point.cumulativeVolume > parent.volume) {
      throw new Error("Historical fill feed point order or value is invalid");
    }
    const expectedPrice = parent[point.kind];
    if (point.price !== expectedPrice) {
      throw new Error("Historical fill feed point kind does not match its parent bar");
    }
    previousTime = point.timestamp;
    previousVolume = point.cumulativeVolume;
    high = Math.max(high, point.price);
    low = Math.min(low, point.price);
    events.push(Object.freeze({
      point: Object.freeze({ ...point }),
      asOfBar: Object.freeze({
        openTime: parent.openTime,
        closeTime: point.timestamp,
        open: parent.open,
        high,
        low,
        close: point.price,
        volume: point.cumulativeVolume,
      }),
      confirmed: index === 3,
    }));
  }
  if (feed.points[0]?.timestamp !== parent.openTime || feed.points[0]?.price !== parent.open || feed.points[3]?.timestamp !== closeTime || feed.points[3]?.price !== parent.close || high !== parent.high || low !== parent.low || previousVolume !== parent.volume) {
    throw new Error("Historical fill feed does not match its parent bar");
  }
  return Object.freeze(events);
}

/** Orders created at one point can first compete at the following point. */
export function eligibleHistoricalOrders(
  orders: readonly HistoricalOrderCandidateV1[],
  barIndex: number,
  pointIndex: number,
): readonly HistoricalOrderCandidateV1[] {
  if (!Number.isSafeInteger(barIndex) || barIndex < 0 || !Number.isSafeInteger(pointIndex) || pointIndex < 0 || pointIndex > 3) {
    throw new Error("Historical fill cursor is invalid");
  }
  const ordinals = new Set<number>();
  const orderIndices = new Set<number>();
  for (const order of orders) {
    const creation = order.created;
    if (!order.id || !Number.isSafeInteger(order.orderIndex) || order.orderIndex < 0 || orderIndices.has(order.orderIndex) || !["pending", "filled", "cancelled"].includes(order.status) || !Number.isSafeInteger(creation.barIndex) || creation.barIndex < 0 || creation.barIndex > barIndex || !Number.isSafeInteger(creation.ordinal) || creation.ordinal < 0 || ordinals.has(creation.ordinal) || (creation.barIndex === barIndex && (!Number.isSafeInteger(creation.pointIndex) || creation.pointIndex! < 0 || creation.pointIndex! > 3)) || (creation.barIndex < barIndex && creation.pointIndex !== undefined)) {
      throw new Error("Historical order creation cursor is invalid");
    }
    orderIndices.add(order.orderIndex);
    ordinals.add(creation.ordinal);
  }
  return Object.freeze(orders
    .filter((order) => order.status === "pending" && (order.created.barIndex < barIndex || order.created.pointIndex! < pointIndex))
    .sort((left, right) => left.created.ordinal - right.created.ordinal || left.id.localeCompare(right.id))
    .map((order) => Object.freeze({ ...order, created: Object.freeze({ ...order.created }) })));
}

function validIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_:-]+$/.test(value);
}
