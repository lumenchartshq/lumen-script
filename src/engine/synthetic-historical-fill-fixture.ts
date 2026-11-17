import type { CompiledProgram } from "../compiler/index.js";
import { LUMEN_SCRIPT_EXECUTOR_VERSION, type ExecutionResult, type MarketBar, type PineLogJournalV1, type SessionOptions, isStrictPineCompatibility } from "../contracts/index.js";
import {
  admitSyntheticHistoricalFillFeed,
  createExecutor,
  createSyntheticHistoricalFillRuntime,
  deserializeRuntimeSnapshot,
  prepareSyntheticHistoricalFillRecalculation,
  serializeRuntimeSnapshot,
  syntheticHistoricalFillCursorComplete,
  transitionSyntheticHistoricalFillPoint,
  type HistoricalOrderCandidateV1,
  type MutableStrategyState,
  type RuntimeSnapshot,
  type StrategyRuntimeHost,
  type SyntheticHistoricalFillCursorV1,
  type SyntheticHistoricalFillFeedV1,
} from "../runtime/index.js";
import { admitBars } from "./dataset.js";
import { deserializePineLogJournal, PineLogAttempt, PineLogJournal, serializePineLogJournal } from "./log-journal.js";

const MAX_FILLS_PER_BAR = 32;
const MAX_EXECUTIONS_PER_BAR = 64;

export interface SyntheticHistoricalFillTrace {
  readonly barIndex: number;
  readonly pointIndex: number;
  readonly kind: "fill" | "rerun" | "close";
  readonly orderIndex?: number;
  readonly positionSize: number;
}

export interface SyntheticHistoricalFillFixtureResult {
  readonly result: ExecutionResult;
  readonly logs: PineLogJournalV1;
  readonly trace: readonly SyntheticHistoricalFillTrace[];
  readonly checkpoint: SyntheticHistoricalFillFixtureCheckpointV1;
}

export interface SyntheticHistoricalFillFixtureCheckpointV1 {
  readonly kind: "synthetic-historical-fill-fixture";
  readonly version: 1;
  readonly executorVersion: string;
  readonly programFingerprint: string;
  readonly optionsFingerprint: string;
  readonly bars: readonly MarketBar[];
  readonly feeds: readonly SyntheticHistoricalFillFeedV1[];
  readonly runtimeState: string;
  readonly logState: string;
  readonly payloadFingerprint: string;
}

/**
 * Internal, synchronous fixture runner only. Its synthetic feed is not a
 * reference-platform event oracle and this module is not exported by @lumencharts/script-engine.
 * A failure discards the entire runtime, log attempt and trace.
 */
export function runSyntheticHistoricalFillFixture(
  program: CompiledProgram,
  bars: readonly MarketBar[],
  feeds: readonly SyntheticHistoricalFillFeedV1[],
  options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode"> = {},
): SyntheticHistoricalFillFixtureResult {
  return runFixture(program, bars, feeds, options);
}

/** Resume only a validated completed-bar fixture checkpoint, not a v2 session. */
export function appendSyntheticHistoricalFillFixture(
  program: CompiledProgram,
  checkpoint: SyntheticHistoricalFillFixtureCheckpointV1,
  bars: readonly MarketBar[],
  feeds: readonly SyntheticHistoricalFillFeedV1[],
  options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode"> = {},
): SyntheticHistoricalFillFixtureResult {
  const stableOptions = admitFixtureOptions(options);
  const previous = readFixtureCheckpoint(program, checkpoint, stableOptions);
  if (bars.length === 0 || bars.length !== feeds.length) throw new Error("Synthetic historical fill append is empty or incomplete");
  return runFixture(program, [...previous.bars, ...bars], [...previous.feeds, ...feeds], stableOptions,
    { snapshot: previous.snapshot, journal: previous.journal, startIndex: previous.bars.length });
}

