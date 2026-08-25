import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { attachTo, rememberView, setPendingAction } from '../core/attach.js';
import { useReviews } from '../core/hooks.js';
import { store } from '../core/store.js';
import type { Review } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { AnnotatedDiff } from '../ui/AnnotatedDiff.js';
import { parseNotes } from '../core/reviewer.js';
import { ReviewDocModal } from '../ui/ReviewDocModal.js';
import { useColinear } from '../ui/context.js';
import { cell, formatDuration, formatTokens, spinner } from '../ui/format.js';
import { REVIEW_COLORS, theme } from '../theme.js';

const ACTIVE: Review['status'][] = ['reviewing', 'posting', 'queued'];

/**
 * Column widths. Status/PR always show; author and size drop out on narrow
 * terminals so the row never wraps (a wrapped row breaks the whole table).
 */
const W = { status: 12, pr: 24, draft: 9, author: 18, size: 14 };

/** Sort fields, cycled with S; picking the same one again flips direction. */
const SORTS = ['needs me', 'updated', 'size', 'repo', 'author', 'cost'] as const;
type SortKey = (typeof SORTS)[number];

/**
 * Shorter than the internal names, so the column doesn't hog the row — and
 * "ready" reads as "reviewed" here, because the next column over uses ready
 * for GitHub's own sense (not a draft).
 */
const STATUS_LABEL: Record<string, string> = {
  ready: 'reviewed',
  changes_requested: 'changes req',
};

function layout(columns: number) {
  const avail = columns - 6 - 2; // view padding/border, then the status glyph
  const size = avail >= 96 ? W.size : 0;
  const author = avail >= 82 ? W.author : 0;
  return {
    size,
    author,
    title: Math.max(16, avail - W.status - W.pr - W.draft - author - size),
  };
}
const SEVERITY_COLOR: Record<string, string> = {
  blocking: theme.err,
  consider: theme.warn,
  nit: theme.dim,
  praise: theme.ok,
};

