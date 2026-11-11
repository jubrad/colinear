import { agentFor, agentNamed, pickableModels } from '../core/agent.js';
import { modelsFor } from '../core/models.js';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useRef, useState } from 'react';
import { attachTo, rememberView, reviewAttachable, sessionRuntime, setPendingAction } from '../core/attach.js';
import { useReviews } from '../core/hooks.js';
import { parsePrSpec } from '../core/reviews.js';
import { store } from '../core/store.js';
import { fileStats, parseDiff, type FileStat } from '../core/diff.js';
import type { Review, ReviewFinding } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { AnnotatedDiff, wrapText } from '../ui/AnnotatedDiff.js';
import { ReviewDocModal } from '../ui/ReviewDocModal.js';
import { ReviewOptionsModal } from '../ui/ReviewOptionsModal.js';
import { Popup, formHeight, popupPlacement } from '../ui/Popup.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { cell, formatDuration, formatTokens, spinner } from '../ui/format.js';
import { REVIEW_COLORS, theme } from '../theme.js';

const ACTIVE: Review['status'][] = ['reviewing', 'posting', 'queued'];

/**
 * Column widths. Status/PR always show; author and size drop out on narrow
 * terminals so the row never wraps (a wrapped row breaks the whole table).
 */
const W = { flag: 4, status: 12, pr: 24, draft: 9, author: 18, size: 14 };

/**
 * Two facts that decide whether a row wants you, neither of which the status
 * says: is the PR still asking for your review, and has the author pushed
 * since you gave it?
 */
export function freshness(r: Review): { glyph: string; color: string; why: string } | undefined {
  // first: only shown at all because `h` is on, and it should say why it was off
  if (r.hidden) return { glyph: '-', color: theme.dim, why: 'you hid this — H puts it back on the list' };
  const reviewed = r.posted?.sha ?? r.reviewedSha;
  if (reviewed && r.headSha && r.headSha !== reviewed) {
    return { glyph: '↻', color: theme.warn, why: 'pushed since your review — r re-reviews' };
  }
  // only meaningful while the PR is open: a settled review is asking nobody
  if (r.requested && r.status !== 'stale') {
    // a request aimed at you personally is yours to answer; one that reached
    // you through a team may already be someone else's, so it reads quieter
    return r.requestedVia === 'team'
      ? { glyph: '○', color: theme.dim, why: 'requested from a team you are on — anyone on it can take this' }
      : { glyph: '●', color: theme.key, why: 'your review is requested' };
  }
  // nobody asked for this one — you put it here. Worth saying, because it is
  // the row that will not leave the list on its own
  if (r.adopted && r.status !== 'stale') {
    return { glyph: '+', color: theme.accent, why: 'you added this one — it stays until the PR settles' };
  }
  return undefined;
}

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
    title: Math.max(16, avail - W.flag - W.status - W.pr - W.draft - author - size),
  };
}
const SEVERITY_COLOR: Record<string, string> = {
  blocking: theme.err,
  consider: theme.warn,
  nit: theme.dim,
  praise: theme.ok,
  // a question or a remark: no judgement, so off the severity ramp
  comment: theme.accent,
  // an annotation is not a mild finding, so it is not a mild yellow
  info: theme.annotation,
};