/** A correction starts a fresh full replay; the accepted checkpoint is untouched. */
export function correctSyntheticHistoricalFillFixtureTail(
  program: CompiledProgram,
  checkpoint: SyntheticHistoricalFillFixtureCheckpointV1,
  bars: readonly MarketBar[],
  feeds: readonly SyntheticHistoricalFillFeedV1[],
  options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode"> = {},
): SyntheticHistoricalFillFixtureResult {
  const stableOptions = admitFixtureOptions(options);
  const previous = readFixtureCheckpoint(program, checkpoint, stableOptions);
  if (bars.length === 0 || bars.length !== feeds.length) throw new Error("Synthetic historical fill correction is empty or incomplete");
  const fromIndex = previous.bars.findIndex((bar) => bar.openTime >= bars[0]!.openTime);
  if (fromIndex < 0 || previous.bars[fromIndex]!.openTime !== bars[0]!.openTime) {
    throw new Error("Synthetic historical fill correction must replace a completed tail");
  }
  return runFixture(program, [...previous.bars.slice(0, fromIndex), ...bars],
    [...previous.feeds.slice(0, fromIndex), ...feeds], stableOptions);
}

interface ResumeBoundary {
  readonly snapshot: RuntimeSnapshot;
  readonly journal: PineLogJournalV1;
  readonly startIndex: number;
}

