import { expandTabs, parseDiff, sliceSpans, toVisualRows, type Span } from './diff.js';
import { highlightDiff, highlightLine } from './highlight.js';

/**
 * A diff row must never be drawn wider than the pane it was laid out in.
 *
 * The failure this guards against is invisible to a typechecker and to a
 * screenshot of the wrong file. A tab is one character to `String.length` and
 * to Ink's width measurement, and up to eight columns to the terminal that
 * finally draws it. On a tab-indented source (Go, Make) those three disagree,
 * and the review pane came apart three ways at once: rows wrapped at the wrong
 * column, truncated early in proportion to their indent — so the deeper the
 * nesting, the less code you could read — and were still drawn wider than the
 * pane, overflowing onto the annotation pane's border, because Ink overflows
 * rather than clips.
 *
 * So the assertion is arithmetic, not a rendering: every visual row, at every
 * pane width, has to fit the columns AnnotatedDiff gives it.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

/** Mirrors AnnotatedDiff: marker + 4-wide number + space + sign before the code. */
const GUTTER = 7;

/**
 * Columns a terminal actually paints, which is the only measure that decides
 * whether the frame survives. A tab advances to the next eight-column stop
 * however many characters it is — measuring in code units is precisely the
 * mistake being guarded against, so the assertions below must not repeat it.
 */
function drawnColumns(text: string): number {
  let n = 0;
  for (const ch of text) n = ch === '\t' ? n + 8 - (n % 8) : n + 1;
  return n;
}
const codeWidthFor = (paneWidth: number) => Math.max(8, Math.floor(paneWidth * 0.62) - 11);
const innerWidthFor = (paneWidth: number) => Math.max(30, Math.floor(paneWidth * 0.62)) - 4;

// Go, as gofmt writes it: tabs to indent, one string long enough to wrap.
const DIFF = [
  'diff --git a/pkg/provider/provider.go b/pkg/provider/provider.go',
  'index 324f3f1a..57f8e9f4 100644',
  '--- a/pkg/provider/provider.go',
  '+++ b/pkg/provider/provider.go',
  '@@ -116,7 +117,7 @@ func Provider(version string) *schema.Provider {',
  ' \t\t\t"host": {',
  ' \t\t\t\tType:        schema.TypeString,',
  '-\t\t\t\tDescription: "The Materialize host. Can also come from the `MZ_HOST` environment variable.",',
  '+\t\t\t\tDescription: "The Materialize host (self-hosted only). Setting this, including through the `MZ_HOST` environment variable, switches the provider to self-hosted mode. Leave it unset to connect to Materialize Cloud.",',
  ' \t\t\t\tDefaultFunc: schema.EnvDefaultFunc("MZ_HOST", nil),',
  '@@ -242,15 +243,64 @@ func Provider(version string) *schema.Provider {',
  '+\t\t\tdiags = append(diags, diag.Diagnostic{',
  '+\t\t\t\tSeverity: diag.Warning,',
  '+\t\t\t\tDetail: fmt.Sprintf(',
  '+\t\t\t\t\t"The provider is using self-hosted mode with host %q, which came from the MZ_HOST "+',
  '+\t\t\t\t\t\t"environment variable rather than this configuration.\\n\\n"+',
  '',
].join('\n');

// tab stops, not a blind replace: a tab advances to the next multiple of four
check('a leading tab fills to the first stop', expandTabs('\tx') === '    x');
check('two tabs reach the second stop', expandTabs('\t\tx') === '        x');
check('a tab after three characters fills one column', expandTabs('abc\tx') === 'abc x');
check('a tab on a stop still advances a full four', expandTabs('abcd\tx') === 'abcd    x');
check('text without tabs is returned as it came', expandTabs('plain text') === 'plain text');

const lines = parseDiff(DIFF);
check('the diff parsed', lines.length > 8, `${lines.length} lines`);
check(
  'no tab survives parsing',
  lines.every((l) => !l.text.includes('\t')),
  lines.filter((l) => l.text.includes('\t')).length + ' line(s) kept one',
);
check(
  'indentation survives as spaces',
  lines.some((l) => l.text.startsWith('                Type:')),
  'four tabs of gofmt nesting should land on column 16',
);

// the widths a real terminal hands this pane, narrow through very wide
for (const paneWidth of [60, 80, 100, 120, 140, 183, 220, 300]) {
  const codeWidth = codeWidthFor(paneWidth);
  const inner = innerWidthFor(paneWidth);
  const rows = toVisualRows(lines, codeWidth);
  // only add/del/context carry the gutter; DiffRow slices file/hunk/meta rows
  // to the pane width itself, so they cannot overflow however long they are
  const code = rows.filter((r) => r.line.kind === 'add' || r.line.kind === 'del' || r.line.kind === 'context');
  const over = code.filter((r) => GUTTER + drawnColumns(r.text) > inner);
  check(
    `every row fits the pane at ${paneWidth} columns`,
    over.length === 0,
    over.length ? `${over.length} row(s) overflow, worst ${Math.max(...over.map((r) => GUTTER + drawnColumns(r.text)))} > ${inner}` : '',
  );

  // wrapping may re-flow a line but must never lose or invent a character
  for (const line of lines) {
    if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'context') continue;
    const joined = rows
      .filter((r) => r.line === line)
      .map((r) => r.text)
      .join('');
    check(`wrapping is lossless at ${paneWidth} columns`, joined === line.text, line.text.slice(0, 40));
    break; // one line per width is enough to catch an off-by-one in the slice
  }
}

