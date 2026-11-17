import { PINE_DISPLAY_MASKS, PINE_MARKET_FIELDS, parsePineDateString, type Diagnostic, type InputDefinition, type PineValue } from "../contracts/index.js";
import type { ExpressionNode } from "./ast.js";
import { evaluateConstant, type ConstantValue } from "./constant-evaluator.js";
import { callableName, memberName } from "./expression-names.js";
import type { PineSemanticModel } from "./semantic-binder.js";

const marketFields = new Set<string>(PINE_MARKET_FIELDS);

export function inputDefaultValue(
  node: ExpressionNode | undefined,
  type: InputDefinition["type"],
  enumValues: ReadonlyMap<string, string>,
  topLevelValues: ReadonlyMap<string, ExpressionNode>,
  semantic?: PineSemanticModel,
): InputDefinition["defaultValue"] {
  const resolved = staticInputValue(node, enumValues, topLevelValues, new Set(), semantic);
  if (resolved !== undefined && !Array.isArray(resolved)) {
    return type === "color" && typeof resolved === "string" ? normalizeInputColor(resolved) : resolved;
  }
  if (type === "source" && node?.kind === "identifier" && marketFields.has(node.name)) return node.name;
  if (type === "color" && node?.kind === "member") return inputColorDefault(memberName(node), semantic) ?? null;
  if (type === "enum" && node?.kind === "member") return enumValues.get(memberName(node)) ?? null;
  return null;
}

