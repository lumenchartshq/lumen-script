import type { Drawing, DrawingRef, ExecutionResult, SceneDelta, TableSnapshot } from "../contracts/index.js";
import { structurallyEqual } from "./value-equality.js";

export function sceneDelta(previous: ExecutionResult | undefined, current: ExecutionResult): SceneDelta {
  const previousDrawings = new Map((previous?.drawings ?? []).map((drawing) => [drawingKey(drawing), drawing]));
  const currentDrawings = new Map(current.drawings.map((drawing) => [drawingKey(drawing), drawing]));
  const addedDrawings: Drawing[] = [];
  const updatedDrawings: Drawing[] = [];
  const deletedDrawings: DrawingRef[] = [];
  for (const [key, drawing] of currentDrawings) {
    const prior = previousDrawings.get(key);
    if (prior === undefined) addedDrawings.push(drawing);
    else if (!structurallyEqual(prior, drawing)) updatedDrawings.push(drawing);
  }
  for (const [key, drawing] of previousDrawings) if (!currentDrawings.has(key)) deletedDrawings.push({ kind: drawing.kind, id: drawing.id });

  const previousTables = new Map((previous?.tables ?? []).map((table) => [table.id, table]));
  const currentTables = new Map(current.tables.map((table) => [table.id, table]));
  const addedTables: TableSnapshot[] = [];
  const updatedTables: TableSnapshot[] = [];
  const deletedTables: number[] = [];
  for (const [id, table] of currentTables) {
    const prior = previousTables.get(id);
    if (prior === undefined) addedTables.push(table);
    else if (!structurallyEqual(prior, table)) updatedTables.push(table);
  }
  for (const id of previousTables.keys()) if (!currentTables.has(id)) deletedTables.push(id);
  return Object.freeze({
    drawings: Object.freeze({
      added: Object.freeze(addedDrawings), updated: Object.freeze(updatedDrawings), deleted: Object.freeze(deletedDrawings),
    }),
    tables: Object.freeze({ added: Object.freeze(addedTables), updated: Object.freeze(updatedTables), deleted: Object.freeze(deletedTables) }),
  });
}

function drawingKey(drawing: Drawing): string {
  return `${drawing.kind}:${String(drawing.id)}`;
}
