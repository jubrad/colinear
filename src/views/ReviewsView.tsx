import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { useReviews } from '../core/hooks.js';
import { store } from '../core/store.js';
import type { Review } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { cell, formatDuration, formatTokens, spinner } from '../ui/format.js';
import { REVIEW_COLORS, theme } from '../theme.js';

const ACTIVE: Review['status'][] = ['reviewing', 'posting', 'queued'];

/**
 * Column widths. Status/PR always show; author and size drop out on narrow
 * terminals so the row never wraps (a wrapped row breaks the whole table).
 */
const W = { status: 18, pr: 24, author: 18, size: 14 };

function layout(columns: number) {
  const avail = columns - 6 - 2; // view padding/border, then the status glyph
  const size = avail >= 96 ? W.size : 0;
  const author = avail >= 82 ? W.author : 0;
  return { size, author, title: Math.max(16, avail - W.status - W.pr - author - size) };
}
const SEVERITY_COLOR: Record<string, string> = {
  blocking: theme.err,
  consider: theme.warn,
  nit: theme.dim,
  praise: theme.ok,
};

/** PRs waiting on my review, with an assisted pre-review per PR. */
export function ReviewsView(_props: { param?: string }) {
  const ctx = useColinear();
  const reviews = useReviews();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'post' | 'approve' | 'request-changes'>();

  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = reviews.filter((r) => {
      if (!terms.length) return true;
      const hay = `${r.repository} ${r.number} ${r.title} ${r.author} ${r.status}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // needs-me-first: ready findings, then in-flight, then untouched
    const rank = (r: Review) =>
      r.status === 'ready' ? 0 : ACTIVE.includes(r.status) ? 1 : r.status === 'error' ? 2 : r.status === 'pending' ? 3 : 4;
    return matched.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  }, [reviews, query]);

  const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => ctx.setCapture(filtering || noting), [filtering, noting]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  // one poll on entry so the list isn't stale from the 5-minute cadence
  useEffect(() => ctx.dispatcher.pollReviews(), []);

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
      if (key.return) setExpanded((e) => !e);
      if (input === 's') {
        ctx.dispatcher.startReview(selected.id);
        ctx.toast(`pre-reviewing ${selected.repository}#${selected.number}`, 'info');
      }
      if (input === 'x' && ACTIVE.includes(selected.status)) ctx.dispatcher.cancelReview(selected.id);
      if (input === 'p' && selected.summary) setConfirm('post');
      if (input === 'A') setConfirm('approve');
      if (input === 'X') setConfirm('request-changes');
      if (input === 'n') setNoting(true);
      if (input === 'o') {
        execFile('open', [selected.url], () => {});
        ctx.toast(`opened ${selected.repository}#${selected.number}`, 'info');
      }
      if (input === 'R') ctx.dispatcher.pollReviews();
    },
    { isActive: !filtering && !noting && !ctx.cmdOpen },
  );

  const ready = reviews.filter((r) => r.status === 'ready').length;
  const cols = layout(ctx.size.columns);
  // rows that fit: total height less the detail pane, header and chrome
  const visible = Math.max(3, ctx.size.rows - (expanded ? 26 : 16));
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

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
          {cell('STATUS', W.status)}
          {cell('PR', W.pr)}
          {cell('TITLE', cols.title)}
          {cols.author ? cell('AUTHOR', cols.author) : ''}
          {cols.size ? cell('SIZE', cols.size) : ''}
        </Text>
        {window.map((r, i) => (
          <Text key={r.id} wrap="truncate" inverse={start + i === cursor}>
            <Text color={REVIEW_COLORS[r.status] ?? theme.dim}>
              {ACTIVE.includes(r.status) ? spinner(ctx.now) : statusGlyph(r)} {cell(r.status, W.status)}
            </Text>
            <Text bold>{cell(`${shortRepo(r.repository)}#${r.number}`, W.pr)}</Text>
            <Text>{cell(r.title, cols.title)}</Text>
            <Text dimColor>
              {cols.author ? cell(r.author, cols.author) : ''}
              {cols.size ? cell(r.changedFiles ? `${r.changedFiles}f +${r.additions}/-${r.deletions}` : '', cols.size) : ''}
            </Text>
          </Text>
        ))}
        {!rows.length && <Text dimColor>No PRs are waiting on your review.</Text>}
        {rows.length > visible && (
          <Text dimColor>
            {start > 0 ? `↑${start} ` : ''}
            {start + visible < rows.length ? `↓${rows.length - start - visible}` : ''}
            {`  ${cursor + 1}/${rows.length}`}
          </Text>
        )}
      </Box>

      {selected && <Detail review={selected} expanded={expanded} now={ctx.now} />}

      {selected?.question && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.info} paddingX={1}>
          <Text color={theme.info} bold wrap="wrap">
            ? {selected.question.text}
          </Text>
          {selected.question.options.map((opt, i) => (
            <Text key={opt} color={theme.info} wrap="wrap">
              {'  '}{i + 1}. {opt}
            </Text>
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

function Detail(props: { review: Review; expanded: boolean; now: number }) {
  const { review, expanded, now } = props;
  const findings = review.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  return (
    <Box flexDirection="column" flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1} overflow="hidden">
      <Text bold wrap="truncate">
        {review.repository}#{review.number}{' '}
        <Text dimColor>
          {review.author} · {review.headRefName || '?'} → {review.baseRefName || '?'}
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
          <Text wrap="wrap">{expanded ? review.summary : `${review.summary.slice(0, 240)}${review.summary.length > 240 ? '…' : ''}`}</Text>
          <Text> </Text>
          <Text bold color={theme.header}>
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {blocking ? <Text color={theme.err}> · {blocking} blocking</Text> : null}
            <Text dimColor> — enter {expanded ? 'collapses' : 'expands'}, p posts, A approves, X requests changes</Text>
          </Text>
          {findings.slice(0, expanded ? 40 : 4).map((f, i) => (
            <Text key={`${f.file}-${i}`} wrap={expanded ? 'wrap' : 'truncate'}>
              <Text color={SEVERITY_COLOR[f.severity] ?? theme.dim}>{f.severity.padEnd(9)}</Text>
              <Text dimColor>
                {f.file}
                {f.line ? `:${f.line}` : ''}{' '}
              </Text>
              {f.comment}
            </Text>
          ))}
          {!expanded && findings.length > 4 && <Text dimColor>… {findings.length - 4} more (enter)</Text>}
        </>
      ) : (
        <Text dimColor>
          {ACTIVE.includes(review.status)
            ? (review.activity[review.activity.length - 1] ?? 'working…')
            : 'no pre-review yet — press s to check the PR out and read the diff'}
        </Text>
      )}
    </Box>
  );
}

function statusGlyph(r: Review): string {
  if (r.status === 'ready') return '◆';
  if (r.status === 'approved') return '✔';
  if (r.status === 'changes_requested') return '✖';
  if (r.status === 'posted') return '↑';
  if (r.status === 'error') return '✖';
  return '·';
}

/** owner/repo is mostly noise in a list where the owner rarely varies. */
function shortRepo(repository: string): string {
  return repository.split('/')[1] ?? repository;
}

export const reviewsKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row'],
  ['s', 'pre-review'],
  ['enter', 'expand'],
  ['p', 'post comments'],
  ['A', 'approve'],
  ['X', 'request changes'],
  ['n', 'note'],
  ['o', 'open PR'],
  ['x', 'cancel'],
  ['R', 'refresh'],
  ['/', 'filter'],
];
