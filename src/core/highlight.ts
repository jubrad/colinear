import { createRequire } from 'node:module';
import Prism from 'prismjs';
import type { DiffLine, Span, TokenKind } from './diff.js';

/**
 * Syntax tokens for the diff view: a line's text becomes coloured spans.
 *
 * **Lexed per hunk, not per line.** A hunk's lines are consecutive, so the
 * new-side block (context + additions) and the old-side block (context +
 * deletions) are each tokenized whole — a block comment, template literal or
 * raw string that spans several lines then colours every one of them, which
 * lexing a line in isolation (what `delta`/`bat` do) cannot manage. The only
 * construct this still gets wrong is one opened *before* the hunk's first line,
 * i.e. outside the diff entirely; fixing that needs the whole file, which lives
 * in the review worktree on the daemon's machine — not here, where a remote
 * daemon sends only the diff string. A daemon-side pass could carry it later,
 * but per-hunk is correct for everything the diff actually contains.
 *
 * Grammars load with `createRequire`: Prism's components are CJS that mutate the
 * singleton, and requiring them synchronously keeps highlighting sync (it runs
 * inside a render memo) with no top-level await. The whole set is ~10ms at
 * import, paid once when the TUI starts.
 */

const require = createRequire(import.meta.url);

/** file extension → Prism language id. */
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
 * a wrong order silently drops a language (an earlier cut rendered `.tsx` plain
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

/** The language for a path, if a grammar is loaded for it. */
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
 * Spans for a block of lines tokenized together, split back out per line. The
 * block is joined with newlines and lexed once, so a token that spans lines
 * (a block comment, a multi-line string) keeps its class on every line; the
 * flat result is then cut at the newlines. Lossless: the returned arrays
 * concatenate to the inputs, one array per input line.
 */
function highlightBlock(texts: string[], lang: string): Span[][] {
  const flat = highlightLine(texts.join('\n'), lang);
  const out: Span[][] = [[]];
  for (const s of flat) {
    const parts = s.text.split('\n');
    for (let j = 0; j < parts.length; j++) {
      if (j > 0) out.push([]);
      if (parts[j]) push(out[out.length - 1], parts[j], s.token);
    }
  }
  // a lossless tokenizer yields exactly one array per line; if some grammar ever
  // breaks that, fall back to plain rather than mis-align the whole hunk
  return out.length === texts.length ? out : texts.map((t) => (t ? [{ text: t }] : []));
}

/**
 * Set `spans` on every code line of a parsed diff, in place, once per diff.
 * Chrome rows (file/hunk/meta) are left plain — they are not source. Code lines
 * are grouped into hunk bodies (a run of context/add/del in one file) and each
 * body's two sides are lexed as blocks so multi-line constructs colour right.
 */
export function highlightDiff(lines: DiffLine[]): DiffLine[] {
  let i = 0;
  const isCode = (l: DiffLine) => l.kind === 'add' || l.kind === 'del' || l.kind === 'context';
  while (i < lines.length) {
    if (!isCode(lines[i])) {
      i++;
      continue;
    }
    const file = lines[i].file;
    const start = i;
    while (i < lines.length && isCode(lines[i]) && lines[i].file === file) i++;
    const body = lines.slice(start, i);
    const lang = langFor(file);
    if (!lang) {
      for (const l of body) l.spans = l.text ? [{ text: l.text }] : [];
      continue;
    }
    // new side = what the file becomes (context + additions); old side carries
    // the deletions. Context is coloured from the new side; both are in order.
    const newSide = body.filter((l) => l.kind !== 'del');
    const newSpans = highlightBlock(newSide.map((l) => l.text), lang);
    newSide.forEach((l, k) => (l.spans = newSpans[k]));
    const oldSide = body.filter((l) => l.kind !== 'add');
    if (oldSide.some((l) => l.kind === 'del')) {
      const oldSpans = highlightBlock(oldSide.map((l) => l.text), lang);
      oldSide.forEach((l, k) => {
        if (l.kind === 'del') l.spans = oldSpans[k];
      });
    }
  }
  return lines;
}
