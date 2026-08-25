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

/** What the margin shows beside one diff row. */
export interface MarginRow {
  text: string;
  /** a comment the agent would send, a note about what the code does, or filler */
  kind: 'comment' | 'note' | 'empty';
  /** the anchor whose block this row belongs to, so the cursor's block can be highlighted */
  owner?: string;
  severity?: string;
  /** true on the first row of a block — where the severity bar reads */
  head?: boolean;
  /** the block was pushed below its own line to fit, so it must name the line */
  drifted?: boolean;
  /** the line it is about, for when it has drifted away from it */
  line?: number;
}

/**
 * Lay annotations out beside the code.
 *
 * Alignment is what makes the margin worth having, but it cannot be absolute:
 * two findings a line apart cannot both start at their own row and both be
 * readable, and cutting the first one off mid-sentence is the worst of the
 * three options. So a block starts at its line **or just after the block above
 * it finishes**, whichever is later, and is never truncated for want of room.
 *
 * A block that has been pushed down says which line it belongs to (`drifted`),
 * because that is exactly when you can no longer read it off the row opposite.
 */
export function layoutMargin(
  visible: Array<{ comment?: string; note?: string; severity?: string; key?: string; line?: number }>,
  width: number,
  wrap: (text: string, width: number) => string[],
  /** a single enormous finding should not push every other one off the screen */
  maxRows = 14,
): MarginRow[] {
  const rows: MarginRow[] = visible.map(() => ({ text: '', kind: 'empty' as const }));
  let next = 0; // the first row not already spoken for

  for (const [start, item] of visible.entries()) {
    const body = item.comment ?? item.note;
    if (!body) continue;
    const at = Math.max(start, next);
    if (at >= visible.length) break; // below the fold; it appears once scrolled
    const drifted = at !== start;
    // the marker is wrapped WITH the text, not painted over it: a prefix the
    // wrap width does not know about is a row that overflows and loses its end
    const marked = drifted && item.line !== undefined ? `↑${item.line} ${body}` : body;
    const lines = wrap(marked, Math.max(4, width));
    const room = Math.min(visible.length - at, maxRows);
    const shown = lines.slice(0, room);
    // cut only against the bottom of the pane or the cap — never against the
    // next finding, which is what used to eat the end of a sentence
    if (lines.length > shown.length && shown.length) {
      const last = shown[shown.length - 1];
      shown[shown.length - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
    }
    shown.forEach((text, k) => {
      rows[at + k] = {
        text,
        kind: item.comment ? 'comment' : 'note',
        owner: item.key,
        severity: item.severity,
        head: k === 0,
        drifted,
        line: item.line,
      };
    });
    next = at + shown.length;
  }
  return rows;
}

/** One rendered row of the diff: a source line, or a continuation of one. */
export interface VisualRow {
  line: DiffLine;
  text: string;
  /** false on the wrapped remainder of a long line */
  first: boolean;
}

/**
 * Expand diff lines into the rows actually drawn, wrapping anything too wide.
 *
 * Truncating was losing the end of every long line — exactly where a call's
 * arguments and a condition's tail live — so long lines wrap. Both panes then
 * iterate *these* rows rather than the source lines, which is what keeps the
 * margin aligned: a comment still starts on the row its line starts on, and a
 * line that takes three rows pushes the next annotation down by three.
 */
export function toVisualRows(lines: DiffLine[], width: number): VisualRow[] {
  const w = Math.max(8, width);
  const out: VisualRow[] = [];
  for (const line of lines) {
    // headers and hunk markers stay one row: they are chrome, not content
    if (line.kind === 'file' || line.kind === 'hunk' || line.kind === 'meta' || line.text.length <= w) {
      out.push({ line, text: line.text, first: true });
      continue;
    }
    for (let i = 0; i < line.text.length; i += w) {
      out.push({ line, text: line.text.slice(i, i + w), first: i === 0 });
    }
  }
  return out;
}