function runFixture(
  program: CompiledProgram,
  bars: readonly MarketBar[],
  feeds: readonly SyntheticHistoricalFillFeedV1[],
  suppliedOptions: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode">,
  resume?: ResumeBoundary,
): SyntheticHistoricalFillFixtureResult {
  if (!isStrictPineCompatibility(program.compatibility) || program.descriptor.kind !== "strategy"
    || program.historicalFillSchedule !== "lumencharts-v1"
    || program.descriptor.strategy?.calc_on_order_fills !== true || program.requestPlans.length > 0
    || program.runtimeRequirements.usesDatasetTail || program.runtimeRequirements.usesExecutionClock || program.runtimeRequirements.usesChartType
    || program.runtimeRequirements.usesVisibleRange) {
    throw new Error("Synthetic historical fill fixture does not admit this program");
  }
  if (bars.length === 0 || feeds.length !== bars.length) {
    throw new Error("Synthetic historical fill fixture feed count is invalid");
  }
  const supplied = suppliedOptions as SessionOptions;
  if (supplied.sourceSeries !== undefined || supplied.intrabarBars !== undefined
    || supplied.intrabarPoints !== undefined || supplied.marketDataGateway !== undefined) {
    throw new Error("Synthetic historical fill fixture does not admit host sources or intrabars");
  }
  const options = admitFixtureOptions(suppliedOptions);
  if (options.signal?.aborted) throw new Error("Synthetic historical fill fixture signal is invalid");
  assertActive(options.signal);
  const optionsFingerprint = fixtureOptionsFingerprint(options);
  const admitted = admitBars(bars, options.limits?.maxBars ?? 20_000);
  const admittedFeeds = admitted.map((bar, index) => {
    const feed = structuredClone(feeds[index]!);
    admitSyntheticHistoricalFillFeed(bar, feed);
    return feed;
  });
  if (admittedFeeds.some((feed) => feed.sourceId !== admittedFeeds[0]?.sourceId)) {
    throw new Error("Synthetic historical fill fixture source identity changed");
  }
  const startIndex = resume?.startIndex ?? 0;
  const priorFeed = admittedFeeds[startIndex - 1];
  if (priorFeed !== undefined && admittedFeeds.slice(startIndex).some((feed) => feed.revision !== priorFeed.revision)) {
    throw new Error("Synthetic historical fill append source revision changed");
  }

  const runtime = createSyntheticHistoricalFillRuntime(program, options);
  const execute = createExecutor(program);
  const logs = new PineLogAttempt();
  const journal = new PineLogJournal();
  const trace: SyntheticHistoricalFillTrace[] = [];
  const started = performance.now();
  if (resume === undefined) runtime.reset(admitted);
  else {
    runtime.restore(resume.snapshot, admitted);
    journal.restore(resume.journal);
  }
  runtime.beginEvaluation(Number.POSITIVE_INFINITY);
  runtime.setLogSink((draft) => logs.add(draft));

  const host: StrategyRuntimeHost = {
    barIndex: () => runtime.barIndex,
    bars: () => admitted,
    data: (name) => runtime.data(name),
    symbolInfo: () => options.symbolInfo ?? {},
    timezone: () => options.timezone ?? "Etc/UTC",
    executionBars: () => [],
    executionPoints: () => [],
  };

  for (let barIndex = resume?.startIndex ?? 0; barIndex < admittedFeeds.length; barIndex += 1) {
    const feed = admittedFeeds[barIndex]!;
    assertActive(options.signal);
    const previousBar = runtime.snapshot();
    runtime.beginSyntheticHistoricalFillBar(barIndex, feed);
    const creationPoints = new Map<number, number>();
    let executions = 0;
    let cursor: SyntheticHistoricalFillCursorV1 = {
      version: 1, phase: "active", sourceId: feed.sourceId, revision: feed.revision,
      barIndex, pointIndex: 0, fillOrdinal: 0, fillCount: 0,
    };

    const runAtPoint = (pointIndex: number, kind: "rerun" | "close"): void => {
      assertActive(options.signal);
      if (executions >= MAX_EXECUTIONS_PER_BAR) throw new Error("Synthetic historical fill execution budget exceeded");
      runtime.setSyntheticHistoricalFillDataView(feed, pointIndex);
      const previousStrategy = strategyState(runtime.snapshot());
      const before = previousStrategy.orders.length;
      execute(runtime);
      const currentStrategy = strategyState(runtime.snapshot());
      const carriedOca = carryRefreshedExitOcaGroups(previousStrategy, currentStrategy, before);
      const carriedTrailing = carryRefreshedTrailingGroups(previousStrategy, currentStrategy, before);
      if (carriedOca || carriedTrailing) {
        runtime.replaceSyntheticHistoricalFillStrategyState(currentStrategy);
      }
      executions += 1;
      for (const orderIndex of runtime.stampSyntheticHistoricalFillOrders(before)) creationPoints.set(orderIndex, pointIndex);
      trace.push({ barIndex, pointIndex, kind, positionSize: strategyState(runtime.snapshot()).positionSize });
      assertActive(options.signal);
    };

    while (!syntheticHistoricalFillCursorComplete(cursor, feed, barIndex)) {
      assertActive(options.signal);
      runtime.setSyntheticHistoricalFillDataView(feed, cursor.pointIndex);
      const state = strategyState(runtime.snapshot());
      assertCursorState(state, cursor, barIndex);
      const candidates = orderCandidates(state, barIndex, feed, creationPoints);
      const transition = transitionSyntheticHistoricalFillPoint({ state, host, feed, cursor, candidates });
      for (const { orderIndex, sourceOrderIndex } of transition.expandedOrderOrigins) {
        const creationPoint = creationPoints.get(sourceOrderIndex);
        if (creationPoint !== undefined) creationPoints.set(orderIndex, creationPoint);
      }
      runtime.replaceSyntheticHistoricalFillStrategyState(transition.state);
      cursor = transition.cursor;
      if (transition.filledOrderIndex === undefined) continue;
      if (cursor.fillCount > MAX_FILLS_PER_BAR) throw new Error("Synthetic historical fill budget exceeded");
      trace.push({
        barIndex, pointIndex: cursor.pointIndex, kind: "fill",
        orderIndex: transition.filledOrderIndex, positionSize: transition.state.positionSize,
      });
      const prepared = prepareSyntheticHistoricalFillRecalculation(previousBar, runtime.snapshot());
      runtime.restore(prepared, admitted);
      runAtPoint(cursor.pointIndex, "rerun");
    }

    const prepared = prepareSyntheticHistoricalFillRecalculation(previousBar, runtime.snapshot());
    runtime.restore(prepared, admitted);
    runAtPoint(3, "close");
    runtime.finalizeSyntheticHistoricalFillBar();
    assertActive(options.signal);
  }

  runtime.setLogSink(undefined);
  journal.commit([logs]);
  const result = runtime.result(program.variableNames, performance.now() - started, admitted.length - (resume?.startIndex ?? 0));
  const snapshot = runtime.snapshot();
  const logState = journal.snapshot();
  const checkpointBars = Object.freeze(admitted.map((bar) => Object.freeze({ ...bar })));
  const checkpointFeeds = Object.freeze(admittedFeeds.map((feed) => Object.freeze({
    ...feed, points: Object.freeze(feed.points.map((point) => Object.freeze({ ...point }))),
  })));
  const runtimeState = serializeRuntimeSnapshot(snapshot);
  const serializedLogState = serializePineLogJournal(logState);
  return {
    result,
    logs: logState,
    trace: Object.freeze(trace.map((entry) => Object.freeze(entry))),
    checkpoint: Object.freeze({
      kind: "synthetic-historical-fill-fixture", version: 1,
      executorVersion: LUMEN_SCRIPT_EXECUTOR_VERSION,
      programFingerprint: fixtureProgramFingerprint(program),
      optionsFingerprint,
      bars: checkpointBars,
      feeds: checkpointFeeds,
      runtimeState,
      logState: serializedLogState,
      payloadFingerprint: fixturePayloadFingerprint(checkpointBars, checkpointFeeds, runtimeState, serializedLogState),
    }),
  };
}

