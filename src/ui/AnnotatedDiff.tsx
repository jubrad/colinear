import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { anchorKey, parseDiff, type DiffLine } from '../core/diff.js';
import type { ChatTurn, Review, ReviewFinding, Severity } from '../core/types.js';
import { TextArea } from './TextArea.js';
import { theme } from '../theme.js';

const SEVERITY_COLOR: Record<string, string> = {
  blocking: theme.err,
  consider: theme.warn,
  nit: theme.dim,
  praise: theme.ok,
};

type Focus = 'diff' | 'edit' | 'chat';

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
  notes: Array<{ file: string; line: number; note: string }>;
  width: number;
  height: number;
  busy: boolean;
  onSend: (text: string) => void;
  onEditFinding: (file: string, line: number, comment: string, severity?: Severity) => void;
  onPost: () => void;
  onClose: () => void;
}) {
  const { review, diff, notes, width, height, busy, onSend, onEditFinding, onPost, onClose } = props;
  const [cursor, setCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [focus, setFocus] = useState<Focus>('diff');
  const [draft, setDraft] = useState('');
  const [chat, setChat] = useState('');

  const lines = useMemo(() => (diff ? parseDiff(diff) : []), [diff]);

  /** file:line → the comment anchored there, and the agent's note about it */
  const { byLine, noteByLine } = useMemo(() => {
    const byLine = new Map<string, ReviewFinding>();
    for (const f of review.findings ?? []) {
      if (f.file && typeof f.line === 'number') byLine.set(anchorKey(f.file, f.line), f);
    }
    const noteByLine = new Map<string, string>();
    for (const n of notes) noteByLine.set(anchorKey(n.file, n.line), n.note);
    return { byLine, noteByLine };
  }, [review.findings, notes]);

  const annotatedRows = useMemo(
    () =>
      lines.reduce<number[]>((acc, line, i) => {
        const key = line.newLine !== undefined ? anchorKey(line.file, line.newLine) : undefined;
        if (key && (byLine.has(key) || noteByLine.has(key))) acc.push(i);
        return acc;
      }, []),
    [lines, byLine, noteByLine],
  );

  const chatRows = 6;
  const paneHeight = Math.max(4, height - chatRows - 3);
  const diffWidth = Math.max(30, Math.floor(width * 0.62));
  const noteWidth = width - diffWidth - 3;

  useEffect(() => {
    // keep the cursor on screen, following it rather than snapping to it
    if (cursor < scroll) setScroll(cursor);
    else if (cursor >= scroll + paneHeight) setScroll(cursor - paneHeight + 1);
  }, [cursor, paneHeight]);

  const current = lines[cursor];
  const anchor =
    current?.newLine !== undefined ? { file: current.file, line: current.newLine } : undefined;
  const finding = anchor ? byLine.get(anchorKey(anchor.file, anchor.line)) : undefined;
  const note = anchor ? noteByLine.get(anchorKey(anchor.file, anchor.line)) : undefined;
  /** findings with no anchor: the lead, and anything about the PR as a whole */
  const unanchored = (review.findings ?? []).filter((f) => !f.file || typeof f.line !== 'number');

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
    if (key.escape || input === 'q') return onClose();
    if (key.tab) return setFocus('chat');
    if (input === 'j' || key.downArrow) setCursor((c) => Math.min(lines.length - 1, c + 1));
    if (input === 'k' || key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.pageDown || input === ' ') setCursor((c) => Math.min(lines.length - 1, c + paneHeight - 1));
    if (key.pageUp) setCursor((c) => Math.max(0, c - (paneHeight - 1)));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(Math.max(0, lines.length - 1));
    // the reason this view exists: walk what the agent flagged, in code order
    if (input === 'n') jump(1);
    if (input === 'N') jump(-1);
    if (input === 'e' && anchor) {
      setDraft(finding?.comment ?? '');
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
          {lines.slice(scroll, scroll + paneHeight - 2).map((line, i) => (
            <DiffRow
              key={`${scroll + i}-${line.text.slice(0, 12)}`}
              line={line}
              width={diffWidth - 4}
              onCursor={scroll + i === cursor}
              annotated={
                line.newLine !== undefined &&
                (byLine.has(anchorKey(line.file, line.newLine)) || noteByLine.has(anchorKey(line.file, line.newLine)))
              }
            />
          ))}
        </Box>

        <Box flexDirection="column" width={noteWidth} borderStyle="single" borderColor={focus === 'edit' ? theme.borderFocus : theme.border} paddingX={1} overflow="hidden">
          {focus === 'edit' && anchor ? (
            <>
              <Text bold color={theme.key} wrap="truncate">
                comment on {anchor.file}:{anchor.line}
              </Text>
              <TextArea
                value={draft}
                onChange={setDraft}
                focus
                width={noteWidth - 4}
                height={paneHeight - 5}
                placeholder="what you'd say to the author — ctrl+d saves, esc cancels"
                onSubmit={() => {
                  onEditFinding(anchor.file, anchor.line, draft, finding?.severity);
                  setFocus('diff');
                  setDraft('');
                }}
              />
              <Text dimColor>ctrl+d saves · esc cancels · empty removes the comment</Text>
            </>
          ) : (
            <Annotation
              anchor={anchor}
              finding={finding}
              note={note}
              unanchored={unanchored}
              width={noteWidth - 4}
              height={paneHeight - 2}
            />
          )}
        </Box>
      </Box>

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
            placeholder={focus === 'chat' ? 'ask the agent — ctrl+d sends' : 'tab to talk to the agent'}
            onSubmit={() => {
              if (chat.trim()) onSend(chat.trim());
              setChat('');
              setFocus('diff');
            }}
          />
        </Box>
      </Box>

      <Text dimColor wrap="truncate">
        j/k move · n/N next annotation · e comment · d drop · tab chat · p post · esc close
      </Text>
    </Box>
  );
}

function DiffRow(props: { line: DiffLine; width: number; onCursor: boolean; annotated: boolean }) {
  const { line, width, onCursor, annotated } = props;
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
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const color = line.kind === 'add' ? theme.ok : line.kind === 'del' ? theme.err : undefined;
  const num = (line.newLine ?? line.oldLine ?? '').toString().padStart(4);
  return (
    <Text wrap="truncate" inverse={onCursor}>
      {/* the marker column: where a comment lives, visible while scrolling past */}
      <Text color={annotated ? theme.key : undefined}>{annotated ? '▍' : ' '}</Text>
      <Text dimColor>{num} </Text>
      <Text color={onCursor ? undefined : color}>
        {sign}
        {line.text.slice(0, Math.max(0, width - 7))}
      </Text>
    </Text>
  );
}

function Annotation(props: {
  anchor?: { file: string; line: number };
  finding?: ReviewFinding;
  note?: string;
  unanchored: ReviewFinding[];
  width: number;
  height: number;
}) {
  const { anchor, finding, note, unanchored, width, height } = props;
  if (finding) {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text bold color={SEVERITY_COLOR[finding.severity ?? 'consider']}>
            {finding.severity ?? 'comment'}
          </Text>
          <Text dimColor>
            {' '}
            · {anchor?.file}:{anchor?.line}
          </Text>
        </Text>
        <Box height={1} />
        {wrapText(finding.comment, width)
          .slice(0, height - 4)
          .map((l, i) => (
            <Text key={`${i}-${l.slice(0, 8)}`}>{l}</Text>
          ))}
        <Box flexGrow={1} />
        <Text dimColor>e edits this · d drops it</Text>
      </Box>
    );
  }
  if (note) {
    return (
      <Box flexDirection="column">
        <Text bold color={theme.info}>
          what this does
        </Text>
        <Box height={1} />
        {wrapText(note, width)
          .slice(0, height - 4)
          .map((l, i) => (
            <Text key={`${i}-${l.slice(0, 8)}`} dimColor>
              {l}
            </Text>
          ))}
        <Box flexGrow={1} />
        <Text dimColor>e writes a comment here</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{anchor ? 'nothing flagged on this line — e writes a comment' : 'no line selected'}</Text>
      {unanchored.length > 0 && (
        <>
          <Box height={1} />
          <Text bold color={theme.header}>
            about the PR as a whole
          </Text>
          {unanchored.slice(0, 3).flatMap((f, i) =>
            wrapText(f.comment, width)
              .slice(0, 3)
              .map((l, j) => (
                <Text key={`${i}-${j}-${l.slice(0, 8)}`} dimColor>
                  {l}
                </Text>
              )),
          )}
        </>
      )}
    </Box>
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
