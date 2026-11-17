import type {
  Diagnostic,
  PineCallableDefinition,
  PineCallableOverloadDefinition,
  PineQualifiedType,
  SourceRange,
} from "../contracts/index.js";
import type { CallArgumentNode, ExpressionNode } from "./ast.js";

export interface CallArgumentBinding {
  readonly ordered: readonly (ExpressionNode | undefined)[];
  readonly signature?: readonly string[];
  readonly overloadIndex?: number;
  readonly typedOverload?: PineCallableOverloadDefinition;
}

interface CallArgumentBindingOptions {
  readonly callable: string;
  readonly arguments: readonly CallArgumentNode[];
  readonly signature?: readonly string[];
  readonly optionalParameters?: readonly string[];
  readonly overloads?: readonly (readonly string[])[];
  readonly variadicParameter?: string;
  readonly range: SourceRange;
  readonly diagnostics: Diagnostic[];
}

/**
 * Validates Pine's positional/named argument rules and returns the runtime
 * positional representation. The compiler deliberately only uses this for the
 * production profile; the sealed baseline profile keeps its historical output.
 */
export function bindCallArguments(options: CallArgumentBindingOptions): CallArgumentBinding {
  const { arguments: args, callable, diagnostics, range } = options;
  if (options.signature === undefined) {
    if (args.some((argument) => argument.name !== undefined)) {
      diagnostics.push({
        severity: "error",
        code: "SCRIPT2014",
        message: `Named arguments for '${callable}' cannot be validated because no callable signature is available`,
        range,
      });
    }
    return { ordered: args.map((argument) => argument.value) };
  }

  const positionalCount = args.filter((argument) => argument.name === undefined).length;
  const candidateSignatures = options.overloads === undefined || options.overloads.length === 0
    ? [options.signature]
    : options.overloads;
  const optional = new Set(options.optionalParameters ?? []);
  const accepts = (signature: readonly string[]): boolean =>
    (options.variadicParameter !== undefined || positionalCount <= signature.length)
    && args.every((argument) => argument.name === undefined || signature.includes(argument.name));
  const complete = (signature: readonly string[]): boolean => signature.every((parameter, index) =>
    optional.has(parameter) || args.some((argument, argumentIndex) => argument.name === parameter || (argument.name === undefined && argumentIndex === index)),
  );
  const matching = candidateSignatures.filter(accepts);
  const signature = matching.find(complete) ?? matching[0] ?? options.signature;

  const result: (ExpressionNode | undefined)[] = [];
  const assigned = new Set<number>();
  let positional = 0;
  let sawNamed = false;
  for (const argument of args) {
    if (argument.name === undefined) {
      if (sawNamed) {
        diagnostics.push({
          severity: "error",
          code: "SCRIPT2014",
          message: `Positional arguments cannot follow named arguments in '${callable}'`,
          range: argument.value.range,
        });
      }
      const index = positional++;
      if (index >= signature.length && options.variadicParameter === undefined) {
        diagnostics.push({
          severity: "error",
          code: "SCRIPT2014",
          message: `'${callable}' accepts at most ${String(signature.length)} argument${signature.length === 1 ? "" : "s"}`,
          range: argument.value.range,
        });
        continue;
      }
      if (index < signature.length && assigned.has(index)) {
        diagnostics.push({ severity: "error", code: "SCRIPT2014", message: `Argument '${signature[index]}' is specified more than once for '${callable}'`, range: argument.value.range });
        continue;
      }
      result[index] = argument.value;
      if (index < signature.length) assigned.add(index);
      continue;
    }

    sawNamed = true;
    const index = signature.indexOf(argument.name);
    if (index < 0) {
      diagnostics.push({ severity: "error", code: "SCRIPT2014", message: `Unknown argument '${argument.name}' for '${callable}'`, range: argument.value.range });
      continue;
    }
    if (assigned.has(index)) {
      diagnostics.push({ severity: "error", code: "SCRIPT2014", message: `Argument '${argument.name}' is specified more than once for '${callable}'`, range: argument.value.range });
      continue;
    }
    result[index] = argument.value;
    assigned.add(index);
  }

  for (const [index, parameter] of signature.entries()) {
    if (!optional.has(parameter) && result[index] === undefined) {
      diagnostics.push({ severity: "error", code: "SCRIPT2014", message: `Missing required argument '${parameter}' for '${callable}'`, range });
    }
  }
  return {
    ordered: options.variadicParameter === undefined ? signature.map((_, index) => result[index]) : result,
    signature,
    overloadIndex: candidateSignatures.indexOf(signature),
  };
}

