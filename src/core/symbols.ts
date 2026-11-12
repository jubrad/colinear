/**
 * Finding your way around a review's checkout without a language server — the
 * pure half, shared by the view (which symbol is on this line?) and the daemon
 * (what kind of mention is this hit?).
 *
 * Deliberately textual. A review is read across every language a PR can touch,
 * and a language server per language, per checkout, is a lot of machinery to
 * answer "who calls this?" — a question a word-match over the tree answers well
 * enough to be useful, provided each hit says what kind of mention it is. The
 * classification is a heuristic and is presented as one: definitions first,
 * because that is usually what you went looking for, then calls, then the rest.
 */

/** What `/` and `*` ask the daemon for. */
export type SearchMode = 'grep' | 'refs';

/** What a hit is to the symbol searched for — absent on a plain text search. */
export type HitKind = 'def' | 'call' | 'ref' | 'import';

export interface CodeHit {
  /** path relative to the repository root — the same spelling the diff uses */
  file: string;
  line: number;
  text: string;
  kind?: HitKind;
}

export interface CodeSearchResult {
  mode: SearchMode;
  query: string;
  hits: CodeHit[];
  /** more matched than were returned */
  truncated?: boolean;
  /** the search could not run: a bad pattern, no checkout yet */
  error?: string;
}

/**
 * Words that are never what you meant by "this symbol" — keywords and the
 * handful of built-ins every line is full of. Union across the languages the
 * highlighter knows; a word that is a keyword in one and a name in another
 * (`type`, `match`) stays out, because offering `type` on every TypeScript line
 * is worse than not offering it on the odd Python one.
 */
const NOT_A_SYMBOL = new Set(
  `abstract and as async await break case catch class const continue crate def default defer del delete do dyn elif
  else enum export extends extern false final finally fn for from func function go goto if impl implements import in
  instanceof interface is lambda let loop match mod module move mut namespace new nil none not null of or package pass
  private protected pub public raise readonly ref return self Self select static struct super switch this throw throws
  trait true try type typeof undefined unsafe use val var void where while with yield
  any bool boolean string number int i32 i64 u8 u32 u64 usize f64 str String Vec Option Result Some Ok Err None True False
  async_trait println format`.split(/\s+/),
);

const IDENT = /[A-Za-z_$][\w$]*/g;

/** Regex-escape an identifier (`$` is legal in JS names). */
function esc(name: string): string {
  return name.replace(/[$]/g, '\\$');
}

/** Modifiers that may precede a method declaration's name. */
const MODIFIERS = '(?:(?:export|public|private|protected|internal|static|async|override|readonly|abstract|final|virtual|default|pub(?:\\([^)]*\\))?|unsafe|const|extern)\\s+)*';
/** Words that introduce a named declaration in one language or another. */
const DECL = '(?:function\\*?|func|fn|def|class|struct|enum|union|trait|interface|type|impl|module|mod|const|let|var|val|static|macro_rules!|protocol|object)';

/**
 * The name a line declares, if it declares one: `function foo(`, `def foo`,
 * `fn foo`, `func (r *T) Foo(`, `const foo =`, a method `foo(a, b) {`.
 */
export function declaredOn(text: string): string | undefined {
  const goMethod = /\bfunc\s*\([^)]*\)\s*([A-Za-z_]\w*)\s*[(<[]/.exec(text);
  if (goMethod) return goMethod[1];
  const decl = new RegExp(`\\b${DECL}\\s+([A-Za-z_$][\\w$]*)`).exec(text);
  if (decl && !NOT_A_SYMBOL.has(decl[1])) return decl[1];
  const method = new RegExp(`^\\s*${MODIFIERS}([A-Za-z_$][\\w$]*)\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]*)?\\{\\s*$`).exec(text);
  if (method && !NOT_A_SYMBOL.has(method[1])) return method[1];
  return undefined;
}

/**
 * The symbols on a line, best guess first: what the line declares, then what
 * it calls, then every other name on it. The view offers these in order, so
 * the common case — standing on a definition and asking who calls it — is one
 * keypress.
 */
export function symbolsOn(text: string): string[] {
  // a string literal's words are not symbols; a comment's mostly are not either
  const code = text
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, ' ')
    .replace(/(?:\/\/|#(?![[!])|--\s).*$/, ' ');
  const seen = new Set<string>();
  const called: string[] = [];
  const rest: string[] = [];
  for (const m of code.matchAll(IDENT)) {
    const word = m[0];
    if (word.length < 2 || NOT_A_SYMBOL.has(word) || seen.has(word)) continue;
    seen.add(word);
    const after = code.slice((m.index ?? 0) + word.length);
    (/^\s*(?:<[^<>()]*>)?\s*!?\(/.test(after) ? called : rest).push(word);
  }
  const declared = declaredOn(text);
  const ordered = [...called, ...rest].filter((w) => w !== declared);
  return declared ? [declared, ...ordered] : ordered;
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** The identifiers on a row of code — what j/l step between and * searches for. */
export function wordsIn(text: string): Word[] {
  return [...text.matchAll(IDENT)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** The word at a column: the one covering it, or failing that the nearest — a column carried from a longer line still lands somewhere. */
export function wordAt(text: string, col: number): Word | undefined {
  const words = wordsIn(text);
  const covering = words.find((w) => col >= w.start && col < w.end);
  if (covering) return covering;
  let best: Word | undefined;
  for (const w of words) if (!best || Math.abs(w.start - col) < Math.abs(best.start - col)) best = w;
  return best;
}

/** The word after (1) or before (-1) the one in hand; from none, the first or the last. Stops at the ends. */
export function stepWord(text: string, from: Word | undefined, dir: 1 | -1): Word | undefined {
  const words = wordsIn(text);
  if (!from) return dir === 1 ? words[0] : words.at(-1);
  const i = words.findIndex((w) => w.start === from.start);
  return words[Math.max(0, Math.min(words.length - 1, i + dir))] ?? from;
}

/** What kind of mention of `name` this line is. */
export function classifyHit(name: string, text: string): HitKind {
  const n = esc(name);
  const imports =
    /^\s*(?:import\b|from\s+\S+\s+import\b|use\s|pub\s+use\s|#include\b|(?:const|let|var)\s.*=\s*require\s*\()/.test(text) ||
    /^\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\b/.test(text);
  if (imports) return 'import';
  if (declaredOn(text) === name) return 'def';
  if (new RegExp(`(?:^|[^\\w$])${n}\\s*(?:<[^<>()]*>)?\\s*!?\\(`).test(text)) return 'call';
  return 'ref';
}

const KIND_ORDER: Record<HitKind, number> = { def: 0, call: 1, ref: 2, import: 3 };

/**
 * The order a list of hits is read in: by kind (definitions, calls, other
 * mentions, imports), and within that the files this change touches first —
 * the callers a PR might have broken are the ones it is worth checking.
 */
export function rankHits(hits: CodeHit[], inChange: (file: string) => boolean): CodeHit[] {
  return [...hits].sort(
    (a, b) =>
      (a.kind ? KIND_ORDER[a.kind] : 0) - (b.kind ? KIND_ORDER[b.kind] : 0) ||
      Number(inChange(b.file)) - Number(inChange(a.file)) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}
