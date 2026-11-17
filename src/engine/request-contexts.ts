import type { ExecutionResult, MarketBar } from "../contracts/index.js";
import { RequestContextBudget } from "./request-context-budget.js";
import { commonBarPrefix } from "./dataset.js";

interface RequestChild {
  runBatch(bars: readonly MarketBar[]): Promise<ExecutionResult>;
  appendBars(bars: readonly MarketBar[]): Promise<ExecutionResult>;
  replaceTail(bars: readonly MarketBar[], options?: { readonly logCause?: "realtime-tick" | "historical-correction" }): Promise<ExecutionResult>;
  close(): Promise<void>;
}
interface RequestContext<Child> {
  readonly key: string;
  readonly child: Child;
  readonly release: () => void;
  busy?: boolean;
  ready?: { readonly bars: readonly MarketBar[]; readonly result: ExecutionResult };
}

/** One registry owns children from creation through cache reuse and disposal. */
export class RequestContexts<Child extends RequestChild> {
  private readonly contexts = new Map<string, RequestContext<Child>>();
  private readonly budget: RequestContextBudget;
  public constructor(limit: number | RequestContextBudget, private readonly retainInvocations = true) {
    this.budget = typeof limit === "number" ? new RequestContextBudget(limit) : limit;
  }
  public get size(): number { return this.contexts.size; }

  public async execute(id: string, key: string, bars: readonly MarketBar[], usesClock: boolean, create: () => Child, selection = key, logCause?: "realtime-tick" | "historical-correction"): Promise<ExecutionResult> {
    const invocation = this.retainInvocations ? JSON.stringify([1, id, selection]) : id;
    let context = this.contexts.get(invocation);
    if (context?.busy) throw new Error("Request context already has a pending evaluation");
    if (context !== undefined && context.key !== key) {
      await this.discard(invocation, context);
      context = undefined;
    }
    if (context === undefined) {
      const release = this.budget.acquire();
      try { context = { key, child: create(), release }; }
      catch (error) { release(); throw error; }
      this.contexts.set(invocation, context);
    }
    context.busy = true;
    try {
      const ready = context.ready;
      let result: ExecutionResult;
      if (ready === undefined) result = await context.child.runBatch(bars);
      else {
        const common = commonBarPrefix(ready.bars, bars);
        const same = common === ready.bars.length && common === bars.length;
        if (same && !usesClock) return ready.result;
        if (same && usesClock && logCause === "realtime-tick" && bars.length > 0) result = await context.child.replaceTail(bars.slice(-1), { logCause });
        else if (same) result = await context.child.runBatch(bars);
        else if (common === ready.bars.length) result = await context.child.appendBars(bars.slice(common));
        else if (common === ready.bars.length - 1 && bars.length > common) result = await context.child.replaceTail(bars.slice(common), logCause === undefined ? undefined : { logCause });
        else result = await context.child.runBatch(bars);
      }
      if (this.contexts.get(invocation) !== context) throw new Error("Request context was disposed during evaluation");
      // The engine admits rows independently; retain our own stable comparison rows.
      context.ready = { bars: Object.freeze(bars.map((bar) => Object.freeze({ ...bar }))), result };
      return result;
    } catch (error) {
      await this.discard(invocation, context);
      throw error;
    } finally { context.busy = false; }
  }

  public async close(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    for (const context of contexts) context.release();
    await Promise.all(contexts.map(({ child }) => child.close()));
  }

  private async discard(id: string, context: RequestContext<Child>): Promise<void> {
    if (this.contexts.get(id) !== context) return;
    this.contexts.delete(id);
    context.release();
    await context.child.close();
  }
}
