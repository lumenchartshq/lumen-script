import type { PineCompatibility, PineVersion, SourceRange } from "../contracts/index.js";
import type {
  CallArgumentNode,
  EnumDeclarationNode,
  ExpressionNode,
  FunctionDeclarationNode,
  MethodDeclarationNode,
  ProgramNode,
  StatementNode,
  TypeDeclarationNode,
} from "./ast.js";
import { lex, PineSyntaxError, type Token } from "./lexer.js";
import { PINE_COMPATIBILITY, isStrictPineCompatibility } from "../contracts/index.js";

const precedence: Readonly<Record<string, number>> = {
  or: 1,
  and: 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};
const lineContinuationAfter = new Set(["(", "[", ",", "?", ":", "=", ":=", "+=", "-=", "*=", "/=", "%=", ...Object.keys(precedence)]);

export function parse(source: string, version: PineVersion, compatibility: PineCompatibility = PINE_COMPATIBILITY.legacy): ProgramNode {
  return new Parser(lex(source, compatibility), version, compatibility).parseProgram();
}

class Parser {
  private index = 0;
  private statementColumn = 1;
  private parenthesisDepth = 0;
  private readonly typeNames = new Set<string>();
  private readonly pendingStatements: StatementNode[] = [];

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly version: PineVersion,
    private readonly compatibility: PineCompatibility,
  ) {}

  public parseProgram(): ProgramNode {
    const statements: StatementNode[] = [];
    this.skipNewlines();
    while (!this.is("eof")) {
      const statement = this.parseStatement();
      statements.push(statement, ...this.drainPendingStatements());
      if (!this.is("newline") && !this.is("eof")) {
        if (["function", "if", "once", "for", "for_in", "while"].includes(statement.kind) || this.current().range.start.line > statement.range.end.line) continue;
        throw new PineSyntaxError("Expected a new line after statement", this.current().range);
      }
      this.skipNewlines();
    }
    return { version: this.version, statements };
  }

  private parseStatement(): StatementNode {
    const statement = this.parseSingleStatement();
    const queued = [...this.drainPendingStatements()];
    while (this.matchValue(",")) {
      const next = this.parseSingleStatement();
      queued.push(next, ...this.drainPendingStatements());
    }
    this.pendingStatements.push(...queued);
    return statement;
  }

  private parseSingleStatement(): StatementNode {
    const start = this.current().range.start;
    this.statementColumn = start.column;
    if (isStrictPineCompatibility(this.compatibility) && this.current().value === "export") {
      this.advance();
      if (this.current().value === "method") return { ...this.parseMethodDeclaration(start.column, start), exported: true };
      if (this.current().value === "type") return { ...this.parseTypeDeclaration(start), exported: true };
      if (this.current().value === "enum") return { ...this.parseEnumDeclaration(start), exported: true };
      if (this.looksLikeFunctionDeclaration()) return { ...this.parseFunctionDeclaration(start.column, start), exported: true };
      throw new PineSyntaxError("Expected a function, method, type, or enum after export", this.current().range);
    }
    if (this.current().kind === "identifier" && this.current().value === "enum") return this.parseEnumDeclaration();
    if (this.current().kind === "identifier" && this.current().value === "type") return this.parseTypeDeclaration();
    if (this.current().kind === "identifier" && this.current().value === "method") return this.parseMethodDeclaration();
    if (this.looksLikeFunctionDeclaration()) return this.parseFunctionDeclaration();
    if (this.current().kind === "identifier" && this.current().value === "if") return this.parseIfStatement();
    if (isStrictPineCompatibility(this.compatibility) && this.version === 6 && this.current().kind === "identifier" && this.current().value === "once") return this.parseOnceStatement();
    if (this.current().kind === "identifier" && this.current().value === "while") return this.parseWhileStatement();
    if (this.current().kind === "identifier" && this.current().value === "for") return this.parseForStatement();
    if (this.current().kind === "identifier" && (this.current().value === "break" || this.current().value === "continue")) {
      const token = this.advance();
      return { kind: token.value as "break" | "continue", range: token.range };
    }
    let qualifier = this.matchTypeQualifier();
    let persistence: "bar" | "var" | "varip" = "bar";
    if (this.matchIdentifier("var")) persistence = "var";
    else if (this.matchIdentifier("varip")) persistence = "varip";
    qualifier ??= this.matchTypeQualifier();

    if (this.current().value === "[" && this.looksLikeTupleDeclaration()) {
      if (persistence !== "bar") throw new PineSyntaxError("Persistent tuple declarations are not supported by this compatibility profile", this.current().range);
      return this.parseTupleDeclaration(start);
    }

    const typeBoundary = this.typedDeclarationBoundary();
    const dataType = typeBoundary === undefined
      ? undefined
      : this.consumeTypeAnnotation(typeBoundary);

    if (this.looksLikeMemberAssignment()) {
      if (persistence !== "bar") throw new PineSyntaxError(`Expected a declaration after ${persistence}`, this.current().range);
      const target = this.parseExpression();
      if (target.kind !== "member") throw new PineSyntaxError("Expected a field assignment target", target.range);
      const operator = this.advance();
      if (operator.value === "%=" && !isStrictPineCompatibility(this.compatibility)) {
        throw new PineSyntaxError(`'%=' is only available in the ${PINE_COMPATIBILITY.strict} compatibility profile`, operator.range);
      }
      const value = this.parseExpression();
      const compoundOperator = ["+=", "-=", "*=", "/=", "%="].includes(operator.value)
        ? operator.value[0] as "+" | "-" | "*" | "/" | "%"
        : undefined;
      return { kind: "member_assignment", object: target.object, property: target.property, ...(compoundOperator === undefined ? {} : { operator: compoundOperator }), value, range: { start, end: value.range.end } };
    }

    if (this.is("identifier") && ["=", ":=", "+=", "-=", "*=", "/=", "%="].includes(this.peekValue(1))) {
      const name = this.advance().value;
      const operator = this.advance();
      let value = this.parseExpression();
      if (["+=", "-=", "*=", "/=", "%="].includes(operator.value)) {
        if (operator.value === "%=" && !isStrictPineCompatibility(this.compatibility)) {
          throw new PineSyntaxError(`'%=' is only available in the ${PINE_COMPATIBILITY.strict} compatibility profile`, operator.range);
        }
        const left = { kind: "identifier", name, range: operator.range } as const;
        value = { kind: "binary", operator: operator.value[0]!, left, right: value, ...(operator.value === "/=" ? { forceFloatDivision: true } : {}), range: { start: left.range.start, end: value.range.end } };
      }
      const range = { start, end: value.range.end };
      if (operator.value !== "=") {
        if (qualifier === "const") throw new PineSyntaxError("Const declarations require '='", operator.range);
        // `var x := ...` or `float x := ...` mixes a declaration with a reassignment.
        if (isStrictPineCompatibility(this.compatibility) && (persistence !== "bar" || qualifier !== undefined || dataType !== undefined)) {
          throw new PineSyntaxError(`Declarations require '='; '${operator.value}' reassigns an existing variable`, operator.range);
        }
        return { kind: "assignment", name, value, range };
      }
      const declaration = { kind: "declaration", persistence, ...(qualifier === undefined ? {} : { qualifier }), name, ...(dataType === undefined ? {} : { dataType }), value, range } as const;
      if (dataType !== undefined) this.parseSharedTypedDeclarations(dataType, qualifier);
      return declaration;
    }
    if (persistence !== "bar" || qualifier !== undefined) {
      throw new PineSyntaxError(`Expected a declaration after ${qualifier ?? persistence}`, this.current().range);
    }
    // `float n := 1`: a type in front of a reassignment.
    const reassignment = this.peekValue(2);
    if (isStrictPineCompatibility(this.compatibility) && this.is("identifier") && this.tokens[this.index + 1]?.kind === "identifier"
      && [":=", "+=", "-=", "*=", "/=", "%="].includes(reassignment)) {
      throw new PineSyntaxError(`Declarations require '='; '${reassignment}' reassigns an existing variable`, this.tokens[this.index + 2]!.range);
    }
    const expression = this.parseExpression();
    return { kind: "expression", expression, range: { start, end: expression.range.end } };
  }

  private parseTypeDeclaration(exportStart?: SourceRange["start"]): TypeDeclarationNode {
    const declarationStart = this.expect("identifier").range.start;
    const start = exportStart ?? declarationStart;
    const name = this.expect("identifier").value;
    this.typeNames.add(name);
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented type body", this.current().range);
    this.skipNewlines();
    if (this.is("eof") || this.current().range.start.column <= start.column) throw new PineSyntaxError("Expected at least one type field", this.current().range);
    const column = this.current().range.start.column;
    const fields = [];
    while (!this.is("eof") && this.current().range.start.column === column) {
      const fieldStart = this.current().range.start;
      const boundary = this.typeFieldBoundary();
      if (boundary === undefined) throw new PineSyntaxError("Expected a type field", this.current().range);
      const dataType = this.consumeTypeAnnotation(boundary);
      const fieldName = this.expect("identifier");
      const defaultValue = this.matchValue("=") ? this.parseExpression() : undefined;
      fields.push({
        dataType,
        name: fieldName.value,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        range: { start: fieldStart, end: (defaultValue?.range ?? fieldName.range).end },
      });
      if (this.is("newline")) this.skipNewlines();
      else if (!this.is("eof")) throw new PineSyntaxError("Expected a new line after type field", this.current().range);
    }
    if (fields.length === 0) throw new PineSyntaxError("Expected at least one type field", this.current().range);
    return { kind: "type", name, fields, range: { start, end: fields.at(-1)!.range.end } };
  }

  private parseEnumDeclaration(exportStart?: SourceRange["start"]): EnumDeclarationNode {
    const declarationStart = this.expect("identifier").range.start;
    const start = exportStart ?? declarationStart;
    const name = this.expect("identifier").value;
    this.typeNames.add(name);
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented enum body", this.current().range);
    this.skipNewlines();
    if (this.is("eof") || this.current().range.start.column <= start.column) throw new PineSyntaxError("Expected at least one enum field", this.current().range);
    const column = this.current().range.start.column;
    const fields = [];
    while (!this.is("eof") && this.current().range.start.column === column) {
      const field = this.expect("identifier");
      let title = field.value;
      let end = field.range.end;
      if (this.matchValue("=")) {
        const titleToken = this.expect("string");
        title = titleToken.value;
        end = titleToken.range.end;
      }
      fields.push({ name: field.value, title, range: { start: field.range.start, end } });
      if (this.is("newline")) this.skipNewlines();
      else if (!this.is("eof")) throw new PineSyntaxError("Expected a new line after enum field", this.current().range);
    }
    if (fields.length === 0) throw new PineSyntaxError("Expected at least one enum field", this.current().range);
    return { kind: "enum", name, fields, range: { start, end: fields.at(-1)!.range.end } };
  }

  private looksLikeTupleDeclaration(): boolean {
    let depth = 0;
    for (let distance = 0; ; distance += 1) {
      const token = this.tokens[this.index + distance];
      if (token === undefined || token.kind === "eof" || token.kind === "newline") return false;
      if (token.value === "[") depth += 1;
      else if (token.value === "]") {
        depth -= 1;
        if (depth === 0) return this.peekValue(distance + 1) === "=";
      }
    }
  }

  private looksLikeMemberAssignment(): boolean {
    let depth = 0;
    let hasTopLevelMember = false;
    for (let distance = 0; ; distance += 1) {
      const token = this.tokens[this.index + distance];
      if (token === undefined || token.kind === "eof" || token.kind === "newline") return false;
      if (token.value === "(" || token.value === "[") depth += 1;
      else if (token.value === ")" || token.value === "]") depth -= 1;
      else if (depth === 0 && token.value === ".") hasTopLevelMember = true;
      else if (depth === 0 && ["=", ":=", "+=", "-=", "*=", "/=", "%="].includes(token.value)) return hasTopLevelMember;
    }
  }

  private parseTupleDeclaration(start: SourceRange["start"]): StatementNode {
    this.expectValue("[");
    const names: string[] = [];
    do {
      names.push(this.expect("identifier").value);
    } while (this.matchValue(","));
    this.expectValue("]");
    this.expectValue("=");
    const value = this.parseExpression();
    return { kind: "tuple_declaration", names, value, range: { start, end: value.range.end } };
  }

  private parseWhileStatement(): StatementNode {
    const start = this.expect("identifier").range.start;
    const test = this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented while body", this.current().range);
    const body = this.parseIndentedBlock(start.column);
    return { kind: "while", test, body, range: { start, end: body.at(-1)?.range.end ?? test.range.end } };
  }

  private parseForStatement(): StatementNode {
    const start = this.expect("identifier").range.start;
    const variables: string[] = [];
    if (this.matchValue("[")) {
      do variables.push(this.expect("identifier").value); while (this.matchValue(","));
      this.expectValue("]");
    } else variables.push(this.expect("identifier").value);
    if (this.matchIdentifier("in")) {
      const collection = this.parseExpression();
      if (!this.is("newline")) throw new PineSyntaxError("Expected an indented for-in body", this.current().range);
      const body = this.parseIndentedBlock(start.column);
      return { kind: "for_in", variables, collection, body, range: { start, end: body.at(-1)?.range.end ?? collection.range.end } };
    }
    if (variables.length !== 1) throw new PineSyntaxError("Range loops require one variable", this.current().range);
    const variable = variables[0]!;
    this.expectValue("=");
    const from = this.parseExpression();
    if (!this.matchIdentifier("to")) throw new PineSyntaxError("Expected 'to' in for loop", this.current().range);
    const end = this.parseExpression();
    const step = this.matchIdentifier("by") ? this.parseExpression() : undefined;
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented for body", this.current().range);
    const body = this.parseIndentedBlock(start.column);
    return { kind: "for", variable, start: from, end, ...(step === undefined ? {} : { step }), body, range: { start, end: body.at(-1)?.range.end ?? end.range.end } };
  }

  private parseIfStatement(parentColumn?: number): StatementNode {
    const start = this.expect("identifier").range.start;
    const blockParentColumn = parentColumn ?? start.column;
    const test = this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented if body", this.current().range);
    const consequent = this.parseIndentedBlock(blockParentColumn);
    const alternate = this.parseElseBranch(blockParentColumn);
    const end = alternate.at(-1)?.range.end ?? consequent.at(-1)?.range.end ?? test.range.end;
    return { kind: "if", test, consequent, alternate, range: { start, end } };
  }

  private parseOnceStatement(): StatementNode {
    const token = this.expect("identifier");
    const test: ExpressionNode = this.is("newline")
      ? { kind: "literal", value: true, range: token.range }
      : this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented once body", this.current().range);
    const body = this.parseIndentedBlock(token.range.start.column);
    return { kind: "once", test, body, range: { start: token.range.start, end: body.at(-1)?.range.end ?? test.range.end } };
  }

  private parseIfExpression(start: Token): ExpressionNode {
    const parentColumn = this.statementColumn;
    const test = this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented if expression body", this.current().range);
    const consequent = this.parseIndentedBlock(parentColumn);
    const alternate = this.parseElseBranch(parentColumn);
    if (alternate.length === 0 && !isStrictPineCompatibility(this.compatibility)) {
      throw new PineSyntaxError("An if expression requires an else branch", start.range);
    }
    const end = alternate.at(-1)?.range.end ?? consequent.at(-1)?.range.end ?? test.range.end;
    return { kind: "if_expression", test, consequent, alternate, range: { start: start.range.start, end } };
  }

  private parseWhileExpression(start: Token): ExpressionNode {
    const test = this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented while expression body", this.current().range);
    const body = this.parseIndentedBlock(this.statementColumn);
    return { kind: "while_expression", test, body, range: { start: start.range.start, end: body.at(-1)?.range.end ?? test.range.end } };
  }

  private parseForExpression(start: Token): ExpressionNode {
    const variables: string[] = [];
    if (this.matchValue("[")) {
      do variables.push(this.expect("identifier").value); while (this.matchValue(","));
      this.expectValue("]");
    } else variables.push(this.expect("identifier").value);
    if (this.matchIdentifier("in")) {
      const collection = this.parseExpression();
      if (!this.is("newline")) throw new PineSyntaxError("Expected an indented for-in expression body", this.current().range);
      const body = this.parseIndentedBlock(this.statementColumn);
      return { kind: "for_in_expression", variables, collection, body, range: { start: start.range.start, end: body.at(-1)?.range.end ?? collection.range.end } };
    }
    if (variables.length !== 1) throw new PineSyntaxError("Range loops require one variable", this.current().range);
    this.expectValue("=");
    const from = this.parseExpression();
    if (!this.matchIdentifier("to")) throw new PineSyntaxError("Expected 'to' in for expression", this.current().range);
    const end = this.parseExpression();
    const step = this.matchIdentifier("by") ? this.parseExpression() : undefined;
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented for expression body", this.current().range);
    const body = this.parseIndentedBlock(this.statementColumn);
    return { kind: "for_expression", variable: variables[0]!, start: from, end, ...(step === undefined ? {} : { step }), body, range: { start: start.range.start, end: body.at(-1)?.range.end ?? end.range.end } };
  }

  private parseSwitchExpression(start: Token): ExpressionNode {
    const parentColumn = this.statementColumn;
    const discriminant = this.is("newline") ? undefined : this.parseExpression();
    if (!this.is("newline")) throw new PineSyntaxError("Expected switch cases on indented lines", this.current().range);
    this.skipNewlines();
    if (this.is("eof") || this.current().range.start.column <= parentColumn) throw new PineSyntaxError("Expected an indented switch case", this.current().range);
    const caseColumn = this.current().range.start.column;
    const cases = [];
    while (!this.is("eof") && this.current().range.start.column === caseColumn) {
      const caseStart = this.current().range.start;
      let test: ExpressionNode | undefined;
      if (this.current().value === "=>") {
        // Pine's default switch arm has no test expression.
      } else if (this.current().kind === "identifier" && this.current().value === "_" && this.peekValue(1) === "=>") this.advance();
      else test = this.parseExpression();
      this.expectValue("=>");
      let body: readonly StatementNode[];
      if (this.is("newline")) body = this.parseIndentedBlock(caseColumn);
      else {
        const value = this.parseExpression();
        body = [{ kind: "expression", expression: value, range: value.range }];
        if (this.is("newline")) this.skipNewlines();
      }
      const caseEnd = body.at(-1)?.range.end ?? test?.range.end ?? this.current().range.end;
      cases.push({ ...(test === undefined ? {} : { test }), body, range: { start: caseStart, end: caseEnd } });
    }
    if (cases.length === 0) throw new PineSyntaxError("A switch expression requires at least one case", start.range);
    return {
      kind: "switch",
      ...(discriminant === undefined ? {} : { discriminant }),
      cases,
      range: { start: start.range.start, end: cases.at(-1)!.range.end },
    };
  }

  private parseElseBranch(parentColumn: number): readonly StatementNode[] {
    if (!(this.current().kind === "identifier" && this.current().value === "else" && this.current().range.start.column === parentColumn)) return [];
    this.advance();
    if (this.current().kind === "identifier" && this.current().value === "if") return [this.parseIfStatement(parentColumn)];
    if (!this.is("newline")) throw new PineSyntaxError("Expected an indented else body", this.current().range);
    return this.parseIndentedBlock(parentColumn);
  }

  private looksLikeFunctionDeclaration(): boolean {
    if (!this.is("identifier") || this.peekValue(1) !== "(") return false;
    for (let distance = 2; this.tokens[this.index + distance]?.kind !== "eof" && this.tokens[this.index + distance]?.kind !== "newline"; distance += 1) {
      if (this.peekValue(distance) === "=>") return true;
    }
    return false;
  }

  private parseFunctionDeclaration(parentColumn = this.current().range.start.column, declarationStart = this.current().range.start): FunctionDeclarationNode {
    const start = declarationStart;
    const name = this.expect("identifier").value;
    this.expectValue("(");
    const parameters = [];
    const allowTypeCommas = isStrictPineCompatibility(this.compatibility);
    if (!this.matchValue(")")) {
      do {
        const parameterStart = this.current().range.start;
        const tokens: Token[] = [];
        let typeDepth = 0;
        while (!this.is("eof") && !this.is("newline")) {
          const token = this.current();
          if (token.value === ")" || token.value === "=" || (token.value === "," && typeDepth === 0)) break;
          if (allowTypeCommas && token.value === "<") typeDepth += 1;
          else if (allowTypeCommas && token.value === ">" && typeDepth > 0) typeDepth -= 1;
          tokens.push(this.advance());
        }
        const parameter = [...tokens].reverse().find((token) => token.kind === "identifier");
        if (parameter === undefined) throw new PineSyntaxError("Expected a function parameter", this.current().range);
        const qualifierToken = tokens.find((token) => token.kind === "identifier" && ["const", "input", "simple", "series"].includes(token.value));
        const typeTokens = tokens.filter((token) => token !== parameter && token !== qualifierToken);
        const dataType = typeTokens.map((token) => token.value).join("") || undefined;
        let defaultValue: ExpressionNode | undefined;
        if (this.matchValue("=")) defaultValue = this.parseExpression();
        parameters.push({
          name: parameter.value,
          ...(dataType === undefined ? {} : { dataType }),
          ...(qualifierToken === undefined ? {} : { qualifier: qualifierToken.value as "const" | "input" | "simple" | "series" }),
          ...(defaultValue === undefined ? {} : { defaultValue }),
          range: { start: parameterStart, end: (defaultValue?.range ?? parameter.range).end },
        });
      } while (this.matchValue(","));
      this.expectValue(")");
    }
    this.expectValue("=>");
    let body: readonly StatementNode[];
    if (this.is("newline")) {
      body = this.parseIndentedBlock(parentColumn);
    } else {
      const expression = this.parseExpression();
      body = [{ kind: "expression", expression, range: expression.range }];
    }
    const end = body.at(-1)?.range.end ?? this.current().range.end;
    return { kind: "function", name, parameters, body, range: { start, end } };
  }

  private parseMethodDeclaration(parentColumn = this.current().range.start.column, declarationStart = this.current().range.start): MethodDeclarationNode {
    this.expect("identifier");
    const declaration = this.parseFunctionDeclaration(parentColumn, declarationStart);
    if (declaration.parameters.length === 0) throw new PineSyntaxError("A method requires a receiver parameter", declaration.range);
    return { ...declaration, kind: "method", range: { start: declarationStart, end: declaration.range.end } };
  }

  private parseIndentedBlock(parentColumn: number): readonly StatementNode[] {
    this.skipNewlines();
    if (this.is("eof") || this.current().range.start.column <= parentColumn) {
      throw new PineSyntaxError("Expected an indented block", this.current().range);
    }
    const column = this.current().range.start.column;
    const statements: StatementNode[] = [];
    while (!this.is("eof") && this.current().range.start.column === column) {
      statements.push(this.parseStatement(), ...this.drainPendingStatements());
      if (this.is("newline")) this.skipNewlines();
      else if (
        !this.is("eof")
        && statements.at(-1)?.kind !== "function"
        && statements.at(-1)?.kind !== "if"
        && statements.at(-1)?.kind !== "for"
        && statements.at(-1)?.kind !== "for_in"
        && statements.at(-1)?.kind !== "while"
        && this.current().range.start.line <= (statements.at(-1)?.range.end.line ?? 0)
      ) throw new PineSyntaxError("Expected a new line in block", this.current().range);
    }
    if (!this.is("eof") && this.current().range.start.column > column) {
      throw new PineSyntaxError("Unexpected additional indentation", this.current().range);
    }
    return statements;
  }

  private parseSharedTypedDeclarations(
    sharedType: string,
    qualifier: "const" | "simple" | "series" | undefined,
  ): void {
    while (this.current().value === "," && this.tokens[this.index + 1]?.kind === "identifier" && this.peekValue(2) === "=") {
      this.advance();
      const start = this.current().range.start;
      const name = this.expect("identifier");
      this.expectValue("=");
      const value = this.parseExpression();
      this.pendingStatements.push({
        kind: "declaration",
        persistence: "bar",
        ...(qualifier === undefined ? {} : { qualifier }),
        name: name.value,
        dataType: sharedType,
        value,
        range: { start, end: value.range.end },
      });
    }
  }

  private drainPendingStatements(): readonly StatementNode[] {
    return this.pendingStatements.splice(0);
  }

  private matchTypeQualifier(): "const" | "simple" | "series" | undefined {
    if (this.current().kind !== "identifier" || !["const", "simple", "series"].includes(this.current().value)) return undefined;
    return this.advance().value as "const" | "simple" | "series";
  }

  private parseExpression(minimumPrecedence = 0): ExpressionNode {
    this.skipContinuationNewlines();
    let left = this.parseUnary();
    while (true) {
      this.skipContinuationNewlines();
      const operator = this.current().value;
      const currentPrecedence = precedence[operator];
      if (currentPrecedence === undefined || currentPrecedence < minimumPrecedence) break;
      this.advance();
      const right = this.parseExpression(currentPrecedence + 1);
      left = { kind: "binary", operator, left, right, range: combine(left.range, right.range) };
    }
    if (minimumPrecedence === 0 && this.matchValue("?")) {
      const consequent = this.parseExpression();
      this.expectValue(":");
      const alternate = this.parseExpression();
      left = { kind: "conditional", test: left, consequent, alternate, range: combine(left.range, alternate.range) };
    }
    return left;
  }

  private parseUnary(): ExpressionNode {
    const current = this.current();
    if ((current.kind === "operator" && (current.value === "+" || current.value === "-")) || (current.kind === "identifier" && current.value === "not")) {
      const token = this.advance();
      const argument = this.parseUnary();
      return {
        kind: "unary",
        operator: token.value as "+" | "-" | "not",
        argument,
        range: { start: token.range.start, end: argument.range.end },
      };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExpressionNode {
    let expression = this.parsePrimary();
    while (true) {
      if (isStrictPineCompatibility(this.compatibility)) {
        // Block expressions consume their final newline while unwinding indentation.
        if (this.current().range.start.line > expression.range.end.line && this.current().range.start.column <= expression.range.start.column) break;
        if (this.parenthesisDepth > 0) this.skipNewlines();
      }
      if (this.matchValue(".")) {
        const property = this.expect("identifier");
        if (this.version === 6 && isStrictPineCompatibility(this.compatibility) && expression.kind === "history"
          && expression.range.start.offset === expression.value.range.start.offset) {
          throw new PineSyntaxError("Enclose the history reference in parentheses before accessing a member", property.range);
        }
        expression = { kind: "member", object: expression, property: property.value, range: combine(expression.range, property.range) };
        continue;
      }
      if (this.current().value === "<" && expression.kind === "member" && this.looksLikeGenericCall()) {
        const typeArguments = this.parseGenericTypeArguments();
        expression = { ...expression, typeArguments };
        continue;
      }
      if (this.matchValue("(")) {
        const args: CallArgumentNode[] = [];
        this.skipNewlines();
        if (this.current().value !== ")") {
          do {
            this.skipNewlines();
            if (this.is("identifier") && this.peekValue(1) === "=") {
              const name = this.advance().value;
              this.advance();
              args.push({ name, value: this.parseExpression() });
            } else {
              args.push({ value: this.parseExpression() });
            }
            this.skipNewlines();
          } while (this.matchValue(","));
          const closing = this.expectValue(")");
          expression = { kind: "call", callee: expression, arguments: args, range: { start: expression.range.start, end: closing.range.end } };
        } else {
          const closing = this.advance();
          expression = { kind: "call", callee: expression, arguments: args, range: { start: expression.range.start, end: closing.range.end } };
        }
        continue;
      }
      if (this.matchValue("[")) {
        const offset = this.parseExpression();
        const closing = this.expectValue("]");
        expression = { kind: "history", value: expression, offset, range: { start: expression.range.start, end: closing.range.end } };
        continue;
      }
      break;
    }
    return expression;
  }

  private looksLikeGenericCall(): boolean {
    let depth = 0;
    let hasIdentifier = false;
    for (let distance = 1; this.index + distance < this.tokens.length; distance += 1) {
      const token = this.tokens[this.index + distance]!;
      if (token.kind === "identifier") hasIdentifier = true;
      else if (token.value === "<") depth += 1;
      else if (token.value === ">") {
        if (depth === 0) return hasIdentifier && this.tokens[this.index + distance + 1]?.value === "(";
        depth -= 1;
      } else if (![".", "[", "]", ","].includes(token.value)) return false;
    }
    return false;
  }

  private parseGenericTypeArguments(): string[] {
    this.expectValue("<");
    const result: string[] = [];
    let current = "";
    let depth = 0;
    while (!this.is("eof")) {
      const token = this.current();
      if (token.value === ">" && depth === 0) {
        this.advance();
        if (current.length > 0) result.push(current);
        return result;
      }
      if (token.value === "," && depth === 0) {
        this.advance();
        result.push(current);
        current = "";
        continue;
      }
      if (token.value === "<") depth += 1;
      else if (token.value === ">") depth -= 1;
      current += this.advance().value;
    }
    throw new PineSyntaxError("Unterminated generic type arguments", this.current().range);
  }

  private parsePrimary(): ExpressionNode {
    this.skipContinuationNewlines();
    const token = this.advance();
    if (token.kind === "number") return { kind: "literal", value: Number(token.value), numericType: token.value.includes(".") ? "float" : "int", range: token.range };
    if (token.kind === "color") return { kind: "literal", value: token.value, literalType: "color", range: token.range };
    if (token.kind === "string") return { kind: "literal", value: token.value, range: token.range };
    if (token.kind === "identifier") {
      if (token.value === "if") return this.parseIfExpression(token);
      if (token.value === "while") return this.parseWhileExpression(token);
      if (token.value === "for") return this.parseForExpression(token);
      if (token.value === "switch") return this.parseSwitchExpression(token);
      if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true", range: token.range };
      if (token.value === "na" && this.current().value !== "(") return { kind: "literal", value: null, range: token.range };
      return { kind: "identifier", name: token.value, range: token.range };
    }
    if (token.value === "(") {
      const expression = this.parseExpression();
      const closing = this.expectValue(")");
      return {
        ...expression,
        range: { start: token.range.start, end: closing.range.end },
      };
    }
    if (token.value === "[") {
      const elements: ExpressionNode[] = [];
      if (!this.matchValue("]")) {
        do {
          elements.push(this.parseExpression());
        } while (this.matchValue(","));
        const closing = this.expectValue("]");
        return { kind: "tuple", elements, range: { start: token.range.start, end: closing.range.end } };
      }
      return { kind: "tuple", elements, range: token.range };
    }
    throw new PineSyntaxError("Expected an expression", token.range);
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private typedDeclarationBoundary(): number | undefined {
    if (!this.is("identifier")) return undefined;
    let angleDepth = 0;
    for (let position = this.index + 1; position < this.tokens.length; position += 1) {
      const token = this.tokens[position]!;
      if (token.kind === "newline" || token.kind === "eof") return undefined;
      if (angleDepth === 0 && token.kind === "identifier" && this.tokens[position + 1]?.value === "=") return position;
      if (token.value === "<") angleDepth += 1;
      else if (token.value === ">") {
        angleDepth -= 1;
        if (angleDepth < 0) return undefined;
      } else if (token.kind !== "identifier" && ![".", "[", "]", ","].includes(token.value)) {
        return undefined;
      }
    }
    return undefined;
  }

  private typeFieldBoundary(): number | undefined {
    if (!this.is("identifier")) return undefined;
    let angleDepth = 0;
    for (let position = this.index + 1; position < this.tokens.length; position += 1) {
      const token = this.tokens[position]!;
      const next = this.tokens[position + 1];
      if (angleDepth === 0 && token.kind === "identifier" && (next?.value === "=" || next?.kind === "newline" || next?.kind === "eof")) return position;
      if (token.kind === "newline" || token.kind === "eof") return undefined;
      if (token.value === "<") angleDepth += 1;
      else if (token.value === ">") {
        angleDepth -= 1;
        if (angleDepth < 0) return undefined;
      } else if (token.kind !== "identifier" && ![".", "[", "]", ","].includes(token.value)) return undefined;
    }
    return undefined;
  }

  private consumeTypeAnnotation(boundary: number): string {
    let value = "";
    while (this.index < boundary) {
      const token = this.advance();
      value += token.value === "," ? ", " : token.value;
    }
    return value;
  }

  private advance(): Token {
    const token = this.current();
    if (token.kind !== "eof") this.index += 1;
    if (token.kind === "operator" && token.value === "(") this.parenthesisDepth++;
    else if (token.kind === "operator" && token.value === ")") this.parenthesisDepth--;
    return token;
  }

  private is(kind: Token["kind"]): boolean {
    return this.current().kind === kind;
  }

  private peekValue(distance: number): string {
    return this.tokens[this.index + distance]?.value ?? "";
  }

  private matchIdentifier(value: string): boolean {
    if (this.current().kind === "identifier" && this.current().value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchValue(value: string): boolean {
    if (this.current().value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: Token["kind"]): Token {
    if (!this.is(kind)) throw new PineSyntaxError(`Expected ${kind}`, this.current().range);
    return this.advance();
  }

  private expectValue(value: string): Token {
    if (this.current().value !== value) throw new PineSyntaxError(`Expected ${JSON.stringify(value)}`, this.current().range);
    return this.advance();
  }

  private skipNewlines(): void {
    while (this.is("newline")) this.advance();
  }

  private skipContinuationNewlines(): void {
    if (!this.is("newline")) return;
    if (isStrictPineCompatibility(this.compatibility) && this.parenthesisDepth > 0) { this.skipNewlines(); return; }
    const previous = this.tokens[this.index - 1]?.value ?? "";
    let nextIndex = this.index;
    while (this.tokens[nextIndex]?.kind === "newline") nextIndex += 1;
    const next = this.tokens[nextIndex];
    const continuesBefore = next !== undefined
      && next.range.start.column > this.statementColumn
      && next.range.start.column !== this.statementColumn + 4
      && (precedence[next.value] !== undefined || next.value === "?" || next.value === ":");
    if (lineContinuationAfter.has(previous) || continuesBefore) this.skipNewlines();
  }
}

function combine(left: SourceRange, right: SourceRange): SourceRange {
  return { start: left.start, end: right.end };
}
