import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffOver, expandDiff, searchCode } from './codesearch.js';
import { fileStats, filesIn, openedFiles, parseDiff, postableLines } from './diff.js';
import { classifyHit, symbolsOn } from './symbols.js';

/**
 * Reading around a diff, against a real repository: a throwaway one with a
 * base commit and a change on top, so every git call here is the one the
 * daemon makes.
 *
 * What matters, and what a typecheck cannot see: widening a file keeps every
 * line number where it was (findings are anchored to them), it never makes a
 * line look commentable that GitHub would refuse, an opened file is told apart
 * from a changed one, and a search for a symbol puts its definition first.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'colinear-codesearch-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=check@example.com', '-c', 'user.name=check', ...args], { encoding: 'utf8' });

try {
  const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`);
  const lib = (extra: string) =>
    ['export function retryCall(n: number) {', ...body.slice(0, 20), extra, ...body.slice(20), '}', ''].join('\n');
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'lib.ts'), lib('  return n;'));
  writeFileSync(join(dir, 'caller.ts'), "import { retryCall } from './lib';\n\nexport const x = retryCall(3);\nconst y = retryCall;\n");
  writeFileSync(join(dir, '.colinear-review.md'), 'retryCall is quoted here and must not be found\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(dir, 'lib.ts'), lib('  return n * 2;'));
  git('commit', '-q', '-am', 'change');

  const { text, range } = await diffOver(dir, ['nope/missing...HEAD', 'HEAD~1...HEAD']);
  check('diffOver falls back to the range that works', range === 'HEAD~1...HEAD', String(range));
  const base = parseDiff(text);
  const wideText = await expandDiff(dir, text, range, ['lib.ts', 'caller.ts']);
  const wide = parseDiff(wideText);

  check('the change alone is one file', filesIn(base).join() === 'lib.ts', filesIn(base).join());
  check('an unchanged file opens after the change', filesIn(wide).join() === 'lib.ts,caller.ts', filesIn(wide).join());
  check('an opened file is told apart from a changed one', [...openedFiles(wide)].join() === 'caller.ts');
  check('widening shows the whole file', wide.filter((l) => l.file === 'lib.ts' && l.newLine !== undefined).length === 43);
  const at = (lines: typeof base, n: number) => lines.find((l) => l.file === 'lib.ts' && l.newLine === n && l.kind !== 'del')?.text;
  check('a line keeps its number when the file is widened', at(base, 22) === at(wide, 22) && at(wide, 22) === '  return n * 2;');
  check('the opened file is numbered as the file is', wide.find((l) => l.file === 'caller.ts' && l.newLine === 3)?.text === 'export const x = retryCall(3);');
  const before = [...postableLines(base)].sort().join();
  const after = [...postableLines(wide)].sort().join();
  check('widening makes no new line commentable', before === after, `${before} vs ${after}`);
  check('three lines either side of a change are commentable', postableLines(wide).has('lib.ts:19') && !postableLines(wide).has('lib.ts:18'));
  check('nothing in an opened file is commentable', ![...postableLines(wide)].some((k) => k.startsWith('caller.ts:')));
  const stat = (lines: typeof base) => fileStats(lines).map((s) => `${s.file} +${s.added} -${s.removed}`).join();
  check('a file counts what it adds and removes', stat(base) === 'lib.ts +1 -1', stat(base));
  check('widening changes no count, and an opened file is not a change', stat(wide) === stat(base), stat(wide));
  check('expanding nothing changes nothing', (await expandDiff(dir, text, range, [])) === text);
  check('a file that is not there is skipped', (await expandDiff(dir, text, range, ['missing.ts'])) === text);

  const refs = await searchCode(dir, 'refs', 'retryCall');
  const kinds = refs.hits.map((h) => `${h.file}:${h.line}:${h.kind}`).sort().join(' ');
  check(
    'call sites are found and classified',
    kinds === 'caller.ts:1:import caller.ts:3:call caller.ts:4:ref lib.ts:1:def',
    kinds,
  );
  check('the review document is never searched', !refs.hits.some((h) => h.file.includes('colinear-review')));
  const grep = await searchCode(dir, 'grep', 'RETURN N');
  check('a capital makes the search case-sensitive', grep.hits.length === 0);
  check('lowercase is case-insensitive', (await searchCode(dir, 'grep', 'return n')).hits.length === 1);
  check('no match is an answer, not an error', !grep.error);
  check('a bad pattern says why', Boolean((await searchCode(dir, 'grep', 'a(')).error));

  check('the declared name is the best guess', symbolsOn('export async function retryCall(n: number) {')[0] === 'retryCall');
  check('a called name comes before the rest', symbolsOn('const y = retryCall(other);')[0] === 'y' && symbolsOn('  retryCall(other);')[0] === 'retryCall');
  check('words in strings are not symbols', !symbolsOn('log("retryCall failed")').includes('retryCall'));
  check('a go method is a definition', classifyHit('Fetch', 'func (r *Repo) Fetch(ctx context.Context) error {') === 'def');
  check('a rust macro call is a call', classifyHit('vec', 'let v = vec![1];') !== 'def');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`codesearch: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — widening a file keeps its line numbers and adds nothing commentable, an opened file\n     is marked as one, and call sites come back classified with the definition first');
