import { evaluateConstant } from "./constant-evaluator.js";
import { findMutatedDeclarations } from "./declaration-mutations.js";
import { PINE_CERTIFIED_STRATEGY_TRADE_CALLS,
  PINE_MARKET_FIELDS,
  PINE_CONSTANT_NAMES,
  PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES,
  PINE_V5_STRATEGY_CALL_SIGNATURES,
  PINE_TIME_COMPONENT_FIELDS,
  pineBuiltinCatalog,
  pineCallableMetadata,
  isPineShadowingNamespaceConstant,
  pineRuntimeFields,
  type PineCompatibility,
  type Diagnostic,
  type PineQualifiedType,
  type PineCallableDefinition,
  type PineQualifier,
  type PineTypeKind,
  type PineVersion,
  isStrictPineCompatibility,
} from "../contracts/index.js";
import type {
  CallArgumentNode,
  CallNode,
  DeclarationNode,
  ExpressionNode,
  FunctionDeclarationNode,
  FunctionParameterNode,
  MethodDeclarationNode,
  ProgramNode,
  StatementNode,
} from "./ast.js";
import { collectCallNodes } from "./ast-walk.js";
import { methodReferenceTypeNames, methodRequiredSignature, referenceNames } from "./method-signature.js";
import {
  bindBuiltinCallArguments,
  bindCallArguments,
  type CallArgumentBinding,
} from "./argument-binding.js";

const builtinConstantNames = new Set<string>([...PINE_CONSTANT_NAMES, ...PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES]);
const suppliedFutureFloatNames = new Set(["dividends.future_amount", "earnings.future_eps", "earnings.future_revenue"]);
const suppliedFutureTimeNames = new Set([
  "dividends.future_ex_date", "dividends.future_pay_date",
  "earnings.future_period_end_time", "earnings.future_time",
]);
const constIntConstantRoots = new Set(["dayofweek", "display", "order"]);
const constStringConstantRoots = new Set([
  "extend", "font", "format", "hline", "location", "plot", "position", "shape", "size", "text", "xloc", "yloc",
]);
const constStringConstantNames = new Set([
  ...PINE_PRODUCTION_STRATEGY_SELECTOR_NAMES,
  "alert.freq_all", "alert.freq_once_per_bar", "alert.freq_once_per_bar_close",
  "backadjustment.inherit", "backadjustment.off", "backadjustment.on",
  "barmerge.gaps_off", "barmerge.gaps_on", "barmerge.lookahead_off", "barmerge.lookahead_on",
  "dividends.gross", "dividends.net",
  "earnings.actual", "earnings.estimate", "earnings.standardized",
  "line.style_solid", "line.style_dashed", "line.style_dotted",
  "line.style_arrow_left", "line.style_arrow_right", "line.style_arrow_both",
  "label.style_circle", "label.style_diamond", "label.style_label_center", "label.style_label_down",
  "label.style_label_left", "label.style_label_right", "label.style_label_up", "label.style_square",
  "splits.denominator", "splits.numerator",
]);

export interface PineSemanticModel {
  readonly diagnostics: readonly Diagnostic[];
  readonly expressionTypes: ReadonlyMap<ExpressionNode, PineQualifiedType>;
  readonly v5BooleanCoercions: ReadonlyMap<ExpressionNode, "direct" | "truncate">;
  readonly v5BooleanMissingValues: ReadonlySet<ExpressionNode>;
  readonly v5RequiresMissingBooleans: boolean;
  readonly valueOrigins: ReadonlyMap<ExpressionNode, ValueOrigin>;
  readonly assignmentOrigins: ReadonlyMap<StatementNode, ValueOrigin>;
  readonly hasMapIteration: boolean;
  readonly symbolTypes: ReadonlyMap<string, PineQualifiedType>;
  readonly callBindings: ReadonlyMap<CallNode, CallArgumentBinding>;
  readonly methodBindings: ReadonlyMap<CallNode, MethodDeclarationNode>;
  readonly methodCandidates: ReadonlyMap<CallNode, ReadonlySet<MethodDeclarationNode | undefined>>;
  callBindingAt(offset: number, endOffset: number): CallArgumentBinding | undefined;
  methodCandidatesAt(offset: number, endOffset: number): ReadonlySet<MethodDeclarationNode | undefined> | undefined;
  typeOf(node: ExpressionNode | undefined): PineQualifiedType;
  constantValueOf(node: ExpressionNode | undefined): string | number | boolean | undefined;
}

export type ValueOrigin = ExpressionNode | FunctionParameterNode;

interface SymbolBinding {
  type: PineQualifiedType;
  readonly explicitQualifier: boolean;
  readonly immutable: boolean;
  readonly origin?: ValueOrigin;
  readonly constantValue?: string | number | boolean | undefined;
  plotEnumValues?: readonly string[] | undefined;
}

interface BindingScope {
  readonly parent?: BindingScope;
  readonly symbols: Map<string, SymbolBinding>;
}

const qualifierRank: Readonly<Record<PineQualifier, number>> = {
  const: 0,
  input: 1,
  simple: 2,
  series: 3,
};
const referenceKinds = new Set<PineTypeKind>(["array", "map", "matrix", "reference", "udt"]);
const scalarKinds = new Set<PineTypeKind>(["bool", "color", "float", "int", "string"]);
const marketFields = new Set<string>(PINE_MARKET_FIELDS);
const timeComponentFields = new Set<string>(PINE_TIME_COMPONENT_FIELDS);
const datasetTailIntegerFields = new Set(["last_bar_index", "last_bar_time"]);
const scalarMathCallNames = new Set([
  "math.abs", "math.acos", "math.asin", "math.atan", "math.avg", "math.ceil", "math.cos", "math.exp",
  "math.floor", "math.log", "math.log10", "math.max", "math.min", "math.pow", "math.round", "math.sign",
  "math.sin", "math.sqrt", "math.tan", "math.todegrees", "math.toradians",
]);
const remainingMathCallNames = new Set(["math.random", "math.round_to_mintick", "math.sum"]);
const scalarMissingCallNames = new Set(["bool", "color", "fixnan", "float", "int", "na", "nz", "string"]);
const scalarStringCallNames = new Set([
  "str.contains", "str.endswith", "str.length", "str.lower", "str.pos", "str.repeat", "str.replace",
  "str.replace_all", "str.split", "str.startswith", "str.substring", "str.tonumber", "str.trim", "str.upper",
]);
const advancedStringCallNames = new Set(["str.format", "str.format_time", "str.match", "str.tostring"]);
const certifiedLineMethods = new Set([
  "set_xy2", "get_x2", "get_y2", "get_price", "delete", "copy", "get_x1", "get_y1",
  "set_xy1", "set_color", "set_x1", "set_x2", "set_y1", "set_y2", "set_width", "set_style", "set_extend",
  "set_first_point", "set_second_point", "set_xloc",
]);
const lineExtendChoices = ["extend.none", "extend.left", "extend.right", "extend.both"] as const;
const lineStyleChoices = ["line.style_solid", "line.style_dashed", "line.style_dotted", "line.style_arrow_left", "line.style_arrow_right", "line.style_arrow_both"] as const;
const isCertifiedLineMethod = (name: string): boolean =>
  name.startsWith("line.") && certifiedLineMethods.has(name.slice(5));
const certifiedFillPolylineCalls = new Set([
  "linefill.new", "linefill.delete", "linefill.get_line1", "linefill.get_line2", "linefill.set_color",
  "polyline.new", "polyline.delete",
]);
const certifiedTableCalls = new Set([
  "new", "cell", "cell_set_bgcolor", "cell_set_height", "cell_set_text", "cell_set_text_color",
  "cell_set_text_font_family", "cell_set_text_halign", "cell_set_text_size", "cell_set_text_valign",
  "cell_set_tooltip", "cell_set_width", "clear", "delete", "merge_cells", "set_bgcolor",
  "set_border_color", "set_border_width", "set_frame_color", "set_frame_width", "set_position",
]);
const isCertifiedTableCall = (name: string): boolean =>
  name.startsWith("table.") && certifiedTableCalls.has(name.slice(6));
const tableTextSizes = new Set(["auto", "tiny", "small", "normal", "large", "huge"]);
const certifiedBoxMethods = new Set([
  "copy", "delete", "get_bottom", "get_left", "get_right", "get_top", "set_bgcolor", "set_border_color",
  "set_border_style", "set_border_width", "set_bottom", "set_bottom_right_point", "set_extend", "set_left",
  "set_lefttop", "set_right", "set_rightbottom", "set_text", "set_text_color", "set_text_font_family",
  "set_text_formatting", "set_text_halign", "set_text_size", "set_text_valign", "set_text_wrap", "set_top",
  "set_top_left_point", "set_xloc",
]);
const isCertifiedBoxMethod = (name: string): boolean =>
  name.startsWith("box.") && certifiedBoxMethods.has(name.slice(4));

const certifiedLabelMethods = new Set([
  "copy", "delete", "get_text", "get_x", "get_y", "set_color", "set_point", "set_size",
  "set_style", "set_text", "set_text_font_family", "set_textalign", "set_textcolor",
  "set_tooltip", "set_x", "set_xloc", "set_xy", "set_y", "set_yloc",
]);
const isCertifiedLabelMethod = (name: string): boolean =>
  name.startsWith("label.") && certifiedLabelMethods.has(name.slice(6));
const labelStyleChoices = [
  "label.style_label_down", "label.style_label_up", "label.style_label_left", "label.style_label_right",
  "label.style_label_center", "label.style_label_lower_left", "label.style_label_lower_right",
  "label.style_label_upper_left", "label.style_label_upper_right", "label.style_circle",
  "label.style_square", "label.style_diamond", "label.style_arrowdown", "label.style_arrowup",
  "label.style_cross", "label.style_flag", "label.style_none", "label.style_text_outline",
  "label.style_triangledown", "label.style_triangleup", "label.style_xcross",
] as const;
const labelOptions = {
  xloc: ["xloc.bar_index", "xloc.bar_time"],
  yloc: ["yloc.price", "yloc.abovebar", "yloc.belowbar"],
  style: labelStyleChoices,
  textalign: ["text.align_left", "text.align_center", "text.align_right"],
  text_font_family: ["font.family_default", "font.family_monospace"],
} as const;
const taHistoryCallNames = new Set([
  "ta.barssince", "ta.change", "ta.cross", "ta.crossover", "ta.crossunder", "ta.cum",
  "ta.falling", "ta.highest", "ta.highestbars", "ta.lowest", "ta.lowestbars", "ta.mom",
  "ta.range", "ta.rising", "ta.roc", "ta.valuewhen",
]);
const taAverageCallNames = new Set([
  "ta.alma", "ta.dev", "ta.ema", "ta.hma", "ta.linreg", "ta.rma", "ta.sma", "ta.stdev",
  "ta.swma", "ta.variance", "ta.vwma", "ta.wma",
]);
const taOscillatorCallNames = new Set([
  "ta.atr", "ta.cci", "ta.cmo", "ta.cog", "ta.dmi", "ta.macd", "ta.rci", "ta.rsi", "ta.stoch",
  "ta.tr", "ta.tsi", "ta.wpr",
]);
const taBandRankCallNames = new Set([
  "ta.bb", "ta.bbw", "ta.correlation", "ta.kc", "ta.kcw", "ta.median", "ta.mode",
  "ta.percentile_linear_interpolation", "ta.percentile_nearest_rank", "ta.percentrank",
]);
const taVolumeCallNames = new Set(["ta.mfi", "ta.vwap"]);
const taPivotTrendCallNames = new Set(["ta.pivothigh", "ta.pivotlow", "ta.sar", "ta.supertrend"]);
const strategyCoreCallNames = new Set([
  "strategy.close",
  "strategy.close_all",
  "strategy.entry",
  "strategy.exit",
  "strategy.order",
  "strategy.risk.allow_entry_in",
  "strategy.risk.max_cons_loss_days",
  "strategy.risk.max_drawdown",
  "strategy.risk.max_intraday_filled_orders",
  "strategy.risk.max_intraday_loss",
  "strategy.risk.max_position_size",
  ...PINE_CERTIFIED_STRATEGY_TRADE_CALLS,
]);
const plotMarkerCallNames = new Set(["plot", "plotshape", "plotchar", "plotarrow"]);
const certifiedArrayMutationCallNames = new Set([
  "clear", "concat", "copy", "fill", "first", "insert", "last", "remove", "reverse", "shift", "slice", "unshift",
]);
const certifiedArraySearchOrderCallNames = new Set([
  "binary_search", "binary_search_leftmost", "binary_search_rightmost", "every", "includes", "indexof", "join",
  "lastindexof", "some", "sort", "sort_indices",
]);
const certifiedArrayNumericCallNames = new Set([
  "abs", "avg", "covariance", "max", "median", "min", "mode", "percentile_linear_interpolation",
  "percentile_nearest_rank", "percentrank", "range", "standardize", "stdev", "sum", "variance",
]);
const certifiedMapCallNames = new Set([
  "clear", "contains", "copy", "get", "keys", "put", "put_all", "remove", "size", "values",
]);
const certifiedMatrixCoreCallNames = new Set([
  "col", "columns", "copy", "elements_count", "fill", "get", "row", "rows", "set", "submatrix",
]);
const certifiedMatrixStructuralCallNames = new Set([
  "add_col", "add_row", "remove_col", "remove_row", "reshape", "swap_columns", "swap_rows", "transpose",
]);
const certifiedMatrixReverseCallNames = new Set(["reverse"]);
const certifiedMatrixNumericCallNames = new Set(["avg", "median", "min", "max", "mode", "trace"]);
const certifiedMatrixLinearAlgebraCallNames = new Set(["det", "rank"]);
const certifiedMatrixInversePowerCallNames = new Set(["inv", "pinv", "pow"]);
const matrixM3CallNames = new Set(["concat", "diff", "kron", "mult", "sort", "sum"]);
const certifiedMatrixPredicateCallNames = new Set([
  "is_antidiagonal", "is_antisymmetric", "is_binary", "is_diagonal", "is_identity",
  "is_square", "is_stochastic", "is_symmetric", "is_triangular", "is_zero",
]);
const arrayEqualitySearchCallNames = new Set(["includes", "indexof", "lastindexof"]);
const arrayBinarySearchCallNames = new Set(["binary_search", "binary_search_leftmost", "binary_search_rightmost"]);
const taFloatVariableNames = new Set([
  "ta.accdist", "ta.iii", "ta.nvi", "ta.obv", "ta.pvi", "ta.pvt", "ta.wad", "ta.wvad",
]);
const stringIntegerParameters: Readonly<Record<string, ReadonlySet<number>>> = {
  "str.repeat": new Set([1]),
  "str.replace": new Set([3]),
  "str.substring": new Set([1, 2]),
};

function advancedStringParameterType(name: string, index: number): PineQualifiedType | undefined {
  if (name === "str.format") return index === 0 ? primitive("string", "series") : undefined;
  if (name === "str.format_time") return primitive(index === 0 ? "int" : "string", "series");
  if (name === "str.match") return primitive("string", "series");
  if (name === "str.tostring") {
    if (index === 1) return primitive("string", "series");
    return undefined;
  }
  return undefined;
}

export function bindProgram(
  program: ProgramNode,
  compatibility: PineCompatibility,
): PineSemanticModel {
  if (!isStrictPineCompatibility(compatibility)) return emptySemanticModel();
  return new SemanticBinder(program.version, compatibility).bind(program);
}

class SemanticBinder {
  private readonly diagnostics: Diagnostic[] = [];
  private readonly expressionTypes = new Map<ExpressionNode, PineQualifiedType>();
  private readonly v5BooleanMissingValues = new Set<ExpressionNode>();
  private v5RequiresMissingBooleans = false;
  private readonly valueOrigins = new Map<ExpressionNode, ValueOrigin>();
  private readonly assignmentOrigins = new Map<StatementNode, ValueOrigin>();
  private hasMapIteration = false;
  private readonly v5BooleanCoercions = new Map<ExpressionNode, "direct" | "truncate">();
  private readonly constantExpressions = new WeakMap<ExpressionNode, string | number | boolean>();
  private readonly plotEnumExpressionValues = new WeakMap<ExpressionNode, readonly string[]>();
  private readonly callBindings = new Map<CallNode, CallArgumentBinding>();
  private readonly methodBindings = new Map<CallNode, MethodDeclarationNode>();
  private readonly methodCandidates = new Map<CallNode, Set<MethodDeclarationNode | undefined>>();
  private readonly methodCandidatesByRange = new Map<string, Set<MethodDeclarationNode | undefined>>();
  private readonly callBindingsByRange = new Map<string, CallArgumentBinding>();
  private readonly functions = new Map<string, FunctionDeclarationNode>();
  private readonly methods = new Map<string, MethodDeclarationNode[]>();
  private readonly udts = new Map<string, Extract<StatementNode, { kind: "type" }>>();
  private readonly enums = new Map<string, Extract<StatementNode, { kind: "enum" }>>();
  private readonly activeCalls = new Set<string>();
  private callableDepth = 0;
  private readonly root: BindingScope = { symbols: new Map() };
  private readonly knownCallables: ReadonlySet<string>;
  private readonly knownVariables: ReadonlySet<string>;
  private readonly runtimeFields: ReadonlySet<string>;
  private readonly callableMetadata: Readonly<Record<string, PineCallableDefinition>>;
  private readonly mutatedDeclarations = new Set<DeclarationNode>();

  constructor(
    private readonly version: PineVersion,
    private readonly compatibility: PineCompatibility,
  ) {
    const catalog = pineBuiltinCatalog(compatibility);
    this.knownCallables = new Set(catalog.builtins);
    this.knownVariables = new Set(catalog.variables);
    this.runtimeFields = new Set(pineRuntimeFields(compatibility));
    this.callableMetadata = pineCallableMetadata(compatibility);
  }

  bind(program: ProgramNode): PineSemanticModel {
    for (const declaration of findMutatedDeclarations(program)) this.mutatedDeclarations.add(declaration);
    this.collectDeclarations(program.statements);
    for (const callable of program.statements) {
      if ((callable.kind !== "function" && callable.kind !== "method") || !callable.exported) continue;
      for (const parameter of callable.parameters) {
        if (parameter.dataType === undefined) this.error("SCRIPT2123", `Exported parameter '${parameter.name}' requires an explicit type`, parameter.range);
        if (parameter.qualifier === "const" || parameter.qualifier === "input") this.error("SCRIPT2123", `Exported parameter '${parameter.name}' must use simple or series, not ${parameter.qualifier}`, parameter.range);
      }
    }
    this.bindStatements(program.statements, this.root);
    for (const fn of this.functions.values()) this.bindCallable(fn, this.declarationParameterTypes(fn));
    for (const overloads of this.methods.values()) {
      for (const method of overloads) this.bindCallable(method, this.declarationParameterTypes(method));
    }
    const symbolTypes = new Map([...this.root.symbols].map(([name, symbol]) => [name, symbol.type]));
    return {
      diagnostics: Object.freeze([...this.diagnostics]),
      expressionTypes: this.expressionTypes,
      v5BooleanCoercions: this.v5BooleanCoercions,
      v5BooleanMissingValues: this.v5BooleanMissingValues,
      v5RequiresMissingBooleans: this.v5RequiresMissingBooleans || this.v5BooleanCoercions.size > 0,
      valueOrigins: this.valueOrigins,
      assignmentOrigins: this.assignmentOrigins,
      hasMapIteration: this.hasMapIteration,
      symbolTypes,
      callBindings: this.callBindings,
      methodBindings: this.methodBindings,
      methodCandidates: this.methodCandidates,
      callBindingAt: (offset, endOffset) => this.callBindingsByRange.get(`${offset}:${endOffset}`),
      methodCandidatesAt: (offset, endOffset) => this.methodCandidatesByRange.get(`${offset}:${endOffset}`),
      typeOf: (node) => node === undefined ? unknownType() : this.expressionTypes.get(node) ?? unknownType(),
      constantValueOf: (node) => node === undefined ? undefined : this.constantExpressions.get(node),
    };
  }

