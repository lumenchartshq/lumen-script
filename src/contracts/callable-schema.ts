import type { PineQualifiedType } from "./index.js";

export interface PineCallableParameterDefinition {
  readonly name: string;
  readonly type: PineQualifiedType;
  readonly optional?: boolean;
}

export interface PineCallableOverloadDefinition {
  readonly parameters: readonly PineCallableParameterDefinition[];
  readonly returnType: PineQualifiedType;
  readonly variadicParameter?: PineCallableParameterDefinition;
}

export interface PineCallableDefinition {
  parameters: readonly string[];
  optionalParameters?: readonly string[];
  overloads?: readonly (readonly string[])[];
  variadicParameter?: string;
  returnType: string;
  documentation: string;
  signatureStatus: "complete" | "unspecified";
  /** Typed overloads consumed by the strict-profile semantic binder. */
  typedOverloads?: readonly PineCallableOverloadDefinition[];
}

/** Internal consistency only; semantic parity still requires execution fixtures. */
export function validateCallableDefinition(name: string, definition: PineCallableDefinition): void {
  const fail = (reason: string): never => { throw new Error(`Invalid callable ${name}: ${reason}`); };
  if (definition.signatureStatus !== "complete") fail("signature is unspecified");
  const signatures = definition.overloads?.length ? definition.overloads : [definition.parameters];
  const typed = definition.typedOverloads;
  if (!typed || typed.length !== signatures.length) return fail("typed overload count differs");
  const allNames = new Set(signatures.flat());
  for (const optional of definition.optionalParameters ?? []) {
    if (!allNames.has(optional)) fail(`unknown optional parameter ${optional}`);
  }
  for (const [index, signature] of signatures.entries()) {
    if (new Set(signature).size !== signature.length) fail("duplicate parameter names");
    const overload = typed[index]!;
    if (signature.length !== overload.parameters.length || signature.some((parameter, position) => parameter !== overload.parameters[position]!.name)) {
      fail(`typed overload ${String(index)} parameter order differs`);
    }
    for (const parameter of overload.parameters) {
      if (Boolean(parameter.optional) !== Boolean(definition.optionalParameters?.includes(parameter.name))) {
        fail(`optionality differs for ${parameter.name}`);
      }
    }
    if (overload.variadicParameter?.name !== definition.variadicParameter) fail("variadic parameter differs");
  }
}

/** Clone before freezing: consumers cannot mutate another profile's nested schema. */
export function freezeCallableDefinition(definition: PineCallableDefinition): PineCallableDefinition {
  return Object.freeze({
    ...definition,
    parameters: Object.freeze([...definition.parameters]),
    ...(definition.optionalParameters === undefined ? {} : { optionalParameters: Object.freeze([...definition.optionalParameters]) }),
    ...(definition.overloads === undefined ? {} : { overloads: Object.freeze(definition.overloads.map((parameters) => Object.freeze([...parameters]))) }),
    ...(definition.typedOverloads === undefined ? {} : {
      typedOverloads: Object.freeze(definition.typedOverloads.map((overload) => Object.freeze({
        ...overload,
        parameters: Object.freeze(overload.parameters.map(freezeParameter)),
        returnType: freezeType(overload.returnType),
        ...(overload.variadicParameter === undefined ? {} : { variadicParameter: freezeParameter(overload.variadicParameter) }),
      }))),
    }),
  });
}

function freezeParameter(parameter: PineCallableParameterDefinition): PineCallableParameterDefinition {
  return Object.freeze({ ...parameter, type: freezeType(parameter.type) });
}

function freezeType(type: PineQualifiedType): PineQualifiedType {
  return Object.freeze({ ...type, ...(type.arguments === undefined ? {} : { arguments: Object.freeze(type.arguments.map(freezeType)) }) });
}

export function deriveTypedOverloads(
  definition: Pick<PineCallableDefinition, "parameters" | "optionalParameters" | "overloads" | "returnType" | "variadicParameter">,
): readonly PineCallableOverloadDefinition[] {
  const optional = new Set(definition.optionalParameters ?? []);
  const signatures = definition.overloads?.length ? definition.overloads : [definition.parameters];
  return signatures.map((signature) => ({
    parameters: signature.map((name) => ({
      name,
      type: { kind: "unknown", qualifier: parameterQualifier(name) },
      ...(optional.has(name) ? { optional: true } : {}),
    })),
    returnType: parseQualifiedType(definition.returnType),
    ...(definition.variadicParameter === undefined ? {} : {
      variadicParameter: {
        name: definition.variadicParameter,
        type: { kind: "unknown", qualifier: "series" },
      },
    }),
  }));
}

function parameterQualifier(name: string): PineQualifiedType["qualifier"] {
  return ["title", "shorttitle", "tooltip", "inline", "group", "options", "sort_field"].includes(name) ? "const" : "series";
}

function parseQualifiedType(source: string): PineQualifiedType {
  const normalized = source.trim();
  const qualifier = /^(const|input|simple|series)\b/u.exec(normalized)?.[1] as PineQualifiedType["qualifier"] | undefined;
  const value = normalized.replace(/^(const|input|simple|series)\s+/u, "");
  const tuple = /^\[(.*)\]$/u.exec(value);
  if (tuple) return {
    kind: "tuple",
    qualifier: qualifier ?? "series",
    arguments: tuple[1]!.split(",").map((item) => parseQualifiedType(item.trim())),
  };
  const generic = /^(array|map|matrix)<(.+)>$/u.exec(value);
  if (generic) return {
    kind: generic[1] as "array" | "map" | "matrix",
    qualifier: "series",
    arguments: generic[2]!.split(",").map((item) => parseQualifiedType(item.trim())),
  };
  const kind = ["bool", "color", "enum", "float", "int", "string", "void", "plot", "hline"].includes(value)
    ? value as PineQualifiedType["kind"]
    : value === "number" || value === "series" || value === "input" ? "unknown"
      : ["array", "map", "matrix"].includes(value) ? value as PineQualifiedType["kind"] : "reference";
  return { kind, qualifier: ["array", "map", "matrix", "reference"].includes(kind) ? "series" : qualifier ?? "series", ...(kind === "reference" ? { name: value } : {}) };
}