/** PRs waiting on my review, with an assisted pre-review per PR. */
export function ReviewsView(props: { param?: string }) {
  const ctx = useColinear();
  const pane = useViewSize();
  const reviews = useReviews();
  // settled rows are hidden rather than gone: the count is always shown, so a
  // list that looks short says how much it is not showing
  const [showHidden, setShowHidden] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<'post' | 'approve' | 'request-changes'>();
  const [reading, setReading] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  /** per review: files widened to the whole file, or opened from a search */
  const [expanded, setExpanded] = useState<Record<string, string[]>>({});
  const [annotated, setAnnotated] = useState(true);
  /** the `c` popup: a model and instructions for this review */
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => ctx.onReviewDiff?.((id, diff) => setDiffs((d) => ({ ...d, [id]: diff }))), []);
  /**
   * A diff fetched before a review re-read the PR is the old PR's diff. Dropped
   * when the sha a review was read at moves, so the preview's file list and
   * enter both ask again rather than showing what was there an hour ago.
   */
  const readAt = useRef(new Map<string, string | undefined>());
  useEffect(() => {
    const moved = reviews.filter((r) => readAt.current.has(r.id) && readAt.current.get(r.id) !== r.reviewedSha);
    for (const r of reviews) readAt.current.set(r.id, r.reviewedSha);
    if (moved.length)
      setDiffs((d) => {
        const next = { ...d };
        for (const r of moved) delete next[r.id];
        return next;
      });
  }, [reviews]);
  /** wide enough for the list and a preview side by side */
  const wide = pane.width >= SPLIT_MIN;
  /** the list or the preview: in the preview, i/k walk the findings */
  const [focus, setFocus] = useState<'list' | 'preview'>('list');
  const [findIdx, setFindIdx] = useState(0);
  /** where enter put the diff — a finding picked in the preview, or the top */
  const [startAt, setStartAt] = useState<{ file: string; line: number }>();
  const [sort, setSort] = useState<SortKey>('needs me');
  const [desc, setDesc] = useState(false);

  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = reviews.filter((r) => {
      // Settled reviews pile up — a month of them, since retention keeps them
      // that long — so the list is what is still live and `h` reveals the rest.
      // It used to be the filter text containing the word "stale", which found
      // them by accident as often as on purpose and told nobody they existed.
      // Hidden with `H` is the same deal by your hand rather than GitHub's.
      if ((r.status === 'stale' || r.hidden) && !showHidden) return false;
      if (!terms.length) return true;
      const hay = `${r.repository} ${r.number} ${r.title} ${r.author} ${r.status}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // needs-me-first: a review whose PR moved under it comes before everything,
    // because it is the one where what you already did no longer applies
    const rank = (r: Review) => {
      // only listed at all because `h` is on: below everything that is live
      if (r.hidden) return 5;
      const reviewed = r.posted?.sha ?? r.reviewedSha;
      if (reviewed && r.headSha && r.headSha !== reviewed) return -1;
      // a team request is not addressed to you in particular, so it sits below
      // work that is
      if (r.requestedVia === 'team' && r.status === 'pending') return 3.5;
      return r.status === 'ready'
        ? 0
        : ACTIVE.includes(r.status)
          ? 1
          : r.status === 'error'
            ? 2
            : r.status === 'pending'
              ? 3
              : 4;
    };
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
  }, [reviews, query, sort, desc, showHidden]);

  const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  /** the preview's findings, in the order you would want them read */
  const ordered = useMemo(() => byWeight(selected?.findings ?? []), [selected?.findings]);
  // another PR is another list of findings: start at its first, from the list
  useEffect(() => {
    setFindIdx(0);
    if (!ordered.length) setFocus('list');
  }, [selected?.id]);
  useEffect(() => setFindIdx((i) => Math.max(0, Math.min(i, ordered.length - 1))), [ordered.length]);

  // The preview lists the files the PR changes, and that needs the diff. Fetched
  // once the cursor settles rather than on every row it passes over: holding j
  // through twenty PRs should not be twenty `git diff`s.
  useEffect(() => {
    if (!wide || !selected?.worktree || diffs[selected.id] !== undefined) return;
    const id = selected.id;
    const t = setTimeout(() => ctx.dispatcher.reviewDiff(id, expanded[id]), 250);
    return () => clearTimeout(t);
  }, [wide, selected?.id, selected?.worktree, selected ? diffs[selected.id] : undefined]);
  const selectedDiff = selected ? diffs[selected.id] : undefined;
  const stats = useMemo(() => (selectedDiff ? fileStats(parseDiff(selectedDiff)) : undefined), [selectedDiff]);

  useEffect(() => {
    // the modal's chat input owns the keyboard too
    ctx.setCapture(filtering || noting || reading || customizing);
  }, [filtering, noting, reading, customizing]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    // esc steps back out of the preview before it clears a filter
    const inPreview = wide && focus === 'preview';
    ctx.setEscHandler(inPreview ? () => (setFocus('list'), true) : query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query, focus, wide]);

  // one poll on entry so the list isn't stale from the 5-minute cadence
  useEffect(() => {
    ctx.dispatcher.pollReviews();
  }, []);

  /** the last param acted on, so a not-found one is handled once and not per poll */
  const handled = useRef<string | undefined>(undefined);

  // :reviews <id> selects that PR; "doc:<id>" reopens its document, which is
  // how we land back where we were after $EDITOR or an attached session
  useEffect(() => {
    if (!props.param) return;
    const wantsDoc = props.param.startsWith('doc:');
    const id = wantsDoc ? props.param.slice(4) : props.param;
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) {
      // Once per thing typed, not once per list change: this effect re-runs
      // whenever the list grows, and adopting or complaining again each time
      // would fire on every poll.
      if (wantsDoc || handled.current === props.param) return;
      handled.current = props.param;
      // a PR we don't hold: adopt it, if what was typed names one. Your own
      // pull requests never arrive on their own — the list is filled by a
      // search for review requests, and you cannot request one from yourself
      if (parsePrSpec(id)) {
        ctx.dispatcher.adoptReview(id);
        return;
      }
      // and if it names nothing at all, say so. Silence here read as the
      // command being broken, when the answer was that `13317` and
      // `cloud#13317` are not pull requests — the owner is not optional
      ctx.toast(`${id}: not on the list, and not a pull request — try owner/repo#123`, 'err');
      return;
    }
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
      const inPreview = wide && focus === 'preview';
      // sideways between the list and the preview, the way the board moves
      // between columns
      if (wide && (input === 'l' || key.rightArrow) && ordered.length) setFocus('preview');
      if (input === 'j' || key.leftArrow) setFocus('list');
      if (inPreview) {
        if (key.upArrow || input === 'i') setFindIdx((n) => Math.max(0, n - 1));
        if (key.downArrow || input === 'k') setFindIdx((n) => Math.min(ordered.length - 1, n + 1));
      } else {
        if (key.upArrow || input === 'i') setCursor((c) => Math.max(0, c - 1));
        if (key.downArrow || input === 'k') setCursor((c) => Math.min(rows.length - 1, c + 1));
      }
      if (input === '/') setFiltering(true);
      if (!selected) return;
      if (input === 'a' && selected.question) return; // answering handled below
      // enter reads the review against the code — from the preview, at the
      // finding the cursor is on; d reads the document itself
      if (key.return) {
        const f = inPreview ? ordered[findIdx] : undefined;
        setStartAt(f?.file && typeof f.line === 'number' ? { file: f.file, line: f.line } : undefined);
        setAnnotated(true);
        setReading(true);
        if (!diffs[selected.id]) ctx.dispatcher.reviewDiff(selected.id, expanded[selected.id]);
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
      if (input === 'c') {
        if (ACTIVE.includes(selected.status)) ctx.toast('a session is running on this review — x stops it first', 'info');
        else if (!selected.repo) ctx.toast(`${selected.repository} is not in your repos allowlist`, 'err');
        else setCustomizing(true);
      }
      if (input === 's') {
        // same as the board: hand this terminal to the review's own session,
        // on the runtime that owns it
        rememberView('reviews', selected.id);
        attachTo(
          reviewAttachable(selected, ACTIVE.includes(selected.status)),
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
      if (input === 'h') {
        setShowHidden((v) => !v);
        setCursor(0);
      }
      if (input === 'H') {
        // a review write like the note: the mirror forwards it to the daemon
        const hide = !selected.hidden;
        store.updateReview(selected.id, { hidden: hide || undefined });
        const pr = `${selected.repository}#${selected.number}`;
        ctx.toast(hide ? `hid ${pr}${showHidden ? '' : ' — h shows hidden ones'}` : `${pr} is back on the list`, 'info');
      }
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
    { isActive: !filtering && !noting && !reading && !customizing && !ctx.cmdOpen },
  );

  const ready = reviews.filter((r) => r.status === 'ready' && !r.hidden).length;
  const settled = reviews.filter((r) => r.status === 'stale').length;
  // a hidden review that has since settled counts once, as settled
  const dismissed = reviews.filter((r) => r.hidden && r.status !== 'stale').length;
  const held = [settled ? `${settled} settled` : '', dismissed ? `${dismissed} hidden by you` : '']
    .filter(Boolean)
    .join(', ');
  const cols = layout(ctx.size.columns);
  // Side by side, the list keeps the columns that pick a row out — whether it
  // wants you, what state it is in, which PR — and the preview carries the
  // rest. The split's height is the pane less the header, the filter bar and
  // whatever prompt sits under it; anything taller would push the header off.
  const listWidth = Math.min(84, Math.max(56, Math.floor(pane.width * 0.42)));
  const splitHeight = Math.max(
    8,
    pane.height - 2 - (filtering ? 1 : 0) - (noting ? 1 : 0) - (confirm ? 3 : 0),
  );
  // rows that fit: in the split, the split less its column header and the
  // scroll line; stacked, the total less the detail pane, header and chrome
  const visible = wide ? Math.max(3, splitHeight - 2) : Math.max(3, ctx.size.rows - 16);
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

  if (reading && selected && annotated) {
    return (
      <AnnotatedDiff
        review={selected}
        diff={diffs[selected.id]}
        width={pane.width}
        height={Math.max(12, pane.height)}
      busy={Boolean(selected.chatting) || ACTIVE.includes(selected.status)}
        onSend={(text) => ctx.dispatcher.reviewChat(selected.id, text)}
        onEditFinding={(file, line, comment, severity, startLine, by, nth) =>
          ctx.dispatcher.editFinding(selected.id, file, line, comment, severity, startLine, by, nth)
        }
        signing={{ signoff: ctx.cfg.prSignoff, scope: ctx.cfg.prSignoffScope }}
        onExplain={(file, startLine, endLine, opts) =>
          ctx.dispatcher.explainLines(selected.id, file, startLine, endLine, opts)
        }
        expanded={expanded[selected.id]}
        onExpand={(files) => {
          setExpanded((e) => ({ ...e, [selected.id]: files }));
          ctx.dispatcher.reviewDiff(selected.id, files);
        }}
        onSearch={(mode, query) => ctx.dispatcher.codeSearch(selected.id, mode, query)}
        startAt={startAt}
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
        width={pane.width}
        height={Math.max(10, pane.height)}
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
          {rows.length} {showHidden ? 'shown' : 'awaiting me'}{' '}
        </Text>
        {ready > 0 && <Text color={REVIEW_COLORS.ready}>· {ready} pre-reviewed </Text>}
        {held && (
          <Text color={showHidden ? theme.accent : REVIEW_COLORS.stale}>
            · {held} {showHidden ? 'shown (h hides)' : 'not shown (h shows)'}{' '}
          </Text>
        )}
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

      {wide ? (
        <Box flexDirection="row" marginTop={1} height={splitHeight} flexShrink={0}>
          <Box flexDirection="column" width={listWidth} flexShrink={0} overflow="hidden">
            <Text bold color={theme.header} wrap="truncate">
              {cell('', W.flag)}
              {'  '}
              {cell('PR', W.pr)}
              TITLE
            </Text>
            {window.map((r, i) => {
              const onCursor = start + i === cursor;
              const flag = freshness(r);
              // the cursor stays lit while you are in the preview, dimmer, so
              // it still says which PR the preview is of
              const lit = onCursor && focus === 'list';
              return (
                <Text
                  key={r.id}
                  wrap="truncate"
                  inverse={lit}
                  bold={onCursor && !lit}
                  dimColor={r.hidden && !onCursor}
                >
                  <Text color={lit ? undefined : flag?.color}>{cell(flag?.glyph ?? '', W.flag)}</Text>
                  <Text color={lit ? undefined : REVIEW_COLORS[r.status] ?? theme.dim}>
                    {ACTIVE.includes(r.status) ? spinner(ctx.now) : statusGlyph(r)}{' '}
                  </Text>
                  <Text bold>{cell(`${shortRepo(r.repository)}#${r.number}`, W.pr)}</Text>
                  <Text color={!lit && r.isDraft ? theme.dim : undefined}>{r.title}</Text>
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
          {selected && (
            <Preview
              review={selected}
              now={ctx.now}
              width={pane.width - listWidth - 1}
              height={splitHeight}
              findings={ordered}
              findIdx={findIdx}
              focused={focus === 'preview'}
              stats={stats}
              loadingStats={Boolean(selected.worktree) && selectedDiff === undefined}
              resumeHint={(id) => {
                const owner = sessionRuntime(selected);
                return (owner ? agentNamed(ctx.cfg, owner) : agentFor(ctx.cfg)).resumeHint(id);
              }}
            />
          )}
        </Box>
      ) : (
        <>
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text bold color={theme.header} wrap="truncate">
          {'  '}
          {cell('', W.flag)}
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
          const flag = freshness(r);
          return (
            <Text key={r.id} wrap="truncate" inverse={onCursor} dimColor={r.hidden && !onCursor}>
              <Text color={onCursor ? undefined : flag?.color}>{cell(flag?.glyph ?? '', W.flag)}</Text>
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

      {selected && (
        <Detail
          review={selected}
          now={ctx.now}
          resumeHint={(id) => {
            const owner = sessionRuntime(selected);
            return (owner ? agentNamed(ctx.cfg, owner) : agentFor(ctx.cfg)).resumeHint(id);
          }}
        />
      )}

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
        </>
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

      {/* last: an absolute box is overdrawn by anything rendered after it */}
      {customizing &&
        selected &&
        (() => {
          const inner = Math.min(100, ctx.size.columns - 6) - 4;
          const lines = Math.max(3, Math.min(8, ctx.size.rows - 8 - formHeight(2) - 4));
          const place = popupPlacement(ctx.size, { width: inner + 4, height: formHeight(2, lines + 2) }, ctx.cmdOpen);
          const ref = `${shortRepo(selected.repository)}#${selected.number}`;
          return (
            <Popup {...place}>
              <ReviewOptionsModal
                title={`${selected.posted ? 're-review' : 'review'} ${ref}${selected.posted ? ' — what changed since you posted' : ''}`}
                models={pickableModels(ctx.cfg)}
                model={selected.model}
                instructions={selected.instructions}
                configured={modelsFor(ctx.cfg, 'review').model}
                width={inner}
                instructionLines={lines}
                onSubmit={(opts) => {
                  setCustomizing(false);
                  ctx.dispatcher.startReview(selected.id, opts);
                  ctx.toast(
                    `${selected.posted ? 're-reviewing' : 'pre-reviewing'} ${ref}${opts.model ? ` on ${opts.model}` : ''}${
                      opts.instructions ? ' with your instructions' : ''
                    }`,
                    'info',
                  );
                }}
                onCancel={() => setCustomizing(false)}
              />
            </Popup>
          );
        })()}
    </Box>
  );
}

/** Rows `DetailHead` draws, so the preview can budget what is left under it. */
function headRows(review: Review): number {
  return (
    (freshness(review) ? 1 : 0) +
    2 +
    (review.sessionId ? 1 : 0) +
    (review.error ? 1 : 0) +
    (review.note ? 1 : 0) +
    (review.model || review.instructions ? 1 : 0)
  );
}

/** Who, where and what state: the top of the detail pane, stacked or beside the list. */
function DetailHead(props: { review: Review; now: number; resumeHint: (id: string) => string | undefined }) {
  const { review, now } = props;
  // the glyph in the row is a hint; this is where it says what it means
  const flag = freshness(review);
  return (
    <>
      {flag && (
        <Text color={flag.color} wrap="truncate">
          {flag.glyph} {flag.why}
        </Text>
      )}
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
          session {review.sessionId}
          {props.resumeHint(review.sessionId) ? ` — ${props.resumeHint(review.sessionId)}` : ''}
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
      {(review.model || review.instructions) && (
        <Text color={theme.accent} wrap="truncate">
          {review.model ? `model: ${review.model}` : ''}
          {review.model && review.instructions ? ' · ' : ''}
          {review.instructions ? `instructions: ${review.instructions.replace(/\s+/g, ' ')}` : ''}
          <Text dimColor> — c changes</Text>
        </Text>
      )}
    </>
  );
}

function Detail(props: { review: Review; now: number; resumeHint: (id: string) => string | undefined }) {
  const { review } = props;
  const findings = review.findings ?? [];
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  return (
    <Box flexDirection="column" flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1} overflow="hidden">
      <DetailHead {...props} />

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

/** Narrower than this, the list and the preview stack — the list needs its title, the preview its findings. */
const SPLIT_MIN = 140;

const WEIGHT: Record<string, number> = { blocking: 1, consider: 2, comment: 3, nit: 4, praise: 5, info: 6 };

/**
 * Findings in the order they are worth reading from a list: the lead (what the
 * whole thing amounts to), then blocking down to praise, annotations last —
 * they are context for reading the diff, and read best beside it.
 */
function byWeight(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => (a.severity ? WEIGHT[a.severity] ?? 7 : 0) - (b.severity ? WEIGHT[b.severity] ?? 7 : 0));
}

/** A path cut from the left, keeping the file name. */
function shortenPath(path: string, room: number): string {
  return path.length <= room ? path : `…${path.slice(path.length - room + 1)}`;
}

/**
 * The selected review beside the list: who and where, what the agent made of
 * it, every finding — walkable, so enter opens the diff on the one you picked —
 * and the files the PR touches with what each one changes. The pane is sized
 * by hand rather than left to flex: Ink overflows instead of clipping, so a
 * preview one row too tall paints over the footer.
 */
function Preview(props: {
  review: Review;
  now: number;
  width: number;
  height: number;
  findings: ReviewFinding[];
  findIdx: number;
  focused: boolean;
  stats?: FileStat[];
  loadingStats: boolean;
  resumeHint: (id: string) => string | undefined;
}) {
  const { review, now, findings, findIdx, focused, stats } = props;
  // border and padding: two columns a side, a row top and bottom
  const w = Math.max(20, props.width - 4);
  const h = Math.max(4, props.height - 2);
  const blocking = findings.filter((f) => f.severity === 'blocking').length;
  const active = ACTIVE.includes(review.status);

  const questions = review.question?.questions ?? [];
  const questionRows = questions.reduce((n, q) => n + 1 + q.options.length, 0);
  // a short pane spends its rows on the findings before the prose about them
  const wrapped = review.summary ? wrapText(review.summary.replace(/\s+/g, ' '), w) : [];
  const summary = wrapped.slice(0, h >= 24 ? 3 : h >= 18 ? 1 : 0);
  if (summary.length && wrapped.length > summary.length) {
    summary[summary.length - 1] = `${summary[summary.length - 1].slice(0, w - 1)}…`;
  }
  // what the agent is doing, while there is nothing yet to say about the PR
  const tail = !review.summary && active ? review.activity.slice(h >= 24 ? -8 : -3) : [];
  const hint = !review.summary && !active && !findings.length;
  const used =
    headRows(review) +
    1 +
    questionRows +
    (summary.length ? 1 + summary.length : 0) +
    (active && !review.summary ? 2 + tail.length : 0) +
    (hint ? 2 : 0);

  // The findings and the files share what is left, each section spending a
  // blank row and a header. Both get all they want when it fits; otherwise the
  // files keep a third and the findings — the reason to look — take the rest.
  const fileCount = stats?.length ?? 0;
  const avail = Math.max(2, h - used - 2 - (findings.length ? 2 : 0));
  const fileWant = Math.max(1, fileCount);
  let findRows = findings.length
    ? Math.max(1, Math.min(findings.length, avail - Math.min(fileWant, Math.max(1, Math.floor(avail / 3)))))
    : 0;
  let filesRows = Math.max(1, Math.min(fileWant, avail - findRows));
  // cut short, the list ends in an "N more" line, which comes out of the files' own rows
  if (fileCount > filesRows) filesRows = Math.max(1, avail - findRows - 1);
  let filesMore = fileCount > filesRows ? 1 : 0;
  // Over budget — the "N more" line is a row too — each list gives way, never
  // below one row. Ink does not clip an overfull box, it squashes rows out of
  // the top, which is how a short terminal lost the PR's own header.
  while (findRows + filesRows + filesMore > avail && findRows > 1) findRows--;
  while (findRows + filesRows + filesMore > avail && filesRows > 1) {
    filesRows--;
    filesMore = fileCount > filesRows ? 1 : 0;
  }
  const top = Math.max(0, Math.min(findIdx - Math.floor(findRows / 2), findings.length - findRows));

  const pathRoom = Math.max(12, w - 26);
  const most = Math.max(1, ...(stats ?? []).map((s) => s.added + s.removed));
  const BAR = 10;
  const bar = (n: number) => (n ? Math.max(1, Math.round((n / most) * BAR)) : 0);

  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      marginLeft={1}
      borderStyle="single"
      borderColor={focused ? theme.key : theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <DetailHead review={review} now={now} resumeHint={props.resumeHint} />
      <Text bold wrap="truncate">
        {review.title}
      </Text>

      {questions.map((q, qi) => (
        <Box key={`${qi}-${q.text.slice(0, 12)}`} flexDirection="column">
          <Text color={theme.info} bold wrap="truncate">
            ? {q.header ? `[${q.header}] ` : ''}
            {q.text}
          </Text>
          {q.options.map((opt, i) => (
            <Text key={opt.label} color={theme.info} wrap="truncate">
              {'  '}
              {i + 1}. {opt.label}
              {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
            </Text>
          ))}
        </Box>
      ))}

      {summary.length > 0 && (
        <>
          <Text> </Text>
          {summary.map((line, i) => (
            <Text key={`s${i}`} wrap="truncate">
              {line}
            </Text>
          ))}
        </>
      )}

      {findings.length > 0 && (
        <>
          <Text> </Text>
          <Text bold color={theme.header} wrap="truncate">
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {blocking ? <Text color={theme.err}> · {blocking} blocking</Text> : null}
            <Text dimColor>
              {focused ? ' — i/k walk · enter opens the diff there · j back' : ' — l walks them · enter reads the diff'}
            </Text>
          </Text>
          {findings.slice(top, top + findRows).map((f, i) => {
            const here = focused && top + i === findIdx;
            const where = f.file ? `${shortenPath(f.file, 28)}${f.line ? `:${f.line}` : ''} ` : '';
            return (
              <Text key={`${f.file}-${f.line}-${top + i}`} wrap="truncate" inverse={here}>
                <Text color={here ? undefined : f.severity ? (SEVERITY_COLOR[f.severity] ?? theme.dim) : theme.accent}>
                  {(f.severity ?? 'lead').padEnd(9)}
                </Text>
                <Text dimColor={!here}>{where}</Text>
                {f.comment.replace(/\s+/g, ' ')}
              </Text>
            );
          })}
        </>
      )}

      {!review.summary && active && (
        <>
          <Text> </Text>
          <Text dimColor>
            {review.activity.length} step{review.activity.length === 1 ? '' : 's'} · s attaches to this session
          </Text>
          {tail.map((line, i) => (
            <Text key={`${i}-${line.slice(0, 12)}`} dimColor wrap="truncate">
              {line}
            </Text>
          ))}
        </>
      )}
      {hint && (
        <>
          <Text> </Text>
          <Text dimColor wrap="truncate">
            no pre-review yet — r checks the PR out and reads the diff
          </Text>
        </>
      )}

      <Text> </Text>
      <Text bold color={theme.header} wrap="truncate">
        {review.changedFiles} file{review.changedFiles === 1 ? '' : 's'}{' '}
        <Text color={theme.ok}>+{review.additions}</Text> <Text color={theme.err}>-{review.deletions}</Text>
        <Text dimColor>
          {stats
            ? ''
            : props.loadingStats
              ? ' — reading the diff…'
              : review.repo
                ? ' — r checks it out, and the files are listed here'
                : ''}
        </Text>
      </Text>
      {(stats ?? []).slice(0, filesRows).map((s) => (
        <Text key={s.file} wrap="truncate">
          {cell(shortenPath(s.file, pathRoom - 1), pathRoom)}
          <Text color={theme.ok}>{`+${s.added}`.padStart(6)}</Text>
          <Text color={theme.err}>{`-${s.removed}`.padStart(6)}</Text>{' '}
          <Text backgroundColor={theme.ok}>{' '.repeat(bar(s.added))}</Text>
          <Text backgroundColor={theme.err}>{' '.repeat(bar(s.removed))}</Text>
        </Text>
      ))}
      {filesMore ? <Text dimColor>… {fileCount - filesRows} more — enter, then ] and [ walk them</Text> : null}
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
  ['l/j ←→', 'into / out of the preview (wide)'],
  ['r', 'pre-review · re-review once posted'],
  ['c', 'review with a model + instructions'],
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
  ['H', 'hide / unhide'],
  ['h', 'show settled + hidden'],
  ['u', 'refresh'],
  ['/', 'filter'],
];
