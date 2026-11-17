import type { StartupNode, StartupProgramV1, StartupScalar } from "../compiler/index.js";
import type { PineValue, SessionOptions } from "../contracts/index.js";
import { PineRuntimeError, pineRound } from "../runtime/index.js";

export interface StartupFailure {
  readonly message: string;
  readonly operation: string;
}

const REQUEST_COUNT_FAILURE: StartupFailure = {
  message: "Request calc_bars_count must resolve to a nonnegative simple int",
  operation: "request.security",
};

/** Resolves a request `calc_bars_count`; zero means "unbounded" and returns `undefined`. */
export function evaluateStartupProgram(program: StartupProgramV1, options: SessionOptions, inputs: Readonly<Record<string, PineValue>>): number | undefined {
  const value = evaluateStartupNumber(program, options, inputs, REQUEST_COUNT_FAILURE);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PineRuntimeError(REQUEST_COUNT_FAILURE.message, REQUEST_COUNT_FAILURE.operation, program.range);
  }
  return value === 0 ? undefined : value;
}

/** Evaluates a bounded startup program to a finite number, failing with the caller's diagnostic. */
export function evaluateStartupNumber(program: StartupProgramV1, options: SessionOptions, inputs: Readonly<Record<string, PineValue>>, failure: StartupFailure): number {
  const fail = (): never => { throw new PineRuntimeError(failure.message, failure.operation, program.range); };
  if (program.version !== 1) return fail();
  let remaining = 256;
  function evaluate(node: StartupNode, slots: ReadonlyMap<number, StartupScalar>, depth: number): StartupScalar {
    if (--remaining < 0 || depth > 32) return fail();
    const next = (child: StartupNode) => evaluate(child, slots, depth + 1);
    if (node.kind === "literal") return node.value;
    if (node.kind === "slot") return slots.get(node.id) ?? fail();
    if (node.kind === "input") {
      const value = Object.hasOwn(inputs, node.id) ? inputs[node.id] : Object.hasOwn(inputs, node.title) ? inputs[node.title] : node.defaultValue;
      return typeof value === "number" && Number.isFinite(value)
        && (node.valueType === "float" || Number.isSafeInteger(value)) ? value : fail();
    }
    if (node.kind === "metadata") {
      const value = node.namespace === "timeframe" ? options.timeframe ?? "" : options.symbolInfo?.[node.field];
      return typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : fail();
    }
    if (node.kind === "let") {
      const local = new Map(slots);
      for (const binding of node.bindings) {
        if (--remaining < 0 || local.has(binding.id)) return fail();
        local.set(binding.id, evaluate(binding.value, local, depth + 1));
      }
      return evaluate(node.result, local, depth + 1);
    }
    if (node.kind === "unary") {
      const value = next(node.argument);
      if (node.operator === "not") return typeof value === "boolean" ? !value : fail();
      if (typeof value !== "number") return fail();
      if (node.operator === "-") return -value;
      return node.operator === "+" ? value : fail();
    }
    if (node.kind === "conditional") {
      const value = next(node.test);
      return typeof value === "boolean" ? next(value ? node.consequent : node.alternate) : fail();
    }
    if (node.kind === "binary") {
      const left = next(node.left);
      if (node.operator === "and" && left === false) return false;
      if (node.operator === "or" && left === true) return true;
      const right = next(node.right);
      if (node.operator === "==") return left === right;
      if (node.operator === "!=") return left !== right;
      if (typeof left === "boolean" && typeof right === "boolean") {
        if (node.operator === "and") return left && right;
        if (node.operator === "or") return left || right;
      }
      if (typeof left !== "number" || typeof right !== "number") return fail();
      switch (node.operator) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "%": return left % right;
        case "<": return left < right;
        case "<=": return left <= right;
        case ">": return left > right;
        case ">=": return left >= right;
        default: return fail();
      }
    }
    if (node.kind === "call") {
      const values = node.arguments.map(next);
      if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value))) return fail();
      const first = values[0];
      if (first === undefined) return fail();
      switch (node.name) {
        case "int": return Math.trunc(first);
        case "float": return first;
        case "math.abs": return Math.abs(first);
        case "math.sign": return Math.sign(first);
        case "math.floor": return Math.floor(first);
        case "math.ceil": return Math.ceil(first);
        case "math.round": return values.length === 1 ? pineRound(first) : fail();
        case "math.min": return Math.min(...values);
        case "math.max": return Math.max(...values);
        default: return fail();
      }
    }
    return fail();
  }
  const value = evaluate(program.expression, new Map(), 0);
  return typeof value === "number" && Number.isFinite(value) ? value : fail();
}