function normalizeInputColor(value: string): string {
  const match = value.match(/^#([\dA-Fa-f]{6})([\dA-Fa-f]{2})?$/u);
  if (match === null) return value;
  const rgb = match[1]!.toUpperCase();
  const alpha = match[2]?.toUpperCase();
  return alpha === undefined || alpha === "FF" ? `#${rgb}` : `#${rgb}${alpha}`;
}

export function inferInputType(
  node: ExpressionNode | undefined,
  semantic?: PineSemanticModel,
): InputDefinition["type"] {
  const semanticType = semantic?.typeOf(node);
  if (semanticType?.kind === "float" && semanticType.qualifier === "series") return "source";
  if (semanticType !== undefined && ["bool", "color", "float", "int", "string"].includes(semanticType.kind)) {
    return semanticType.kind as "bool" | "color" | "float" | "int" | "string";
  }
  if (node?.kind === "identifier" && marketFields.has(node.name)) return "source";
  if (node?.kind === "member" && memberName(node).startsWith("color.")) return "color";
  if (node?.kind === "literal") {
    if (typeof node.value === "boolean") return "bool";
    if (typeof node.value === "number") return Number.isInteger(node.value) ? "int" : "float";
    if (typeof node.value === "string" && node.value.startsWith("#")) return "color";
  }
  return "string";
}

export function inputDescriptorOptions(
  node: Extract<ExpressionNode, { kind: "call" }>,
  type: InputDefinition["type"],
  enumValues: ReadonlyMap<string, string>,
  topLevelValues: ReadonlyMap<string, ExpressionNode>,
  semantic?: PineSemanticModel,
): Partial<InputDefinition> {
  const optionOverload = (type === "int" || type === "float") && (node.arguments.some((argument) => argument.name === "options") || node.arguments.filter((argument) => argument.name === undefined)[2]?.value.kind === "tuple");
  const signature = inputOptionSignature(type, optionOverload);
  const values = new Map<string, ExpressionNode>();
  for (const [index, argument] of node.arguments.filter((argument) => argument.name === undefined).entries()) {
    const key = signature[index];
    if (key !== undefined) values.set(key, argument.value);
  }
  for (const argument of node.arguments) if (argument.name !== undefined) values.set(argument.name, argument.value);
  const resolved = (key: string): PineValue | undefined => {
    const value = values.get(key);
    return staticInputValue(value, enumValues, topLevelValues, new Set(), semantic) ?? (value?.kind === "identifier" ? value.name : undefined);
  };
  const tooltip = resolved("tooltip");
  const inline = resolved("inline");
  const group = resolved("group");
  const confirm = resolved("confirm");
  const active = resolved("active");
  const display = resolved("display");
  const options = resolved("options");
  const minValue = resolved("minval");
  const maxValue = resolved("maxval");
  const step = resolved("step");
  return {
    ...(typeof tooltip === "string" ? { tooltip } : {}),
    ...(typeof inline === "string" ? { inline } : {}),
    ...(typeof group === "string" ? { group } : {}),
    ...(typeof confirm === "boolean" ? { confirm } : {}),
    ...(typeof active === "boolean" ? { active } : {}),
    ...(typeof display === "number" ? { display } : {}),
    ...(isPineValueList(options) ? { options: Object.freeze([...options]) } : {}),
    ...(typeof minValue === "number" ? { minValue } : {}),
    ...(typeof maxValue === "number" ? { maxValue } : {}),
    ...(typeof step === "number" ? { step } : {}),
  };
}

export function inputDescriptorDiagnostics(
  node: Extract<ExpressionNode, { kind: "call" }>,
  definition: InputDefinition,
): readonly Diagnostic[] {
  const fail = (message: string): Diagnostic[] => [{
    severity: "error",
    code: "SCRIPT2018",
    message,
    range: node.range,
  }];
  const value = definition.defaultValue;
  if (definition.type === "source") return value === null || typeof value === "string"
    ? []
    : fail("Input source default must be a supported series expression");
  if (definition.type === "bool" && typeof value !== "boolean") return fail("Input bool default must be a constant bool");
  if (["color", "enum", "session", "string", "symbol", "text_area", "timeframe"].includes(definition.type)
    && typeof value !== "string") {
    return fail(`Input ${definition.type} default must be a constant string value`);
  }
  if (["float", "int", "price", "time"].includes(definition.type)
    && (typeof value !== "number" || !Number.isFinite(value))) {
    return fail(`Input ${definition.type} default must be a finite constant number`);
  }
  if ((definition.type === "int" || definition.type === "time") && typeof value === "number" && !Number.isInteger(value)) {
    return fail(`Input ${definition.type} default must be an integer`);
  }
  if (definition.type === "color" && typeof value === "string" && !/^#[\dA-F]{6}(?:[\dA-F]{2})?$/u.test(value)) {
    return fail("Input color default must resolve to a hexadecimal color");
  }
  if (definition.type === "session" && typeof value === "string" && !validInputSession(value)) {
    return fail("Input session default must use the supported session grammar");
  }
  if (definition.type === "timeframe" && typeof value === "string" && !validInputTimeframe(value)) {
    return fail("Input timeframe default must use the supported timeframe grammar");
  }
  if (definition.options !== undefined) {
    if (definition.options.length === 0) return fail(`Input ${definition.type} options must not be empty`);
    if (!definition.options.some((option) => Object.is(option, value))) {
      return fail(`Input ${definition.type} default must be one of its options`);
    }
    if (definition.type === "int" && definition.options.some((option) => typeof option !== "number" || !Number.isInteger(option))) {
      return fail("Input int options must contain only integers");
    }
    if (definition.type === "session" && definition.options.some((option) => typeof option !== "string" || !validInputSession(option))) {
      return fail("Input session options must use the supported session grammar");
    }
    if (definition.type === "timeframe" && definition.options.some((option) => typeof option !== "string" || !validInputTimeframe(option))) {
      return fail("Input timeframe options must use the supported timeframe grammar");
    }
  }
  if (definition.type !== "int" && definition.type !== "float") return [];
  if (definition.minValue !== undefined && !Number.isFinite(definition.minValue)) return fail(`Input ${definition.type} minval must be finite`);
  if (definition.maxValue !== undefined && !Number.isFinite(definition.maxValue)) return fail(`Input ${definition.type} maxval must be finite`);
  if (definition.step !== undefined && (!Number.isFinite(definition.step) || definition.step <= 0)) return fail(`Input ${definition.type} step must be a finite positive number`);
  if (definition.type === "int" && [definition.minValue, definition.maxValue, definition.step].some((entry) => entry !== undefined && !Number.isInteger(entry))) {
    return fail("Input int minval, maxval and step must be integers");
  }
  if (definition.minValue !== undefined && definition.maxValue !== undefined && definition.minValue > definition.maxValue) {
    return fail(`Input ${definition.type} minval must not exceed maxval`);
  }
  if (typeof value === "number" && definition.minValue !== undefined && value < definition.minValue) {
    return fail(`Input ${definition.type} default must not be less than minval`);
  }
  if (typeof value === "number" && definition.maxValue !== undefined && value > definition.maxValue) {
    return fail(`Input ${definition.type} default must not exceed maxval`);
  }
  if (definition.type === "int" && typeof value === "number" && definition.step !== undefined) {
    const origin = definition.minValue ?? 0;
    const steps = (value - origin) / definition.step;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8;
    if (Math.abs(steps - Math.round(steps)) > tolerance) {
      return fail(`Input ${definition.type} default must align to step`);
    }
  }
  return [];
}

function validInputSession(value: string): boolean {
  const source = value.trim();
  if (source === "24x7") return true;
  const match = /^(.*?)(?::([1-7]+))?$/u.exec(source);
  if (match === null || match[1]!.length === 0) return false;
  return match[1]!.split(",").every((window) => {
    const parts = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/u.exec(window);
    if (parts === null) return false;
    const [startHour, startMinute, endHour, endMinute] = parts.slice(1).map(Number);
    return startHour! <= 23 && endHour! <= 23 && startMinute! <= 59 && endMinute! <= 59;
  });
}

function validInputTimeframe(value: string): boolean {
  if (value === "") return true;
  const source = value.trim();
  const aliases: Readonly<Record<string, string>> = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "45m": "45",
    "1h": "60", "2h": "120", "3h": "180", "4h": "240", "1d": "D", "1w": "W", "1M": "M",
  };
  const normalized = aliases[source] ?? aliases[source.toLowerCase()] ?? source.toUpperCase();
  if (/^\d+$/u.test(normalized)) {
    const minutes = Number.parseInt(normalized, 10);
    return minutes >= 1 && minutes <= 1_440;
  }
  const match = /^(\d+)?([SDWM])$/u.exec(normalized);
  if (match === null) return false;
  const multiplier = Number.parseInt(match[1] ?? "1", 10);
  if (match[2] === "S") return [1, 5, 10, 15, 30, 45].includes(multiplier);
  if (match[2] === "D") return multiplier >= 1 && multiplier <= 365;
  if (match[2] === "W") return multiplier >= 1 && multiplier <= 52;
  return multiplier >= 1 && multiplier <= 12;
}

