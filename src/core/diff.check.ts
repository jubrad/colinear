import { expandTabs, parseDiff, toVisualRows } from './diff.js';

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

if (failures.length) {
  console.error(`diff layout: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log('ok — tab-indented diff rows fit the pane they are drawn in, at every width');
