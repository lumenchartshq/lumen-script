import type { MethodDeclarationNode } from "./ast.js";
import type { PineBindingRename } from "./binding-renames.js";
import { lex } from "./lexer.js";
import { parse } from "./parser.js";
import { bindProgram } from "./semantic-binder.js";
import { methodReferenceTypeNames, methodRequiredSignature } from "./method-signature.js";
import { PINE_COMPATIBILITY } from "../contracts/index.js";

/** Resolve imported receiver syntax using temporary, typed export aliases. */
export function renamePineReceiverMethods(source: string, renames: readonly PineBindingRename[], startOffset = 0): { source: string; used: readonly string[] } {
  if (renames.length === 0) return { source, used: [] };
  const program = parse(source, /^\s*\/\/@version\s*=\s*5\s*$/mu.test(source) ? 5 : 6, PINE_COMPATIBILITY.strict);
  const referenceTypes = methodReferenceTypeNames(program.statements);
  const aliases = new Map<MethodDeclarationNode, string>();
  const seen = new Set<string>();
  for (const rename of renames) {
    const key = `${rename.name}\u0000${rename.replacement}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const statement of program.statements) {
      if (statement.kind !== "method" || statement.name !== rename.replacement) continue;
      const local = program.statements.some((candidate) => candidate.kind === "method"
        && candidate.name === rename.name && methodRequiredSignature(candidate, referenceTypes) === methodRequiredSignature(statement, referenceTypes));
      if (!local) aliases.set({ ...statement, name: rename.name }, rename.replacement);
    }
  }
  const ownerBySignature = new Map<string, string>();
  for (const [method, owner] of aliases) {
    const key = `${method.name}\u0000${methodRequiredSignature(method, referenceTypes)}`;
    const previous = ownerBySignature.get(key);
    if (previous !== undefined && previous !== owner) throw new Error(`Ambiguous imported receiver method '${method.name}'; use the library-qualified call`);
    ownerBySignature.set(key, owner);
  }
  // Actual local methods precede import aliases, preserving local ownership.
  const semantic = bindProgram({ ...program, statements: [...program.statements, ...aliases.keys()] }, PINE_COMPATIBILITY.strict);
  const tokens = lex(source, PINE_COMPATIBILITY.strict);
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const used = new Set<string>();
  for (const [call, method] of semantic.methodBindings) {
    if (call.range.start.offset < startOffset || call.callee.kind !== "member") continue;
    const candidates = [...(semantic.methodCandidates.get(call) ?? [])];
    if (!candidates.some((candidate) => candidate !== undefined && aliases.has(candidate))) continue;
    const targets = new Set(candidates.map((candidate) => candidate === undefined ? "<builtin>" : aliases.get(candidate) ?? candidate.name));
    if (targets.size > 1) throw new Error(`Polymorphic imported receiver method '${method.name}' requires library-qualified calls`);
    const replacement = aliases.get(method);
    if (replacement === undefined) continue;
    const ambiguous = [...aliases.keys()].some((candidate) => candidate !== method && candidate.name === method.name && methodRequiredSignature(candidate, referenceTypes) === methodRequiredSignature(method, referenceTypes));
    if (ambiguous) throw new Error(`Ambiguous imported receiver method '${method.name}'; use the library-qualified call`);
    const member = call.callee;
    const token = tokens.find((item) => item.range.start.offset >= member.object.range.end.offset && item.range.end.offset <= member.range.end.offset && item.value === member.property);
    if (token === undefined) continue;
    edits.push({ start: token.range.start.offset, end: token.range.end.offset, value: replacement });
    used.add(replacement);
  }
  let linked = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) linked = linked.slice(0, edit.start) + edit.value + linked.slice(edit.end);
  return { source: linked, used: [...used] };
}