/** Carry reduced explicit-OCA reservations through a same-parameter script reissue. */
function carryRefreshedExitOcaGroups(
  previous: MutableStrategyState, current: MutableStrategyState, startIndex: number,
): boolean {
  let changed = false;
  for (let index = startIndex; index < current.orders.length; index += 1) {
    const order = current.orders[index]!;
    if (order.status !== "pending" || order.command !== "exit" || order.targetTradeId !== undefined
      || order.ocaName === undefined || order.ocaType !== "reduce" || isTrailingExit(order)) continue;
    const prior = previous.orders.filter((candidate) => candidate.status === "pending"
      && candidate.command === "exit" && candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined);
    const matching = current.openTrades.filter((trade) => order.targetEntryId === "" || trade.entryId === order.targetEntryId);
    const filledSameCallThisBar = previous.orders.filter((candidate) => candidate.status === "filled"
      && candidate.command === "exit" && candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined
      && candidate.fillBarIndex === order.createdBarIndex);
    const filledGroupThisBar = previous.orders.filter((candidate) => candidate.status === "filled"
      && candidate.command === "exit" && candidate.ocaName === order.ocaName && candidate.ocaType === "reduce"
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined
      && candidate.fillBarIndex === order.createdBarIndex);
    if (prior.length === 0) {
      if (filledSameCallThisBar.some((candidate) => !sameNonTrailingExitParameters(candidate, order))) {
        throw new Error("Synthetic historical fill exit OCA refresh is not admitted");
      }
      if (filledGroupThisBar.length > 0) {
        order.status = "cancelled";
        changed = true;
      }
      continue;
    }
    const targets = new Set(prior.map((candidate) => candidate.targetTradeId));
    const filledTargets = new Set(filledGroupThisBar.map((candidate) => candidate.targetTradeId));
    if (targets.size !== prior.length
      || matching.some((trade) => !targets.has(trade.id) && !filledTargets.has(trade.id))
      || [...targets, ...filledTargets].some((target) => !matching.some((trade) => trade.id === target))
      || prior.some((candidate) => !sameNonTrailingExitParameters(candidate, order))
      || filledSameCallThisBar.some((candidate) => !sameNonTrailingExitParameters(candidate, order))) {
      throw new Error("Synthetic historical fill exit OCA refresh is not admitted");
    }
    for (const [targetIndex, candidate] of prior.entries()) {
      if (candidate.targetTradeId === undefined || candidate.reservedQuantity === undefined
        || candidate.reservationBasisQuantity === undefined) {
        throw new Error("Synthetic historical fill exit OCA reservation is invalid");
      }
      const refreshed = targetIndex === 0 ? order : { ...order };
      refreshed.targetTradeId = candidate.targetTradeId;
      refreshed.reservedQuantity = candidate.reservedQuantity;
      refreshed.reservationBasisQuantity = candidate.reservationBasisQuantity;
      copyReservationProvenance(candidate, refreshed);
      if (targetIndex > 0) current.orders.push(refreshed);
    }
    changed = true;
  }
  return changed;
}