  private collectDeclarations(statements: readonly StatementNode[]) {
    const referenceTypes = methodReferenceTypeNames(statements);
    for (const statement of statements) {
      if (statement.kind === "type") this.udts.set(statement.name, statement);
      else if (statement.kind === "enum") this.enums.set(statement.name, statement);
      else if (statement.kind === "function") this.functions.set(statement.name, statement);
      else if (statement.kind === "method") {
        const overloads = this.methods.get(statement.name) ?? [];
        const signature = methodRequiredSignature(statement, referenceTypes);
        if (overloads.some((method) => methodRequiredSignature(method, referenceTypes) === signature)) {
          this.error("SCRIPT2013", `Method '${statement.name}' has a duplicate required signature for '${statement.parameters[0]?.dataType ?? "receiver"}'`, statement.range);
          continue;
        }
        overloads.push(statement);
        this.methods.set(statement.name, overloads);
      }
    }
  }

  private bindStatements(statements: readonly StatementNode[], scope: BindingScope): PineQualifiedType {
    let result = voidType();
    for (const statement of statements) result = this.bindStatement(statement, scope);
    return result;
  }

  private bindStatement(statement: StatementNode, scope: BindingScope): PineQualifiedType {
    switch (statement.kind) {
      case "enum":
      case "type":
      case "function":
      case "method":
      case "break":
      case "continue":
        return voidType();
      case "declaration": {
        const valueType = this.infer(statement.value, scope);
        const declaredType = statement.dataType === undefined
          ? valueType
          : this.parseType(statement.dataType, statement.qualifier ?? valueType.qualifier);
        const targetType = statement.qualifier === undefined
          ? statement.persistence !== "bar" || this.mutatedDeclarations.has(statement)
            ? withQualifier(declaredType, "series")
            : declaredType
          : withQualifier(declaredType, statement.qualifier);
        if (this.version === 5 && targetType.kind === "bool" && valueType.kind === "na") {
          this.v5BooleanMissingValues.add(statement.value);
        }
        if (invalidVoidValue(statement.value, valueType)) {
          this.error("SCRIPT2137", `Void expression cannot initialize variable '${statement.name}'`, statement.value.range);
        } else if (statement.dataType === undefined && valueType.kind === "na") {
          this.error("SCRIPT2101", `Variable '${statement.name}' initialized with na requires an explicit type`, statement.range);
        } else if (this.version === 5 && targetType.kind === "bool" && (valueType.kind === "int" || valueType.kind === "float")
          && qualifierRank[valueType.qualifier] <= qualifierRank[targetType.qualifier]) {
          this.v5BooleanCoercions.set(statement.value, "direct");
        } else if (!assignable(valueType, targetType)) {
          this.typeMismatch("SCRIPT2102", `Cannot assign ${describe(valueType)} to variable '${statement.name}' of type ${describe(targetType)}`, statement.value);
        }
        let constantValue = targetType.qualifier === "const" ? this.constantValue(statement.value, scope) : undefined;
        if (this.v5BooleanCoercions.has(statement.value) && typeof constantValue === "number") {
          constantValue = Number.isNaN(constantValue) ? undefined : constantValue !== 0;
        }
        this.declare(scope, statement.name, {
          type: targetType,
          explicitQualifier: statement.qualifier !== undefined,
          immutable: statement.qualifier === "const",
          origin: statement.value,
          ...(targetType.qualifier === "const" ? { constantValue } : {}),
          plotEnumValues: this.plotEnumValues(statement.value, scope),
        }, statement.range);
        return targetType;
      }
      case "tuple_declaration": {
        const value = this.infer(statement.value, scope);
        if (invalidVoidValue(statement.value, value)) {
          this.error("SCRIPT2137", "Void expression cannot initialize a tuple", statement.value.range);
        }
        const members = value.kind === "tuple" ? value.arguments ?? [] : [];
        if (value.kind === "tuple" && members.length !== statement.names.length) {
          this.error("SCRIPT2139", `Cannot destructure a ${String(members.length)}-value tuple into ${String(statement.names.length)} variables`, statement.range);
        }
        for (const [index, name] of statement.names.entries()) {
          if (name !== "_") this.declare(scope, name, { type: members[index] ?? unknownType(value.qualifier), explicitQualifier: false, immutable: false, origin: statement.value }, statement.range);
        }
        return value;
      }
      case "assignment": {
        const value = this.infer(statement.value, scope);
        const symbol = lookup(scope, statement.name);
        if (!symbol) {
          this.error("SCRIPT2103", `Cannot reassign undeclared variable '${statement.name}'`, statement.range);
          return value;
        }
        if (symbol.origin !== undefined) this.assignmentOrigins.set(statement, symbol.origin);
        if (this.version === 5 && symbol.type.kind === "bool" && value.kind === "na") this.v5BooleanMissingValues.add(statement.value);
        if (invalidVoidValue(statement.value, value)) {
          this.error("SCRIPT2137", `Void expression cannot be assigned to variable '${statement.name}'`, statement.value.range);
          return symbol.type;
        }
        if (this.callableDepth > 0 && this.root.symbols.get(statement.name) === symbol) this.error("SCRIPT2007", `Functions cannot reassign global variable '${statement.name}'`, statement.range);
        if (symbol.immutable) this.error("SCRIPT2104", `Cannot reassign const variable '${statement.name}'`, statement.range);
        if (symbol.explicitQualifier && qualifierRank[value.qualifier] > qualifierRank[symbol.type.qualifier]) {
          this.error("SCRIPT2105", `Cannot assign ${describe(value)} to ${describe(symbol.type)} variable '${statement.name}'`, statement.range);
        } else if (this.version === 5 && symbol.type.kind === "bool" && (value.kind === "int" || value.kind === "float")) {
          this.v5BooleanCoercions.set(statement.value, value.kind === "float" ? "truncate" : "direct");
          if (!symbol.explicitQualifier) symbol.type = withQualifier(symbol.type, strongest(symbol.type.qualifier, value.qualifier));
        } else if (!valueTypeAssignable(value, symbol.type)) {
          this.error("SCRIPT2102", `Cannot assign ${describe(value)} to variable '${statement.name}' of type ${describe(symbol.type)}`, statement.range);
        } else if (!symbol.explicitQualifier) {
          symbol.type = joinTypes(symbol.type, value);
        }
        const nextEnumValues = this.plotEnumValues(statement.value, scope);
        symbol.plotEnumValues = symbol.plotEnumValues && nextEnumValues
          ? [...new Set([...symbol.plotEnumValues, ...nextEnumValues])]
          : undefined;
        return symbol.type;
      }
      case "member_assignment": {
        if (statement.object.kind === "call") {
          this.error("SCRIPT2106", "Assign the object to a variable before assigning its fields", statement.object.range);
        }
        const object = this.infer(statement.object, scope);
        const value = this.infer(statement.value, scope);
        const field = this.memberType(object, statement.property, statement.range);
        if (field.kind !== "unknown" && !assignable(value, field)) {
          this.error("SCRIPT2106", `Cannot assign ${describe(value)} to field '${statement.property}' of type ${describe(field)}`, statement.range);
        }
        return field;
      }
      case "expression": return this.infer(statement.expression, scope);
      case "if": {
        this.requireCondition(statement.test, scope);
        const consequent = this.bindStatements(statement.consequent, childScope(scope));
        const alternate = this.bindStatements(statement.alternate, childScope(scope));
        this.recordV5BooleanBranches(consequent, alternate);
        return joinTypes(consequent, alternate);
      }
      case "once": {
        this.requireCondition(statement.test, scope);
        this.bindStatements(statement.body, childScope(scope));
        return voidType();
      }
      case "while": {
        this.requireCondition(statement.test, scope);
        return this.bindStatements(statement.body, childScope(scope));
      }
      case "for": {
        const loop = this.rangeScope(statement, scope);
        return this.bindStatements(statement.body, loop);
      }
      case "for_in": {
        const collection = this.infer(statement.collection, scope);
        const loop = childScope(scope);
        this.bindForInVariables(loop, statement.variables, collection, statement.collection);
        return this.bindStatements(statement.body, loop);
      }
    }
  }

  private rangeScope(node: Extract<StatementNode | ExpressionNode, { kind: "for" | "for_expression" }>, scope: BindingScope): BindingScope {
    const start = this.infer(node.start, scope);
    this.requireNumeric(start, node.start);
    this.requireNumeric(this.infer(node.end, scope), node.end);
    const counterKind = start.kind === "float" ? "float" : "int";
    if (node.step) {
      const step = this.infer(node.step, scope);
      this.requireNumeric(step, node.step);
      if (counterKind === "int" && step.kind === "float") {
        this.error("SCRIPT2106", "A float loop step is incompatible with an int counter", node.step.range);
      }
    }
    const loop = childScope(scope);
    loop.symbols.set(node.variable, { type: primitive(counterKind, "series"), explicitQualifier: true, immutable: true, origin: node.start });
    return loop;
  }

  private infer(node: ExpressionNode, scope: BindingScope): PineQualifiedType {
    const existing = this.expressionTypes.get(node);
    if (existing && this.callableDepth === 0) return existing;
    let type: PineQualifiedType;
    switch (node.kind) {
      case "literal":
        type = node.value === null ? naType() : typeof node.value === "boolean" ? primitive("bool", "const")
          : typeof node.value === "string" ? primitive(node.literalType === "color" ? "color" : "string", "const")
          : primitive(node.numericType ?? "float", "const");
        break;
      case "identifier": type = this.identifierType(node.name, scope, node); break;
      case "member": type = this.inferMember(node, scope); break;
      case "history": {
        const base = this.infer(node.value, scope);
        const offset = this.infer(node.offset, scope);
        if (this.version === 6) {
          if (node.value.kind === "literal") this.error("SCRIPT2107", "Version 6 scripts cannot reference the history of literal values", node.value.range);
          if (node.value.kind === "member") {
            const root = rootIdentifier(node.value);
            const builtin = root !== undefined && lookup(scope, root) === undefined && namespaceLike(root);
            if (builtin && builtinConstantNames.has(memberName(node.value))
              && !suppliedFutureFloatNames.has(memberName(node.value))
              && !suppliedFutureTimeNames.has(memberName(node.value))) {
              this.error("SCRIPT2107", "Version 6 scripts cannot reference the history of built-in constants", node.value.range);
            } else if (!builtin && this.infer(node.value.object, scope).kind === "udt") {
              this.error("SCRIPT2107", "Reference the history of the object or assign its field to a variable first", node.value.range);
            }
          }
        }
        if (offset.kind !== "int" && offset.kind !== "unknown") this.error("SCRIPT2107", "History offset must be an int", node.offset.range);
        type = withQualifier(base, "series");
        break;
      }
      case "unary": {
        const argument = this.infer(node.argument, scope);
        if (node.operator === "not") {
          this.requireBoolean(argument, node.argument);
          type = primitive("bool", argument.qualifier);
        } else {
          this.requireNumeric(argument, node.argument);
          type = argument;
        }
        break;
      }
      case "binary": type = this.inferBinary(node, scope); break;
      case "conditional": {
        this.requireCondition(node.test, scope);
        const consequent = this.infer(node.consequent, scope);
        const alternate = this.infer(node.alternate, scope);
        if (this.version === 6 && consequent.kind === "bool" && alternate.kind === "na") {
          this.error("SCRIPT2138", "A bool conditional branch cannot be na in version 6 scripts", node.alternate.range);
        } else if (this.version === 6 && consequent.kind === "na" && alternate.kind === "bool") {
          this.error("SCRIPT2138", "A bool conditional branch cannot be na in version 6 scripts", node.consequent.range);
        } else if (incompatiblePrimitiveBranches(consequent, alternate)) {
          this.error("SCRIPT2138", `Conditional branches have incompatible types ${describe(consequent)} and ${describe(alternate)}`, node.range);
        }
        type = joinTypes(consequent, alternate);
        type = withQualifier(type, strongest(type.qualifier, this.infer(node.test, scope).qualifier));
        break;
      }
      case "tuple": type = compound("tuple", node.elements.map((element) => this.infer(element, scope)), strongestOf(node.elements.map((element) => this.infer(element, scope)))); break;
      case "call": type = this.inferCall(node, scope); break;
      case "if_expression": {
        const test = this.requireCondition(node.test, scope);
        const consequentScope = childScope(scope);
        const alternateScope = childScope(scope);
        const consequent = this.bindStatements(node.consequent, consequentScope);
        const alternate = this.bindStatements(node.alternate, alternateScope);
        this.recordV5BooleanBranches(consequent, alternate);
        this.recordPlotEnumBranches(node, [
          this.plotEnumBranchValues(node.consequent, consequentScope),
          this.plotEnumBranchValues(node.alternate, alternateScope),
        ]);
        type = joinTypes(consequent, alternate);
        if (isStrictPineCompatibility(this.compatibility)) type = withQualifier(type, strongest(type.qualifier, test.qualifier));
        break;
      }
      case "while_expression": {
        this.requireCondition(node.test, scope);
        type = this.bindStatements(node.body, childScope(scope));
        break;
      }
      case "for_expression": {
        const loop = this.rangeScope(node, scope);
        type = this.bindStatements(node.body, loop);
        break;
      }
      case "for_in_expression": {
        const collection = this.infer(node.collection, scope);
        const loop = childScope(scope);
        this.bindForInVariables(loop, node.variables, collection, node.collection);
        type = this.bindStatements(node.body, loop);
        break;
      }
      case "switch": {
        const discriminant = node.discriminant ? this.infer(node.discriminant, scope) : undefined;
        if (node.discriminant && discriminant) this.recordV5Constant(node.discriminant, discriminant, scope);
        let result = unknownType("const");
        let selectorQualifier = discriminant?.qualifier ?? "const";
        const enumBranches: Array<readonly string[] | undefined> = [];
        let hasMissingArm = false;
        for (const arm of node.cases) {
          if (arm.test) {
            const test = this.infer(arm.test, scope);
            selectorQualifier = strongest(selectorQualifier, test.qualifier);
            if (discriminant && !comparable(discriminant, test)) this.error("SCRIPT2108", `Switch case ${describe(test)} is incompatible with ${describe(discriminant)}`, arm.test.range);
            if (!discriminant) this.requireCondition(arm.test, scope);
            else this.recordV5Constant(arm.test, test, scope);
          }
          const armScope = childScope(scope);
          const armType = this.bindStatements(arm.body, armScope);
          hasMissingArm ||= armType.kind === "na";
          result = joinTypes(result, armType);
          enumBranches.push(this.plotEnumBranchValues(arm.body, armScope));
        }
        const hasDefault = node.cases.some((arm) => arm.test === undefined);
        if (this.version === 5 && result.kind === "bool" && (hasMissingArm || !hasDefault)) this.v5RequiresMissingBooleans = true;
        this.recordPlotEnumBranches(node, hasDefault ? enumBranches : [undefined]);
        type = isStrictPineCompatibility(this.compatibility)
          ? withQualifier(result, strongest(result.qualifier, selectorQualifier))
          : result;
        break;
      }
    }
    this.expressionTypes.set(node, existing === undefined ? type : joinTypes(existing, type));
    return type;
  }

  private inferBinary(node: Extract<ExpressionNode, { kind: "binary" }>, scope: BindingScope): PineQualifiedType {
    const left = this.infer(node.left, scope);
    const right = this.infer(node.right, scope);
    const qualifier = strongest(left.qualifier, right.qualifier);
    if (["and", "or"].includes(node.operator)) {
      this.requireBoolean(left, node.left);
      this.requireBoolean(right, node.right);
      return primitive("bool", qualifier);
    }
    if (["==", "!=", "<", "<=", ">", ">="].includes(node.operator)) {
      if (!comparable(left, right)) this.error("SCRIPT2109", `Cannot compare ${describe(left)} and ${describe(right)}`, node.range);
      return primitive("bool", qualifier);
    }
    if (node.operator === "+" && left.kind === "string" && right.kind === "string") return primitive("string", qualifier);
    this.requireNumeric(left, node.left);
    this.requireNumeric(right, node.right);
    if (node.operator === "/" && this.version === 6) return primitive("float", qualifier);
    return primitive(left.kind === "float" || right.kind === "float" ? "float" : "int", qualifier);
  }

