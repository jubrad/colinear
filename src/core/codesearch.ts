/**
 * The daemon half of reading around a diff: search the checkout, list a
 * symbol's call sites, and widen a file's diff to the whole file — or open a
 * file the change never touched, so a call site found in it can be read in
 * the same view as everything else.
 *
 * All of it runs against the checkout the diff came from (a review's worktree
 * pinned at the reviewed sha, or a task's own), so a hit's line number is a
 * line number in the code the margin is anchored to.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandTabs, OPENED_MARK, UNCOMMITTED_MARK } from './diff.js';
import { REVIEW_FILE } from './reviewer.js';
import { classifyHit, type CodeHit, type CodeSearchResult, type SearchMode } from './symbols.js';

const exec = promisify(execFile);

/** Hits past this are not being read one by one; say there were more. */
const MAX_HITS = 500;
/** A matched line is shown, not studied: a minified file's one line is not. */
const MAX_TEXT = 240;
/** Context that turns a file's diff into the whole file. */
const WHOLE_FILE = 1_000_000;
/** An unchanged file opened for reading, past which it is not opened. */
const MAX_OPEN_LINES = 20_000;

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * `git diff <range>` over the first range that works, and which one that was —
 * the review and the self-review both fall back from the base branch to the
 * last commit, and widening a file has to ask git the same question again.
 */
export async function diffOver(worktree: string, ranges: string[]): Promise<{ text: string; range?: string }> {
  for (const range of ranges) {
    try {
      const { stdout } = await exec('git', ['-C', worktree, 'diff', range], { maxBuffer: 32 * 1024 * 1024 });
      return { text: stdout, range };
    } catch {
      // an unfetched base, or a branch with no merge base yet: try the next
    }
  }
  return { text: '' };
}

/**
 * The commit a task's branch left its base at: the merge base of the first
 * `a...b` range that resolves. The live diff is measured from here, because a
 * worktree's uncommitted work can only be compared against a commit.
 */
async function mergeBase(worktree: string, ranges: string[]): Promise<string | undefined> {
  for (const range of ranges) {
    const [from, to] = range.split('...');
    if (!from || !to) continue;
    const found = await exec('git', ['-C', worktree, 'merge-base', from, to]).catch(() => undefined);
    const sha = found?.stdout.trim();
    if (sha) return sha;
  }
  return undefined;
}

/** Untracked files past this many are listed by the next poll's agent, not diffed into this one. */
const MAX_UNTRACKED = 50;

/**
 * A task's worktree as it stands — committed, uncommitted and untracked work
 * against where the branch left its base — and which files have work not yet
 * committed. Read-only: untracked files are diffed against /dev/null rather
 * than added with `git add -N`, because the index belongs to the agent writing
 * in it. `range` is the base commit, which `git diff` (and so `expandDiff`)
 * reads as "against the working tree".
 */