/** PRs waiting on my review, with an assisted pre-review per PR. */
export function ReviewsView(props: { param?: string }) {
  const ctx = useColinear();
  const reviews = useReviews();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'post' | 'approve' | 'request-changes'>();
  const [reading, setReading] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [annotated, setAnnotated] = useState(true);

  useEffect(() => ctx.onReviewDiff?.((id, diff) => setDiffs((d) => ({ ...d, [id]: diff }))), []);
  const [sort, setSort] = useState<SortKey>('needs me');
  const [desc, setDesc] = useState(false);

  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = reviews.filter((r) => {
      // PRs that stopped requesting me pile up otherwise; /stale finds them
      if (r.status === 'stale' && !query.includes('stale')) return false;
      if (!terms.length) return true;
      const hay = `${r.repository} ${r.number} ${r.title} ${r.author} ${r.status}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // needs-me-first: ready findings, then in-flight, then untouched
    const rank = (r: Review) =>
      r.status === 'ready' ? 0 : ACTIVE.includes(r.status) ? 1 : r.status === 'error' ? 2 : r.status === 'pending' ? 3 : 4;
    const size = (r: Review) => r.additions + r.deletions;
    const compare = (a: Review, b: Review) => {
      switch (sort) {
        case 'updated':
          return b.updatedAt.localeCompare(a.updatedAt);
        case 'size':
          return size(b) - size(a);
        case 'repo':
          return a.repository.localeCompare(b.repository) || a.number - b.number;
        case 'author':
          return a.author.localeCompare(b.author) || b.updatedAt.localeCompare(a.updatedAt);
        case 'cost':
          return b.costUsd - a.costUsd;
        default:
          return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
      }
    };
    const sorted = [...matched].sort(compare);
    return desc ? sorted.reverse() : sorted;
  }, [reviews, query, sort, desc]);

  const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    // the modal's chat input owns the keyboard too
    ctx.setCapture(filtering || noting || reading);
  }, [filtering, noting, reading]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  // one poll on entry so the list isn't stale from the 5-minute cadence
  useEffect(() => {
    ctx.dispatcher.pollReviews();
  }, []);

  // :reviews <id> selects that PR; "doc:<id>" reopens its document, which is
  // how we land back where we were after $EDITOR or an attached session
  useEffect(() => {
    if (!props.param) return;
    const wantsDoc = props.param.startsWith('doc:');
    const id = wantsDoc ? props.param.slice(4) : props.param;
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    setCursor(idx);
    if (wantsDoc) {
      // coming back from $EDITOR on the document: return to the document
      setAnnotated(false);
      setReading(true);
    }
  }, [props.param, rows.length]);

  useInput(
    (input, key) => {
      if (confirm) {
        if (input === 'y' || key.return) {
          if (confirm === 'post') ctx.dispatcher.postReview(selected!.id);
          else ctx.dispatcher.reviewVerdict(selected!.id, confirm);
        }
        setConfirm(undefined);
        return;
      }
      if (key.upArrow || input === 'i') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'k') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === '/') setFiltering(true);
      if (!selected) return;
      if (input === 'a' && selected.question) return; // answering handled below
      // enter reads the review against the code; d reads the document itself
      if (key.return) {
        setAnnotated(true);
        setReading(true);
        if (!diffs[selected.id]) ctx.dispatcher.reviewDiff(selected.id);
      }
      if (input === 'd') {
        setAnnotated(false);
        setReading(true);
      }
      if (input === 'r') {
        ctx.dispatcher.startReview(selected.id);
        // one key, two jobs: a review that has been sent revises itself
        // against what landed since, rather than reviewing the PR again
        ctx.toast(
          selected.posted
            ? `re-reviewing ${selected.repository}#${selected.number} — changes and replies since you posted`
            : `pre-reviewing ${selected.repository}#${selected.number}`,
          'info',
        );
      }
      if (input === 's') {
        // same as the board: hand this terminal to the review's own session
        rememberView('reviews', selected.id);
        attachTo(
          {
            id: selected.id,
            identifier: `${shortRepo(selected.repository)}-${selected.number}`,
            sessionId: selected.sessionId,
            worktree: selected.worktree,
            live: ACTIVE.includes(selected.status),
          },
          ctx.cfg,
          (id) => ctx.dispatcher.suspendReview(id),
          ctx.toast,
          ctx.quit,
        );
      }
      if (input === 'x' && ACTIVE.includes(selected.status)) ctx.dispatcher.cancelReview(selected.id);
      if (input === 'p' && (selected.summary || selected.doc)) setConfirm('post');
      if (input === 'A') setConfirm('approve');
      if (input === 'X') setConfirm('request-changes');
      if (input === 'n') setNoting(true);
      if (input === 'o') {
        execFile('open', [selected.url], () => {});
        ctx.toast(`opened ${selected.repository}#${selected.number}`, 'info');
      }
      // not R: the global handler owns R (reload ui) and Ink runs every
      // active useInput hook, so binding it here fired both — a refresh
      // that also restarted the frontend
      if (input === 'u') ctx.dispatcher.pollReviews();
      if (input === 'S') {
        // cycle the field; landing back on the current one flips direction
        const next = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
        if (desc) {
          setDesc(false);
          setSort(next);
        } else {
          setDesc(true);
        }
      }
    },
    { isActive: !filtering && !noting && !reading && !ctx.cmdOpen },
  );

  const ready = reviews.filter((r) => r.status === 'ready').length;
  const cols = layout(ctx.size.columns);
  // rows that fit: total height less the detail pane, header and chrome
  const visible = Math.max(3, ctx.size.rows - 16);
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

  if (reading && selected && annotated) {
    return (
      <AnnotatedDiff
        review={selected}
        diff={diffs[selected.id]}
        notes={parseNotes(selected.doc ?? '')}
        width={ctx.size.columns - 4}
        height={Math.max(12, ctx.size.rows - 6)}
        busy={Boolean(selected.chatting) || ACTIVE.includes(selected.status)}
        onSend={(text) => ctx.dispatcher.reviewChat(selected.id, text)}
        onEditFinding={(file, line, comment, severity) =>
          ctx.dispatcher.editFinding(selected.id, file, line, comment, severity)
        }
        onPost={() => {
          ctx.dispatcher.postReview(selected.id);
          ctx.toast(`posting ${selected.repository}#${selected.number}…`, 'info');
        }}
        onClose={() => setReading(false)}
      />
    );
  }

  if (reading && selected) {
    return (
      <ReviewDocModal
        review={selected}
        width={ctx.size.columns - 4}
        height={Math.max(10, ctx.size.rows - 6)}
        busy={Boolean(selected.chatting) || ACTIVE.includes(selected.status)}
        onSend={(text) => ctx.dispatcher.reviewChat(selected.id, text)}
        onPost={() => {
          ctx.dispatcher.postReview(selected.id);
          ctx.toast(`posting ${selected.repository}#${selected.number}…`, 'info');
        }}
        onEdit={() => {
          if (!selected.worktree) {
            ctx.toast('no review doc on disk yet', 'err');
            return;
          }
          rememberView('reviews', `doc:${selected.id}`);
          // hand the terminal to $EDITOR, then re-read what came back
          setPendingAction({
            kind: 'edit-file',
            path: `${selected.worktree}/.colinear-review.md`,
            reviewId: selected.id,
          });
          ctx.quit();
        }}
        onClose={() => setReading(false)}
      />
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          reviews{' '}
        </Text>
        <Text dimColor>
          {rows.length} awaiting me ·{' '}
        </Text>
        {ready > 0 && <Text color={REVIEW_COLORS.ready}>{ready} pre-reviewed </Text>}
        <Text dimColor>· sort: </Text>
        <Text color={theme.accent}>
          {sort}
          {desc ? ' ↑' : ' ↓'}
        </Text>
        {query ? <Text color={theme.accent}>/{query}</Text> : null}
      </Box>
      {filtering && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setFiltering(false)}
          onCancel={() => {
            setQuery('');
            setFiltering(false);
          }}
        />
      )}

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text bold color={theme.header} wrap="truncate">
          {'  '}
          {cell('REVIEW', W.status)}
          {cell('PR', W.pr)}
          {cell('PR STATE', W.draft)}
          {cell('TITLE', cols.title)}
          {cols.author ? cell('AUTHOR', cols.author) : ''}
          {cols.size ? cell('SIZE', cols.size) : ''}
        </Text>
        {window.map((r, i) => {
          // the cursor row goes plain: `inverse` over coloured cells turns each
          // colour into a background, so a coloured row inverts into a strip of
          // mismatched blocks rather than one bar (same rule as ui/Table)
          const onCursor = start + i === cursor;
          return (
            <Text key={r.id} wrap="truncate" inverse={onCursor}>
              <Text color={onCursor ? undefined : REVIEW_COLORS[r.status] ?? theme.dim}>
                {ACTIVE.includes(r.status) ? spinner(ctx.now) : statusGlyph(r)}{' '}
                {cell(STATUS_LABEL[r.status] ?? r.status, W.status)}
              </Text>
              <Text bold>{cell(`${shortRepo(r.repository)}#${r.number}`, W.pr)}</Text>
              <Text color={onCursor ? undefined : r.isDraft ? theme.dim : theme.ok}>
                {cell(r.isDraft ? 'draft' : 'open', W.draft)}
              </Text>
              <Text>{cell(r.title, cols.title)}</Text>
              <Text dimColor={!onCursor}>
                {cols.author ? cell(r.author, cols.author) : ''}
                {cols.size
                  ? cell(r.changedFiles ? `${r.changedFiles}f +${r.additions}/-${r.deletions}` : '', cols.size)
                  : ''}
              </Text>
            </Text>
          );
        })}
        {!rows.length && <Text dimColor>No PRs are waiting on your review.</Text>}
        {rows.length > visible && (
          <Text dimColor>
            {start > 0 ? `↑${start} ` : ''}
            {start + visible < rows.length ? `↓${rows.length - start - visible}` : ''}
            {`  ${cursor + 1}/${rows.length}`}
          </Text>
        )}
      </Box>

      {selected && <Detail review={selected} now={ctx.now} />}

      {selected?.question && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.info} paddingX={1}>
          {selected.question.questions.map((q, qi) => (
            <Box key={`${qi}-${q.text.slice(0, 12)}`} flexDirection="column">
              <Text color={theme.info} bold wrap="wrap">
                ? {q.header ? `[${q.header}] ` : ''}{q.text}
              </Text>
              {q.options.map((opt, i) => (
                <Text key={opt.label} color={theme.info} wrap="wrap">
                  {'  '}{i + 1}. {opt.label}
                  {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )}

      {noting && (
        <Box>
          <Text color={theme.accent}>note (posted with the review): </Text>
          <TextInput
            value={note}
            onChange={setNote}
            onSubmit={(value) => {
              if (selected) store.updateReview(selected.id, { note: value.trim() || undefined });
              setNote('');
              setNoting(false);
            }}
          />
        </Box>
      )}

      {confirm && selected && (
        <Box borderStyle="double" borderColor={theme.key} paddingX={1}>
          <Text>
            {confirm === 'post'
              ? `post ${selected.findings?.length ?? 0} comment(s) to ${selected.repository}#${selected.number}?`
              : `${confirm === 'approve' ? 'approve' : 'request changes on'} ${selected.repository}#${selected.number}?`}{' '}
            <Text color={theme.key}>y</Text>
            <Text dimColor> / any other key cancels</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Detail(props: { review: Review; now: number }) {
  const { review, now } = props;
  const findings = review.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  return (
    <Box flexDirection="column" flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1} overflow="hidden">
      <Text bold wrap="truncate">
        {review.repository}#{review.number}{' '}
        <Text dimColor>
          {review.author} · {review.isDraft ? 'draft' : 'open'} ·{' '}
          {review.headRefName || '?'} → {review.baseRefName || '?'}
          {review.startedAt ? ` · ${formatDuration(review, now)}` : ''}
          {review.costUsd ? ` · $${review.costUsd.toFixed(2)} · ${formatTokens(review.tokens)} tok` : ''}
        </Text>
      </Text>
      {review.repo ? (
        <Text dimColor wrap="truncate">
          {review.worktree ?? `${review.repo.name} (not checked out yet — s to pre-review)`}
        </Text>
      ) : (
        <Text color={theme.warn} wrap="truncate">
          {review.repository} is not in your repos allowlist — add it to pre-review here
        </Text>
      )}
      {review.sessionId && (
        <Text dimColor wrap="truncate">
          session {review.sessionId} — claude --resume {review.sessionId}
        </Text>
      )}
      {review.error && (
        <Text color={theme.err} wrap="truncate">
          ✖ {review.error}
        </Text>
      )}
      {review.note && (
        <Text color={theme.accent} wrap="truncate">
          note: {review.note}
        </Text>
      )}

      {review.summary ? (
        <>
          <Text> </Text>
          <Text wrap="wrap">{`${review.summary.slice(0, 240)}${review.summary.length > 240 ? '…' : ''}`}</Text>
          <Text> </Text>
          <Text bold color={theme.header}>
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {blocking ? <Text color={theme.err}> · {blocking} blocking</Text> : null}
            <Text dimColor> — enter reads the full review, p posts, A approves, X requests changes</Text>
          </Text>
          {findings.slice(0, 4).map((f, i) => (
            <Text key={`${f.file}-${i}`} wrap="truncate">
              <Text color={f.severity ? (SEVERITY_COLOR[f.severity] ?? theme.dim) : theme.accent}>
                {(f.severity ?? 'lead').padEnd(9)}
              </Text>
              <Text dimColor>
                {f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}
              </Text>
              {f.comment}
            </Text>
          ))}
          {findings.length > 4 && <Text dimColor>… {findings.length - 4} more (enter)</Text>}
        </>
      ) : ACTIVE.includes(review.status) ? (
        <>
          <Text> </Text>
          <Text dimColor>
            {review.activity.length} step{review.activity.length === 1 ? '' : 's'} · s attaches to this session
          </Text>
          {review.activity.slice(-8).map((line, i) => (
            <Text key={`${i}-${line.slice(0, 12)}`} dimColor wrap="truncate">
              {line}
            </Text>
          ))}
          {!review.activity.length && <Text dimColor>starting…</Text>}
        </>
      ) : (
        <Text dimColor>no pre-review yet — press r to check the PR out and read the diff</Text>
      )}
    </Box>
  );
}

function statusGlyph(r: Review): string {
  if (r.status === 'ready') return '◆';
  if (r.status === 'approved') return '✔';
  if (r.status === 'changes_requested') return '✖';
  if (r.status === 'commented') return '↑';
  if (r.status === 'error') return '✖';
  return '·';
}

/** owner/repo is mostly noise in a list where the owner rarely varies. */
function shortRepo(repository: string): string {
  return repository.split('/')[1] ?? repository;
}

export const reviewsKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row'],
  ['r', 'pre-review · re-review once posted'],
  ['enter', 'diff + annotations'],
  ['d', 'the review document'],
  ['s', 'attach claude'],
  ['p', 'post comments'],
  ['A', 'approve'],
  ['X', 'request changes'],
  ['n', 'note'],
  ['o', 'open PR'],
  ['x', 'cancel'],
  ['S', 'sort'],
  ['u', 'refresh'],
  ['/', 'filter'],
];
