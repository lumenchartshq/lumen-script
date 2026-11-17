import type { PineQualifier, PineVersion, SourceRange } from "../contracts/index.js";

export interface ProgramNode {
  readonly version: PineVersion;
  readonly statements: readonly StatementNode[];
}

export type StatementNode = DeclarationNode | TupleDeclarationNode | AssignmentNode | MemberAssignmentNode | ExpressionStatementNode | FunctionDeclarationNode | MethodDeclarationNode | TypeDeclarationNode | EnumDeclarationNode | IfStatementNode | OnceStatementNode | WhileStatementNode | ForStatementNode | ForInStatementNode | LoopControlNode;

export interface EnumFieldNode {
  readonly name: string;
  readonly title: string;
  readonly range: SourceRange;
}

export interface EnumDeclarationNode {
  readonly kind: "enum";
  readonly name: string;
  readonly exported?: boolean;
  readonly fields: readonly EnumFieldNode[];
  readonly range: SourceRange;
}

export interface TypeFieldNode {
  readonly dataType: string;
  readonly name: string;
  readonly defaultValue?: ExpressionNode;
  readonly range: SourceRange;
}

export interface TypeDeclarationNode {
  readonly kind: "type";
  readonly name: string;
  readonly exported?: boolean;
  readonly fields: readonly TypeFieldNode[];
  readonly range: SourceRange;
}

export interface LoopControlNode {
  readonly kind: "break" | "continue";
  readonly range: SourceRange;
}

export interface TupleDeclarationNode {
  readonly kind: "tuple_declaration";
  readonly names: readonly string[];
  readonly value: ExpressionNode;
  readonly range: SourceRange;
}

export interface WhileStatementNode {
  readonly kind: "while";
  readonly test: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface ForStatementNode {
  readonly kind: "for";
  readonly variable: string;
  readonly start: ExpressionNode;
  readonly end: ExpressionNode;
  readonly step?: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface ForInStatementNode {
  readonly kind: "for_in";
  readonly variables: readonly string[];
  readonly collection: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface IfStatementNode {
  readonly kind: "if";
  readonly test: ExpressionNode;
  readonly consequent: readonly StatementNode[];
  readonly alternate: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface OnceStatementNode {
  readonly kind: "once";
  readonly test: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface FunctionParameterNode {
  readonly name: string;
  readonly dataType?: string;
  readonly qualifier?: PineQualifier;
  readonly defaultValue?: ExpressionNode;
  readonly range: SourceRange;
}

export interface FunctionDeclarationNode {
  readonly kind: "function";
  readonly exported?: boolean;
  readonly name: string;
  readonly parameters: readonly FunctionParameterNode[];
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface MethodDeclarationNode {
  readonly kind: "method";
  readonly exported?: boolean;
  readonly name: string;
  readonly parameters: readonly FunctionParameterNode[];
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface DeclarationNode {
  readonly kind: "declaration";
  readonly persistence: "bar" | "var" | "varip";
  readonly qualifier?: Exclude<PineQualifier, "input">;
  readonly name: string;
  readonly dataType?: string;
  readonly value: ExpressionNode;
  readonly range: SourceRange;
}

export interface AssignmentNode {
  readonly kind: "assignment";
  readonly name: string;
  readonly value: ExpressionNode;
  readonly range: SourceRange;
}

export interface MemberAssignmentNode {
  readonly kind: "member_assignment";
  readonly object: ExpressionNode;
  readonly property: string;
  readonly operator?: "+" | "-" | "*" | "/" | "%";
  readonly value: ExpressionNode;
  readonly range: SourceRange;
}

export interface ExpressionStatementNode {
  readonly kind: "expression";
  readonly expression: ExpressionNode;
  readonly range: SourceRange;
}

export type ExpressionNode =
  | LiteralNode
  | IdentifierNode
  | MemberNode
  | CallNode
  | HistoryNode
  | UnaryNode
  | BinaryNode
  | ConditionalNode
  | IfExpressionNode
  | WhileExpressionNode
  | ForExpressionNode
  | ForInExpressionNode
  | SwitchExpressionNode
  | TupleNode;

export interface TupleNode {
  readonly kind: "tuple";
  readonly elements: readonly ExpressionNode[];
  readonly range: SourceRange;
}

export interface SwitchCaseNode {
  readonly test?: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface SwitchExpressionNode {
  readonly kind: "switch";
  readonly discriminant?: ExpressionNode;
  readonly cases: readonly SwitchCaseNode[];
  readonly range: SourceRange;
}

export interface IfExpressionNode {
  readonly kind: "if_expression";
  readonly test: ExpressionNode;
  readonly consequent: readonly StatementNode[];
  readonly alternate: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface WhileExpressionNode {
  readonly kind: "while_expression";
  readonly test: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface ForExpressionNode {
  readonly kind: "for_expression";
  readonly variable: string;
  readonly start: ExpressionNode;
  readonly end: ExpressionNode;
  readonly step?: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface ForInExpressionNode {
  readonly kind: "for_in_expression";
  readonly variables: readonly string[];
  readonly collection: ExpressionNode;
  readonly body: readonly StatementNode[];
  readonly range: SourceRange;
}

export interface LiteralNode {
  readonly kind: "literal";
  readonly value: number | string | boolean | null;
  readonly literalType?: "color";
  readonly numericType?: "int" | "float";
  readonly range: SourceRange;
}

export interface IdentifierNode {
  readonly kind: "identifier";
  readonly name: string;
  readonly range: SourceRange;
}

export interface MemberNode {
  readonly kind: "member";
  readonly object: ExpressionNode;
  readonly property: string;
  readonly typeArguments?: readonly string[];
  readonly range: SourceRange;
}

export interface CallArgumentNode {
  readonly name?: string;
  readonly value: ExpressionNode;
}

export interface CallNode {
  readonly kind: "call";
  readonly callee: ExpressionNode;
  readonly arguments: readonly CallArgumentNode[];
  readonly range: SourceRange;
}

export interface HistoryNode {
  readonly kind: "history";
  readonly value: ExpressionNode;
  readonly offset: ExpressionNode;
  readonly range: SourceRange;
}

export interface UnaryNode {
  readonly kind: "unary";
  readonly operator: "+" | "-" | "not";
  readonly argument: ExpressionNode;
  readonly range: SourceRange;
}

export interface BinaryNode {
  readonly kind: "binary";
  readonly operator: string;
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
  readonly forceFloatDivision?: boolean;
  readonly range: SourceRange;
}

export interface ConditionalNode {
  readonly kind: "conditional";
  readonly test: ExpressionNode;
  readonly consequent: ExpressionNode;
  readonly alternate: ExpressionNode;
  readonly range: SourceRange;
}