  private inferCall(node: CallNode, scope: BindingScope): PineQualifiedType {
    const name = callableName(node.callee);
    const argumentTypesByNode = new Map(node.arguments.map((argument) => [
      argument.value,
      this.infer(argument.value, scope),
    ]));
    let argumentNodes = node.arguments.map((argument) => argument.value);
    let orderedArgumentNodes: readonly (ExpressionNode | undefined)[] = argumentNodes;
    let typedReturnType: PineQualifiedType | undefined;
    const declaredMetadata = this.callableMetadata[name];
    let metadata = isStrictPineCompatibility(this.compatibility) && name === "matrix.new" && declaredMetadata
      ? { ...declaredMetadata, optionalParameters: ["rows", "columns", "initial_value"] }
      : declaredMetadata;
    const v5StrategySignature = isStrictPineCompatibility(this.compatibility) && this.version === 5
      ? PINE_V5_STRATEGY_CALL_SIGNATURES[name]
      : undefined;
    if (metadata !== undefined && v5StrategySignature?.at(-1) === "when") {
      const v5TypedOverloads = name === "strategy.cancel"
        ? [{ parameters: [
          { name: "id", type: primitive("string", "series") },
          { name: "immediately", type: primitive("bool", "series"), optional: true },
          { name: "when", type: primitive("bool", "series"), optional: true },
        ], returnType: voidType() }]
        : metadata.typedOverloads?.map((overload) => ({
          ...overload,
          parameters: [...overload.parameters, { name: "when", type: primitive("bool", "series"), optional: true }],
        }));
      metadata = {
        ...metadata,
        parameters: v5StrategySignature,
        optionalParameters: [...(metadata.optionalParameters ?? []), "when"],
        ...(v5TypedOverloads === undefined ? {} : { typedOverloads: v5TypedOverloads }),
      };
    }
    if (metadata) {
      const firstArgument = node.arguments[0]?.value;
      const firstType = firstArgument ? argumentTypesByNode.get(firstArgument) : undefined;
      const pointConstructor = firstArgument?.kind === "call" && callableName(firstArgument.callee).startsWith("chart.point.");
      const numericDrawingNew = isStrictPineCompatibility(this.compatibility) && (name === "line.new" || name === "box.new")
        && !node.arguments.some((argument) => ["first_point", "second_point", "top_left", "bottom_right"].includes(argument.name ?? ""))
        && !(firstType?.kind === "reference" && firstType.name === "chart.point") && !pointConstructor;
      const numericLabelNew = isStrictPineCompatibility(this.compatibility) && name === "label.new"
        && !node.arguments.some((argument) => argument.name === "point")
        && !(firstType?.kind === "reference" && firstType.name === "chart.point") && !pointConstructor;
      const numericSignature = metadata.typedOverloads?.[name === "box.new" ? 2 : 1]?.parameters;
      const binding = (numericDrawingNew || numericLabelNew) && numericSignature
        ? bindCallArguments({
          callable: name,
          arguments: node.arguments,
          signature: numericSignature.map((parameter) => parameter.name),
          optionalParameters: numericSignature.filter((parameter) => parameter.optional).map((parameter) => parameter.name),
          range: node.range,
          diagnostics: this.diagnostics,
        })
        : bindBuiltinCallArguments(
          name,
          node.arguments,
          metadata,
          node.range,
          this.diagnostics,
          argumentTypesByNode,
        );
      this.recordCallBinding(node, binding);
      const ordered = binding.ordered;
      orderedArgumentNodes = ordered;
      if (["alertcondition", "indicator", "library", "max_bars_back", "strategy"].includes(name)) {
        for (const argument of ordered) {
          if (argument === undefined || this.infer(argument, scope).qualifier !== "const") continue;
          const constant = this.constantValue(argument, scope);
          if (constant !== undefined) this.constantExpressions.set(argument, constant);
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && name === "fill" && ordered[0] && ordered[1]) {
        const firstKind = this.infer(ordered[0], scope).kind;
        const secondKind = this.infer(ordered[1], scope).kind;
        if (!["plot", "hline", "na"].includes(firstKind) || !["plot", "hline", "na"].includes(secondKind)
          || (firstKind !== "na" && secondKind !== "na" && firstKind !== secondKind)) {
          this.error("SCRIPT2117", "fill() requires two plot handles or two hline handles", node.range);
        }
      }
      this.validateSort(
        name,
        ordered[0] ? this.infer(ordered[0], scope) : unknownType(),
        ordered[name === "matrix.sort" ? 2 : 1],
        ordered[name === "matrix.sort" ? 3 : 2],
        node,
        scope,
      );
      const typed = binding.typedOverload;
      typedReturnType = typed?.returnType;
      // These visual and effect calls have one exact signature. A type mismatch prevents
      // overload selection, so validate that signature explicitly as well.
      if (isStrictPineCompatibility(this.compatibility) &&
        (["alert", "alertcondition", "runtime.error", "strategy.cancel", "strategy.default_entry_qty",
          "strategy.convert_to_account", "strategy.convert_to_symbol",
          "plotbar", "plotcandle", "bgcolor", "barcolor", "hline", "fill", "line.new", "box.new", "label.new", "box", "label", "line", "linefill", "table"].includes(name)
          || certifiedFillPolylineCalls.has(name)
          || isCertifiedLineMethod(name) || isCertifiedBoxMethod(name) || isCertifiedLabelMethod(name)
          || isCertifiedTableCall(name) || name.startsWith("chart.point.")) && !typed) {
        const signature = metadata.typedOverloads?.find((candidate) =>
          candidate.parameters.map((parameter) => parameter.name).join("\0") === binding.signature?.join("\0"));
        for (const [index, argument] of ordered.entries()) {
          const parameter = signature?.parameters[index];
          if (!argument || !parameter) continue;
          if (((isCertifiedTableCall(name) || name === "box.new") && parameter.name === "text_size")
            || ((name === "box.set_text_size" || name === "label.new" || name === "label.set_size") && parameter.name === "size")) continue;
          const argumentType = this.infer(argument, scope);
          if (!assignable(argumentType, parameter.type)) this.error("SCRIPT2117", `Argument '${parameter.name}' for '${name}' requires ${describe(parameter.type)}, received ${describe(argumentType)}`, argument.range);
        }
      }
      if (typed) {
        for (const [index, argument] of ordered.entries()) {
          const parameter = typed.parameters[index] ?? typed.variadicParameter;
          if (!argument || !parameter) continue;
          const argumentType = this.infer(argument, scope);
          if (!((name === "label.new" || name === "label.set_size") && parameter.name === "size")
            && !assignable(argumentType, parameter.type)) {
            this.error("SCRIPT2117", `Argument '${parameter.name}' for '${name}' requires ${describe(parameter.type)}, received ${describe(argumentType)}`, argument.range);
          }
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && ["time", "time_close", "timestamp"].includes(name) && !typed) {
        for (const [index, argument] of ordered.entries()) {
          if (!argument) continue;
          const parameter = binding.signature?.[index];
          if (!parameter) continue;
          const expectedKind = ["bars_back", "timeframe_bars_back", "year", "month", "day", "hour", "minute", "second"].includes(parameter)
            ? "int" : "string";
          const actual = this.infer(argument, scope);
          if (!assignable(actual, primitive(expectedKind, parameter === "dateString" ? "const" : "series"))) {
            this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${parameter === "dateString" ? "const" : "series"} ${expectedKind}, received ${describe(actual)}`, argument.range);
          }
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && (name === "table.cell" || name === "table.cell_set_text_size")) {
        this.validateTableTextSize(name, ordered[metadata.parameters.indexOf("text_size")], scope);
      }
      if (isStrictPineCompatibility(this.compatibility) && (name === "box.new" || name === "box.set_text_size")) {
        this.validateBoxTextSize(name, ordered[binding.signature?.indexOf(name === "box.new" ? "text_size" : "size") ?? -1], scope);
      }
      if (isStrictPineCompatibility(this.compatibility) && name === "hline") {
        const style = ordered[binding.signature?.indexOf("linestyle") ?? -1];
        if (style && this.plotEnumValues(style, scope)?.every((choice) =>
          ["hline.style_solid", "hline.style_dotted", "hline.style_dashed"].includes(choice)) !== true) {
          this.error("SCRIPT2117", "Argument 'linestyle' for 'hline' requires an hline style constant", style.range);
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && (name === "line.new" || name === "line.set_style" || name === "line.set_extend" || name === "line.set_xloc" || name === "box.new" || name === "box.set_border_style" || name === "box.set_extend" || name === "box.set_xloc")) {
        for (const [parameter, allowed] of [
          ["xloc", ["xloc.bar_index", "xloc.bar_time"]],
          ["extend", lineExtendChoices],
          [name === "box.new" ? "border_style" : "style", name.startsWith("box.") ? lineStyleChoices.slice(0, 3) : lineStyleChoices],
        ] as const) {
          if (name === "line.set_style" && parameter !== "style") continue;
          if (name === "line.set_extend" && parameter !== "extend") continue;
          if (name === "line.set_xloc" && parameter !== "xloc") continue;
          if (name === "box.set_border_style" && parameter !== "style") continue;
          if (name === "box.set_extend" && parameter !== "extend") continue;
          if (name === "box.set_xloc" && parameter !== "xloc") continue;
          const index = binding.signature?.indexOf(parameter) ?? -1;
          const argument = ordered[index];
          if (!argument) continue;
          const choices = this.plotEnumValues(argument, scope);
          if (!choices?.every((choice) => (allowed as readonly string[]).includes(choice))) {
            this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a ${parameter} constant`, argument.range);
          }
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && name === "polyline.new") {
        for (const [parameter, allowed] of [
          ["xloc", ["xloc.bar_index", "xloc.bar_time"]],
          ["line_style", lineStyleChoices.slice(0, 3)],
        ] as const) {
          const argument = ordered[binding.signature?.indexOf(parameter) ?? -1];
          if (!argument || this.plotEnumValues(argument, scope)?.every((choice) => (allowed as readonly string[]).includes(choice)) !== true) {
            if (argument) this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a ${parameter} constant`, argument.range);
          }
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && (name === "table.new" || name === "table.set_position")) {
        const position = ordered[name === "table.new" ? 0 : 1];
        const choices = position && this.plotEnumValues(position, scope);
        if (position && choices && !choices.every((choice) => choice.startsWith("position.") && builtinConstantNames.has(choice))) {
          this.error("SCRIPT2117", `Argument 'position' for '${name}' requires a position constant`, position.range);
        }
      }
      if (isStrictPineCompatibility(this.compatibility) && (name === "label.new" || isCertifiedLabelMethod(name))) {
        if (name === "label.new" || name === "label.set_size") {
          this.validateLabelSize(name, ordered[binding.signature?.indexOf("size") ?? -1], scope);
        }
        for (const [parameter, allowed] of Object.entries(labelOptions)) {
          if (name !== "label.new" && name !== `label.set_${parameter}` && !(parameter === "textalign" && name === "label.set_textalign")
            && !(parameter === "text_font_family" && name === "label.set_text_font_family")) continue;
          const nameInSignature = name === "label.set_text_font_family" ? "family" : parameter;
          const index = binding.signature?.indexOf(nameInSignature) ?? -1;
          const argument = ordered[index];
          if (!argument) continue;
          this.validateLabelOption(name, parameter, argument, allowed, scope);
        }
      }
      if (isStrictPineCompatibility(this.compatibility) &&
        ["plotbar", "plotcandle", "bgcolor", "barcolor"].includes(name)) {
        if (name === "plotbar" || name === "plotcandle") {
          const format = ordered[metadata.parameters.indexOf("format")];
          if (format && !this.isOhlcFormatExpression(format, scope)) {
            this.error("SCRIPT2117", `Argument 'format' for '${name}' requires format.inherit, format.price, format.percent, or format.volume`, format.range);
          }
        }
        const display = ordered[metadata.parameters.indexOf("display")];
        const mask = display ? this.constantValue(display, scope) : undefined;
        if (typeof mask === "number" && (!Number.isInteger(mask) || mask < 0 || mask > 31)) {
          this.error("SCRIPT2117", `Argument 'display' for '${name}' requires a display mask from 0 to 31`, display?.range);
        }
        const showLast = ordered[metadata.parameters.indexOf("show_last")];
        const count = showLast ? this.constantValue(showLast, scope) : undefined;
        if (typeof count === "number" && (!Number.isInteger(count) || count < 0)) {
          this.error("SCRIPT2117", `Argument 'show_last' for '${name}' requires a nonnegative integer`, showLast?.range);
        }
      }
      argumentNodes = ordered.filter(
        (argument): argument is ExpressionNode => argument !== undefined,
      );
    }
    const fn = this.functions.get(name);
    if (fn) {
      const binding = bindCallArguments({
        callable: name,
        arguments: node.arguments,
        signature: fn.parameters.map((parameter) => parameter.name),
        optionalParameters: fn.parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name),
        range: node.range,
        diagnostics: this.diagnostics,
      });
      this.recordCallBinding(node, binding);
      argumentNodes = binding.ordered.filter((argument): argument is ExpressionNode => argument !== undefined);
    }
    const argumentTypes = argumentNodes.map((argument) => this.infer(argument, scope));
    if (isStrictPineCompatibility(this.compatibility) && name.startsWith("color.")) {
      const expectedKinds = name === "color.new" ? ["color", "float"]
        : name === "color.rgb" ? ["float", "float", "float", "float"]
          : name === "color.from_gradient" ? ["float", "float", "float", "color", "color"]
            : ["color"];
      for (const [index, argumentType] of argumentTypes.entries()) {
        const expectedKind = expectedKinds[index] as "color" | "float" | undefined;
        if (expectedKind !== undefined && !assignable(argumentType, primitive(expectedKind, "series"))) {
          const parameter = metadata?.typedOverloads?.[0]?.parameters[index]?.name ?? metadata?.parameters[index] ?? `argument${String(index)}`;
          this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires series ${expectedKind}, received ${describe(argumentType)}`, argumentNodes[index]?.range);
        }
      }
    }
    if (isStrictPineCompatibility(this.compatibility) && scalarMissingCallNames.has(name)) {
      this.validateScalarMissingArguments(name, argumentNodes, argumentTypes);
      return this.scalarMissingReturnType(name, argumentTypes);
    }
    if (["bool", "color", "float", "int", "string"].includes(name)) return primitive(name as "bool" | "color" | "float" | "int" | "string", argumentTypes[0]?.qualifier ?? "const");
    if (name === "na") return primitive("bool", argumentTypes[0]?.qualifier ?? "const");
    if (name === "color.new" || name === "color.rgb") return primitive("color", strongestOf(argumentTypes));
    if (isStrictPineCompatibility(this.compatibility) && ["color.b", "color.g", "color.r", "color.t"].includes(name)) {
      return primitive("float", strongestOf(argumentTypes));
    }
    if (isStrictPineCompatibility(this.compatibility) && name === "color.from_gradient") return primitive("color", "series");
    if (name === "array.from") {
      this.validateArrayFromArguments(node, argumentNodes, argumentTypes);
      return compound("array", [joinAll(argumentTypes)], "series");
    }
    if (name.startsWith("array.new")) {
      this.validateArrayConstructorArguments(node, name, orderedArgumentNodes, scope);
      return compound("array", [this.constructorElementType(node, name)], "series");
    }
    if (scalarMathCallNames.has(name)) this.validateScalarMathArguments(name, orderedArgumentNodes, scope);
    if (remainingMathCallNames.has(name)) this.validateRemainingMathArguments(name, orderedArgumentNodes, scope);
    if (scalarStringCallNames.has(name)) this.validateScalarStringArguments(name, orderedArgumentNodes, scope);
    if (advancedStringCallNames.has(name)) this.validateAdvancedStringArguments(name, orderedArgumentNodes, scope);
    if (timeComponentFields.has(name)) {
      this.validateArrayConstructorValue(name, "time", orderedArgumentNodes[0], primitive("int", "series"), scope);
      this.validateArrayConstructorValue(name, "timezone", orderedArgumentNodes[1], primitive("string", "series"), scope);
    }
    if (taHistoryCallNames.has(name)) this.validateTaHistoryArguments(name, orderedArgumentNodes, scope);
    if (taAverageCallNames.has(name)) this.validateTaAverageArguments(name, orderedArgumentNodes, scope);
    if (taOscillatorCallNames.has(name)) this.validateTaOscillatorArguments(name, orderedArgumentNodes, scope);
    if (taBandRankCallNames.has(name)) this.validateTaBandRankArguments(name, orderedArgumentNodes, scope);
    if (taVolumeCallNames.has(name)) this.validateTaVolumeArguments(name, orderedArgumentNodes, scope);
    if (taPivotTrendCallNames.has(name)) this.validateTaPivotTrendArguments(name, orderedArgumentNodes, scope);
    if (strategyCoreCallNames.has(name)) this.validateStrategyCoreArguments(name, orderedArgumentNodes, scope);
    if (plotMarkerCallNames.has(name)) this.validatePlotMarkerArguments(name, orderedArgumentNodes, scope);
    if (name === "matrix.new") {
      this.validateMatrixConstructorArguments(node, orderedArgumentNodes, scope);
      return compound("matrix", [this.constructorElementType(node, name)], "series");
    }
    if (isStrictPineCompatibility(this.compatibility) && name.startsWith("matrix.")) {
      const method = name.slice(7);
      if (certifiedMatrixStructuralCallNames.has(method)) {
        this.validateMatrixStructural(method, orderedArgumentNodes[0] ? this.infer(orderedArgumentNodes[0], scope) : unknownType("series"), orderedArgumentNodes.slice(1), scope);
      }
    }
    if (name === "map.new") {
      const typeArguments = node.callee.kind === "member" ? node.callee.typeArguments ?? [] : [];
      const mapType = compound("map", typeArguments.map((value) => this.parseType(value, "series")), "series");
      this.validateMapConstructor(node, mapType);
      return mapType;
    }
    if (["math.ceil", "math.floor"].includes(name)) return primitive("int", strongestOf(argumentTypes));
    if (name === "math.round") return primitive(argumentTypes.length > 1 ? "float" : "int", strongestOf(argumentTypes));
    if (["math.max", "math.min", "math.abs", "math.sign"].includes(name)) {
      return primitive(argumentTypes.some((type) => type.kind === "float") ? "float" : "int", strongestOf(argumentTypes));
    }
    if (name === "math.round_to_mintick") {
      return primitive("float", argumentTypes[0]?.qualifier === "series" ? "series" : "simple");
    }
    if (["time", "time_close"].includes(name)) return primitive("int", "series");
    if (name === "timestamp" && isStrictPineCompatibility(this.compatibility)) {
      if (this.callBindings.get(node)?.signature?.[0] === "dateString") return primitive("int", "const");
      return primitive("int", argumentTypes.some((type) => type.qualifier === "series") ? "series" : "simple");
    }
    if (name === "timeframe.change") return primitive("bool", "series");
    if (name === "ta.change") {
      const source = argumentTypes[0];
      return source && ["bool", "float", "int"].includes(source.kind) ? withQualifier(source, "series") : unknownType("series");
    }
    if (name === "ta.valuewhen") {
      const source = argumentTypes[1];
      return source === undefined ? unknownType("series") : withQualifier(source, "series");
    }
    // runtime.error() never returns normally, so it is compatible with the
    // surrounding expression's expected type (Pine uses it in guards).
    if (name === "runtime.error") return unknownType(strongestOf(argumentTypes));

    if (isStrictPineCompatibility(this.compatibility) && (name === "input" || name.startsWith("input."))) {
      return this.certifiedInputReturnType(
        name,
        orderedArgumentNodes,
        this.callBindings.get(node)?.signature,
        scope,
      );
    }

    if (metadata) {
      if (isStrictPineCompatibility(this.compatibility) && (name === "request.security" || name === "request.security_lower_tf")) {
        for (const index of [0, 1]) {
          const selector = orderedArgumentNodes[index];
          if (!selector) continue;
          const actual = this.infer(selector, scope);
          if (!assignable(actual, primitive("string", "series"))) {
            this.error("SCRIPT2117", `Argument '${index === 0 ? "symbol" : "timeframe"}' for '${name}' requires series string, received ${describe(actual)}`, selector.range);
          }
        }
        const expression = orderedArgumentNodes[2];
        const child = expression ? this.infer(expression, scope) : unknownType("series");
        if (this.version === 5 && name === "request.security" && (child.kind === "bool"
          || (child.kind === "tuple" && child.arguments?.some((member) => member.kind === "bool")))) {
          this.v5RequiresMissingBooleans = true;
        }
        const result = (member: PineQualifiedType): PineQualifiedType => name === "request.security"
          ? withQualifier(member, "series")
          : compound("array", [member], "series");
        return child.kind === "tuple"
          ? compound("tuple", (child.arguments ?? []).map(result), "series")
          : result(child);
      }
      if (isStrictPineCompatibility(this.compatibility) && name.startsWith("matrix.") && matrixM3CallNames.has(name.slice(7))) {
        const receiverNode = orderedArgumentNodes[0];
        return this.matrixM3ReturnType(name.slice(7), receiverNode, orderedArgumentNodes.slice(1), scope);
      }
      if (name.startsWith("array.")) {
        this.validateCertifiedArrayMutationIndexes(name.slice("array.".length), orderedArgumentNodes.slice(1), scope);
      }
      const collection = this.directCollectionReturnType(name, argumentTypes, argumentNodes);
      if (collection) return collection;
      if (typedReturnType?.kind === "tuple") return typedReturnType;
      return this.builtinReturnType(metadata.returnType, argumentTypes);
    }

    if (node.callee.kind === "member") {
      const receiver = this.infer(node.callee.object, scope);
      const methodName = node.callee.property;
      const selection = this.bindMethod(node, methodName, receiver, node.arguments, scope);
      if (selection.type) return selection.type;
      if (selection.ambiguous) return unknownType("series");
      if (isStrictPineCompatibility(this.compatibility) && receiver.kind === "udt" && methodName === "copy") {
        this.recordCallBinding(node, bindCallArguments({
          callable: methodName,
          arguments: node.arguments,
          signature: [],
          range: node.range,
          diagnostics: this.diagnostics,
        }));
        return receiver;
      }
      const collectionCallable = `${receiver.kind}.${node.callee.property}`;
      const collectionMetadata = this.callableMetadata[collectionCallable];
      const collectionArguments = collectionMetadata?.signatureStatus === "complete"
        ? this.bindReceiverArguments(node, collectionCallable, collectionMetadata, scope)
        : { nodes: argumentNodes, types: argumentTypes };
      const receiverBinding = this.callBindings.get(node);
      if (receiver.kind === "array") {
        this.validateCertifiedArrayMutationIndexes(
          node.callee.property,
          receiverBinding?.ordered ?? node.arguments.map((argument) => argument.value),
          scope,
        );
      }
      this.validateSort(
        collectionCallable,
        receiver,
        receiverBinding?.ordered[collectionCallable === "matrix.sort" ? 1 : 0],
        receiverBinding?.ordered[collectionCallable === "matrix.sort" ? 2 : 1],
        node,
        scope,
      );
      if (isStrictPineCompatibility(this.compatibility) && receiver.kind === "matrix"
        && matrixM3CallNames.has(node.callee.property)) {
        return this.matrixM3ReturnType(node.callee.property, node.callee.object, receiverBinding?.ordered ?? node.arguments.map((argument) => argument.value), scope);
      }
      if (isStrictPineCompatibility(this.compatibility) && certifiedMatrixStructuralCallNames.has(node.callee.property)) {
        this.validateMatrixStructural(node.callee.property, receiver, receiverBinding?.ordered ?? node.arguments.map((argument) => argument.value), scope);
      }
      const collectionResult = this.collectionMethodType(receiver, node.callee.property, collectionArguments.types, collectionArguments.nodes);
      if (collectionResult) {
        this.recordMethodCandidate(node, undefined);
        return collectionResult;
      }
      if (receiver.kind === "reference" && receiver.name) {
        const receiverCallable = `${receiver.name}.${node.callee.property}`;
        const receiverMetadata = this.callableMetadata[receiverCallable];
        if (receiverMetadata) {
          this.recordMethodCandidate(node, undefined);
          const receiverArguments = this.bindReceiverArguments(node, receiverCallable, receiverMetadata, scope);
          if (isStrictPineCompatibility(this.compatibility) &&
            (isCertifiedLineMethod(receiverCallable) || certifiedFillPolylineCalls.has(receiverCallable) || isCertifiedBoxMethod(receiverCallable)
              || isCertifiedLabelMethod(receiverCallable) || isCertifiedTableCall(receiverCallable)
              || receiverCallable === "chart.point.copy")) {
            const parameters = receiverMetadata.typedOverloads?.[0]?.parameters.slice(1) ?? [];
            if (!isCertifiedTableCall(receiverCallable)) {
              for (const [index, argument] of receiverArguments.nodes.entries()) {
                const parameter = parameters[index];
                if (parameter && !(["box.set_text_size", "label.set_size"].includes(receiverCallable) && parameter.name === "size")
                  && !assignable(receiverArguments.types[index]!, parameter.type)) {
                  this.error("SCRIPT2117", `Argument '${parameter.name}' for '${receiverCallable}' requires ${describe(parameter.type)}, received ${describe(receiverArguments.types[index]!)}`, argument.range);
                }
              }
            } else {
              const ordered = this.callBindings.get(node)?.ordered ?? [];
              for (const [index, argument] of ordered.entries()) {
                const parameter = parameters[index];
                if (!argument || !parameter || parameter.name === "text_size") continue;
                const actual = this.infer(argument, scope);
                if (!assignable(actual, parameter.type)) {
                  this.error("SCRIPT2117", `Argument '${parameter.name}' for '${receiverCallable}' requires ${describe(parameter.type)}, received ${describe(actual)}`, argument.range);
                }
              }
              this.validateTableTextSize(receiverCallable, ordered[receiverMetadata.parameters.indexOf("text_size") - 1], scope);
            }
            if (receiverCallable === "box.set_text_size") this.validateBoxTextSize(receiverCallable, receiverArguments.nodes[0], scope);
            if (receiverCallable === "table.set_position") {
              const position = receiverArguments.nodes[0];
              const choices = position && this.plotEnumValues(position, scope);
              if (position && choices && !choices.every((choice) => choice.startsWith("position.") && builtinConstantNames.has(choice))) {
                this.error("SCRIPT2117", `Argument 'position' for '${receiverCallable}' requires a position constant`, position.range);
              }
            }
            if (["line.set_style", "line.set_extend", "line.set_xloc", "box.set_border_style", "box.set_extend", "box.set_xloc"].includes(receiverCallable)) {
              let parameter = "style";
              let allowed: readonly string[] = lineStyleChoices;
              let argumentIndex = 0;
              if (receiverCallable === "box.set_border_style") { parameter = "border_style"; allowed = lineStyleChoices.slice(0, 3); }
              if (receiverCallable === "line.set_extend" || receiverCallable === "box.set_extend") {
                parameter = "extend";
                allowed = lineExtendChoices;
              } else if (receiverCallable === "line.set_xloc" || receiverCallable === "box.set_xloc") {
                parameter = "xloc";
                allowed = ["xloc.bar_index", "xloc.bar_time"];
                argumentIndex = 2;
              }
              const argument = receiverArguments.nodes[argumentIndex];
              const choices = argument && this.plotEnumValues(argument, scope);
              if (argument && !choices?.every((choice) => allowed.includes(choice))) {
                this.error("SCRIPT2117", `Argument '${parameter}' for '${receiverCallable}' requires a ${parameter} constant`, argument.range);
              }
            }
            if (isCertifiedLabelMethod(receiverCallable)) {
              if (receiverCallable === "label.set_size") {
                this.validateLabelSize(receiverCallable, receiverArguments.nodes[0], scope);
              }
              for (const [parameter, allowed] of Object.entries(labelOptions)) {
                if (receiverCallable !== `label.set_${parameter}`) continue;
                const argument = receiverArguments.nodes[parameter === "xloc" ? 1 : 0];
                if (argument) this.validateLabelOption(receiverCallable, parameter, argument, allowed, scope);
              }
            }
          }
          return this.builtinReturnType(receiverMetadata.returnType, [receiver, ...receiverArguments.types]);
        }
      }
      if (isStrictPineCompatibility(this.compatibility) &&
        certifiedLineMethods.has(node.callee.property) && receiver.kind !== "unknown") {
        this.error("SCRIPT2117", `Method '${node.callee.property}' requires a line receiver`, node.callee.object.range);
      }
      if (isStrictPineCompatibility(this.compatibility) &&
        certifiedLabelMethods.has(node.callee.property) && receiver.kind !== "unknown") {
        this.error("SCRIPT2117", `Method '${node.callee.property}' requires a label receiver`, node.callee.object.range);
      }
      if (node.callee.property === "new" && node.callee.object.kind === "identifier") {
        const type = this.udts.get(node.callee.object.name);
        if (type) {
          const binding = bindCallArguments({
            callable: `${type.name}.new`,
            arguments: node.arguments,
            signature: type.fields.map((field) => field.name),
            optionalParameters: type.fields
              .filter((field) => isStrictPineCompatibility(this.compatibility) || field.defaultValue !== undefined)
              .map((field) => field.name),
            range: node.range,
            diagnostics: this.diagnostics,
          });
          this.recordCallBinding(node, binding);
          for (const [index, field] of type.fields.entries()) {
            const value = binding.ordered[index] ?? field.defaultValue;
            if (!value) continue;
            const actual = this.infer(value, scope);
            const expected = this.parseType(field.dataType, "series");
            if (!assignable(actual, expected)) {
              this.error("SCRIPT2118", `Field '${field.name}' for '${type.name}.new' requires ${describe(expected)}, received ${describe(actual)}`, value.range);
            }
          }
          return named("udt", type.name, "series");
        }
      }
      if (selection.hasReceiver) {
        this.error("SCRIPT2014", `No matching overload for method '${node.callee.property}'`, node.range);
        return unknownType("series");
      }
    }

    if (!fn && node.callee.kind === "identifier" && this.methods.has(name) && node.arguments[0]) {
      const receiver = this.infer(node.arguments[0].value, scope);
      const selection = this.bindMethod(node, name, receiver, node.arguments.slice(1), scope);
      if (selection.type) return selection.type;
      if (selection.ambiguous) return unknownType("series");
      this.error("SCRIPT2014", `No matching overload for method '${name}'`, node.range);
      return unknownType("series");
    }

    if (fn) return this.bindCallable(fn, argumentTypes);
    if (!this.knownCallables.has(name)) {
      const root = node.callee.kind === "member" ? rootIdentifier(node.callee) : undefined;
      this.error("SCRIPT2015", root && namespaceLike(root) ? `Unknown namespace callable '${name}'` : `Unknown callable '${name}'`, node.range);
    }
    return unknownType(strongestOf(argumentTypes));
  }

  private bindMethod(node: CallNode, name: string, receiver: PineQualifiedType, args: readonly CallArgumentNode[], scope: BindingScope): { type?: PineQualifiedType; ambiguous: boolean; hasReceiver: boolean } {
    const receiverMethods = (this.methods.get(name) ?? []).filter((method) => {
      const declared = method.parameters[0]?.dataType;
      return declared !== undefined && sameValueType(this.parseType(declared, "series"), receiver);
    });
    const candidates = receiverMethods.flatMap((method) => {
      const diagnostics: Diagnostic[] = [];
      const parameters = method.parameters.slice(1);
      const binding = bindCallArguments({
        callable: name,
        arguments: args,
        signature: parameters.map((parameter) => parameter.name),
        optionalParameters: parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => parameter.name),
        range: node.range,
        diagnostics,
      });
      if (diagnostics.length > 0) return [];
      let score = 0;
      for (const [index, argument] of binding.ordered.entries()) {
        if (!argument) continue;
        const actual = this.infer(argument, scope);
        const expected = this.parameterType(parameters[index]!);
        if (!assignable(actual, expected)) return [];
        if (sameValueType(actual, expected)) score += 8;
        score += 3 - (qualifierRank[expected.qualifier] - qualifierRank[actual.qualifier]);
      }
      return [{ method, binding, score }];
    });
    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0];
    if (selected && (candidates.length === 1 || selected.score > candidates[1]!.score)) {
      this.methodBindings.set(node, selected.method);
      this.recordMethodCandidate(node, selected.method);
      this.recordCallBinding(node, selected.binding);
      const methodArguments = selected.binding.ordered.filter((argument): argument is ExpressionNode => argument !== undefined);
      return { type: this.bindCallable(selected.method, [receiver, ...methodArguments.map((argument) => this.infer(argument, scope))]), ambiguous: false, hasReceiver: true };
    }
    if (selected) this.error("SCRIPT2018", `Ambiguous method overload '${name}'`, node.range);
    return { ambiguous: selected !== undefined, hasReceiver: receiverMethods.length > 0 };
  }

