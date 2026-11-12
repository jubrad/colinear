import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { pickableModels } from '../core/agent.js';
import { useJobs } from '../core/hooks.js';
import { newJob, nextRun } from '../core/jobs.js';
import { age } from '../core/fleet.js';
import { modelsFor } from '../core/models.js';
import { store } from '../core/store.js';
import type { Job, JobRun } from '../core/types.js';
import { JOB_FORM_ROWS, JobModal, type JobFields } from '../ui/JobModal.js';
import { Popup, popupPlacement } from '../ui/Popup.js';
import { wrap } from '../ui/TextArea.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { cell, spinner } from '../ui/format.js';
import { theme } from '../theme.js';

/** Wide enough for the list and the report side by side. */
const SPLIT_MIN = 120;

const RUN_GLYPH: Record<JobRun['status'], string> = { running: '', ok: '✓', error: '✖', cancelled: '-' };

/** "in 3h", "in 12m" — when the clock next starts it. */
function until(at: number, now: number): string {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

function whenText(job: Job, now: number): string {
  if (!job.schedule) return 'by hand';
  if (job.paused) return 'paused';
  return job.nextRunAt ? until(job.nextRunAt, now) : '…';
}

/**
 * Jobs: work asked of colinear directly, once or on a schedule. The list says
 * what each one is and when it next runs; beside it, the selected job's last
 * run — what it did through colinear, and its report, which is the point of
 * running it. `enter` moves into the report to scroll it, `[` `]` step through
 * earlier runs.
 */
export function JobsView(props: { param?: string }) {
  const ctx = useColinear();
  const pane = useViewSize();
  const jobs = useJobs();
  const [cursorId, setCursorId] = useState<string | undefined>(
    () => store.listJobs().find((j) => j.id === props.param || j.name === props.param)?.id,
  );
  const [form, setForm] = useState<{ job?: Job } | null>(null);
  const [focus, setFocus] = useState<'list' | 'report'>('list');
  /** which run is shown, counted back from the newest */
  const [back, setBack] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState<string>();

  const found = jobs.findIndex((j) => j.id === cursorId);
  const cursor = found === -1 ? 0 : found;
  const selected = jobs[cursor];
  const runs = selected?.runs ?? [];
  const run = runs[runs.length - 1 - Math.min(back, Math.max(0, runs.length - 1))];

  useEffect(() => {
    setBack(0);
    setScroll(0);
  }, [selected?.id]);
  useEffect(() => setScroll(0), [back]);

  useEffect(() => ctx.setCapture(form !== null), [form]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(focus === 'report' ? () => (setFocus('list'), true) : null);
    return () => ctx.setEscHandler(null);
  }, [focus]);

  const move = (to: number) => {
    const next = jobs[Math.max(0, Math.min(jobs.length - 1, to))];
    if (next) setCursorId(next.id);
  };

  const save = (fields: JobFields) => {
    const nextRunAt = fields.schedule ? nextRun(fields.schedule).at : undefined;
    if (form?.job) {
      store.updateJob(form.job.id, { ...fields, nextRunAt });
      ctx.toast(`saved ${fields.name}`, 'ok');
    } else {
      const job = newJob({ ...fields, nextRunAt });
      store.upsertJob(job);
      setCursorId(job.id);
      ctx.toast(fields.schedule ? `${fields.name} scheduled — r runs it now too` : `${fields.name} created — r runs it`, 'ok');
    }
    setForm(null);
  };

  // the report, laid out to the preview's width so scrolling is by real lines
  const wide = pane.width >= SPLIT_MIN;
  const listWidth = wide ? Math.min(70, Math.floor(pane.width * 0.42)) : pane.width;
  const bodyHeight = Math.max(6, pane.height - 2);
  const listHeight = wide ? bodyHeight : Math.max(4, Math.min(jobs.length + 2, Math.floor(bodyHeight / 3)));
  const previewWidth = wide ? pane.width - listWidth - 1 : pane.width;
  const previewHeight = wide ? bodyHeight : bodyHeight - listHeight;
  const reportText = run?.report ?? (run?.error ? `✖ ${run.error}` : '');
  const reportLines = reportText
    .split('\n')
    .flatMap((line) => (line ? wrap(line, Math.max(10, previewWidth - 4)).map((l) => l.text) : ['']));

  useInput(
    (input, key) => {
      if (focus === 'report') {
        if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
        if (key.downArrow || input === 'j') setScroll((s) => Math.min(Math.max(0, reportLines.length - 1), s + 1));
        if (input === ' ' || key.pageDown) setScroll((s) => Math.min(Math.max(0, reportLines.length - 1), s + 10));
        if (key.pageUp) setScroll((s) => Math.max(0, s - 10));
        if (input === '[') setBack((b) => Math.min(runs.length - 1, b + 1));
        if (input === ']') setBack((b) => Math.max(0, b - 1));
        return;
      }
      if (key.upArrow || input === 'k') move(cursor - 1);
      if (key.downArrow || input === 'j') move(cursor + 1);
      if (input === 'g') move(0);
      if (input === 'G') move(jobs.length - 1);
      if (input === 'n') return setForm({});
      if (!selected) return;
      if (input === '[') setBack((b) => Math.min(Math.max(0, runs.length - 1), b + 1));
      if (input === ']') setBack((b) => Math.max(0, b - 1));
      if (key.return && run) setFocus('report');
      if (input === 'e') setForm({ job: selected });
      if (input === 'r') {
        if (selected.running) return ctx.toast(`${selected.name} is already running — x stops it`, 'info');
        ctx.dispatcher.runJob(selected.id);
        setBack(0);
        ctx.toast(`running ${selected.name}`, 'info');
      }
      if (input === 'x') {
        if (!selected.running) return ctx.toast(`${selected.name} is not running`, 'info');
        ctx.dispatcher.cancelJob(selected.id);
      }
      if (input === 'p' && selected.schedule) {
        store.updateJob(selected.id, { paused: selected.paused ? undefined : true });
        ctx.toast(selected.paused ? `${selected.name} resumed` : `${selected.name} paused — its schedule is kept`, 'info');
      }
      if (input === 'D') {
        if (selected.running) return ctx.toast('stop it first — x', 'info');
        if (confirmDelete !== selected.id) {
          setConfirmDelete(selected.id);
          return ctx.toast(`D again deletes ${selected.name} and its runs`, 'info');
        }
        store.deleteJob(selected.id);
        setConfirmDelete(undefined);
        ctx.toast(`deleted ${selected.name}`, 'ok');
      } else if (confirmDelete) setConfirmDelete(undefined);
    },
    { isActive: form === null && !ctx.cmdOpen },
  );

  const listRows = Math.max(1, listHeight - 1);
  const top = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), jobs.length - listRows));

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          jobs{' '}
        </Text>
        <Text dimColor>
          {jobs.length} · {jobs.filter((j) => j.running).length} running · n new · r run · e edit · enter read the report
        </Text>
      </Text>
      <Box height={1} />
      <Box flexDirection={wide ? 'row' : 'column'} height={bodyHeight}>
        <Box flexDirection="column" width={listWidth} flexShrink={0} height={listHeight} overflow="hidden">
          <Text bold color={theme.header} wrap="truncate">
            {'  '}
            {cell('JOB', 24)}
            {cell('NEXT', 10)}
            LAST RUN
          </Text>
          {jobs.slice(top, top + listRows).map((job, i) => {
            const idx = top + i;
            const last = job.runs[job.runs.length - 1];
            const on = idx === cursor;
            const glyph = job.running ? spinner(ctx.now) : last ? RUN_GLYPH[last.status] : ' ';
            const color = job.running ? theme.warn : last?.status === 'ok' ? theme.ok : last?.status === 'error' ? theme.err : theme.dim;
            return (
              <Text key={job.id} wrap="truncate" inverse={on && focus === 'list'}>
                <Text color={on ? undefined : color}>{glyph} </Text>
                <Text bold={on}>{cell(job.name, 24)}</Text>
                <Text dimColor={!on}>{cell(whenText(job, ctx.now), 10)}</Text>
                <Text dimColor={!on}>
                  {job.running ? 'running…' : last ? `${age(last.endedAt ?? last.startedAt, ctx.now)} ago · ${last.summary ?? last.error ?? last.status}` : 'never run'}
                </Text>
              </Text>
            );
          })}
          {!jobs.length && (
            <Text dimColor wrap="wrap">
              No jobs yet. A job is work you ask colinear for directly — "review and approve the dependabot PRs", "summarise
              my week on GitHub" — run by hand or on a cron schedule, reporting back here. n makes one.
            </Text>
          )}
        </Box>
        {selected && (
          <Preview
            job={selected}
            run={run}
            runIndex={runs.length - Math.min(back, Math.max(0, runs.length - 1))}
            runCount={runs.length}
            lines={reportLines}
            scroll={scroll}
            focused={focus === 'report'}
            now={ctx.now}
            width={previewWidth}
            height={previewHeight}
          />
        )}
      </Box>
      {/* last: an absolute box is painted in tree order */}
      {form &&
        (() => {
          const inner = Math.max(50, Math.min(96, ctx.size.columns - 8)) - 4;
          const lines = Math.max(3, Math.min(8, pane.height - JOB_FORM_ROWS - 2));
          const place = popupPlacement(ctx.size, { width: inner + 4, height: JOB_FORM_ROWS + lines + 2 }, ctx.cmdOpen);
          return (
            <Popup {...place}>
              <JobModal
                job={form.job}
                models={pickableModels(ctx.cfg)}
                configured={modelsFor(ctx.cfg, 'job').model}
                configuredMode={ctx.cfg.agentPermissionMode ?? 'auto'}
                width={inner}
                promptLines={lines}
                onSubmit={save}
                onCancel={() => setForm(null)}
              />
            </Popup>
          );
        })()}
    </Box>
  );
}

