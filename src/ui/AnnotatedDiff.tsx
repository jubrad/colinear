import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { anchorKey, layoutMargin, parseDiff, toVisualRows, type DiffLine, type VisualRow } from '../core/diff.js';
import type { ChatTurn, Review, ReviewFinding, Severity } from '../core/types.js';
import { TextArea } from './TextArea.js';
import { theme } from '../theme.js';

const SEVERITY_COLOR: Record<string, string> = {
  blocking: theme.err,
  consider: theme.warn,
  nit: theme.dim,
  praise: theme.ok,
  // never posted, never a problem: blue keeps it off the severity ramp
  info: theme.annotation,
};

type Focus = 'diff' | 'severity' | 'edit' | 'chat' | 'read';

/**
 * What a finding can be, in the order you are offered it — and what each one
 * means, because the difference that matters is not severity but whether the
 * author ever sees it.
 */
/**
 * How a block announces itself. Two findings on adjacent lines are two blocks
 * with nothing between them, so the first row of each says what it is — which
 * is both the separator and the severity, for the price of a few characters
 * rather than a whole row nobody has to spare.
 */
const KIND_WORD: Record<string, string> = {
  blocking: 'blocking',
  consider: 'consider',
  nit: 'nit',
  praise: 'praise',
  info: 'note',
};

/** Rows the PR-wide comment may take before it costs the diff too much. */
const ABOUT_MAX = 3;

const KINDS: Array<{ severity: Severity; label: string; hint: string }> = [
  { severity: 'blocking', label: 'blocking', hint: 'would request changes over it' },
  { severity: 'consider', label: 'consider', hint: 'worth a second look' },
  { severity: 'nit', label: 'nit', hint: 'optional polish' },
  { severity: 'praise', label: 'praise', hint: 'worth saying out loud' },
  { severity: 'info', label: 'annotation', hint: 'explains the code — never posted' },
];

/**
 * The review, read the way it was written: the diff on the left, and beside
 * each line what the agent had to say about it.
 *
 * A review document read end to end tells you the findings in the agent's
 * order; this tells you them in the *code's* order, which is the order you
 * check them in. The right pane is editable because the agent's comment is a
 * draft of yours — edits rewrite the document's fence, so what you send and
 * what the agent sees never diverge.
 */
