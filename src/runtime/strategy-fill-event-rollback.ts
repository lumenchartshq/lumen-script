import { cloneRuntimeGraph, type RuntimeSnapshot } from "./runtime-snapshot.js";

/**
 * Internal S5 state preparation for one historical post-fill script execution.
 * The previous completed bar supplies ordinary program/visual state. The
 * current point supplies committed strategy effects, intrabar-persistent
 * variables and already fired alerts. Logs are owned by the engine journal,
 * not by RuntimeSnapshot. This does not restore or run a production runtime.
 */
export function prepareSyntheticHistoricalFillRecalculation(
  previousBar: RuntimeSnapshot,
  postFill: RuntimeSnapshot,
): RuntimeSnapshot {
  if (!Number.isSafeInteger(previousBar.barIndex) || previousBar.barIndex < -1
    || postFill.barIndex !== previousBar.barIndex + 1) {
    throw new Error("Historical fill rollback requires adjacent previous/current bars");
  }
  if (previousBar.strategy === undefined || postFill.strategy === undefined) {
    throw new Error("Historical fill rollback requires strategy state");
  }
  if (previousBar.strategy.timeline.length !== previousBar.barIndex + 1) {
    throw new Error("Historical fill rollback requires a completed previous bar");
  }
  if (postFill.strategy.timeline.length !== previousBar.strategy.timeline.length) {
    throw new Error("Historical fill rollback cannot include a finalized bar timeline");
  }
  if (Object.keys(previousBar.requestSeries).length > 0 || Object.keys(postFill.requestSeries).length > 0) {
    throw new Error("Historical fill rollback does not admit request series");
  }
  if (!Number.isSafeInteger(postFill.operations) || postFill.operations < 0) {
    throw new Error("Historical fill rollback operation count is invalid");
  }

  const ordinary = cloneRuntimeGraph(previousBar);
  const durable = cloneRuntimeGraph(postFill);
  const globalPersistence = [...ordinary.globalPersistence];
  for (const [id, persistence] of durable.globalPersistence.entries()) {
    if (persistence !== "varip") continue;
    const values = durable.variables[id];
    const history = durable.variableHistory[id];
    if (values === undefined || history === undefined) {
      throw new Error("Historical fill rollback varip history is incomplete");
    }
    ordinary.variables[id] = values;
    ordinary.variableHistory[id] = history;
    globalPersistence[id] = "varip";
  }
  for (const [key, state] of durable.localState) {
    if (state.persistence === "varip") ordinary.localState.set(key, state);
  }

  return {
    ...ordinary,
    barIndex: durable.barIndex,
    globalPersistence,
    strategy: durable.strategy,
    alerts: durable.alerts,
    firedAlerts: durable.firedAlerts,
    operations: durable.operations,
  };
}
