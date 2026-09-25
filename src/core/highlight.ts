import { createRequire } from 'node:module';
import Prism from 'prismjs';
import type { DiffLine, Span, TokenKind } from './diff.js';

/**
 * Syntax tokens for the diff view. SPIKE.
 *
 * Turns a diff line's text into coloured spans. The render path (diff.ts's
 * span model, AnnotatedDiff's DiffRow, diff.check.ts's invariants) is what this
 * proves; the token *source* is deliberately the simplest thing that exercises
 * it — Prism over each line's own text.
 *
 * Two shortcuts the production version removes, both noted where they bite:
 *
 *  - **Per-line, not whole-file.** The design tokenizes the new-side file out of
 *    the review worktree and maps hunk lines to it, so a string or comment opened
 *    above the hunk lexes correctly. Here each line is lexed alone, which is what
 *    `delta`/`bat` do and is wrong at exactly those boundaries. The span shape is
 *    identical either way, so swapping the source later touches only this file.
 *  - **A fixed grammar set**, loaded once below. Production lazy-loads per language.
 *
 * Grammars are pulled in with `createRequire`: Prism's component files are CJS
 * that mutate the singleton, and requiring them synchronously keeps
 * `highlightLine` synchronous (it runs inside a render memo) without a
 * top-level await or an async init the TUI would have to wait on.
 */

const require = createRequire(import.meta.url);

/** file extension → Prism language id. The set the spike loads. */
const LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

/**
 * Grammars to register, **dependencies first**. A Prism component throws when a
 * grammar it extends is not loaded yet — `markdown` needs `markup`, `tsx` needs
 * `jsx` needs `javascript` needs `clike` — and the throw is swallowed below, so
 * a wrong order silently drops a language (the spike shipped with `.tsx` plain
 * for exactly this reason). Base grammars lead so the dependents resolve.
 */
const GRAMMARS = [
  'markup',
  'clike',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'go',
  'rust',
  'sql',
  'yaml',
  'markdown',
];

// load each grammar once; a missing component must never take the view down
const loaded = new Set<string>();
for (const lang of GRAMMARS) {
  try {
    require(`prismjs/components/prism-${lang}.js`);
    loaded.add(lang);
  } catch {
    // a grammar that will not load just means that language renders plain
  }
}

/** The Prism token types we colour, everything else falls to the default fg. */
function kindOf(prismType: string): TokenKind | undefined {
  switch (prismType) {
    case 'comment':
    case 'doc-comment':
      return 'comment';
    case 'string':
    case 'char':
    case 'regex':
    case 'template-string':
    case 'attr-value':
      return 'string';
    case 'keyword':
    case 'boolean':
    case 'important':
      return 'keyword';
    case 'number':
      return 'number';
    case 'class-name':
    case 'builtin':
      return 'type';
    // markdown, mapped onto the same five kinds rather than new colours
    case 'title':
      return 'keyword';
    case 'code':
    case 'code-snippet':
      return 'string';
    case 'url':
    case 'url-reference':
      return 'number';
    case 'bold':
    case 'italic':
      return 'type';
    case 'blockquote':
    case 'hr':
    case 'strike':
      return 'comment';
    default:
      return undefined;
  }
}

/** The language for a path, if the spike loaded a grammar for it. */
export function langFor(file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const lang = LANGS[ext];
  return lang && loaded.has(lang) ? lang : undefined;
}

/**
 * Flatten Prism's token tree into a flat span list that concatenates back to
 * exactly the input — the invariant diff.check.ts enforces. A raw string leaf
 * inherits its parent token's kind (so the text inside a `string` stays a
 * string); a nested token uses its own kind, falling back to the parent.
 */
function flatten(tokens: Array<string | Prism.Token>, out: Span[], parent?: TokenKind): void {
  for (const t of tokens) {
    if (typeof t === 'string') {
      push(out, t, parent);
      continue;
    }
    const kind = kindOf(t.type) ?? parent;
    if (typeof t.content === 'string') push(out, t.content, kind);
    else if (Array.isArray(t.content)) flatten(t.content as Array<string | Prism.Token>, out, kind);
    else flatten([t.content as Prism.Token], out, kind);
  }
}

/** Append text, merging into the previous span when the kind matches — fewer nodes. */
function push(out: Span[], text: string, token?: TokenKind): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.token === token) last.text += text;
  else out.push(token ? { text, token } : { text });
}

/** One line's spans. Plain (one span) when there is no grammar for the file. */
export function highlightLine(text: string, lang: string | undefined): Span[] {
  if (!lang || !Prism.languages[lang]) return [{ text }];
  const out: Span[] = [];
  flatten(Prism.tokenize(text, Prism.languages[lang]), out);
  return out;
}

/**
 * Set `spans` on every code line of a parsed diff, in place, once per diff.
 * Chrome rows (file/hunk/meta) are left plain — they are not source.
 */
export function highlightDiff(lines: DiffLine[]): DiffLine[] {
  for (const line of lines) {
    if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'context') continue;
    line.spans = highlightLine(line.text, langFor(line.file));
  }
  return lines;
}