function isTrailingExit(order: MutableStrategyState["orders"][number]): boolean {
  return order.trailOffset !== undefined || order.trailPrice !== undefined || order.trailPoints !== undefined
    || order.trailArmed !== undefined || order.trailPeak !== undefined;
}

function sameNonTrailingExitParameters(
  previous: MutableStrategyState["orders"][number], next: MutableStrategyState["orders"][number],
): boolean {
  return previous.type === "market" && next.type === "market"
    && previous.quantity === next.quantity && previous.quantityPercent === next.quantityPercent
    && previous.ocaName === next.ocaName && previous.ocaType === "reduce" && next.ocaType === "reduce"
    && previous.limit === next.limit && previous.stop === next.stop
    && previous.profitTicks === next.profitTicks && previous.lossTicks === next.lossTicks
    && !isTrailingExit(previous) && !isTrailingExit(next);
}

/** Preserve independent peaks and frozen reservations when one script call refreshes an expanded trailing exit. */
function carryRefreshedTrailingGroups(
  previous: MutableStrategyState, current: MutableStrategyState, startIndex: number,
): boolean {
  let changed = false;
  for (let index = startIndex; index < current.orders.length; index += 1) {
    const order = current.orders[index]!;
    if (order.status !== "pending" || order.command !== "exit" || order.trailOffset === undefined
      || order.targetTradeId !== undefined) continue;
    const prior = previous.orders.filter((candidate) => candidate.status === "pending"
      && candidate.command === "exit" && candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined);
    const matching = current.openTrades.filter((trade) => order.targetEntryId === "" || trade.entryId === order.targetEntryId);
    const filledThisBar = previous.orders.filter((candidate) => candidate.status === "filled"
      && candidate.command === "exit" && candidate.id === order.id
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined
      && candidate.fillBarIndex === order.createdBarIndex);
    const filledUngroupedTargetThisBar = order.ocaName === undefined && order.ocaType === undefined
      ? previous.orders.filter((candidate) => candidate.status === "filled"
        && candidate.command === "exit" && candidate.id !== order.id
        && candidate.ocaName === undefined && candidate.ocaType === undefined && isTrailingExit(candidate)
        && candidate.targetTradeId !== undefined && candidate.fillBarIndex === order.createdBarIndex
        && matching.some((trade) => trade.id === candidate.targetTradeId))
      : [];
    const filledGroupThisBar = order.ocaName === undefined ? filledThisBar : previous.orders.filter((candidate) =>
      candidate.status === "filled" && candidate.command === "exit"
      && candidate.ocaName === order.ocaName && candidate.ocaType === "reduce"
      && candidate.targetEntryId === order.targetEntryId && candidate.targetTradeId !== undefined
      && candidate.fillBarIndex === order.createdBarIndex);
    if (prior.length === 0) {
      // A fill-triggered rerun refreshes only the still-pending reservations from
      // this bar. It must not silently replenish a reservation that just filled.
      const previousSameCall = previous.orders.filter((candidate) => candidate.command === "exit"
        && candidate.id === order.id && candidate.targetEntryId === order.targetEntryId
        && candidate.targetTradeId !== undefined && candidate.ocaName === order.ocaName
        && candidate.ocaType === order.ocaType
        && (candidate.fillBarIndex === order.createdBarIndex
          || (candidate.status === "cancelled" && candidate.createdBarIndex === order.createdBarIndex)));
      if (filledUngroupedTargetThisBar.length > 0 && filledThisBar.length === 0) {
        throw new Error("Synthetic historical fill trailing refresh is not admitted");
      }
      if (filledGroupThisBar.length > 0 && (previousSameCall.length === 0
        || previousSameCall.some((candidate) => !sameTrailingParameters(candidate, order)))) {
        throw new Error("Synthetic historical fill trailing refresh is not admitted");
      }
      if (filledGroupThisBar.length > 0) {
        order.status = "cancelled";
        changed = true;
      }
      continue;
    }
    const targets = new Set(prior.map((candidate) => candidate.targetTradeId));
    const filledTargets = new Set(filledGroupThisBar.map((candidate) => candidate.targetTradeId));
    const reduceGroup = order.ocaName !== undefined && order.ocaType === "reduce";
    if ((order.ocaName === undefined) !== (order.ocaType === undefined)
      || (order.ocaName !== undefined && !reduceGroup)
      || targets.size !== prior.length
      || (!reduceGroup && filledTargets.size !== filledGroupThisBar.length)
      || (!reduceGroup && [...targets].some((target) => filledTargets.has(target)))
      || matching.some((trade) => !targets.has(trade.id) && !filledTargets.has(trade.id))
      || [...targets, ...filledTargets].some((target) => !matching.some((trade) => trade.id === target))
      || prior.some((candidate) => !sameTrailingParameters(candidate, order))
      || filledThisBar.some((candidate) => !sameTrailingParameters(candidate, order))) {
      throw new Error("Synthetic historical fill trailing refresh is not admitted");
    }
    for (const [targetIndex, candidate] of prior.entries()) {
      if (candidate.targetTradeId === undefined) throw new Error("Synthetic historical fill trailing target is invalid");
      if (candidate.trailArmed !== undefined && typeof candidate.trailArmed !== "boolean") {
        throw new Error("Synthetic historical fill trailing state is invalid");
      }
      const refreshed = targetIndex === 0 ? order : { ...order };
      refreshed.targetTradeId = candidate.targetTradeId;
      if (candidate.reservedQuantity === undefined || candidate.reservationBasisQuantity === undefined) {
        throw new Error("Synthetic historical fill trailing reservation is invalid");
      }
      refreshed.reservedQuantity = candidate.reservedQuantity;
      refreshed.reservationBasisQuantity = candidate.reservationBasisQuantity;
      copyReservationProvenance(candidate, refreshed);
      if (candidate.trailArmed === true) {
        if (!Number.isFinite(candidate.trailPeak)) throw new Error("Synthetic historical fill trailing peak is invalid");
        refreshed.trailArmed = true;
        refreshed.trailPeak = candidate.trailPeak!;
      } else {
        if (candidate.trailPeak !== undefined) throw new Error("Synthetic historical fill trailing peak is invalid");
        delete refreshed.trailArmed;
        delete refreshed.trailPeak;
      }
      if (targetIndex > 0) current.orders.push(refreshed);
    }
    changed = true;
  }
  return changed;
}