export async function liveDiff(
  worktree: string,
  ranges: string[],
): Promise<{ text: string; range?: string; uncommitted: Set<string> }> {
  const base = await mergeBase(worktree, ranges);
  if (!base) return { text: '', uncommitted: new Set() };
  const spec = ['--', '.', `:(exclude)${REVIEW_FILE}`];
  const git = (args: string[]) =>
    exec('git', ['-C', worktree, ...args], { maxBuffer: 32 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch(() => '');
  const [tracked, dirty, others] = await Promise.all([
    git(['diff', base, ...spec]),
    git(['diff', '--name-only', 'HEAD', ...spec]),
    git(['ls-files', '--others', '--exclude-standard', '-z', ...spec]),
  ]);
  const untracked = others.split('\0').filter(Boolean);
  let text = tracked;
  for (const file of untracked.slice(0, MAX_UNTRACKED)) {
    // --no-index exits 1 when the files differ, which here they always do
    const added = await exec('git', ['diff', '--no-index', '--', '/dev/null', file], { cwd: worktree, maxBuffer: 16 * 1024 * 1024 })
      .then((r) => r.stdout)
      .catch((err: { stdout?: string }) => err.stdout ?? '');
    if (added && !/^Binary files/m.test(added)) text += added.endsWith('\n') ? added : `${added}\n`;
  }
  return { text, range: base, uncommitted: new Set([...dirty.split('\n').filter(Boolean), ...untracked]) };
}

/** Put `mark` as a meta row under the header of every file in `files` — how a diff says which files are which. */
export function markFiles(text: string, files: Set<string>, mark: string = UNCOMMITTED_MARK): string {
  if (!files.size) return text;
  return splitDiff(text)
    .map((c) => {
      if (!c.file || !files.has(c.file)) return c.text;
      const nl = c.text.indexOf('\n');
      return nl === -1 ? c.text : `${c.text.slice(0, nl + 1)}${mark}\n${c.text.slice(nl + 1)}`;
    })
    .join('');
}

/** A diff cut at each file header, keeping whatever came before the first. */
function splitDiff(text: string): Array<{ file?: string; text: string }> {
  const out: Array<{ file?: string; text: string }> = [];
  for (const line of text.split('\n')) {
    const header = FILE_HEADER.exec(line);
    if (header || !out.length) out.push({ file: header ? (header[2] === '/dev/null' ? header[1] : header[2]) : undefined, text: '' });
    out[out.length - 1].text += `${line}\n`;
  }
  // the final newline of the input became an empty last line plus our own
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\n\n$/, '\n');
  return out;
}

/**
 * The diff with `expand` widened: a file the change touches is re-read with
 * the whole file as context, in place; a file it does not touch is appended as
 * a diff of nothing but context, which the view reads like any other file —
 * highlighted, tabbed, annotatable. The line numbers in either are the file's
 * own, so findings stay where they were.
 */
export async function expandDiff(worktree: string, base: string, range: string | undefined, expand: string[]): Promise<string> {
  const wanted = [...new Set(expand.filter((f) => f && !f.startsWith('-') && !f.includes('\0')))];
  if (!wanted.length || !range) return base;
  const chunks = splitDiff(base);
  const present = new Set(chunks.map((c) => c.file).filter(Boolean));
  const changed = wanted.filter((f) => present.has(f));
  const unchanged = wanted.filter((f) => !present.has(f));

  if (changed.length) {
    const wide = await exec('git', ['-C', worktree, 'diff', `-U${WHOLE_FILE}`, range, '--', ...changed], {
      maxBuffer: 32 * 1024 * 1024,
    }).catch(() => ({ stdout: '' }));
    const byFile = new Map(splitDiff(wide.stdout).filter((c) => c.file).map((c) => [c.file!, c.text]));
    for (const c of chunks) if (c.file && byFile.has(c.file)) c.text = byFile.get(c.file)!;
  }

  for (const file of unchanged) {
    const opened = await openFile(worktree, file);
    if (opened) chunks.push({ file, text: opened });
  }
  return chunks.map((c) => c.text).join('');
}

/** A file at HEAD as a diff that changes nothing, or undefined if it cannot be read as text. */
async function openFile(worktree: string, file: string): Promise<string | undefined> {
  const shown = await exec('git', ['-C', worktree, 'show', `HEAD:${file}`], { maxBuffer: 16 * 1024 * 1024 }).catch(() => undefined);
  if (!shown || shown.stdout.includes('\0')) return undefined;
  const lines = shown.stdout.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_OPEN_LINES) return undefined;
  const header =
    `diff --git a/${file} b/${file}\n` +
    // kept as a meta row by the parser: the reader is told why this file is here
    `${OPENED_MARK}\n`;
  if (!lines.length) return header;
  return `${header}@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((l) => ` ${l}`).join('\n')}\n`;
}

/**
 * Search the checkout. `grep` is a regex over every tracked file, case
 * sensitive only when the pattern has a capital in it; `refs` is a whole-word
 * match on a symbol, each hit classified as a definition, call, import or
 * other mention. Both leave out the review document, which quotes the code it
 * is about and would otherwise answer every search.
 */
export async function searchCode(worktree: string, mode: SearchMode, query: string): Promise<CodeSearchResult> {
  const q = query.trim();
  if (!q) return { mode, query, hits: [], error: 'nothing to search for' };
  const args = ['-C', worktree, 'grep', '-n', '-I', '--no-color', '--full-name'];
  if (mode === 'refs') args.push('-w', '-F');
  else {
    args.push('-E');
    if (q === q.toLowerCase()) args.push('-i');
  }
  // HEAD, not the working tree: the diff and any file opened beside it are read
  // out of commits, and a hit has to name a line in the same text they show
  args.push('-e', q, 'HEAD', '--', '.', `:(exclude)${REVIEW_FILE}`);
  let stdout: string;
  try {
    ({ stdout } = await exec('git', args, { maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    // git grep exits 1 for "no match", which is an answer rather than a failure
    if (e.code === 1) return { mode, query: q, hits: [] };
    const why = (e.stderr ?? String(err)).split('\n').find((l) => l.trim()) ?? 'git grep failed';
    return { mode, query: q, hits: [], error: why.replace(/^fatal:\s*/, '').slice(0, 160) };
  }
  const hits: CodeHit[] = [];
  let truncated = false;
  for (const raw of stdout.split('\n')) {
    const m = /^HEAD:(.+?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    if (hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }
    const text = expandTabs(m[3]).trim().slice(0, MAX_TEXT);
    hits.push({ file: m[1], line: Number(m[2]), text, kind: mode === 'refs' ? classifyHit(q, m[3]) : undefined });
  }
  return { mode, query: q, hits, truncated };
}