// ── syntax spans ─────────────────────────────────────────────────────────
//
// The render path now carries coloured spans instead of a raw string. Two
// invariants keep it honest, and they are the tab guard restated on the span
// model: a wrong flatten or a mis-cut wrap that dropped or duplicated a
// character would mis-colour the one view whose job is catching bugs.

const concat = (spans: Span[]) => spans.map((s) => s.text).join('');
const spanWidth = (spans: Span[]) => spans.reduce((n, s) => n + drawnColumns(s.text), 0);

// a real TypeScript diff, highlighted, wrapped at every width
const TS_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 1..2 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,2 +1,3 @@',
  '+  const label = "a rather long string literal that will wrap at the narrow pane widths"; // trailing note',
  '   return label;',
  '-  const gone = 12345;',
  '',
].join('\n');
const tsLines = highlightDiff(parseDiff(TS_DIFF));

for (const paneWidth of [60, 80, 100, 120, 183, 300]) {
  const rows = toVisualRows(tsLines, codeWidthFor(paneWidth));
  for (const r of rows) {
    if (r.line.kind !== 'add' && r.line.kind !== 'del' && r.line.kind !== 'context') continue;
    check(`spans concatenate to the row text at ${paneWidth}`, concat(r.spans) === r.text, JSON.stringify(r.text).slice(0, 50));
    check(`span widths sum to the row width at ${paneWidth}`, spanWidth(r.spans) === drawnColumns(r.text), `${spanWidth(r.spans)} vs ${drawnColumns(r.text)}`);
  }
}

// sliceSpans must not lose or invent a character at any cut point
{
  const spans: Span[] = [{ text: 'const ', token: 'keyword' }, { text: 'x = ' }, { text: '42', token: 'number' }];
  const whole = 'const x = 42';
  for (let cut = 0; cut <= whole.length; cut++) {
    const joined = concat(sliceSpans(spans, 0, cut)) + concat(sliceSpans(spans, cut, whole.length));
    check(`sliceSpans is lossless at cut ${cut}`, joined === whole, joined);
  }
}

// the tokenizer earns its place only if it actually classifies — a comment, a
// string and a keyword on one line, still concatenating losslessly
{
  const spans = highlightLine('const s = "hi"; // note', 'typescript');
  check('tokenizer is lossless', concat(spans) === 'const s = "hi"; // note', concat(spans));
  const kinds = new Set(spans.map((s) => s.token).filter(Boolean));
  check('tokenizer finds a keyword', kinds.has('keyword'), [...kinds].join(','));
  check('tokenizer finds a string', kinds.has('string'), [...kinds].join(','));
  check('tokenizer finds a comment', kinds.has('comment'), [...kinds].join(','));
  // the string body stays a string end to end (the flatten inherits the parent)
  const str = spans.find((s) => s.text.includes('hi'));
  check('the string literal is coloured as a string', str?.token === 'string', JSON.stringify(str));
}

// markdown: a heading, a code span and a link — mapped onto the shared kinds
{
  const heading = highlightLine('## Rate limiting', 'markdown');
  check('markdown heading is a keyword', heading.some((s) => s.token === 'keyword'), JSON.stringify(heading));
  const body = highlightLine('Set the `limit` and see [docs](http://x).', 'markdown');
  check('markdown is lossless', concat(body) === 'Set the `limit` and see [docs](http://x).', concat(body));
  const kinds = new Set(body.map((s) => s.token).filter(Boolean));
  check('markdown code span is a string', kinds.has('string'), [...kinds].join(','));
  check('markdown link is a number', kinds.has('number'), [...kinds].join(','));
}

// the load-order fix: tsx resolves rather than silently rendering plain
{
  const spans = highlightLine('const App = () => <div className="x">{n}</div>;', 'tsx');
  check('tsx is lossless', concat(spans) === 'const App = () => <div className="x">{n}</div>;', concat(spans));
  check('tsx classifies a keyword', spans.some((s) => s.token === 'keyword'), JSON.stringify(spans).slice(0, 80));
}

// an unknown language renders plain — never worse than today
{
  const spans = highlightLine('some plain text', undefined);
  check('no grammar yields one plain span', spans.length === 1 && spans[0].token === undefined, JSON.stringify(spans));
}

if (failures.length) {
  console.error(`diff layout: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — diff rows fit the pane at every width, and syntax spans are lossless and classified',
);