function sameTrailingParameters(
  previous: MutableStrategyState["orders"][number], next: MutableStrategyState["orders"][number],
): boolean {
  return previous.type === "market" && next.type === "market"
    && previous.quantity === next.quantity && previous.quantityPercent === next.quantityPercent
    && previous.ocaName === next.ocaName && previous.ocaType === next.ocaType
    && previous.trailPrice === next.trailPrice && previous.trailPoints === next.trailPoints
    && previous.trailOffset === next.trailOffset;
}

function copyReservationProvenance(
  source: MutableStrategyState["orders"][number], target: MutableStrategyState["orders"][number],
): void {
  if (source.reservationOriginBarIndex === undefined) delete target.reservationOriginBarIndex;
  else target.reservationOriginBarIndex = source.reservationOriginBarIndex;
  if (source.reservationOriginTime === undefined) delete target.reservationOriginTime;
  else target.reservationOriginTime = source.reservationOriginTime;
  if (source.reservationIssuedBarIndex === undefined) delete target.reservationIssuedBarIndex;
  else target.reservationIssuedBarIndex = source.reservationIssuedBarIndex;
  if (source.reservationIssuedTime === undefined) delete target.reservationIssuedTime;
  else target.reservationIssuedTime = source.reservationIssuedTime;
}