function isPineValueList(value: PineValue | undefined): value is readonly PineValue[] {
  return Array.isArray(value);
}

export function staticInputValue(
  node: ExpressionNode | undefined,
  enumValues: ReadonlyMap<string, string>,
  topLevelValues: ReadonlyMap<string, ExpressionNode> = new Map(),
  resolving: ReadonlySet<string> = new Set(),
  semantic?: PineSemanticModel,
): PineValue | undefined {
  if (node === undefined) return undefined;
  if (node.kind === "literal") return node.value;
  if (node.kind === "identifier") {
    if (marketFields.has(node.name)) return node.name;
    if (resolving.has(node.name)) return undefined;
    const declared = topLevelValues.get(node.name);
    return declared === undefined
      ? undefined
      : staticInputValue(declared, enumValues, topLevelValues, new Set([...resolving, node.name]), semantic);
  }
  if (node.kind === "unary" && (node.operator === "+" || node.operator === "-") && node.argument.kind === "literal" && typeof node.argument.value === "number") {
    return node.operator === "-" ? -node.argument.value : node.argument.value;
  }
  if (node.kind === "tuple") {
    const values = node.elements.map((element) => staticInputValue(element, enumValues, topLevelValues, resolving, semantic));
    return values.every((value) => value !== undefined) ? values as readonly PineValue[] : undefined;
  }
  if (node.kind === "member") {
    const name = memberName(node);
    const enumValue = enumValues.get(name);
    if (enumValue !== undefined) return enumValue;
    if (name.startsWith("display.")) return PINE_DISPLAY_MASKS[name.slice("display.".length) as keyof typeof PINE_DISPLAY_MASKS];
    return inputColorDefault(name, semantic) ?? name;
  }
  if (node.kind === "binary" && (node.operator === "+" || node.operator === "-")) {
    const left = staticInputValue(node.left, enumValues, topLevelValues, resolving, semantic);
    const right = staticInputValue(node.right, enumValues, topLevelValues, resolving, semantic);
    if (typeof left === "number" && typeof right === "number") return node.operator === "+" ? left + right : left - right;
  }
  if (node.kind === "call") {
    const name = callableName(node.callee);
    const boundArguments = semantic?.callBindingAt(node.range.start.offset, node.range.end.offset)?.ordered;
    const argumentNodes = boundArguments ?? node.arguments.map((argument) => argument.value);
    const args = argumentNodes.map((argument) => staticInputValue(argument, enumValues, topLevelValues, resolving, semantic));
    if (name === "color.new") return staticColorNew(args[0], args[1]);
    if (name === "color.rgb") return staticColorRgb(args);
    if (semantic !== undefined && name === "timestamp" && args.length === 1 && typeof args[0] === "string") {
      const parsed = parsePineDateString(args[0]);
      return parsed.ok ? parsed.value : undefined;
    }
  }
  if (semantic === undefined) return undefined;
  return evaluateConstant(node, {
    identifier: (name): ConstantValue | undefined => {
      if (resolving.has(name)) return undefined;
      const declared = topLevelValues.get(name);
      if (declared === undefined) return undefined;
      const value = staticInputValue(declared, enumValues, topLevelValues, new Set([...resolving, name]), semantic);
      return isConstantValue(value) ? value : undefined;
    },
    member: (member): ConstantValue | undefined => {
      if (member.kind !== "member") return undefined;
      const name = memberName(member);
      const value = enumValues.get(name)
        ?? (name.startsWith("display.") ? PINE_DISPLAY_MASKS[name.slice("display.".length) as keyof typeof PINE_DISPLAY_MASKS] : undefined)
        ?? inputColorDefault(name, semantic);
      return isConstantValue(value) ? value : undefined;
    },
    arguments: (call) => semantic.callBindingAt(call.range.start.offset, call.range.end.offset)?.ordered
      ?? call.arguments.map((argument) => argument.value),
    integerDivision: (expression) => semantic.typeOf(expression).kind === "int",
  });
}