  private recordMethodCandidate(node: CallNode, method: MethodDeclarationNode | undefined): void {
    const candidates = this.methodCandidates.get(node) ?? new Set<MethodDeclarationNode | undefined>();
    candidates.add(method);
    this.methodCandidates.set(node, candidates);
    const key = `${node.range.start.offset}:${node.range.end.offset}`;
    const byRange = this.methodCandidatesByRange.get(key) ?? new Set<MethodDeclarationNode | undefined>();
    byRange.add(method);
    this.methodCandidatesByRange.set(key, byRange);
  }

  private recordCallBinding(node: CallNode, binding: CallArgumentBinding): void {
    this.callBindings.set(node, binding);
    this.callBindingsByRange.set(`${node.range.start.offset}:${node.range.end.offset}`, binding);
  }

  private validateSort(
    name: string,
    collection: PineQualifiedType,
    order: ExpressionNode | undefined,
    selector: ExpressionNode | undefined,
    call: CallNode,
    scope: BindingScope,
  ): void {
    if (!["array.sort", "array.sort_indices", "matrix.sort"].includes(name)) return;
    if (order) {
      const orderType = this.infer(order, scope);
      if (orderType.qualifier !== "const" || orderType.kind !== "int") {
        this.error("SCRIPT2122", "order requires a const order.ascending or order.descending value", order.range);
      }
    }
    if (selector) {
      const type = this.infer(selector, scope);
      if (type.qualifier !== "const" || !["int", "string"].includes(type.kind)) {
        this.error("SCRIPT2122", "sort_field requires a const int or string", selector.range);
        return;
      }
    }
    const element = collection.arguments?.[0];
    if (!element || element.kind === "unknown") return;
    if (element.kind !== "udt") {
      if (!["int", "float", "string"].includes(element.kind)) this.error("SCRIPT2122", "Sorting requires int, float, string, or UDT elements", call.range);
      return;
    }
    const fields = this.udts.get(element.name ?? "")?.fields;
    if (!fields) return;
    const selected = selector ? this.constantValue(selector, scope) : 0;
    if (selected === undefined) {
      this.error("SCRIPT2122", "This constant sort_field expression cannot be resolved yet", selector?.range);
      return;
    }
    const field = typeof selected === "string" ? fields.find((item) => item.name === selected)
      : typeof selected === "number" && Number.isInteger(selected) ? fields[selected] : undefined;
    if (!field) this.error("SCRIPT2122", `Unknown sort_field '${String(selected)}' for '${element.name ?? "UDT"}'`, selector?.range ?? call.range);
    else if (!["int", "float", "string"].includes(field.dataType)) this.error("SCRIPT2122", "sort_field must select an int, float, or string field", selector?.range ?? call.range);
  }

  private constantValue(node: ExpressionNode, scope: BindingScope): string | number | boolean | undefined {
    return evaluateConstant(node, {
      identifier: (name) => lookup(scope, name)?.constantValue,
      member: (member) => member.kind === "member" && this.knownVariables.has(memberName(member))
        && this.infer(member, scope).qualifier === "const" ? member.property : undefined,
      arguments: (call) => this.callBindings.get(call)?.ordered ?? [],
      integerDivision: (expression) => this.version === 5 && this.infer(expression, scope).kind === "int",
    });
  }

  private validateTableTextSize(name: string, node: ExpressionNode | undefined, scope: BindingScope): void {
    if (!node) return;
    const actual = this.infer(node, scope);
    if (actual.kind !== "int" && actual.kind !== "string" && actual.kind !== "unknown") {
      this.error("SCRIPT2117", `Argument 'text_size' for '${name}' requires a size string or integer, received ${describe(actual)}`, node.range);
      return;
    }
    const choices = this.plotEnumValues(node, scope);
    if (choices && !choices.every((choice) => choice.startsWith("size.") && tableTextSizes.has(choice.slice(5)))) {
      this.error("SCRIPT2117", `Argument 'text_size' for '${name}' requires a supported size value`, node.range);
      return;
    }
    const value = this.constantValue(node, scope);
    if (typeof value === "string" && !tableTextSizes.has(value.replace(/^size\./u, ""))) {
      this.error("SCRIPT2117", `Argument 'text_size' for '${name}' requires a supported size value`, node.range);
    }
    if (typeof value === "number" && (!Number.isInteger(value) || value < 0)) {
      this.error("SCRIPT2117", `Argument 'text_size' for '${name}' requires a nonnegative integer`, node.range);
    }
  }

