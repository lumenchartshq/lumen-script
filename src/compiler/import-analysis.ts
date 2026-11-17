import type { PineCompatibility } from '../contracts/index.js';
import { lex, PineSyntaxError } from './lexer.js';
import { parse } from './parser.js';
import { isStrictPineCompatibility } from "../contracts/index.js";

/** Validate import declarations and root syntax without resolving or executing libraries. */
export function hasUnresolvedImports(source: string, compatibility: PineCompatibility): boolean {
  return maskPineImports(source, compatibility).hasImports;
}

/** Keep source offsets intact while excluding provider-resolved imports from compiler analysis. */
export function maskPineImports(source: string, compatibility: PineCompatibility): { source: string; hasImports: boolean } {
  const tokens = lex(source, compatibility);
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== 'operator') continue;
    if (token.value === '(' || token.value === '[') depth++;
    if (token.value === ')' || token.value === ']') depth--;
    if (depth > 256) throw new PineSyntaxError('Script source nesting exceeds the compilation limit', token.range);
  }
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'identifier' || token.value !== 'import') continue;
    if (i > 0 && tokens[i - 1]!.kind !== 'newline') continue;
    const lineStart = i + 1;
    let lineEnd = lineStart;
    while (tokens[lineEnd]!.kind !== 'newline' && tokens[lineEnd]!.kind !== 'eof') lineEnd++;
    const author = tokens[lineStart];
    const authorSeparator = tokens[lineStart + 1];
    const library = tokens[lineStart + 2];
    const librarySeparator = tokens[lineStart + 3];
    const version = tokens[lineStart + 4];
    const aliasKeyword = tokens[lineStart + 5];
    const alias = tokens[lineStart + 6];
    const implicitAlias = isStrictPineCompatibility(compatibility) && lineEnd - lineStart === 5;
    if ((!implicitAlias && lineEnd - lineStart !== 7) || author?.kind !== 'identifier' || authorSeparator?.value !== '/' || library?.kind !== 'identifier' || librarySeparator?.value !== '/' || version?.kind !== 'number' || !/^[1-9]\d*$/.test(version.value) || (!implicitAlias && (aliasKeyword?.value !== 'as' || alias?.kind !== 'identifier'))) {
      throw new PineSyntaxError('Invalid library import declaration', token.range);
    }
    spans.push({ start: token.range.start.offset, end: (implicitAlias ? version! : alias!).range.end.offset });
  }
  if (spans.length === 0) return { source, hasImports: false };
  const marker = source.match(/^\s*\/\/@version\s*=\s*([56])\s*$/mu);
  if (!marker) throw new PineSyntaxError('The script must declare version 5 or 6', tokens[0]!.range);
  const root: string[] = [];
  let offset = 0;
  for (const span of spans) {
    root.push(source.slice(offset, span.start), ' '.repeat(span.end - span.start));
    offset = span.end;
  }
  root.push(source.slice(offset));
  const masked = root.join('');
  parse(masked, Number(marker[1]) as 5 | 6, compatibility);
  return { source: masked, hasImports: true };
}