function isConstantValue(value: PineValue | undefined): value is ConstantValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function staticColorNew(value: PineValue | undefined, transparency: PineValue | undefined): string | undefined {
  if (typeof value !== "string" || typeof transparency !== "number") return undefined;
  const match = value.match(/^#([\dA-Fa-f]{6})([\dA-Fa-f]{2})?$/u);
  if (match === null) return undefined;
  const alpha = Math.round(255 * (100 - Math.min(100, Math.max(0, transparency))) / 100);
  return `#${match[1]!.toUpperCase()}${alpha.toString(16).padStart(2, "0").toUpperCase()}`;
}

function staticColorRgb(args: readonly (PineValue | undefined)[]): string | undefined {
  if (!args.slice(0, 3).every((value) => typeof value === "number")) return undefined;
  const channels = args.slice(0, 3).map((value) => Math.min(255, Math.max(0, Math.round(value as number))).toString(16).padStart(2, "0").toUpperCase());
  const transparency = typeof args[3] === "number" ? args[3] : 0;
  const alpha = Math.round(255 * (100 - Math.min(100, Math.max(0, transparency))) / 100).toString(16).padStart(2, "0").toUpperCase();
  return `#${channels.join("")}${alpha}`;
}

function inputColorDefault(name: string, semantic: PineSemanticModel | undefined): string | undefined {
  // Code generation supplies the semantic model only for the production profile.
  return name === "color.blue" && semantic !== undefined ? "#2962FF" : inputColorDefaults[name];
}

const inputColorDefaults: Readonly<Record<string, string>> = {
  "color.aqua": "#00BCD4",
  "color.black": "#363A45",
  "color.blue": "#2196F3",
  "color.fuchsia": "#E040FB",
  "color.gray": "#787B86",
  "color.green": "#4CAF50",
  "color.lime": "#00E676",
  "color.maroon": "#880E4F",
  "color.navy": "#311B92",
  "color.olive": "#808000",
  "color.orange": "#FF9800",
  "color.purple": "#9C27B0",
  "color.red": "#F23645",
  "color.silver": "#B2B5BE",
  "color.teal": "#089981",
  "color.white": "#FFFFFF",
  "color.yellow": "#FDD835",
};


function inputOptionSignature(type: InputDefinition["type"], optionOverload: boolean): readonly string[] {
  if ((type === "int" || type === "float") && !optionOverload) return ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display", "active"];
  if (optionOverload || type === "enum" || type === "session" || type === "string" || type === "timeframe") return ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display", "active"];
  if (type === "source") return ["defval", "title", "tooltip", "inline", "group", "display", "active", "confirm"];
  if (type === "text_area") return ["defval", "title", "tooltip", "group", "confirm", "display", "active"];
  if (type === "bool" || type === "color" || type === "price" || type === "symbol" || type === "time") return ["defval", "title", "tooltip", "inline", "group", "confirm", "display", "active"];
  return ["defval", "title", "tooltip", "inline", "group", "display", "active"];
}
