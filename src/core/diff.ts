/**
 * Unified diff → a flat list of renderable lines that know where they came
 * from.
 *
 * Flat rather than nested (files → hunks → lines) because the view scrolls and
 * anchors: every row needs its file and its **new-side line number** without
 * walking a tree, and the new-side number is the one GitHub's inline comments
 * take — the same number the posting path already sends.
 */
export type DiffLineKind = 'file' | 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** the raw text, without the leading +/-/space */
  text: string;
  /** the file this line belongs to (new path, or the old one for a deletion) */
  file: string;
  /** line number in the new file — the anchor a comment attaches to */
  newLine?: number;
  /** line number in the old file, for context when reading a removal */
  oldLine?: number;
}

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse `git diff` output. Anything unrecognised is kept as `meta` rather than
 * dropped: a diff you cannot fully parse is still a diff worth reading, and
 * silently swallowing lines is how a review misses a file.
 */
export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  let file = '';
  let newLine = 0;
  let oldLine = 0;
  let inHunk = false;

  const rows = text.split('\n');
  // the final newline yields one empty element; treating it as a blank context
  // line invents a row and advances the counters past the end of the file. A
  // blank line *inside* the body is still honoured below — some diffs arrive
  // with the leading space stripped, and dropping those would misalign every
  // line number after them.
  if (rows.length && rows[rows.length - 1] === '') rows.pop();

  for (const raw of rows) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      file = header[2] === '/dev/null' ? header[1] : header[2];
      inHunk = false;
      out.push({ kind: 'file', text: file, file });
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[3], 10);
      inHunk = true;
      out.push({ kind: 'hunk', text: raw, file });
      continue;
    }
    if (!inHunk) {
      // index/mode/similarity lines, and the +++/--- pair
      if (raw.trim()) out.push({ kind: 'meta', text: raw, file });
      continue;
    }
    // "\ No newline at end of file" belongs to the line before it and moves
    // neither counter
    if (raw.startsWith('\\')) {
      out.push({ kind: 'meta', text: raw, file });
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === '+') {
      out.push({ kind: 'add', text: body, file, newLine });
      newLine++;
    } else if (marker === '-') {
      out.push({ kind: 'del', text: body, file, oldLine });
      oldLine++;
    } else if (marker === ' ' || raw === '') {
      // a truly empty line in the diff body is an unchanged empty line
      out.push({ kind: 'context', text: body, file, newLine, oldLine });
      newLine++;
      oldLine++;
    } else {
      out.push({ kind: 'meta', text: raw, file });
    }
  }
  return out;
}

/** Files touched, in the order they appear — the diff's table of contents. */
export function filesIn(lines: DiffLine[]): string[] {
  return lines.filter((l) => l.kind === 'file').map((l) => l.file);
}

/**
 * Index of anchored comments by `file:line`, so a row lookup is O(1) while
 * scrolling. Anything without both a file and a line has no anchor and is
 * deliberately left out — the view shows those separately rather than
 * pretending they belong to a row.
 */
export function anchorKey(file: string, line: number): string {
  return `${file}:${line}`;
}