export function bindBuiltinCallArguments(
  callable: string,
  args: readonly CallArgumentNode[],
  definition: PineCallableDefinition | undefined,
  range: SourceRange,
  diagnostics: Diagnostic[],
  argumentTypes?: ReadonlyMap<ExpressionNode, PineQualifiedType>,
): CallArgumentBinding {
  if (definition === undefined || definition.signatureStatus === "unspecified") {
    return bindCallArguments({ callable, arguments: args, range, diagnostics });
  }
  const selected = selectTypedOverload(args, definition.typedOverloads, argumentTypes);
  const selectedSignature = selected?.overload.parameters.map((parameter) => parameter.name);
  const optionalParameters = selected?.overload.parameters.filter((parameter) => parameter.optional).map((parameter) => parameter.name)
    ?? definition.optionalParameters;
  const binding = bindCallArguments({
    callable,
    arguments: args,
    signature: selectedSignature ?? definition.parameters,
    ...(optionalParameters === undefined ? {} : { optionalParameters }),
    ...(selectedSignature !== undefined || definition.overloads === undefined ? {} : { overloads: definition.overloads }),
    ...(definition.variadicParameter === undefined ? {} : { variadicParameter: definition.variadicParameter }),
    range,
    diagnostics,
  });
  return {
    ...binding,
    ...(selected === undefined ? {} : {
      overloadIndex: selected.index,
      typedOverload: selected.overload,
    }),
  };
}

function selectTypedOverload(
  args: readonly CallArgumentNode[],
  overloads: readonly PineCallableOverloadDefinition[] | undefined,
  argumentTypes: ReadonlyMap<ExpressionNode, PineQualifiedType> | undefined,
): { index: number; overload: PineCallableOverloadDefinition } | undefined {
  if (!overloads?.length) return undefined;
  const ranked = overloads.flatMap((overload, index) => {
    const indexes = argumentParameterIndexes(args, overload);
    if (!indexes) return [];
    let score = 0;
    for (const [argumentIndex, parameterIndex] of indexes.entries()) {
      const argument = args[argumentIndex];
      const parameter = overload.parameters[parameterIndex] ?? overload.variadicParameter;
      if (!argument || !parameter) return [];
      const argumentType = argumentTypes?.get(argument.value);
      const compatibility = argumentType === undefined ? 0 : typeCompatibility(argumentType, parameter.type);
      if (compatibility < 0) return [];
      score += compatibility;
    }
    return [{ index, overload, score }];
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = ranked[0];
  return selected && { index: selected.index, overload: selected.overload };
}

function argumentParameterIndexes(
  args: readonly CallArgumentNode[],
  overload: PineCallableOverloadDefinition,
): readonly number[] | undefined {
  const indexes: number[] = [];
  let positional = 0;
  let sawNamed = false;
  for (const argument of args) {
    if (argument.name === undefined) {
      if (sawNamed) return undefined;
      const index = positional++;
      if (index >= overload.parameters.length && overload.variadicParameter === undefined) return undefined;
      indexes.push(index);
    } else {
      sawNamed = true;
      const index = overload.parameters.findIndex((parameter) => parameter.name === argument.name);
      if (index < 0 || indexes.includes(index)) return undefined;
      indexes.push(index);
    }
  }
  const assigned = new Set(indexes);
  return overload.parameters.some((parameter, index) => !parameter.optional && !assigned.has(index))
    ? undefined
    : indexes;
}

function typeCompatibility(source: PineQualifiedType, target: PineQualifiedType): number {
  const qualifierRank = { const: 0, input: 1, simple: 2, series: 3 } as const;
  if (qualifierRank[source.qualifier] > qualifierRank[target.qualifier]) return -1;
  if (target.kind === "unknown" || source.kind === "unknown" || source.kind === "na") return 1;
  if (source.kind === target.kind && source.name === target.name) return 4;
  if (source.kind === "int" && target.kind === "float") return 3;
  return -1;
}