  private validateBoxTextSize(name: string, node: ExpressionNode | undefined, scope: BindingScope): void {
    if (!node) return;
    const parameter = name === "box.new" ? "text_size" : "size";
    const actual = this.infer(node, scope);
    if (actual.kind !== "int" && actual.kind !== "string") {
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a size string or integer, received ${describe(actual)}`, node.range);
      return;
    }
    const choices = this.plotEnumValues(node, scope);
    if (choices && !choices.every((choice) => choice.startsWith("size.") && tableTextSizes.has(choice.slice(5)))) {
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a supported size value`, node.range);
      return;
    }
    const value = this.constantValue(node, scope);
    if (typeof value === "string" && !tableTextSizes.has(value.replace(/^size\./u, ""))) {
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a supported size value`, node.range);
    }
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0 || value > 100)) {
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires an integer from 0 to 100`, node.range);
    }
  }

  private validateLabelSize(name: string, node: ExpressionNode | undefined, scope: BindingScope): void {
    if (!node) return;
    const actual = this.infer(node, scope);
    if (actual.kind === "int") {
      const value = this.constantValue(node, scope);
      if (typeof value === "number" && (!Number.isInteger(value) || value < 0 || value > 100)) {
        this.error("SCRIPT2117", `Argument 'size' for '${name}' requires an integer from 0 to 100`, node.range);
      }
      return;
    }
    if (actual.kind !== "string") {
      this.error("SCRIPT2117", `Argument 'size' for '${name}' requires a size constant or integer from 0 to 100`, node.range);
      return;
    }
    this.validateLabelOption(name, "size", node,
      ["size.auto", "size.tiny", "size.small", "size.normal", "size.large", "size.huge"], scope);
  }

  private validateLabelOption(name: string, parameter: string, node: ExpressionNode,
    allowed: readonly string[], scope: BindingScope): void {
    const choices = this.plotEnumValues(node, scope);
    const literal = this.constantValue(node, scope);
    if (choices?.every((choice) => allowed.includes(choice)) || (choices === undefined && literal === undefined)) return;
    this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a ${parameter} constant`, node.range);
  }

  private plotEnumValues(node: ExpressionNode, scope: BindingScope): readonly string[] | undefined {
    if (node.kind === "member" && node.object.kind === "identifier" && (node.object.name === "hline" || lookup(scope, node.object.name) === undefined)
      && namespaceLike(node.object.name)) return [memberName(node)];
    if (node.kind === "identifier") return lookup(scope, node.name)?.plotEnumValues;
    if (node.kind === "conditional") {
      const consequent = this.plotEnumValues(node.consequent, scope);
      const alternate = this.plotEnumValues(node.alternate, scope);
      return consequent && alternate ? [...new Set([...consequent, ...alternate])] : undefined;
    }
    if (node.kind === "if_expression" || node.kind === "switch") return this.plotEnumExpressionValues.get(node);
    return undefined;
  }

  private plotEnumBranchValues(body: readonly StatementNode[], scope: BindingScope): readonly string[] | undefined {
    const last = body.at(-1);
    if (last?.kind === "expression") return this.plotEnumValues(last.expression, scope);
    if (last?.kind === "declaration" || last?.kind === "assignment") return lookup(scope, last.name)?.plotEnumValues;
    return undefined;
  }

  private recordPlotEnumBranches(node: ExpressionNode, branches: readonly (readonly string[] | undefined)[]): void {
    if (branches.every((branch): branch is readonly string[] => branch !== undefined)) {
      this.plotEnumExpressionValues.set(node, [...new Set(branches.flat())]);
    } else {
      this.plotEnumExpressionValues.delete(node);
    }
  }

  private isOhlcFormatExpression(node: ExpressionNode, scope: BindingScope): boolean {
    const choices = this.plotEnumValues(node, scope);
    return choices !== undefined && choices.every((value) =>
      ["format.inherit", "format.price", "format.percent", "format.volume"].includes(value));
  }

  private bindReceiverArguments(
    node: CallNode,
    callable: string,
    metadata: PineCallableDefinition,
    scope: BindingScope,
  ): { readonly nodes: readonly ExpressionNode[]; readonly types: readonly PineQualifiedType[] } {
    const signatures = metadata.overloads?.map((signature) => signature.slice(1));
    const signature = metadata.parameters.slice(1);
    const binding = bindCallArguments({
      callable,
      arguments: node.arguments,
      signature,
      optionalParameters: (metadata.optionalParameters ?? []).filter((parameter) => signature.includes(parameter)),
      ...(signatures === undefined ? {} : { overloads: signatures }),
      range: node.range,
      diagnostics: this.diagnostics,
    });
    this.recordCallBinding(node, binding);
    const nodes = binding.ordered.filter((argument): argument is ExpressionNode => argument !== undefined);
    return { nodes, types: nodes.map((argument) => this.infer(argument, scope)) };
  }

  private inferMember(node: Extract<ExpressionNode, { kind: "member" }>, scope: BindingScope): PineQualifiedType {
    const name = memberName(node);
    const root = rootIdentifier(node);
    if (isStrictPineCompatibility(this.compatibility) && name === "table.all" && root === "table" && lookup(scope, root) === undefined) {
      return compound("array", [named("reference", "table", "series")], "series");
    }
    if (node.object.kind === "identifier" && this.enums.has(node.object.name)) return named("enum", node.object.name, "const");
    if (taFloatVariableNames.has(name)) return primitive("float", "series");
    if (isPineShadowingNamespaceConstant(name)) return builtinVariableType(name, this.compatibility);
    if (root && lookup(scope, root) !== undefined) {
      const object = this.infer(node.object, scope);
      return this.memberType(object, node.property, node.range);
    }
    if (this.knownVariables.has(name)) {
      if (isStrictPineCompatibility(this.compatibility) && name === "line.all") return compound("array", [named("reference", "line", "series")], "series");
      if (isStrictPineCompatibility(this.compatibility) && name === "linefill.all") return compound("array", [named("reference", "linefill", "series")], "series");
      if (isStrictPineCompatibility(this.compatibility) && name === "polyline.all") return compound("array", [named("reference", "polyline", "series")], "series");
      if (isStrictPineCompatibility(this.compatibility) && name === "box.all") return compound("array", [named("reference", "box", "series")], "series");
      if (isStrictPineCompatibility(this.compatibility) && name === "label.all") return compound("array", [named("reference", "label", "series")], "series");
      return builtinVariableType(name, this.compatibility);
    }
    if (["strategy.commission.", "strategy.direction.", "strategy.oca."].some((prefix) => name.startsWith(prefix))) {
      this.error("SCRIPT2015", `Unknown namespace variable '${name}'`, node.range);
      return unknownType("series");
    }
    if (name === "ta.tr") return primitive("float", "series");
    if (root && ["barstate", "syminfo", "timeframe"].includes(root)) {
      this.error("SCRIPT2015", `Unknown namespace variable '${name}'`, node.range);
      return unknownType("series");
    }
    if (root && namespaceLike(root)) return primitive(namespaceValueKind(root), namespaceQualifier(root));
    const object = this.infer(node.object, scope);
    return this.memberType(object, node.property, node.range);
  }

  private memberType(object: PineQualifiedType, property: string, range?: Diagnostic["range"]): PineQualifiedType {
    if (object.kind === "udt" && object.name) {
      const field = this.udts.get(object.name)?.fields.find((candidate) => candidate.name === property);
      if (field) return withQualifier(this.parseType(field.dataType, "series"), "series");
      this.error("SCRIPT2119", `Type '${object.name}' has no field '${property}'`, range);
      return unknownType("series");
    }
    if (object.kind === "reference" && object.name === "chart.point") {
      if (property === "price") return primitive("float", "series");
      if (property === "index" || property === "time") return primitive("int", "series");
    }
    return unknownType(object.qualifier);
  }

  private collectionMethodType(receiver: PineQualifiedType, method: string, arguments_: readonly PineQualifiedType[], argumentNodes: readonly ExpressionNode[]): PineQualifiedType | undefined {
    if (!["array", "matrix", "map"].includes(receiver.kind)) return undefined;
    const key = receiver.arguments?.[0] ?? unknownType("series");
    const value = receiver.arguments?.at(-1) ?? unknownType("series");
    const requireArgument = (argument: PineQualifiedType | undefined, expected: PineQualifiedType, index: number): void => {
      if (argument && !assignable(argument, withQualifier(expected, "series"))) {
        this.error("SCRIPT2111", `Collection expects ${describe(expected)}, received ${describe(argument)}`, argumentNodes[index]?.range);
      }
    };

    if (receiver.kind === "map") {
      if (["get", "remove"].includes(method)) {
        requireArgument(arguments_[0], key, 0);
        return withQualifier(value, "series");
      }
      if (method === "contains") {
        requireArgument(arguments_[0], key, 0);
        return primitive("bool", "series");
      }
      if (method === "put") {
        requireArgument(arguments_[0], key, 0);
        requireArgument(arguments_[1], value, 1);
        // The previous value for the key, or na when the key is new.
        return withQualifier(value, "series");
      }
      if (method === "put_all") {
        requireArgument(arguments_[0], receiver, 0);
        return voidType();
      }
      if (method === "keys") return compound("array", [key], "series");
      if (method === "values") return compound("array", [value], "series");
      if (method === "copy") return receiver;
      if (method === "size") return primitive("int", "series");
      if (method === "clear") return voidType();
      return unknownType("series");
    }

    if (receiver.kind === "matrix") {
      if (isStrictPineCompatibility(this.compatibility) && certifiedMatrixInversePowerCallNames.has(method)) {
        if (value.kind !== "int" && value.kind !== "float") {
          this.error("SCRIPT2122", `matrix.${method} requires int or float matrix elements, received ${describe(value)}`, argumentNodes[0]?.range);
        }
        if (method === "pow") requireArgument(arguments_[0], primitive("int", "series"), 0);
        return receiver;
      }
      if (isStrictPineCompatibility(this.compatibility) && certifiedMatrixLinearAlgebraCallNames.has(method)) {
        if (value.kind !== "int" && value.kind !== "float") {
          this.error("SCRIPT2122", `matrix.${method} requires int or float matrix elements, received ${describe(value)}`, argumentNodes[0]?.range);
        }
        if (method === "det") return primitive("float", "series");
        return primitive("int", "series");
      }
      if (isStrictPineCompatibility(this.compatibility) && certifiedMatrixNumericCallNames.has(method)) {
        if (value.kind !== "int" && value.kind !== "float") {
          this.error("SCRIPT2122", `matrix.${method} requires int or float matrix elements, received ${describe(value)}`, argumentNodes[0]?.range);
        }
        return withQualifier(value, "series");
      }
      if (isStrictPineCompatibility(this.compatibility) && certifiedMatrixPredicateCallNames.has(method)) {
        if (method !== "is_square" && !["int", "float"].includes(value.kind)) {
          this.error("SCRIPT2122", `matrix.${method} requires int or float matrix elements, received ${describe(value)}`, argumentNodes[0]?.range);
        }
        return primitive("bool", "series");
      }
      const requireIndex = (index: number): void => requireArgument(arguments_[index], primitive("int", "series"), index);
      if (method === "get") {
        requireIndex(0);
        requireIndex(1);
        return withQualifier(value, "series");
      }
      if (["row", "col"].includes(method)) {
        requireIndex(0);
        return compound("array", [value], "series");
      }
      if (["copy", "submatrix"].includes(method)) {
        if (method === "submatrix") for (let index = 0; index < arguments_.length; index += 1) requireIndex(index);
        return receiver;
      }
      if (["rows", "columns", "elements_count"].includes(method)) return primitive("int", "series");
      if (method === "set") {
        requireIndex(0);
        requireIndex(1);
        requireArgument(arguments_.at(-1), value, arguments_.length - 1);
        return voidType();
      }
      if (["add_row", "add_col"].includes(method)) {
        return voidType();
      }
      if (["remove_row", "remove_col"].includes(method)) return compound("array", [value], "series");
      if (method === "transpose") return receiver;
      if (isStrictPineCompatibility(this.compatibility) && ["sum", "diff", "mult"].includes(method)) {
        const operand = arguments_[0];
        const resultElement = operand?.kind === "float" || operand?.arguments?.[0]?.kind === "float"
          ? primitive("float", "series") : value;
        return compound(method === "mult" && operand?.kind === "array" ? "array" : "matrix", [resultElement], "series");
      }
      if (isStrictPineCompatibility(this.compatibility) && method === "kron" && arguments_[0]?.kind === "matrix"
        && (value.kind === "int" || value.kind === "float")) {
        const other = arguments_[0].arguments?.[0];
        if (other?.kind === "int" || other?.kind === "float") {
          return compound("matrix", [primitive(value.kind === "float" || other.kind === "float" ? "float" : "int", "series")], "series");
        }
      }
      if (["fill", "reshape", "reverse", "swap_columns", "swap_rows"].includes(method)) {
        if (method === "fill") {
          requireArgument(arguments_[0], value, 0);
          for (let index = 1; index < arguments_.length; index += 1) requireIndex(index);
        }
        return voidType();
      }
      return unknownType("series");
    }

    if (isStrictPineCompatibility(this.compatibility) && certifiedArrayNumericCallNames.has(method)) {
      return this.certifiedArrayNumericReturnType(receiver, method, arguments_, argumentNodes);
    }

    if (["get", "first", "last", "max", "min", "avg", "median", "mode", "percentile_linear_interpolation", "percentile_nearest_rank"].includes(method)) return withQualifier(value, "series");
    if (arrayEqualitySearchCallNames.has(method)) requireArgument(arguments_[0], value, 0);
    if (arrayBinarySearchCallNames.has(method)) {
      if (!["int", "float", "unknown"].includes(value.kind)) {
        this.error("SCRIPT2122", "Binary search requires int or float array elements", argumentNodes[0]?.range);
      }
      requireArgument(arguments_[0], value, 0);
    }
    if (["every", "some"].includes(method) && !["bool", "int", "float", "unknown"].includes(value.kind)) {
      this.error("SCRIPT2122", `array.${method} requires bool, int, or float elements`, argumentNodes[0]?.range);
    }
    if (method === "join") {
      if (!["int", "float", "string", "unknown"].includes(value.kind)) {
        this.error("SCRIPT2122", "array.join requires int, float, or string elements", argumentNodes[0]?.range);
      }
      const separator = arguments_[0];
      if (separator && !assignable(separator, primitive("string", "series"))) {
        this.error("SCRIPT2117", `Argument 'separator' for 'array.join' requires series string, received ${describe(separator)}`, argumentNodes[0]?.range);
      }
    }
    if (["size", "binary_search", "binary_search_leftmost", "binary_search_rightmost", "indexof", "lastindexof"].includes(method)) return primitive("int", "series");
    if (method === "includes") return primitive("bool", "series");
    if (["every", "some"].includes(method)) return primitive("bool", "series");
    if (method === "join") return primitive("string", "series");
    if (["copy", "slice"].includes(method)) return receiver;
    if (method === "concat") {
      const source = arguments_[0];
      if (source?.kind !== "array") {
        this.error("SCRIPT2117", `Argument 'id2' for 'array.concat' requires series array, received ${describe(source ?? unknownType("series"))}`, argumentNodes[0]?.range);
      } else if (!sameValueType(source, receiver)) {
        this.error("SCRIPT2111", `Collection expects ${describe(receiver)}, received ${describe(source)}`, argumentNodes[0]?.range);
      }
      return receiver;
    }
    if (method === "sort_indices") return compound("array", [primitive("int", "series")], "series");
    if (["remove", "pop", "shift"].includes(method)) return withQualifier(value, "series");
    if (["set", "insert"].includes(method)) requireArgument(arguments_.at(-1), value, arguments_.length - 1);
    else if (["push", "unshift", "fill"].includes(method)) requireArgument(arguments_[0], value, 0);
    if (["set", "push", "unshift", "insert", "clear", "fill", "sort", "reverse", "swap"].includes(method)) return voidType();
    return unknownType("series");
  }

  private certifiedArrayNumericReturnType(
    receiver: PineQualifiedType,
    method: string,
    arguments_: readonly PineQualifiedType[],
    argumentNodes: readonly ExpressionNode[],
  ): PineQualifiedType {
    const element = receiver.arguments?.[0] ?? unknownType("series");
    if (!["int", "float", "unknown"].includes(element.kind)) {
      this.error("SCRIPT2122", `array.${method} requires int or float array elements`, argumentNodes[0]?.range);
    }
    const validateBias = (bias: PineQualifiedType | undefined, index: number): void => {
      if (bias && !assignable(bias, primitive("bool", "series"))) {
        this.error(
          "SCRIPT2117",
          `Argument 'biased' for 'array.${method}' requires series bool, received ${describe(bias)}`,
          argumentNodes[index]?.range,
        );
      }
    };
    if (method === "covariance") {
      const right = arguments_[0];
      if (right?.kind !== "array") {
        this.error(
          "SCRIPT2117",
          `Argument 'id2' for 'array.covariance' requires series array, received ${describe(right ?? unknownType("series"))}`,
          argumentNodes[0]?.range,
        );
      } else {
        const rightElement = right.arguments?.[0] ?? unknownType("series");
        if (!["int", "float", "unknown"].includes(rightElement.kind)) {
          this.error("SCRIPT2122", "array.covariance requires int or float array elements", argumentNodes[0]?.range);
        }
      }
      validateBias(arguments_[1], 1);
    } else if (["stdev", "variance"].includes(method)) {
      validateBias(arguments_[0], 0);
    }
    if (["percentile_linear_interpolation", "percentile_nearest_rank"].includes(method)) {
      const percentage = arguments_[0];
      if (percentage && !assignable(percentage, primitive("float", "series"))) {
        this.error(
          "SCRIPT2117",
          `Argument 'percentage' for 'array.${method}' requires series float, received ${describe(percentage)}`,
          argumentNodes[0]?.range,
        );
      }
    }
    if (method === "max" || method === "min") {
      const nth = arguments_[0];
      if (nth && !assignable(nth, primitive("int", "series"))) {
        this.error(
          "SCRIPT2117",
          `Argument 'nth' for 'array.${method}' requires series int, received ${describe(nth)}`,
          argumentNodes[0]?.range,
        );
      }
    }
    if (method === "percentrank") {
      const index = arguments_[0];
      if (index && !assignable(index, primitive("int", "series"))) {
        this.error(
          "SCRIPT2117",
          `Argument 'index' for 'array.percentrank' requires series int, received ${describe(index)}`,
          argumentNodes[0]?.range,
        );
      }
    }
    if (method === "abs") return receiver;
    if (method === "standardize") return compound("array", [primitive("float", "series")], "series");
    if (["avg", "covariance", "median", "percentile_linear_interpolation", "percentrank", "stdev", "variance"].includes(method)) {
      return primitive("float", "series");
    }
    return withQualifier(element, "series");
  }

  private validateCertifiedArrayMutationIndexes(
    method: string,
    argumentNodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const indexPositions = method === "fill" ? [1, 2]
      : method === "slice" ? [0, 1]
      : ["insert", "remove"].includes(method) ? [0]
      : [];
    for (const indexPosition of indexPositions) {
      const node = argumentNodes[indexPosition];
      if (!node) continue;
      const index = this.infer(node, scope);
      if (!assignable(index, primitive("int", "series"))) {
        this.error("SCRIPT2117", `Argument index for 'array.${method}' requires series int, received ${describe(index)}`, node.range);
      }
    }
  }

  private bindForInVariables(scope: BindingScope, variables: readonly string[], collection: PineQualifiedType, origin: ExpressionNode): void {
    this.hasMapIteration ||= collection.kind === "map";
    const rawElement = collection.arguments?.at(-1) ?? unknownType("series");
    const element = collection.kind === "matrix" ? compound("array", [rawElement], "series") : rawElement;
    if (variables.length === 1) {
      const item = collection.kind === "map"
        ? compound("tuple", [collection.arguments?.[0] ?? unknownType("series"), element], "series")
        : element;
      scope.symbols.set(variables[0]!, { type: withQualifier(item, "series"), explicitQualifier: true, immutable: true, origin });
      return;
    }
    const iterationKey = collection.kind === "map"
      ? collection.arguments?.[0] ?? unknownType("series")
      : primitive("int", "series");
    scope.symbols.set(variables[0]!, { type: withQualifier(iterationKey, "series"), explicitQualifier: true, immutable: true, origin });
    scope.symbols.set(variables[1]!, { type: withQualifier(element, "series"), explicitQualifier: true, immutable: true, origin });
  }

  private bindCallable(callable: FunctionDeclarationNode | MethodDeclarationNode, argumentTypes: readonly PineQualifiedType[]): PineQualifiedType {
    const key = `${callable.kind}:${callable.name}:${argumentTypes.map(describe).join(",")}`;
    if (this.activeCalls.has(key)) {
      this.error("SCRIPT2112", `Recursive callable '${callable.name}' is not supported`, callable.range);
      return unknownType("series");
    }
    this.activeCalls.add(key);
    this.callableDepth += 1;
    const scope = childScope(this.root);
    const simpleParameters = callable.exported ? this.exportedSimpleParameters(callable) : new Set<string>();
    for (const [index, parameter] of callable.parameters.entries()) {
      const argument = argumentTypes[index];
      const qualifier = parameter.qualifier ?? (callable.exported ? simpleParameters.has(parameter.name) ? "simple" : "series" : argument?.qualifier ?? "series");
      const target = parameter.dataType === undefined
        ? argument ?? unknownType("series")
        : this.parseType(parameter.dataType, qualifier);
      const parameterType = parameter.qualifier ? withQualifier(target, parameter.qualifier) : target;
      if (argument && !assignable(argument, parameterType)) {
        this.error("SCRIPT2113", `Argument for '${parameter.name}' requires ${describe(parameterType)}, received ${describe(argument)}`, parameter.range);
      }
      scope.symbols.set(parameter.name, { type: parameterType, explicitQualifier: parameter.qualifier !== undefined, immutable: true, origin: parameter });
      if (parameter.defaultValue) {
        const defaultType = this.infer(parameter.defaultValue, this.root);
        if (!assignable(defaultType, parameterType)) this.error("SCRIPT2114", `Default value for '${parameter.name}' is ${describe(defaultType)}, expected ${describe(parameterType)}`, parameter.defaultValue.range);
      }
    }
    const result = this.bindStatements(callable.body, scope);
    this.callableDepth -= 1;
    this.activeCalls.delete(key);
    return callable.exported && scalarKinds.has(result.kind) && qualifierRank[result.qualifier] < qualifierRank.simple
      ? withQualifier(result, "simple")
      : result;
  }

  private exportedSimpleParameters(callable: FunctionDeclarationNode | MethodDeclarationNode): Set<string> {
    const names = new Set(callable.parameters.filter((parameter) => parameter.qualifier === undefined).map((parameter) => parameter.name));
    const simple = new Set<string>();
    for (const call of collectCallNodes({ version: this.version, statements: [callable] })) {
      if (callableName(call.callee) !== "ta.ema") continue;
      const length = call.arguments.find((argument) => argument.name === "length")
        ?? call.arguments.filter((argument) => argument.name === undefined)[1];
      if (length?.value.kind === "identifier" && names.has(length.value.name)) simple.add(length.value.name);
    }
    return simple;
  }

  private declarationParameterTypes(callable: FunctionDeclarationNode | MethodDeclarationNode): PineQualifiedType[] {
    const inferredSimple = callable.exported ? this.exportedSimpleParameters(callable) : new Set<string>();
    return callable.parameters.map((parameter) => inferredSimple.has(parameter.name)
      ? withQualifier(this.parameterType(parameter), "simple")
      : this.parameterType(parameter));
  }

  private builtinReturnType(returnType: string, arguments_: readonly PineQualifiedType[]): PineQualifiedType {
    const normalized = returnType.trim().toLowerCase();
    const qualifier = normalized.startsWith("series ") || normalized === "series" ? "series"
      : normalized.startsWith("input ") || normalized === "input" ? "input"
      : strongestOf(arguments_);
    const raw = normalized.replace(/^(const|input|simple|series)\s+/u, "");
    if (["bool", "color", "float", "int", "string"].includes(raw)) return primitive(raw as "bool" | "color" | "float" | "int" | "string", qualifier);
    if (raw === "number") return primitive(arguments_.some((type) => type.kind === "float") ? "float" : "int", qualifier);
    if (raw === "void") return voidType();
    if (raw === "plot") return named("plot", "plot", "series");
    if (raw === "hline") return named("hline", "hline", "series");
    if (referenceNames.has(raw)) return named("reference", raw, "series");
    if (raw.endsWith("[]")) return compound("array", [this.parseType(raw.slice(0, -2), "series")], "series");
    if (raw === "array" || raw === "matrix" || raw === "map") return compound(raw, [unknownType("series")], "series");
    const collection = raw.match(/^(array|matrix|map)<(.+)>$/u);
    if (collection) return compound(collection[1] as "array" | "matrix" | "map", [this.parseType(collection[2]!, "series")], "series");
    return unknownType(qualifier);
  }

  private matrixM3ReturnType(
    method: string,
    receiverNode: ExpressionNode | undefined,
    operandNodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): PineQualifiedType {
    const name = `matrix.${method}`;
    const receiver = receiverNode ? this.infer(receiverNode, scope) : unknownType("series");
    if (receiver.kind !== "matrix") {
      this.error("SCRIPT2117", `Argument 'id1' for '${name}' requires a series matrix, received ${describe(receiver)}`, receiverNode?.range);
      return unknownType("series");
    }
    const element = receiver.arguments?.[0] ?? unknownType("series");
    const operandNode = operandNodes[0];
    const operand = operandNode ? this.infer(operandNode, scope) : unknownType("series");
    if (method === "concat") {
      if (operand.kind !== "matrix") {
        this.error("SCRIPT2117", `Argument 'id2' for '${name}' requires a series matrix, received ${describe(operand)}`, operandNode?.range);
      } else if (!sameValueType(receiver, operand)) {
        this.error("SCRIPT2111", `Collection expects ${describe(receiver)}, received ${describe(operand)}`, operandNode?.range);
      }
      return receiver;
    }
    if (method === "sort") {
      if (!["int", "float", "string", "udt"].includes(element.kind)) {
        this.error("SCRIPT2122", "matrix.sort requires int, float, string, or UDT elements", receiverNode?.range);
      }
      const columnNode = operandNodes[0];
      const orderNode = operandNodes[1];
      const fieldNode = operandNodes[2];
      if (columnNode && !assignable(this.infer(columnNode, scope), primitive("int", "series"))) {
        this.error("SCRIPT2117", "matrix.sort column requires series int", columnNode.range);
      }
      if (orderNode) {
        let choices = this.plotEnumValues(orderNode, scope);
        if (choices === undefined && orderNode.kind === "member") choices = [memberName(orderNode)];
        if (!choices?.every((choice) => choice === "order.ascending" || choice === "order.descending")) {
          this.error("SCRIPT2122", "matrix.sort order requires order.ascending or order.descending", orderNode.range);
        }
      }
      if (fieldNode && element.kind !== "udt") {
        this.error("SCRIPT2122", "matrix.sort sort_field requires a UDT matrix", fieldNode.range);
      }
      return voidType();
    }
    const numeric = (type: PineQualifiedType): boolean => type.kind === "int" || type.kind === "float";
    if (!numeric(element)) {
      this.error("SCRIPT2122", `${name} requires int or float matrix elements, received ${describe(element)}`, receiverNode?.range);
    }
    const operandElement = operand.arguments?.[0] ?? unknownType("series");
    const collection = operand.kind === "matrix" || (method === "mult" && operand.kind === "array");
    let valid = numeric(operand);
    if (method === "kron") valid = operand.kind === "matrix" && numeric(operandElement);
    else if (collection) valid = numeric(operandElement);
    if (!valid) {
      this.error("SCRIPT2117", `Argument 'id2' for '${name}' requires a numeric ${method === "kron" ? "matrix" : "scalar or compatible collection"}, received ${describe(operand)}`, operandNode?.range);
    }
    let promoted: "int" | "float" = "int";
    if (element.kind === "float" || collection && operandElement.kind === "float" || !collection && operand.kind === "float") {
      promoted = "float";
    }
    return compound(method === "mult" && operand.kind === "array" ? "array" : "matrix", [primitive(promoted, "series")], "series");
  }

  private directCollectionReturnType(name: string, arguments_: readonly PineQualifiedType[], nodes: readonly ExpressionNode[]): PineQualifiedType | undefined {
    const [namespace, method] = name.split(".");
    if (!namespace || !method || !["array", "matrix", "map"].includes(namespace)) return undefined;
    const receiver = arguments_[0];
    if (namespace === "array" && (["get", "pop", "push", "set", "size"].includes(method)
      || certifiedArrayMutationCallNames.has(method) || certifiedArraySearchOrderCallNames.has(method)
      || (isStrictPineCompatibility(this.compatibility) && certifiedArrayNumericCallNames.has(method)))
      && receiver?.kind !== "array" && receiver?.kind !== "unknown") {
      this.error("SCRIPT2117", `Argument 'id' for '${name}' requires series array, received ${describe(receiver ?? unknownType("series"))}`, nodes[0]?.range);
      return unknownType("series");
    }
    if (namespace === "array" && receiver?.kind === "unknown") return unknownType("series");
    if (namespace === "map" && isStrictPineCompatibility(this.compatibility)
      && certifiedMapCallNames.has(method) && receiver?.kind !== "map" && receiver?.kind !== "unknown") {
      this.error("SCRIPT2117", `Argument 'id' for '${name}' requires series map, received ${describe(receiver ?? unknownType("series"))}`, nodes[0]?.range);
      return unknownType("series");
    }
    if (namespace === "map" && receiver?.kind === "unknown") return unknownType("series");
    if (namespace === "matrix" && isStrictPineCompatibility(this.compatibility)
      && (certifiedMatrixCoreCallNames.has(method) || certifiedMatrixStructuralCallNames.has(method)
        || certifiedMatrixReverseCallNames.has(method) || certifiedMatrixPredicateCallNames.has(method)
        || certifiedMatrixNumericCallNames.has(method) || certifiedMatrixLinearAlgebraCallNames.has(method)
        || certifiedMatrixInversePowerCallNames.has(method))
      && receiver?.kind !== "matrix"
      && (certifiedMatrixNumericCallNames.has(method) || certifiedMatrixLinearAlgebraCallNames.has(method)
        || certifiedMatrixInversePowerCallNames.has(method) || receiver?.kind !== "unknown")) {
      this.error("SCRIPT2117", `Argument 'id' for '${name}' requires series matrix, received ${describe(receiver ?? unknownType("series"))}`, nodes[0]?.range);
      return unknownType("series");
    }
    if (namespace === "matrix" && receiver?.kind === "unknown") return unknownType("series");
    if (!receiver || receiver.kind !== namespace) return undefined;
    if (namespace === "array" && ["get", "set"].includes(method)) {
      const indexPositions = [1];
      for (const indexPosition of indexPositions) {
        const index = arguments_[indexPosition];
        if (index && !assignable(index, primitive("int", "series"))) {
          this.error("SCRIPT2117", `Argument index for '${name}' requires series int, received ${describe(index)}`, nodes[indexPosition]?.range);
        }
      }
    }
    const element = receiver.arguments?.[0] ?? unknownType("series");
    if (namespace === "matrix" && isStrictPineCompatibility(this.compatibility)
      && certifiedMatrixInversePowerCallNames.has(method)) {
      if (element.kind !== "int" && element.kind !== "float") {
        this.error("SCRIPT2122", `${name} requires int or float matrix elements, received ${describe(element)}`, nodes[0]?.range);
      }
      if (method === "pow" && arguments_[1] && !assignable(arguments_[1], primitive("int", "series"))) {
        this.error("SCRIPT2117", "matrix.pow power requires series int", nodes[1]?.range);
      }
      return receiver;
    }
    if (namespace === "matrix" && isStrictPineCompatibility(this.compatibility)
      && certifiedMatrixNumericCallNames.has(method)) {
      if (element.kind !== "int" && element.kind !== "float") {
        this.error("SCRIPT2122", `${name} requires int or float matrix elements, received ${describe(element)}`, nodes[0]?.range);
      }
      return withQualifier(element, "series");
    }
    if (namespace === "matrix" && isStrictPineCompatibility(this.compatibility)
      && certifiedMatrixLinearAlgebraCallNames.has(method)) {
      if (element.kind !== "int" && element.kind !== "float") {
        this.error("SCRIPT2122", `${name} requires int or float matrix elements, received ${describe(element)}`, nodes[0]?.range);
      }
      if (method === "det") return primitive("float", "series");
      return primitive("int", "series");
    }
    const operand = arguments_[1];
    if (namespace === "matrix" && ["concat", "inv", "pinv", "pow", "transpose"].includes(method)) return receiver;
    if (namespace === "matrix" && ["sum", "diff", "mult"].includes(method)) {
      if (operand && !["int", "float", "matrix", ...(method === "mult" ? ["array"] : [])].includes(operand.kind)) {
        this.error("SCRIPT2117", `Argument 'id2' for '${name}' requires a numeric scalar or compatible collection`, nodes[1]?.range);
      }
      if (operand?.kind === "matrix" || operand?.kind === "array") {
        const other = operand.arguments?.[0];
        if (other && !["int", "float", "unknown"].includes(other.kind)) {
          this.error("SCRIPT2117", `Argument 'id2' for '${name}' requires numeric elements`, nodes[1]?.range);
        }
      }
      const resultElement = operand?.kind === "float" || operand?.arguments?.[0]?.kind === "float" ? primitive("float", "series") : element;
      return compound(operand?.kind === "array" ? "array" : "matrix", [resultElement], "series");
    }
    if (namespace === "matrix" && ["avg", "min", "max", "median", "mode", "trace"].includes(method)) return withQualifier(element, "series");
    if (namespace === "array" && !isStrictPineCompatibility(this.compatibility)
      && ["sum", "min", "max", "range", "stdev", "variance"].includes(method)) return withQualifier(element, "series");
    const inferred = this.collectionMethodType(receiver, method, arguments_.slice(1), nodes.slice(1));
    return inferred?.kind === "unknown" ? undefined : inferred;
  }

  private constructorElementType(node: CallNode, name: string): PineQualifiedType {
    const explicit = node.callee.kind === "member" ? node.callee.typeArguments?.[0] : undefined;
    if (explicit) return this.parseType(explicit, "series");
    const suffix = name.match(/^array\.new_(.+)$/u)?.[1];
    if (suffix) return this.parseType(suffix, "series");
    const initial = node.arguments[name === "matrix.new" ? 2 : 1]?.value;
    return initial ? this.expressionTypes.get(initial) ?? unknownType("series") : unknownType("series");
  }

  private validateMatrixConstructorArguments(
    node: CallNode,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    if (!isStrictPineCompatibility(this.compatibility)) return;
    const typeArguments = node.callee.kind === "member" ? node.callee.typeArguments ?? [] : [];
    if (typeArguments.length !== 1) {
      this.error("SCRIPT2014", "'matrix.new<type>' requires exactly one type parameter", node.callee.range);
    }
    const element = this.constructorElementType(node, "matrix.new");
    if (["array", "map", "matrix", "tuple", "void"].includes(element.kind)) {
      this.error("SCRIPT2117", `'matrix.new<type>' does not admit nested collection element type ${describe(element)}`, node.callee.range);
    } else if (element.kind === "unknown") {
      this.error("SCRIPT2117", "'matrix.new<type>' requires a known primitive, enum, UDT, or object reference type", node.callee.range);
    }
    this.validateArrayConstructorValue("matrix.new", "rows", nodes[0], primitive("int", "series"), scope);
    this.validateArrayConstructorValue("matrix.new", "columns", nodes[1], primitive("int", "series"), scope);
    this.validateArrayConstructorValue("matrix.new", "initial_value", nodes[2], element, scope);
  }

  private validateMatrixStructural(
    method: string,
    receiver: PineQualifiedType,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    if (receiver.kind !== "matrix" && receiver.kind !== "unknown") return;
    const indexes = method === "reshape" || method.startsWith("swap_") ? [0, 1]
      : method === "transpose" ? [] : [0];
    for (const index of indexes) {
      this.validateArrayConstructorValue(`matrix.${method}`, "index", nodes[index], primitive("int", "series"), scope);
    }
    if (!method.startsWith("add_")) return;
    const node = nodes[1];
    if (!node) return;
    const inserted = this.infer(node, scope);
    if (inserted.kind !== "array") {
      this.error("SCRIPT2117", `Argument 'array_id' for 'matrix.${method}' requires a series array, received ${describe(inserted)}`, node.range);
      return;
    }
    const element = receiver.arguments?.[0] ?? unknownType("series");
    const actual = inserted.arguments?.[0] ?? unknownType("series");
    if (!assignable(actual, withQualifier(element, "series"))) {
      this.error("SCRIPT2111", `Collection expects ${describe(element)}, received ${describe(actual)}`, node.range);
    }
  }

  private validateArrayFromArguments(
    node: CallNode,
    nodes: readonly ExpressionNode[],
    types: readonly PineQualifiedType[],
  ): void {
    if (!isStrictPineCompatibility(this.compatibility)) return;
    if (node.callee.kind === "member" && (node.callee.typeArguments?.length ?? 0) > 0) {
      this.error("SCRIPT2014", "'array.from' does not accept type parameters", node.callee.range);
    }

    let admitted: PineQualifiedType | undefined;
    for (const [index, type] of types.entries()) {
      if (["na", "unknown"].includes(type.kind)) continue;
      if (["array", "map", "matrix", "tuple", "void"].includes(type.kind)) {
        this.error("SCRIPT2117", `Argument ${String(index + 1)} for 'array.from' must be a scalar, enum, UDT, or object reference, received ${describe(type)}`, nodes[index]?.range);
        continue;
      }
      if (admitted === undefined) {
        admitted = type;
        continue;
      }
      if (sameValueType(admitted, type)) continue;
      if ([admitted.kind, type.kind].every((kind) => kind === "int" || kind === "float")) {
        admitted = primitive("float", strongest(admitted.qualifier, type.qualifier));
        continue;
      }
      this.error("SCRIPT2117", `All arguments for 'array.from' must have one compatible element type; received ${describe(admitted)} and ${describe(type)}`, nodes[index]?.range);
    }
  }

  private validateMapConstructor(node: CallNode, mapType: PineQualifiedType): void {
    if (!isStrictPineCompatibility(this.compatibility)) return;
    const typeArguments = node.callee.kind === "member" ? node.callee.typeArguments ?? [] : [];
    if (typeArguments.length !== 2) {
      this.error("SCRIPT2014", "'map.new<keyType, valueType>' requires exactly two type parameters", node.callee.range);
      return;
    }
    const [key, value] = mapType.arguments ?? [];
    if (!key || (!scalarKinds.has(key.kind) && key.kind !== "enum")) {
      this.error(
        "SCRIPT2117",
        `'map.new<keyType, valueType>' requires a primitive or enum key type, received ${describe(key ?? unknownType("series"))}`,
        node.callee.range,
      );
    }
    if (!value || ![...scalarKinds, "enum", "reference", "udt"].includes(value.kind)) {
      this.error(
        "SCRIPT2117",
        `'map.new<keyType, valueType>' requires a primitive, enum, UDT, or object reference value type, received ${describe(value ?? unknownType("series"))}`,
        node.callee.range,
      );
    }
  }

  private validateArrayConstructorArguments(
    node: CallNode,
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    if (!isStrictPineCompatibility(this.compatibility)) {
      if (name !== "array.new_float") return;
      this.validateArrayConstructorValue(name, "size", nodes[0], primitive("int", "series"), scope);
      this.validateArrayConstructorValue(name, "initial_value", nodes[1], primitive("float", "series"), scope);
      return;
    }

    const generic = name === "array.new";
    const typeArguments = node.callee.kind === "member" ? node.callee.typeArguments ?? [] : [];
    if (generic && typeArguments.length !== 1) {
      this.error("SCRIPT2014", `'array.new<type>' requires exactly one type parameter`, node.callee.range);
    }
    if (!generic && typeArguments.length > 0) {
      this.error("SCRIPT2014", `'${name}' does not accept type parameters`, node.callee.range);
    }

    const element = this.constructorElementType(node, name);
    if (["array", "map", "matrix", "tuple", "void"].includes(element.kind)) {
      this.error("SCRIPT2117", `'array.new<type>' does not admit nested collection element type ${describe(element)}`, node.callee.range);
    } else if (element.kind === "unknown") {
      this.error("SCRIPT2117", `'array.new<type>' requires a known primitive, enum, UDT, or object reference type`, node.callee.range);
    }

    this.validateArrayConstructorValue(name, "size", nodes[0], primitive("int", "series"), scope);
    this.validateArrayConstructorValue(name, "initial_value", nodes[1], element, scope);
  }

  private validateArrayConstructorValue(
    name: string,
    parameter: string,
    node: ExpressionNode | undefined,
    expected: PineQualifiedType,
    scope: BindingScope,
  ): void {
    if (node === undefined) return;
    const actual = this.infer(node, scope);
    if (assignable(actual, expected)) return;
    this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
  }

  private certifiedInputReturnType(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    signature: readonly string[] | undefined,
    scope: BindingScope,
  ): PineQualifiedType {
    const parameterNames = signature ?? this.callableMetadata[name]?.parameters ?? [];
    const nodeFor = (parameter: string): ExpressionNode | undefined => nodes[parameterNames.indexOf(parameter)];
    const defvalNode = nodeFor("defval");
    const defval = defvalNode === undefined ? unknownType("series") : this.infer(defvalNode, scope);
    const requireParameterType = (parameter: string, expected: PineQualifiedType): void => {
      const node = nodeFor(parameter);
      if (node === undefined) return;
      const actual = this.infer(node, scope);
      if (!assignable(actual, expected)) {
        this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
      }
    };

    for (const parameter of ["title", "tooltip", "inline", "group"]) requireParameterType(parameter, primitive("string", "const"));
    requireParameterType("confirm", primitive("bool", "const"));
    requireParameterType("display", primitive("int", "const"));
    requireParameterType("active", primitive("bool", "input"));

    let result: PineQualifiedType;
    if (name === "input") {
      const scalar = scalarKinds.has(defval.kind) && defval.qualifier === "const";
      const source = defval.kind === "float" && defval.qualifier === "series";
      if (!scalar && !source && defval.kind !== "unknown") {
        this.error(
          "SCRIPT2117",
          `Argument 'defval' for 'input' requires a const scalar or series float source, received ${describe(defval)}`,
          defvalNode?.range,
        );
      }
      result = source ? primitive("float", "series") : withQualifier(defval, "input");
    } else if (name === "input.source") {
      requireParameterType("defval", primitive("float", "series"));
      result = primitive("float", "series");
    } else if (name === "input.enum") {
      if (defval.kind !== "enum" || defval.qualifier !== "const") {
        this.error("SCRIPT2117", `Argument 'defval' for 'input.enum' requires a const enum, received ${describe(defval)}`, defvalNode?.range);
      }
      result = defval.kind === "enum" && defval.name !== undefined
        ? named("enum", defval.name, "input")
        : unknownType("input");
    } else {
      const resultKinds: Readonly<Record<string, "bool" | "color" | "float" | "int" | "string">> = {
        "input.bool": "bool",
        "input.color": "color",
        "input.float": "float",
        "input.int": "int",
        "input.price": "float",
        "input.session": "string",
        "input.string": "string",
        "input.symbol": "string",
        "input.text_area": "string",
        "input.time": "int",
        "input.timeframe": "string",
      };
      const kind = resultKinds[name];
      if (kind === undefined) return unknownType("input");
      requireParameterType("defval", primitive(kind, "const"));
      result = primitive(kind, "input");
    }

    const optionsNode = nodeFor("options");
    if (optionsNode !== undefined) {
      if (optionsNode.kind !== "tuple" || optionsNode.elements.length === 0) {
        this.error("SCRIPT2117", `Argument 'options' for '${name}' requires a non-empty const tuple`, optionsNode.range);
      } else {
        for (const option of optionsNode.elements) {
          const actual = this.infer(option, scope);
          if (!assignable(actual, withQualifier(defval, "const"))) {
            this.error("SCRIPT2117", `Argument 'options' for '${name}' must match ${describe(withQualifier(defval, "const"))}, received ${describe(actual)}`, option.range);
          }
        }
      }
    }
    const numericKind = name === "input.int" ? "int" : "float";
    for (const parameter of ["minval", "maxval", "step"]) {
      if (nodeFor(parameter) !== undefined) requireParameterType(parameter, primitive(numericKind, "const"));
    }
    return result;
  }

  private validateScalarMathArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    for (const [index, node] of nodes.entries()) {
      if (node === undefined) continue;
      const expected = name === "math.round" && index === 1 ? primitive("int", "series") : primitive("float", "series");
      const actual = this.infer(node, scope);
      if (assignable(actual, expected)) continue;
      const parameter = this.callableMetadata[name]?.parameters[index]
        ?? this.callableMetadata[name]?.variadicParameter
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    }
  }

  private validateRemainingMathArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    for (const [index, node] of nodes.entries()) {
      if (node === undefined) continue;
      const integerParameter = (name === "math.random" && index === 2) || (name === "math.sum" && index === 1);
      const expected = primitive(integerParameter ? "int" : "float", "series");
      const actual = this.infer(node, scope);
      if (assignable(actual, expected)) continue;
      const parameter = this.callableMetadata[name]?.parameters[index] ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    }
  }

  private validateScalarStringArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const integerParameters = stringIntegerParameters[name] ?? new Set<number>();
    for (const [index, node] of nodes.entries()) {
      if (node === undefined) continue;
      const expected = primitive(integerParameters.has(index) ? "int" : "string", "series");
      const actual = this.infer(node, scope);
      if (assignable(actual, expected)) continue;
      const parameter = this.callableMetadata[name]?.parameters[index] ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    }
    if (name !== "str.substring" || !isStrictPineCompatibility(this.compatibility)) return;
    const [sourceNode, beginNode, endNode] = nodes;
    if (beginNode === undefined) return;
    const begin = this.constantValue(beginNode, scope);
    if (typeof begin !== "number" || !Number.isInteger(begin)) return;
    const source = sourceNode === undefined ? undefined : this.constantValue(sourceNode, scope);
    const end = endNode === undefined
      ? (typeof source === "string" ? Array.from(source).length : undefined)
      : this.constantValue(endNode, scope);
    if (begin >= 0 && (typeof end !== "number" || begin <= end)) return;
    const detail = typeof end === "number" ? `: (${end})` : "";
    this.error("SCRIPT2117", `Invalid value "${begin}" for "begin_pos" parameter of the "str.substring" function. It must be >= 0 or lower than the "end_pos"${detail}`, beginNode.range);
  }

  private validateAdvancedStringArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    for (const [index, node] of nodes.entries()) {
      if (node === undefined) continue;
      const actual = this.infer(node, scope);
      const scalarValue = name === "str.format" && index > 0;
      if (scalarValue && !["unknown", "na", "bool", "color", "float", "int", "string"].includes(actual.kind)) {
        const parameter = this.callableMetadata[name]?.parameters[index]
          ?? this.callableMetadata[name]?.variadicParameter
          ?? `argument${String(index)}`;
        this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a scalar value, received ${describe(actual)}`, node.range);
        continue;
      }
      const tostringValue = name === "str.tostring" && index === 0;
      const numericMatrix = actual.kind === "matrix" && (actual.arguments?.[0]?.kind === "float" || actual.arguments?.[0]?.kind === "int");
      if (tostringValue && !numericMatrix && !["unknown", "na", "bool", "color", "float", "int", "string", "array"].includes(actual.kind)) {
        this.error("SCRIPT2117", `Argument 'value' for 'str.tostring' requires a scalar, array or numeric matrix value, received ${describe(actual)}`, node.range);
        continue;
      }
      const expected = advancedStringParameterType(name, index);
      if (expected === undefined || assignable(actual, expected)) continue;
      const parameter = this.callableMetadata[name]?.parameters[index]
        ?? this.callableMetadata[name]?.variadicParameter
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    }
  }

  private validateTaHistoryArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const types = nodes.map((node) => node === undefined ? undefined : this.infer(node, scope));
    const requireType = (index: number, expected: PineQualifiedType): void => {
      const node = nodes[index];
      const actual = types[index];
      if (node === undefined || actual === undefined || assignable(actual, expected)) return;
      const parameter = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[index]?.name
        ?? this.callableMetadata[name]?.parameters[index]
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };
    const requireNumeric = (index: number): void => requireType(index, primitive("float", "series"));
    const requireInteger = (index: number): void => requireType(index, primitive("int", "series"));

    if (name === "ta.change") {
      const source = types[0];
      const node = nodes[0];
      if (node && source && !["unknown", "na", "bool", "float", "int"].includes(source.kind)) {
        this.error("SCRIPT2117", `Argument 'source' for '${name}' requires series bool or series float, received ${describe(source)}`, node.range);
      }
      requireInteger(1);
      return;
    }
    if (["ta.highest", "ta.lowest", "ta.highestbars", "ta.lowestbars"].includes(name) && nodes.length === 1) {
      requireInteger(0);
      return;
    }
    if (["ta.mom", "ta.roc", "ta.range", "ta.rising", "ta.falling", "ta.highest", "ta.lowest", "ta.highestbars", "ta.lowestbars"].includes(name)) {
      requireNumeric(0);
      requireInteger(1);
      return;
    }
    if (["ta.cross", "ta.crossover", "ta.crossunder"].includes(name)) {
      requireNumeric(0);
      requireNumeric(1);
      return;
    }
    if (name === "ta.cum") {
      requireNumeric(0);
      return;
    }
    if (name === "ta.barssince") {
      requireType(0, primitive("bool", "series"));
      return;
    }
    if (name === "ta.valuewhen") {
      requireType(0, primitive("bool", "series"));
      const source = types[1];
      const node = nodes[1];
      if (node && source && !["unknown", "na", "bool", "color", "float", "int", "string"].includes(source.kind)) {
        this.error("SCRIPT2117", `Argument 'source' for '${name}' requires a scalar series, received ${describe(source)}`, node.range);
      }
      requireInteger(2);
    }
  }

  private validateScalarMissingArguments(
    name: string,
    nodes: readonly ExpressionNode[],
    types: readonly PineQualifiedType[],
  ): void {
    const source = types[0];
    const sourceNode = nodes[0];
    if (!source || !sourceNode) return;
    const accepted = name === "bool" ? ["na", "bool", "int", "float"]
      : name === "int" || name === "float" ? ["na", "int", "float"]
        : name === "color" ? ["na", "color"]
          : name === "string" ? ["na", "int", "float", "string"]
            : name === "na" ? undefined
              : this.version === 5 ? ["bool", "color", "float", "int"] : ["color", "float", "int"];

    if (name === "na") {
      if (this.version === 6 && source.kind === "bool") {
        this.error("SCRIPT2117", "Argument 'value' for 'na' does not accept bool in version 6 scripts", sourceNode.range);
      } else if (source.kind === "void") {
        this.error("SCRIPT2117", "Argument 'value' for 'na' requires a value", sourceNode.range);
      }
      return;
    }

    const contextuallyTypedNzSource = name === "nz" && source.kind === "na";
    if (accepted !== undefined && !contextuallyTypedNzSource && !["unknown", ...accepted].includes(source.kind)) {
      this.error("SCRIPT2117", `Argument '${name === "nz" || name === "fixnan" ? "source" : "value"}' for '${name}' requires ${accepted.join(", ")}, received ${describe(source)}`, sourceNode.range);
      return;
    }

    if (name !== "nz") return;
    const replacement = types[1];
    const replacementNode = nodes[1];
    if (source.kind === "na") {
      if (replacement === undefined || replacementNode === undefined || replacement.kind === "na" || replacement.kind === "unknown") {
        this.error("SCRIPT2117", "Cannot determine the 'nz' source type from na without a typed replacement", sourceNode.range);
        return;
      }
      if (accepted === undefined || !accepted.includes(replacement.kind)) {
        this.error("SCRIPT2117", `Argument 'replacement' for 'nz' requires ${accepted?.join(", ") ?? "a supported scalar"}, received ${describe(replacement)}`, replacementNode.range);
      }
      return;
    }
    if (replacement === undefined || replacementNode === undefined) return;
    const compatible = source.kind === "unknown" || replacement.kind === "unknown"
      || replacement.kind === "na"
      || sameValueType(source, replacement)
      || (source.kind === "float" && replacement.kind === "int");
    if (!compatible) {
      this.error("SCRIPT2117", `Argument 'replacement' for 'nz' must match ${describe(source)}, received ${describe(replacement)}`, replacementNode.range);
    }
  }

  private scalarMissingReturnType(name: string, types: readonly PineQualifiedType[]): PineQualifiedType {
    const source = types[0] ?? unknownType("series");
    if (["bool", "color", "float", "int", "string"].includes(name)) {
      return primitive(name as "bool" | "color" | "float" | "int" | "string", source.qualifier);
    }
    if (name === "na") return primitive("bool", source.qualifier === "series" ? "series" : "simple");
    if (name === "fixnan") {
      return source.kind === "unknown" || source.kind === "na" ? unknownType("series") : withQualifier(source, "series");
    }
    const qualifier = strongestOf(types);
    const resolvedSource = source.kind === "na" && types[1] !== undefined ? types[1] : source;
    return resolvedSource.kind === "unknown" || resolvedSource.kind === "na"
      ? unknownType(qualifier === "series" ? "series" : "simple")
      : withQualifier(resolvedSource, qualifier === "series" ? "series" : "simple");
  }

  private validateStrategyCoreArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const overload = this.callableMetadata[name]?.typedOverloads?.[0];
    if (overload === undefined) return;
    for (const [index, parameter] of overload.parameters.entries()) {
      const node = nodes[index];
      if (node === undefined) continue;
      const actual = this.infer(node, scope);
      if (assignable(actual, parameter.type)) continue;
      this.error(
        "SCRIPT2117",
        `Argument '${parameter.name}' for '${name}' requires ${describe(parameter.type)}, received ${describe(actual)}`,
        node.range,
      );
    }
  }

  private validatePlotMarkerArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const parameters = this.callableMetadata[name]?.parameters ?? [];
    for (const [index, node] of nodes.entries()) {
      if (node === undefined) continue;
      const parameter = parameters[index];
      if (parameter === undefined) continue;
      const actual = this.infer(node, scope);
      // Defer unresolved chart fields and user-call return flow to their
      // existing source-aware diagnostics instead of masking those errors.
      if (node.kind === "member" && node.object.kind === "identifier" && node.object.name === "chart"
        && !this.knownVariables.has(memberName(node))) continue;
      if (actual.kind === "void" && node.kind === "call" && this.functions.has(callableName(node.callee))) continue;
      if (parameter === "series" && (name === "plotshape" || name === "plotchar")) {
        if (["unknown", "na", "bool", "int", "float"].includes(actual.kind)) continue;
        this.error("SCRIPT2117", `Argument 'series' for '${name}' requires series bool or series float, received ${describe(actual)}`, node.range);
        continue;
      }
      if (["color", "colorup", "colordown", "textcolor"].includes(parameter)
        && node.kind === "literal" && typeof node.value === "string" && /^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/u.test(node.value)) continue;
      const expected = plotMarkerParameterType(parameter);
      if (expected !== undefined && !assignable(actual, expected)) {
        this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
        continue;
      }
      const namespace = plotMarkerEnumNamespace(name, parameter);
      const enumPrefix = plotMarkerEnumPrefix(name, parameter);
      if (namespace !== undefined && enumPrefix !== undefined) {
        const choices = this.plotEnumValues(node, scope);
        if (!choices?.every((value) => value.startsWith(enumPrefix))) {
          this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires a ${namespace} constant`, node.range);
        } else {
          for (const value of choices) {
            if (!builtinConstantNames.has(value)) this.error("SCRIPT2015", `Unknown namespace variable '${value}'`, node.range);
          }
        }
      }
    }
  }

  private validateTaAverageArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const types = nodes.map((node) => node === undefined ? undefined : this.infer(node, scope));
    const requireType = (index: number, expected: PineQualifiedType): void => {
      const node = nodes[index];
      const actual = types[index];
      if (node === undefined || actual === undefined || assignable(actual, expected)) return;
      const parameter = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[index]?.name
        ?? this.callableMetadata[name]?.parameters[index]
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };

    requireType(0, primitive("float", "series"));
    if (name === "ta.swma") return;
    requireType(1, primitive("int", ["ta.ema", "ta.rma", "ta.hma"].includes(name) ? "simple" : "series"));
    if (name === "ta.alma") {
      requireType(2, primitive("float", "simple"));
      requireType(3, primitive("float", "simple"));
      requireType(4, primitive("bool", "simple"));
    } else if (name === "ta.linreg") {
      requireType(2, primitive("int", "simple"));
    } else if (name === "ta.stdev" || name === "ta.variance") {
      requireType(2, primitive("bool", "series"));
    }
  }

  private validateTaOscillatorArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const types = nodes.map((node) => node === undefined ? undefined : this.infer(node, scope));
    const requireType = (index: number, expected: PineQualifiedType): void => {
      const node = nodes[index];
      const actual = types[index];
      if (node === undefined || actual === undefined || assignable(actual, expected)) return;
      const parameter = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[index]?.name
        ?? this.callableMetadata[name]?.parameters[index]
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };
    const requireFloat = (index: number): void => requireType(index, primitive("float", "series"));
    const requireInt = (index: number, qualifier: "series" | "simple"): void => requireType(index, primitive("int", qualifier));

    if (name === "ta.tr") {
      requireType(0, primitive("bool", "simple"));
      return;
    }
    if (name === "ta.atr") {
      requireInt(0, "simple");
      return;
    }
    if (name === "ta.dmi") {
      requireInt(0, "simple");
      requireInt(1, "simple");
      return;
    }
    if (name === "ta.wpr") {
      requireInt(0, "series");
      return;
    }
    requireFloat(0);
    if (name === "ta.stoch") {
      requireFloat(1);
      requireFloat(2);
      requireInt(3, "series");
      return;
    }
    const lengthType = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[1]?.type;
    requireType(1, lengthType ?? primitive("int", "simple"));
    if (name === "ta.tsi") requireInt(2, "simple");
    if (name === "ta.macd") {
      requireInt(2, "simple");
      requireInt(3, "simple");
    }
  }

  private validateTaBandRankArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const types = nodes.map((node) => node === undefined ? undefined : this.infer(node, scope));
    const requireType = (index: number, expected: PineQualifiedType): void => {
      const node = nodes[index];
      const actual = types[index];
      if (node === undefined || actual === undefined || assignable(actual, expected)) return;
      const parameter = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[index]?.name
        ?? this.callableMetadata[name]?.parameters[index]
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };

    requireType(0, primitive("float", "series"));
    if (name === "ta.correlation") {
      requireType(1, primitive("float", "series"));
      requireType(2, primitive("int", "series"));
      return;
    }
    requireType(1, primitive("int", name === "ta.kc" || name === "ta.kcw" ? "simple" : "series"));
    if (name === "ta.bb" || name === "ta.bbw" || name === "ta.kc" || name === "ta.kcw") {
      requireType(2, primitive("float", "simple"));
      if (name === "ta.kc" || name === "ta.kcw") requireType(3, primitive("bool", "simple"));
      return;
    }
    if (name === "ta.percentile_linear_interpolation" || name === "ta.percentile_nearest_rank") {
      requireType(2, primitive("float", "simple"));
    }
  }

  private validateTaVolumeArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const requireType = (index: number, expected: PineQualifiedType): void => {
      const node = nodes[index];
      if (node === undefined) return;
      const actual = this.infer(node, scope);
      if (assignable(actual, expected)) return;
      const parameter = this.callableMetadata[name]?.typedOverloads?.[0]?.parameters[index]?.name
        ?? this.callableMetadata[name]?.parameters[index]
        ?? `argument${String(index)}`;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };

    requireType(0, primitive("float", "series"));
    if (name === "ta.mfi") {
      requireType(1, primitive("int", "series"));
    } else {
      requireType(1, primitive("bool", "series"));
      requireType(2, primitive("float", "series"));
    }
  }

  private validateTaPivotTrendArguments(
    name: string,
    nodes: readonly (ExpressionNode | undefined)[],
    scope: BindingScope,
  ): void {
    const requireType = (index: number, parameter: string, expected: PineQualifiedType): void => {
      const node = nodes[index];
      if (node === undefined) return;
      const actual = this.infer(node, scope);
      if (assignable(actual, expected)) return;
      this.error("SCRIPT2117", `Argument '${parameter}' for '${name}' requires ${describe(expected)}, received ${describe(actual)}`, node.range);
    };

    if (name === "ta.pivothigh" || name === "ta.pivotlow") {
      if (nodes.length === 2) {
        requireType(0, "leftbars", primitive("int", "series"));
        requireType(1, "rightbars", primitive("int", "series"));
        return;
      }
      requireType(0, "source", primitive("float", "series"));
      requireType(1, "leftbars", primitive("int", "series"));
      requireType(2, "rightbars", primitive("int", "series"));
      return;
    }
    if (name === "ta.sar") {
      requireType(0, "start", primitive("float", "simple"));
      requireType(1, "inc", primitive("float", "simple"));
      requireType(2, "max", primitive("float", "simple"));
      return;
    }
    requireType(0, "factor", primitive("float", "series"));
    requireType(1, "atrPeriod", primitive("int", "simple"));
  }

  private identifierType(name: string, scope: BindingScope, node: ExpressionNode): PineQualifiedType {
    const symbol = lookup(scope, name);
    if (symbol) {
      if (symbol.origin !== undefined) this.valueOrigins.set(node, symbol.origin);
      return symbol.type;
    }
    if (name === "na") return naType();
    if (name === "bar_index") return primitive("int", "series");
    if (marketFields.has(name)) return primitive(["time", "time_close"].includes(name) ? "int" : "float", "series");
    if (timeComponentFields.has(name)) return primitive("int", "series");
    if (datasetTailIntegerFields.has(name)) return primitive("int", "series");
    if (this.runtimeFields.has(name)) return ["timenow", "time_tradingday"].includes(name) ? primitive("int", "series") : unknownType("series");
    if (this.enums.has(name)) return named("enum", name, "const");
    if (this.udts.has(name)) return named("udt", name, "series");
    if (!namespaceLike(name) && !this.functions.has(name)) this.error("SCRIPT2100", `Unknown identifier '${name}'`, node.range);
    return unknownType("series");
  }

  private parseType(source: string, qualifier: PineQualifier): PineQualifiedType {
    const value = source.replace(/\s+/gu, "");
    if (value.endsWith("[]")) return compound("array", [this.parseType(value.slice(0, -2), "series")], "series");
    const generic = /^(array|matrix|map)<(.+)>$/u.exec(value);
    if (generic) return compound(generic[1] as "array" | "matrix" | "map", splitTypeArguments(generic[2]!).map((argument) => this.parseType(argument, "series")), "series");
    if (["bool", "color", "float", "int", "string"].includes(value)) return primitive(value as "bool" | "color" | "float" | "int" | "string", qualifier);
    if (value === "plot" || value === "hline") return named(value, value, "series");
    if (this.enums.has(value)) return named("enum", value, qualifier);
    if (this.udts.has(value)) return named("udt", value, "series");
    if (referenceNames.has(value)) return named("reference", value, "series");
    return named("unknown", value, qualifier);
  }

  private parameterType(parameter: FunctionDeclarationNode["parameters"][number]): PineQualifiedType {
    return parameter.dataType === undefined ? unknownType(parameter.qualifier ?? "series") : this.parseType(parameter.dataType, parameter.qualifier ?? "series");
  }

  private declare(scope: BindingScope, name: string, binding: SymbolBinding, range: StatementNode["range"]) {
    if (scope.symbols.has(name)) this.error("SCRIPT2003", `Variable '${name}' is already declared`, range);
    else scope.symbols.set(name, binding);
  }

  private recordV5BooleanBranches(left: PineQualifiedType, right: PineQualifiedType): void {
    if (this.version === 5 && ((left.kind === "bool" && right.kind === "na") || (left.kind === "na" && right.kind === "bool"))) {
      this.v5RequiresMissingBooleans = true;
    }
  }

  private recordV5Constant(node: ExpressionNode, type: PineQualifiedType, scope: BindingScope): void {
    if (this.version !== 5 || type.qualifier !== "const") return;
    const constant = this.constantValue(node, scope);
    if (constant !== undefined) this.constantExpressions.set(node, constant);
  }

  private requireCondition(node: ExpressionNode, scope: BindingScope): PineQualifiedType {
    const type = this.infer(node, scope);
    this.requireBoolean(type, node);
    this.recordV5Constant(node, type, scope);
    return type;
  }

  private requireBoolean(type: PineQualifiedType, node: ExpressionNode) {
    if (type.kind === "unknown" || type.kind === "bool") return;
    if (this.version === 5 && ["int", "float"].includes(type.kind)) return;
    this.error("SCRIPT2115", `Condition requires bool, received ${describe(type)}`, node.range);
  }

  private requireNumeric(type: PineQualifiedType, node: ExpressionNode) {
    if (!["unknown", "na", "int", "float"].includes(type.kind)) this.error("SCRIPT2116", `Numeric expression required, received ${describe(type)}`, node.range);
  }

  private typeMismatch(code: string, message: string, node: ExpressionNode) {
    this.error(code, message, node.range);
  }

  private error(code: string, message: string, range?: Diagnostic["range"]) {
    if (this.diagnostics.some((diagnostic) => diagnostic.code === code && diagnostic.message === message && diagnostic.range?.start.offset === range?.start.offset)) return;
    this.diagnostics.push({ severity: "error", code, message, ...(range ? { range } : {}) });
  }
}

function emptySemanticModel(): PineSemanticModel {
  return {
    diagnostics: [],
    expressionTypes: new Map(),
    v5BooleanCoercions: new Map(),
    v5BooleanMissingValues: new Set(),
    v5RequiresMissingBooleans: false,
    valueOrigins: new Map(),
    assignmentOrigins: new Map(),
    hasMapIteration: false,
    symbolTypes: new Map(),
    callBindings: new Map(),
    methodBindings: new Map(),
    methodCandidates: new Map(),
    callBindingAt: () => undefined,
    methodCandidatesAt: () => undefined,
    typeOf: () => unknownType(),
    constantValueOf: () => undefined,
  };
}

function childScope(parent: BindingScope): BindingScope { return { parent, symbols: new Map() }; }
function lookup(scope: BindingScope, name: string): SymbolBinding | undefined {
  for (let current: BindingScope | undefined = scope; current; current = current.parent) {
    const value = current.symbols.get(name);
    if (value) return value;
  }
  return undefined;
}

function primitive(kind: "bool" | "color" | "float" | "int" | "string", qualifier: PineQualifier): PineQualifiedType { return { kind, qualifier }; }
function named(kind: PineTypeKind, name: string, qualifier: PineQualifier): PineQualifiedType { return { kind, name, qualifier: referenceKinds.has(kind) ? "series" : qualifier }; }
function compound(kind: "array" | "map" | "matrix" | "tuple", arguments_: readonly PineQualifiedType[], qualifier: PineQualifier): PineQualifiedType { return { arguments: arguments_, kind, qualifier: referenceKinds.has(kind) ? "series" : qualifier }; }
function unknownType(qualifier: PineQualifier = "series"): PineQualifiedType { return { kind: "unknown", qualifier }; }
function naType(qualifier: PineQualifier = "const"): PineQualifiedType { return { kind: "na", qualifier }; }
function voidType(): PineQualifiedType { return { kind: "void", qualifier: "const" }; }

function invalidVoidValue(node: ExpressionNode, type: PineQualifiedType): boolean {
  if (type.kind !== "void") return false;
  return !["while_expression", "for_expression", "for_in_expression"].includes(node.kind);
}
function withQualifier(type: PineQualifiedType, qualifier: PineQualifier): PineQualifiedType { return { ...type, qualifier: referenceKinds.has(type.kind) ? "series" : qualifier }; }
function strongest(left: PineQualifier, right: PineQualifier): PineQualifier { return qualifierRank[left] >= qualifierRank[right] ? left : right; }
function strongestOf(types: readonly PineQualifiedType[]): PineQualifier { return types.reduce<PineQualifier>((result, type) => strongest(result, type.qualifier), "const"); }

function assignable(source: PineQualifiedType, target: PineQualifiedType): boolean {
  if (source.kind === "unknown" || target.kind === "unknown") return qualifierRank[source.qualifier] <= qualifierRank[target.qualifier];
  if (source.kind === "na") return target.kind !== "void" && qualifierRank[source.qualifier] <= qualifierRank[target.qualifier];
  if (!sameValueType(source, target) && !(source.kind === "int" && target.kind === "float")) return false;
  return qualifierRank[source.qualifier] <= qualifierRank[target.qualifier];
}

function valueTypeAssignable(source: PineQualifiedType, target: PineQualifiedType): boolean {
  return source.kind === "unknown" || source.kind === "na" || target.kind === "unknown" || sameValueType(source, target) || (source.kind === "int" && target.kind === "float");
}

function sameValueType(left: PineQualifiedType, right: PineQualifiedType): boolean {
  if (left.kind !== right.kind || left.name !== right.name) return false;
  const leftArgs = left.arguments ?? [];
  const rightArgs = right.arguments ?? [];
  return leftArgs.length === rightArgs.length && leftArgs.every((argument, index) => sameValueType(argument, rightArgs[index]!));
}

function comparable(left: PineQualifiedType, right: PineQualifiedType): boolean {
  return left.kind === "unknown" || right.kind === "unknown" || left.kind === "na" || right.kind === "na" || sameValueType(left, right) || ([left.kind, right.kind].every((kind) => kind === "int" || kind === "float"));
}

function joinAll(types: readonly PineQualifiedType[]): PineQualifiedType {
  return types.reduce(joinTypes, unknownType("const"));
}

const conditionalPrimitiveKinds: ReadonlySet<PineQualifiedType["kind"]> = new Set(["int", "float", "bool", "string", "color"]);

/** Two known primitive branch types that no Pine conversion unifies, e.g. `float` and `string`. */
function incompatiblePrimitiveBranches(left: PineQualifiedType, right: PineQualifiedType): boolean {
  if (!conditionalPrimitiveKinds.has(left.kind) || !conditionalPrimitiveKinds.has(right.kind)) return false;
  return joinTypes(left, right).kind === "unknown";
}

function joinTypes(left: PineQualifiedType, right: PineQualifiedType): PineQualifiedType {
  if (left.kind === "unknown") return withQualifier(right, strongest(left.qualifier, right.qualifier));
  if (right.kind === "unknown") return withQualifier(left, strongest(left.qualifier, right.qualifier));
  if (left.kind === "void") return right;
  if (right.kind === "void") return left;
  if (left.kind === "na") return withQualifier(right, strongest(left.qualifier, right.qualifier));
  if (right.kind === "na") return withQualifier(left, strongest(left.qualifier, right.qualifier));
  const qualifier = strongest(left.qualifier, right.qualifier);
  if (sameValueType(left, right)) return withQualifier(left, qualifier);
  if ([left.kind, right.kind].every((kind) => kind === "int" || kind === "float")) return primitive("float", qualifier);
  return unknownType(qualifier);
}

function describe(type: PineQualifiedType): string {
  const name = type.name ?? type.kind;
  const arguments_ = type.arguments?.length ? `<${type.arguments.map((argument) => describe(argument).replace(/^(const|input|simple|series)\s+/u, "")).join(", ")}>` : "";
  return `${type.qualifier} ${name}${arguments_}`;
}

function callableName(node: ExpressionNode): string {
  if (node.kind === "identifier") return node.name;
  if (node.kind === "member") return memberName(node);
  return "<expression>";
}

function memberName(node: Extract<ExpressionNode, { kind: "member" }>): string {
  const object = node.object.kind === "identifier" ? node.object.name : node.object.kind === "member" ? memberName(node.object) : "<expression>";
  return `${object}.${node.property}`;
}

function rootIdentifier(node: ExpressionNode): string | undefined {
  if (node.kind === "identifier") return node.name;
  if (node.kind === "member") return rootIdentifier(node.object);
  return undefined;
}

function namespaceLike(name: string): boolean {
  return ["adjustment", "alert", "array", "barmerge", "barstate", "box", "chart", "color", "currency", "dayofweek", "display", "dividends", "earnings", "extend", "font", "format", "hline", "input", "label", "line", "linefill", "location", "map", "math", "matrix", "month", "plot", "polyline", "position", "request", "runtime", "scale", "session", "shape", "size", "strategy", "str", "syminfo", "ta", "table", "text", "timeframe", "weekofyear", "xloc", "yloc"].includes(name);
}

function plotMarkerParameterType(parameter: string): PineQualifiedType | undefined {
  if (["series", "histbase"].includes(parameter)) return primitive("float", "series");
  if (["color", "colorup", "colordown", "textcolor"].includes(parameter)) return primitive("color", "series");
  if (["title", "char", "text"].includes(parameter)) return primitive("string", "const");
  if (["style", "location", "size", "format", "linestyle"].includes(parameter)) return primitive("string", "input");
  if (parameter === "offset") return primitive("int", "simple");
  if (["linewidth", "show_last", "precision", "minheight", "maxheight"].includes(parameter)) return primitive("int", "input");
  if (["trackprice", "join", "editable", "force_overlay"].includes(parameter)) return primitive("bool", "input");
  if (parameter === "display") return primitive("int", "input");
  return undefined;
}

function plotMarkerEnumNamespace(name: string, parameter: string): string | undefined {
  if (parameter === "style") return name === "plot" ? "plot" : "shape";
  if (parameter === "linestyle") return "plot";
  if (["location", "size", "format"].includes(parameter)) return parameter;
  return undefined;
}

function plotMarkerEnumPrefix(name: string, parameter: string): string | undefined {
  if (parameter === "style") return name === "plot" ? "plot.style_" : "shape.";
  if (parameter === "linestyle") return "plot.linestyle_";
  if (["location", "size", "format"].includes(parameter)) return `${parameter}.`;
  return undefined;
}

function namespaceValueKind(root: string): "bool" | "color" | "float" | "int" | "string" {
  if (root === "color" || root === "chart") return "color";
  if (root === "barstate") return "bool";
  if (["syminfo", "timeframe"].includes(root)) return "string";
  return "string";
}

function namespaceQualifier(root: string): PineQualifier {
  if (root === "barstate") return "series";
  if (["syminfo", "timeframe", "chart"].includes(root)) return "simple";
  return "const";
}

function builtinVariableType(name: string, compatibility: PineCompatibility): PineQualifiedType {
  const root = name.split(".")[0]!;
  if (suppliedFutureFloatNames.has(name)) return primitive("float", "series");
  if (suppliedFutureTimeNames.has(name)) return primitive("int", "series");
  if (name === "timenow" || name === "time_tradingday") return primitive("int", "series");
  if (name === "strategy.position_size") return primitive("float", "series");
  if (name === "strategy.opentrades" || name === "strategy.closedtrades") return primitive("int", "series");
  if (isStrictPineCompatibility(compatibility)) {
    if (name === "strategy.account_currency") return primitive("string", "simple");
    if (name === "strategy.position_entry_name") return primitive("string", "series");
    if (["strategy.eventrades", "strategy.losstrades", "strategy.wintrades"].includes(name)) return primitive("int", "series");
    if (name.startsWith("strategy.") && [
      "avg_losing_trade", "avg_losing_trade_percent", "avg_trade", "avg_trade_percent",
      "avg_winning_trade", "avg_winning_trade_percent", "equity", "grossloss",
      "grossloss_percent", "grossprofit", "grossprofit_percent", "initial_capital",
      "max_contracts_held_all", "max_contracts_held_long", "max_contracts_held_short",
      "netprofit", "netprofit_percent", "openprofit", "openprofit_percent", "position_avg_price",
    ].includes(name.slice(9))) return primitive("float", "series");
  }
  if (name === "strategy.closedtrades.first_index") return primitive("int", "series");
  if (name === "strategy.opentrades.capital_held") return primitive("float", "series");
  if (root === "math") return primitive("float", "const");
  if (root === "color") return primitive("color", "const");
  if (taFloatVariableNames.has(name)) return primitive("float", "series");
  if (constIntConstantRoots.has(root)) return primitive("int", "const");
  if (constStringConstantRoots.has(root) || constStringConstantNames.has(name)) return primitive("string", "const");
  if (root === "barstate") return primitive("bool", "series");
  if (root === "session") return name === "session.regular" || name === "session.extended"
    ? primitive("string", "const")
    : primitive("bool", "series");
  if (root === "chart") {
    if (name.startsWith("chart.is_")) return primitive("bool", "simple");
    if (name.endsWith("_visible_bar_time")) return primitive("int", "series");
    return primitive("color", "simple");
  }
  if (root === "syminfo") return ["employees", "minmove", "pricescale", "shareholders"].some((suffix) => name.endsWith(suffix)) ? primitive("int", "simple")
    : ["mincontract", "mintick", "pointvalue"].some((suffix) => name.endsWith(suffix)) ? primitive("float", "simple") : primitive("string", "simple");
  if (root === "timeframe") return name.startsWith("timeframe.is") ? primitive("bool", "simple") : name.endsWith("multiplier") ? primitive("int", "simple") : primitive("string", "simple");
  return unknownType("series");
}

function splitTypeArguments(value: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "<") depth += 1;
    else if (value[index] === ">") depth -= 1;
    else if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}
