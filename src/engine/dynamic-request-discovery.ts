import type { CompiledRequestPlan } from "../compiler/index.js";
import type { PineValue } from "../contracts/index.js";
import { PineRuntimeError } from "../runtime/index.js";
import { normalizeEngineTimeframe } from "./request-context-policy.js";

export class RequestDatasetDemand extends Error {
  public constructor(public readonly plan: CompiledRequestPlan) { super("Request dataset discovery required"); }
}

/** A speculative evaluation owns admissions until the engine commits its result. */
export class DynamicRequestDiscovery {
  public readonly admitted: Map<string, CompiledRequestPlan>;
  private readonly plans: ReadonlyMap<string, CompiledRequestPlan>;
  private readonly values = new Map<string, readonly PineValue[]>();

  public constructor(plans: readonly CompiledRequestPlan[], previous: ReadonlyMap<string, CompiledRequestPlan>, private readonly symbol: string, private readonly timeframe: string) {
    this.plans = new Map(plans.filter((plan) => plan.dynamic).map((plan) => [plan.id, plan]));
    this.admitted = new Map(previous);
  }

  public resolve = (id: string, symbolValue: PineValue, timeframeValue: PineValue, realtime: boolean, index: number): PineValue => {
    const plan = this.plans.get(id);
    if (plan === undefined) throw new Error("Unknown dynamic request plan");
    const fail = (message: string): never => { throw PineRuntimeError.at(new Error(message), plan.sourceRange, `request.${plan.kind}`); };
    if (typeof symbolValue !== "string" || typeof timeframeValue !== "string") return fail("Request symbol and timeframe must evaluate to strings");
    const symbol = symbolValue || this.symbol;
    const timeframe = normalizeEngineTimeframe(timeframeValue || this.timeframe);
    const key = JSON.stringify([1, id, symbol, timeframe]);
    if (!this.admitted.has(key)) {
      if (realtime) return fail("A realtime request cannot introduce a context that was not accessed on historical bars");
      if (this.admitted.size >= 40) return fail("Request context limit exceeded: Lumen Script supports at most 40 unique request contexts");
    }
    const values = this.values.get(key);
    if (values !== undefined) return values[index] ?? Number.NaN;
    const concrete = { ...plan, id: key, symbol, timeframe, dynamic: false };
    delete concrete.symbolInputId;
    delete concrete.symbolInputTitle;
    delete concrete.timeframeInputId;
    delete concrete.timeframeInputTitle;
    throw new RequestDatasetDemand(concrete);
  };

  public admit(plan: CompiledRequestPlan, values: readonly PineValue[]): void {
    this.admitted.set(plan.id, plan);
    this.values.set(plan.id, values);
  }

  public resolvedSeries(): Readonly<Record<string, readonly PineValue[]>> {
    return Object.freeze(Object.fromEntries(this.values));
  }
}
