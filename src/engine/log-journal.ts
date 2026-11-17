import type { PineLogDraft, PineLogEventV1, PineLogJournalV1 } from "../contracts/index.js";

const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_EVENTS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPT_EVENTS = 20_000;
const encoder = new TextEncoder();

type LogContext = PineLogEventV1["context"];
export type PendingLog = PineLogDraft & { readonly context: LogContext };

function bytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).length; }
function validInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function freezeEvent(event: PineLogEventV1): PineLogEventV1 {
  return Object.freeze({
    ...event,
    callSite: Object.freeze({ ...event.callSite }),
    context: Object.freeze({ ...event.context }),
  });
}

export class PineLogAttempt {
  private readonly events: PendingLog[] = [];
  private encodedBytes = 0;
  private count = 0;
  private discarded = 0;

  public add(draft: PineLogDraft, context: LogContext = { kind: "root" }): void {
    this.count += 1;
    const event = { ...draft, context };
    const size = bytes(event);
    if (size > MAX_BYTES) {
      this.discarded += 1;
      return;
    }
    this.events.push(event);
    this.encodedBytes += size;
    while (this.events.length > MAX_EVENTS || this.encodedBytes > MAX_BYTES || this.count > MAX_ATTEMPT_EVENTS) {
      const removed = this.events.shift();
      if (removed === undefined) break;
      this.encodedBytes -= bytes(removed);
      this.discarded += 1;
      if (this.count > MAX_ATTEMPT_EVENTS) this.count -= 1;
    }
  }

  public addChild(event: PineLogEventV1, requestId: string): void {
    this.add({
      level: event.level,
      message: event.message,
      ...(event.truncated === undefined ? {} : { truncated: event.truncated }),
      barIndex: event.barIndex,
      barOpenTimeMs: event.barOpenTimeMs,
      emittedAtMs: event.emittedAtMs,
      phase: event.phase,
      callSite: event.callSite,
    }, { kind: "request", requestId });
  }

  public retained(fromIndex = 0): readonly PendingLog[] {
    return this.events.filter((event) => event.context.kind === "request" || event.barIndex >= fromIndex);
  }

  public get droppedCount(): number { return this.discarded; }
}

/** Committed events live outside runtime snapshots and survive real tick rollback. */
export class PineLogJournal {
  private logEpoch: string = crypto.randomUUID();
  private nextSequence = 0;
  private droppedCount = 0;
  private historyUnavailable = false;
  private readonly events: PineLogEventV1[] = [];
  private encodedBytes = 0;

  public get logsCount(): number { return this.events.length; }

  public reset(historyUnavailable = false): void {
    this.logEpoch = crypto.randomUUID();
    this.nextSequence = 0;
    this.droppedCount = 0;
    this.historyUnavailable = historyUnavailable;
    this.events.length = 0;
    this.encodedBytes = 0;
  }

  public commit(attempts: readonly PineLogAttempt[]): readonly PineLogEventV1[] {
    const added: PineLogEventV1[] = [];
    for (const attempt of attempts) {
      this.nextSequence += attempt.droppedCount;
      this.droppedCount += attempt.droppedCount;
      for (const pending of attempt.retained()) {
        const event = freezeEvent({ ...pending, version: 1, sequence: this.nextSequence++, logEpoch: this.logEpoch });
        added.push(event);
        this.events.push(event);
        this.encodedBytes += bytes(event);
        while (this.events.length > MAX_EVENTS || this.encodedBytes > MAX_BYTES) {
          const removed = this.events.shift()!;
          this.encodedBytes -= bytes(removed);
          this.droppedCount += 1;
        }
      }
    }
    return added;
  }

  public snapshot(): PineLogJournalV1 {
    return Object.freeze({
      version: 1,
      logEpoch: this.logEpoch,
      firstRetainedSequence: this.events[0]?.sequence ?? this.nextSequence,
      nextSequence: this.nextSequence,
      droppedCount: this.droppedCount,
      historyUnavailable: this.historyUnavailable,
      events: Object.freeze([...this.events]),
    });
  }

  public restore(state: PineLogJournalV1): void {
    validatePineLogJournal(state);
    this.logEpoch = state.logEpoch;
    this.nextSequence = state.nextSequence;
    this.droppedCount = state.droppedCount;
    this.historyUnavailable = state.historyUnavailable;
    this.events.length = 0;
    this.events.push(...state.events.map(freezeEvent));
    this.encodedBytes = state.events.reduce((sum, event) => sum + bytes(event), 0);
  }
}

export function serializePineLogJournal(state: PineLogJournalV1): string {
  validatePineLogJournal(state);
  return JSON.stringify(state);
}

export function deserializePineLogJournal(source: string): PineLogJournalV1 {
  if (encoder.encode(source).length > MAX_BYTES + MAX_EVENTS * 512) throw new TypeError("Script log checkpoint exceeds byte budget");
  const state: unknown = JSON.parse(source);
  validatePineLogJournal(state);
  return state;
}

function validatePineLogJournal(value: unknown): asserts value is PineLogJournalV1 {
  const fail = (): never => { throw new TypeError("Invalid Script log checkpoint"); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.logEpoch !== "string" || state.logEpoch.length > 128
    || !validInteger(state.firstRetainedSequence) || !validInteger(state.nextSequence)
    || !validInteger(state.droppedCount) || typeof state.historyUnavailable !== "boolean"
    || !Array.isArray(state.events) || state.events.length > MAX_EVENTS) fail();
  let previous = -1;
  let totalBytes = 0;
  for (const candidate of state.events as unknown[]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail();
    const event = candidate as Record<string, unknown>;
    const site = event.callSite as Record<string, unknown> | undefined;
    const context = event.context as Record<string, unknown> | undefined;
    if (event.version !== 1 || event.logEpoch !== state.logEpoch || !validInteger(event.sequence)
      || (event.sequence as number) <= previous || (event.sequence as number) >= (state.nextSequence as number)
      || !["info", "warning", "error"].includes(String(event.level))
      || typeof event.message !== "string" || encoder.encode(event.message).length > MAX_MESSAGE_BYTES
      || (event.truncated !== undefined && typeof event.truncated !== "boolean")
      || !validInteger(event.barIndex) || !Number.isFinite(event.barOpenTimeMs) || !Number.isFinite(event.emittedAtMs)
      || !["historical", "realtime"].includes(String(event.phase))
      || site === undefined || ![site.line, site.column, site.endLine, site.endColumn].every((field) => validInteger(field))
      || context === undefined || !["root", "request"].includes(String(context.kind))
      || (context.requestId !== undefined && typeof context.requestId !== "string")) fail();
    previous = event.sequence as number;
    totalBytes += bytes(event);
    if (totalBytes > MAX_BYTES) fail();
  }
  if ((state.events as unknown[]).length > 0 && (state.events as PineLogEventV1[])[0]!.sequence !== state.firstRetainedSequence) fail();
  if ((state.events as unknown[]).length === 0 && state.firstRetainedSequence !== state.nextSequence) fail();
}