function readFixtureCheckpoint(
  program: CompiledProgram,
  checkpoint: SyntheticHistoricalFillFixtureCheckpointV1,
  options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode">,
): { readonly bars: readonly MarketBar[]; readonly feeds: readonly SyntheticHistoricalFillFeedV1[];
  readonly snapshot: RuntimeSnapshot; readonly journal: PineLogJournalV1 } {
  assertActive(options.signal);
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("Synthetic historical fill checkpoint is invalid");
  }
  const expectedKeys = ["bars", "executorVersion", "feeds", "kind", "logState", "optionsFingerprint", "payloadFingerprint", "programFingerprint", "runtimeState", "version"];
  if (Object.keys(checkpoint).sort().join("|") !== expectedKeys.sort().join("|")
    || checkpoint.kind !== "synthetic-historical-fill-fixture" || checkpoint.version !== 1
    || checkpoint.executorVersion !== LUMEN_SCRIPT_EXECUTOR_VERSION
    || checkpoint.programFingerprint !== fixtureProgramFingerprint(program)
    || checkpoint.optionsFingerprint !== fixtureOptionsFingerprint(options)
    || !Array.isArray(checkpoint.bars) || !Array.isArray(checkpoint.feeds)
    || checkpoint.bars.length !== checkpoint.feeds.length
    || checkpoint.payloadFingerprint !== fixturePayloadFingerprint(checkpoint.bars, checkpoint.feeds,
      checkpoint.runtimeState, checkpoint.logState)) {
    throw new Error("Synthetic historical fill checkpoint identity or shape is invalid");
  }
  const bars = admitBars(checkpoint.bars, options.limits?.maxBars ?? 20_000);
  const storedFeeds = checkpoint.feeds as readonly SyntheticHistoricalFillFeedV1[];
  const feeds = storedFeeds.map((source, index) => {
    const feed = structuredClone(source);
    admitSyntheticHistoricalFillFeed(bars[index]!, feed);
    return feed;
  });
  if (feeds.some((feed) => feed.sourceId !== feeds[0]?.sourceId)) {
    throw new Error("Synthetic historical fill checkpoint source identity changed");
  }
  const snapshot = deserializeRuntimeSnapshot(checkpoint.runtimeState);
  const journal = deserializePineLogJournal(checkpoint.logState);
  const lastBarIndex = bars.length - 1;
  if (snapshot.barIndex !== lastBarIndex || snapshot.strategy === undefined
    || !snapshot.strategy.config.calc_on_order_fills || snapshot.strategy.timeline.length !== bars.length
    || snapshot.strategy.timeline.some((entry, index) => entry.barIndex !== index || entry.time !== bars[index]!.openTime)
    || snapshot.strategy.positionSize !== snapshot.strategy.openTrades.reduce((total, trade) => total + trade.direction * trade.quantity, 0)
    || snapshot.strategy.timeline.at(-1)?.positionSize !== snapshot.strategy.positionSize
    || snapshot.variables.length !== program.variableNames.length
    || snapshot.variableHistory.length !== program.variableNames.length
    || snapshot.globalPersistence.length > program.variableNames.length
    || snapshot.variables.some((series) => series.length > bars.length)
    || snapshot.variableHistory.some((window) => window.last > lastBarIndex)
    || [...snapshot.argumentSeries.values(), ...snapshot.historySeries.values(),
      ...[...snapshot.localState.values()].map((state) => state.values)].some((window) => window.last > lastBarIndex)
    || [...snapshot.plots.values()].some((plot) => plot.points.length > bars.length)
    || snapshot.alerts.some((alert) => alert.barIndex > lastBarIndex)
    || Object.keys(snapshot.requestSeries).length > 0
    || journal.events.some((event) => event.barIndex >= bars.length
      || event.barOpenTimeMs !== bars[event.barIndex]?.openTime)) {
    throw new Error("Synthetic historical fill checkpoint is not at a completed bar boundary");
  }
  return { bars, feeds, snapshot, journal };
}