/**
 * The selected job and one of its runs: what it is allowed, what the run did
 * through colinear, then the report. Sized by hand — Ink squashes an overfull
 * box from the top, and the top says what this is.
 */
function Preview(props: {
  job: Job;
  run?: JobRun;
  runIndex: number;
  runCount: number;
  lines: string[];
  scroll: number;
  focused: boolean;
  now: number;
  width: number;
  height: number;
}) {
  const { job, run, now } = props;
  const grants = [
    job.actions.length ? `may ${job.actions.join(', ')}` : 'read and report only',
    job.userSettings ? 'your MCP servers' : '',
    job.permissionMode ? `mode ${job.permissionMode}` : '',
    job.deny?.length ? `denies ${job.deny.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const actionRows = run ? Math.min(run.actions.length, 4) : 0;
  const fixed = 2 + 1 + 1 + 1 + 1 + (run ? 1 : 0) + (actionRows ? actionRows + 1 : 0) + 1 + 1;
  const room = Math.max(1, props.height - fixed);
  const shown = props.lines.slice(props.scroll, props.scroll + room);
  const runColor = run?.status === 'ok' ? theme.ok : run?.status === 'error' ? theme.err : run?.status === 'running' ? theme.warn : theme.dim;

  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      marginLeft={props.width < 60 ? 0 : 1}
      borderStyle="single"
      borderColor={props.focused ? theme.borderFocus : theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        {job.name}
        <Text dimColor> {job.schedule ? `${job.schedule}${job.paused ? ' (paused)' : ''}` : 'by hand'}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {job.schedule && !job.paused && job.nextRunAt ? `next ${new Date(job.nextRunAt).toLocaleString()} · ` : ''}
        {job.model ?? 'default model'} · ${job.costUsd.toFixed(2)} so far
      </Text>
      <Text color={job.actions.includes('approve') || job.actions.includes('comment') ? theme.warn : theme.dim} wrap="truncate">
        {grants}
      </Text>
      <Text dimColor wrap="truncate">
        {job.prompt.split('\n')[0]}
      </Text>
      {run ? (
        <Text wrap="truncate">
          <Text color={runColor}>
            {run.status === 'running' ? spinner(now) : RUN_GLYPH[run.status]} {run.status}
          </Text>
          <Text dimColor>
            {' '}
            · run {props.runIndex} of {props.runCount} · {run.trigger === 'schedule' ? 'scheduled' : 'by hand'} ·{' '}
            {age(run.startedAt, now)} ago{run.endedAt ? ` · took ${age(run.startedAt, run.endedAt).replace('now', '<1m')}` : ''}
            {run.costUsd ? ` · $${run.costUsd.toFixed(2)}` : ''}
          </Text>
        </Text>
      ) : (
        <Text dimColor>never run — r runs it now</Text>
      )}
      {run?.summary && (
        <Text bold wrap="truncate">
          {run.summary}
        </Text>
      )}
      {actionRows > 0 && (
        <>
          <Text color={theme.header} wrap="truncate">
            through colinear:
          </Text>
          {run!.actions.slice(-actionRows).map((a, i) => (
            <Text key={`${i}-${a}`} dimColor wrap="truncate">
              {'  '}
              {a}
            </Text>
          ))}
        </>
      )}
      <Text> </Text>
      {shown.map((line, i) => (
        <Text key={`${props.scroll + i}`} wrap="truncate">
          {line || ' '}
        </Text>
      ))}
      <Box flexGrow={1} />
      <Text color={theme.key} wrap="truncate">
        {props.focused
          ? `j/k scroll · space page · [ ] other runs · esc back${props.lines.length > room ? ` · ${props.scroll + 1}-${Math.min(props.lines.length, props.scroll + room)} of ${props.lines.length}` : ''}`
          : 'enter read · [ ] other runs · r run now · x stop · p pause · D delete'}
      </Text>
    </Box>
  );
}

export const jobsKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'job · in the report, scroll'],
  ['n', 'new job'],
  ['e', 'edit'],
  ['r', 'run now'],
  ['x', 'stop the run'],
  ['enter', 'read the report'],
  ['[ ]', 'older / newer run'],
  ['p', 'pause the schedule'],
  ['D', 'delete (twice)'],
];