export function AnnotatedDiff(props: {
  review: Review;
  diff?: string;
  width: number;
  height: number;
  busy: boolean;
  onSend: (text: string) => void;
  onEditFinding: (file: string, line: number, comment: string, severity?: Severity) => void;
  onPost: () => void;
  onClose: () => void;
}) {
  const { review, diff, width, height, busy, onSend, onEditFinding, onPost, onClose } = props;
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [focus, setFocus] = useState<Focus>('diff');
  const [draft, setDraft] = useState('');
  /** which kind the editor is writing: a comment to send, or an annotation that never is */
  const [editAs, setEditAs] = useState<Severity | undefined>(undefined);
  const [kindIdx, setKindIdx] = useState(1);
  const [chat, setChat] = useState('');

  const parsed = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);
  // the gutter this pane spends before the code: marker, line number, sign
  const codeWidth = Math.max(8, Math.floor(width * 0.62) - 11);
  /** what is actually drawn — long lines wrap, so a row is not always a line */
  const lines = useMemo(() => toVisualRows(parsed, codeWidth), [parsed, codeWidth]);

  /** file:line → what is anchored there. `info` entries are annotations, the rest are comments. */
  const byLine = useMemo(() => {
    const map = new Map<string, ReviewFinding>();
    for (const f of review.findings ?? []) {
      if (f.file && typeof f.line === 'number') map.set(anchorKey(f.file, f.line), f);
    }
    return map;
  }, [review.findings]);

  const annotatedRows = useMemo(
    () =>
      lines.reduce<number[]>((acc, row, i) => {
        // only the first row of a wrapped line: n/N should land on the line,
        // not walk its continuations
        if (!row.first || row.line.newLine === undefined) return acc;
        if (byLine.has(anchorKey(row.line.file, row.line.newLine))) acc.push(i);
        return acc;
      }, []),
    [lines, byLine],
  );

  const chatRows = 6;
  /** findings with no anchor: the lead, and anything about the PR as a whole */
  const unanchored = (review.findings ?? []).filter((f) => !f.file || typeof f.line !== 'number');
  /**
   * The PR-wide comments, wrapped rather than cut at the right edge — the lead
   * is usually the sentence saying whether the whole thing is sound, so losing
   * its second half loses the point. Capped: these rows come out of the diff's,
   * and three lines is a paragraph. The document has the rest.
   */
  const aboutLines = useMemo(() => {
    if (!unanchored.length) return [];
    const text = unanchored.map((f) => f.comment.trim()).join(' · ');
    const wrapped = wrapText(text, Math.max(20, width - 15));
    if (wrapped.length <= ABOUT_MAX) return wrapped;
    const shown = wrapped.slice(0, ABOUT_MAX);
    shown[ABOUT_MAX - 1] = `${shown[ABOUT_MAX - 1].trimEnd()}…`;
    return shown;
  }, [unanchored, width]);
  // the panes get what is left: one row per line the PR-wide comment takes
  const paneHeight = Math.max(4, height - chatRows - 2 - Math.max(1, aboutLines.length));
  const diffWidth = Math.max(30, Math.floor(width * 0.62));
  const noteWidth = width - diffWidth - 3;
  // What a margin row has left for words: the pane's border and padding (4),
  // then the severity bar and its space (2). Wrapping to anything wider makes
  // every line overflow by exactly that much and lose its tail to truncation —
  // which reads as the text being mangled rather than the column being narrow.
  const marginText = Math.max(8, noteWidth - 6);

  useEffect(() => {
    // keep the cursor on screen, following it rather than snapping to it
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + paneHeight) setScroll(cursor - paneHeight + 1);
  }, [cursor, paneHeight]);

  const visibleRows = Math.max(1, paneHeight - 2);
  const visible = lines.slice(scroll, scroll + visibleRows);
  /** the right column, row-for-row with the diff on the left */
  const margin = useMemo(() => {
    // Lay out over the pane's rows rather than only the diff's: a comment
    // anchored near the end of a short file would otherwise be cut off with
    // blank screen underneath it, having no more code rows to flow into.
    const slots = Math.max(visible.length, visibleRows);
    const annotated = Array.from({ length: slots }, (_, i) => visible[i]).map((row) => {
      // a continuation carries no annotation of its own: the block already
      // started on the row above, and starting it again would double it
      const key =
        row?.first && row.line.newLine !== undefined ? anchorKey(row.line.file, row.line.newLine) : undefined;
      const finding = key ? byLine.get(key) : undefined;
      const info = finding?.severity === 'info';
      const label = finding ? `${KIND_WORD[finding.severity ?? 'consider'] ?? 'comment'} · ` : '';
      return {
        key,
        comment: info ? undefined : finding ? `${label}${finding.comment}` : undefined,
        note: info ? `${label}${finding.comment}` : undefined,
        severity: finding?.severity,
        line: finding ? row?.line.newLine : undefined,
      };
    });
    return layoutMargin(annotated, marginText, wrapText);
  }, [visible, visibleRows, byLine, marginText]);

  const current = lines[cursor]?.line;
  const anchor =
    current?.newLine !== undefined ? { file: current.file, line: current.newLine } : undefined;
  const finding = anchor ? byLine.get(anchorKey(anchor.file, anchor.line)) : undefined;

  // open on the first thing the agent flagged rather than on a file header:
  // the point of this view is the annotations, so start at one
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (landed || !annotatedRows.length) return;
    setCursor(annotatedRows[0]);
    setLanded(true);
  }, [annotatedRows, landed]);

  const jump = (dir: 1 | -1) => {
    if (!annotatedRows.length) return;
    const next =
      dir === 1
        ? annotatedRows.find((i) => i > cursor) ?? annotatedRows[0]
        : [...annotatedRows].reverse().find((i) => i < cursor) ?? annotatedRows.at(-1)!;
    setCursor(next);
  };

  useInput((input, key) => {
    if (focus === 'severity') {
      if (key.escape) return setFocus('diff');
      if (key.leftArrow || input === 'k' || key.upArrow) setKindIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === 'j' || key.downArrow) setKindIdx((i) => Math.min(KINDS.length - 1, i + 1));
      // the first letter of each kind, for anyone who already knows what they want
      const typed = KINDS.findIndex((k) => k.severity[0] === input);
      if (typed !== -1) setKindIdx(typed);
      if (key.return || input === ' ') {
        setEditAs(KINDS[typed !== -1 ? typed : kindIdx].severity);
        setFocus('edit');
      }
      return;
    }
    if (focus === 'edit') {
      if (key.escape) {
        setFocus('diff');
        setDraft('');
      }
      return; // the TextArea owns everything else
    }
    if (focus === 'chat') {
      if (key.escape || key.tab) setFocus('diff');
      return;
    }
    if (focus === 'read') {
      // any key closes it: it is a reading pane, not a mode to get stuck in
      setFocus('diff');
      return;
    }
    if (key.escape || input === 'q') return onClose();
    if (key.tab) return setFocus('chat');
    if (input === 'j' || key.downArrow) setCursor((c) => Math.min(lines.length - 1, c + 1));
    if (input === 'k' || key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.pageDown || input === ' ') setCursor((c) => Math.min(lines.length - 1, c + paneHeight - 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - (paneHeight - 1)));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(Math.max(0, lines.length - 1));
    // the reason this view exists: walk what the agent flagged, in code order
    // the margin cuts a block that would run into the next one; this is how you
    // read the rest without editing it
    if (key.return && finding) return setFocus('read');
    if (input === 'n') jump(1);
    if (input === 'N') jump(-1);
    // pick what kind of finding this is *before* writing it: the old default
    // put every new comment on the author's PR at `consider` without asking,
    // and left blocking, nit and praise unreachable from this view entirely
    if (input === 'e' && anchor) {
      setDraft(finding?.comment ?? '');
      const existing = KINDS.findIndex((k) => k.severity === finding?.severity);
      setKindIdx(existing === -1 ? 1 : existing);
      setFocus('severity');
    }
    // straight to an annotation: the common case when reading unfamiliar code
    if (input === 'i' && anchor) {
      setDraft(finding?.severity === 'info' ? finding.comment : '');
      setEditAs('info');
      setFocus('edit');
    }
    if (input === 'd' && anchor && finding) onEditFinding(anchor.file, anchor.line, '');
    if (input === 'p') onPost();
  });

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          {review.repository}#{review.number}
        </Text>
        <Text dimColor>
          {' '}
          {review.title} · {review.findings?.length ?? 0} comment
          {(review.findings?.length ?? 0) === 1 ? '' : 's'}
          {annotatedRows.length ? ` · ${annotatedRows.length} anchored (n/N)` : ''}
          {review.posted ? ' · posted' : ''}
        </Text>
      </Text>

      <Box height={paneHeight}>
        <Box flexDirection="column" width={diffWidth} borderStyle="single" borderColor={focus === 'diff' ? theme.borderFocus : theme.border} paddingX={1} overflow="hidden">
          {!diff && <Text dimColor>loading the diff…</Text>}
          {diff && !lines.length && <Text dimColor>no diff — has the branch been fetched?</Text>}
          {lines.slice(scroll, scroll + paneHeight - 2).map((row, i) => (
            <DiffRow
              key={`${scroll + i}-${row.text.slice(0, 12)}`}
              row={row}
              width={diffWidth - 4}
              onCursor={scroll + i === cursor}
              annotated={row.line.newLine !== undefined && byLine.has(anchorKey(row.line.file, row.line.newLine))}
              info={
                row.line.newLine !== undefined &&
                byLine.get(anchorKey(row.line.file, row.line.newLine))?.severity === 'info'
              }
            />
          ))}
        </Box>

        <Box flexDirection="column" width={noteWidth} borderStyle="single" borderColor={focus === 'edit' ? theme.borderFocus : theme.border} paddingX={1} overflow="hidden">
          {focus === 'read' && finding && anchor ? (
            <Box flexDirection="column">
              <Text bold color={SEVERITY_COLOR[finding.severity ?? 'consider']} wrap="truncate">
                {KIND_WORD[finding.severity ?? 'consider'] ?? 'comment'} · {anchor.file}:{anchor.line}
              </Text>
              <Box height={1} />
              {wrapText(finding.comment, noteWidth - 4)
                .slice(0, paneHeight - 5)
                .map((line, i) => (
                  <Text key={`r${i}-${line.slice(0, 8)}`}>{line}</Text>
                ))}
              <Box flexGrow={1} />
              <Text dimColor>any key returns · e edits it</Text>
            </Box>
          ) : focus === 'severity' && anchor ? (
            <Box flexDirection="column">
              <Text bold color={theme.key} wrap="truncate">
                {finding ? 'change' : 'new'} finding on {anchor.file}:{anchor.line}
              </Text>
              <Box height={1} />
              {KINDS.map((kind, i) => (
                <Text key={kind.severity} wrap="truncate" inverse={i === kindIdx}>
                  <Text color={i === kindIdx ? undefined : SEVERITY_COLOR[kind.severity]}>
                    {i === kindIdx ? '▸ ' : '  '}
                    {kind.label.padEnd(11)}
                  </Text>
                  <Text dimColor={i !== kindIdx}>{kind.hint}</Text>
                </Text>
              ))}
              <Box flexGrow={1} />
              <Text dimColor wrap="truncate">
                j/k or the first letter · enter writes it · esc cancels
              </Text>
            </Box>
          ) : focus !== 'edit' ? (
            margin.map((row, i) => {
              const source = visible[i]?.line;
              const mine =
                source?.newLine !== undefined && anchor && row.owner === anchorKey(anchor.file, anchor.line);
              const bar = row.kind === 'empty' ? ' ' : row.kind === 'note' ? '│' : '▌';
              const barColor =
                row.kind === 'note' ? theme.annotation : SEVERITY_COLOR[row.severity ?? 'consider'] ?? theme.dim;
              return (
                <Text key={`m${scroll + i}`} wrap="truncate">
                  <Text color={barColor}>{bar} </Text>
                  <Text
                    // the head row carries the severity word and wears its
                    // colour, so where one finding ends and the next begins is
                    // visible even when their lines are adjacent
                    bold={row.head}
                    color={row.head ? barColor : undefined}
                    dimColor={!row.head && !mine}
                  >
                    {row.text}
                  </Text>
                </Text>
              );
            })
          ) : anchor ? (
            <>
              <Text bold color={editAs ? SEVERITY_COLOR[editAs] : theme.key} wrap="truncate">
                {editAs === 'info' ? 'annotation on ' : `${editAs ?? 'comment'} on `}
                {anchor.file}:{anchor.line}
              </Text>
              {/* the consequence, said plainly: this is the difference between
                  thinking out loud and writing on someone else's PR */}
              <Text dimColor wrap="truncate">
                {editAs === 'info' ? 'stays in colinear — never posted' : 'goes to the author when you post'}
              </Text>
              <TextArea
                value={draft}
                onChange={setDraft}
                focus
                width={noteWidth - 4}
                height={paneHeight - 6}
                placeholder={
                  editAs === 'info'
                    ? 'what this code does, for whoever reads the review — never posted'
                    : "what you'd say to the author — ctrl+d saves, esc cancels"
                }
                onSubmit={() => {
                  onEditFinding(anchor.file, anchor.line, draft, editAs);
                  setFocus('diff');
                  setDraft('');
                }}
              />
              <Text dimColor wrap="truncate">
                ctrl+d saves · esc cancels · empty removes it
              </Text>
            </>
          ) : null}
        </Box>
      </Box>

      {aboutLines.map((line, i) => (
        // outside both columns on purpose: a comment about the PR as a whole
        // has no line to sit beside, and inventing one would break the margin
        <Text key={`about${i}`} wrap="truncate">
          <Text color={theme.header}>{i === 0 ? 'about the PR ' : '             '}</Text>
          <Text dimColor>{line}</Text>
        </Text>
      ))}
      <Box flexDirection="column" height={chatRows} borderStyle="single" borderColor={focus === 'chat' ? theme.borderFocus : theme.border} paddingX={1} overflow="hidden">
        <Chat turns={review.chat ?? []} rows={chatRows - 4} busy={busy} />
        <Box>
          <Text color={focus === 'chat' ? theme.accent : theme.dim}>{'> '}</Text>
          <TextArea
            value={chat}
            onChange={setChat}
            focus={focus === 'chat'}
            width={width - 6}
            height={1}
            submitOnEnter
            placeholder={focus === 'chat' ? 'ask the agent — enter sends' : 'tab to talk to the agent'}
            onSubmit={() => {
              if (chat.trim()) onSend(chat.trim());
              setChat('');
              setFocus('diff');
            }}
          />
        </Box>
      </Box>

      <Text dimColor wrap="truncate">
        j/k move · n/N next · enter reads · e finding · i annotate · d drop · tab chat · p post · esc
      </Text>
    </Box>
  );
}