function admitFixtureOptions(options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode">): Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "signal" | "alertMode"> {
  const allowed = new Set(["symbolInfo", "timezone", "limits", "signal", "alertMode"]);
  if (Object.getPrototypeOf(options) !== Object.prototype
    || Reflect.ownKeys(options).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw new Error("Synthetic historical fill fixture options are invalid");
  }
  const signal = options.signal;
  const limits = structuredClone(options.limits ?? {});
  const allowedLimits = new Set(["maxBars", "maxOperationsPerBar", "maxTableCells"]);
  if (Object.entries(limits as Record<string, unknown>).some(([key, value]) =>
    !allowedLimits.has(key) || !Number.isSafeInteger(value) || (value as number) < 0)) {
    throw new Error("Synthetic historical fill fixture limits are invalid");
  }
  return {
    symbolInfo: structuredClone(options.symbolInfo ?? {}),
    timezone: options.timezone ?? "Etc/UTC",
    limits,
    alertMode: options.alertMode ?? "realtime",
    ...(signal === undefined ? {} : { signal }),
  };
}

function fixtureProgramFingerprint(program: CompiledProgram): string {
  return fingerprint(JSON.stringify([
    "synthetic-historical-fill-fixture-v1", LUMEN_SCRIPT_EXECUTOR_VERSION,
    program.compatibility, program.historicalFillSchedule, program.source, program.descriptor,
    program.variableNames, program.runtimeRequirements, program.generatedSource,
  ]));
}

function fixtureOptionsFingerprint(options: Pick<SessionOptions, "symbolInfo" | "timezone" | "limits" | "alertMode">): string {
  return fingerprint(JSON.stringify([
    options.symbolInfo ?? {}, options.timezone ?? "Etc/UTC", options.alertMode ?? "realtime", options.limits ?? {},
  ]));
}

function fixturePayloadFingerprint(
  bars: readonly MarketBar[], feeds: readonly SyntheticHistoricalFillFeedV1[], runtimeState: string, logState: string,
): string {
  return fingerprint(JSON.stringify([bars, feeds, runtimeState, logState]));
}

function fingerprint(source: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= BigInt(source.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function strategyState(snapshot: RuntimeSnapshot): MutableStrategyState {
  if (snapshot.strategy === undefined) throw new Error("Synthetic historical fill strategy state is unavailable");
  return snapshot.strategy;
}

function assertCursorState(state: MutableStrategyState, cursor: SyntheticHistoricalFillCursorV1, barIndex: number): void {
  if (state.timeline.length !== barIndex || cursor.fillCount !== state.orders.filter((order) => order.status === "filled" && order.fillBarIndex === barIndex).length) {
    throw new Error("Synthetic historical fill cursor and strategy state diverged");
  }
}

function orderCandidates(
  state: MutableStrategyState,
  barIndex: number,
  feed: SyntheticHistoricalFillFeedV1,
  creationPoints: ReadonlyMap<number, number>,
): readonly HistoricalOrderCandidateV1[] {
  return state.orders.map((order, orderIndex) => {
    const pointIndex = creationPoints.get(orderIndex);
    if (order.createdBarIndex === barIndex && (pointIndex === undefined || order.createdTime !== feed.points[pointIndex]?.timestamp)) {
      throw new Error("Synthetic historical fill order creation point or time is invalid");
    }
    if (order.createdBarIndex < barIndex && pointIndex !== undefined) {
      throw new Error("Synthetic historical fill prior order has a current creation point");
    }
    return {
      orderIndex,
      id: order.id,
      status: order.status,
      created: { barIndex: order.createdBarIndex, ordinal: orderIndex,
        ...(pointIndex === undefined ? {} : { pointIndex }) },
    };
  });
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Synthetic historical fill fixture aborted", "AbortError");
}