function DiffRow(props: { row: VisualRow; width: number; onCursor: boolean; annotated: boolean; info?: boolean }) {
  const { row, width, onCursor, annotated, info } = props;
  const line = { ...row.line, text: row.text };
  if (line.kind === 'file') {
    return (
      <Text bold color={theme.accent} wrap="truncate" inverse={onCursor}>
        {line.text}
      </Text>
    );
  }
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return (
      <Text dimColor wrap="truncate" inverse={onCursor}>
        {line.text.slice(0, width)}
      </Text>
    );
  }
  const sign = row.first ? (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') : ' ';
  const color = line.kind === 'add' ? theme.ok : line.kind === 'del' ? theme.err : undefined;
  // a continuation shows no number: it is the same line, still
  const num = (row.first ? (line.newLine ?? line.oldLine ?? '') : '').toString().padStart(4);
  return (
    <Text wrap="truncate" inverse={onCursor}>
      {/* the marker column: where a comment lives, visible while scrolling past */}
      {/* the marker says which kind: a comment to send, or an annotation */}
      <Text color={annotated ? (info ? theme.annotation : theme.key) : undefined}>
        {annotated ? (info ? '│' : '▍') : ' '}
      </Text>
      <Text dimColor>{num} </Text>
      <Text color={onCursor ? undefined : color}>
        {sign}
        {line.text}
      </Text>
    </Text>
  );
}

function Chat(props: { turns: ChatTurn[]; rows: number; busy: boolean }) {
  const { turns, rows, busy } = props;
  const shown = turns.slice(-Math.max(1, rows));
  if (!shown.length) {
    return <Text dimColor>{busy ? 'the agent is thinking…' : 'tab to ask the agent about any of this'}</Text>;
  }
  return (
    <>
      {shown.map((turn, i) => (
        <Text key={`${i}-${turn.at}`} wrap="truncate">
          <Text color={turn.role === 'operator' ? theme.key : theme.accent}>
            {turn.role === 'operator' ? 'you' : turn.role === 'note' ? '—' : 'agent'}{' '}
          </Text>
          <Text dimColor={turn.role === 'note'}>{turn.text.split('\n')[0]}</Text>
        </Text>
      ))}
    </>
  );
}

/** Word wrap for the annotation pane; the comment is prose and must stay readable. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.trim()) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > width) {
        if (line) out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
