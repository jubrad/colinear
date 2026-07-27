import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import { fetchProjectIssues, fetchProjects } from '../core/linear.js';
import { store } from '../core/store.js';
import type { LinearIssue, LinearProject } from '../core/types.js';
import { fuzzyMatch } from '../ui/CommandBar.js';
import { openUrl } from '../core/open.js';
import { useColinear } from '../ui/context.js';
import { DispatchModal, type DispatchOptions } from '../ui/DispatchModal.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { projectCache } from './ProjectsView.js';

interface StateColumn {
  title: string;
  types: string[];
  color: string;
}

const STATE_COLUMNS: StateColumn[] = [
  { title: 'Backlog', types: ['triage', 'backlog'], color: 'gray' },
  { title: 'Todo', types: ['unstarted'], color: '#5f87af' },
  { title: 'In Progress', types: ['started'], color: 'yellow' },
  { title: 'Done', types: ['completed'], color: 'green' },
];

export function ProjectView(props: { param?: string }) {
  const ctx = useColinear();
  useTasks(); // re-render on task changes so dispatched-status chips stay live
  const [project, setProject] = useState<LinearProject>();
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);

  useEffect(() => ctx.setCapture(asking), [asking]);
  useEffect(() => () => ctx.setCapture(false), []);

  const resolveProject = useCallback(async (): Promise<LinearProject | undefined> => {
    const param = (props.param ?? '').toLowerCase();
    const pool = projectCache.length ? projectCache : await fetchProjects(ctx.cfg);
    return (
      pool.find((p) => p.id === props.param) ??
      pool.find((p) => p.name.toLowerCase() === param) ??
      pool.find((p) => fuzzyMatch(p.name.toLowerCase(), param))
    );
  }, [props.param, ctx.cfg]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(undefined);
    resolveProject()
      .then(async (p) => {
        if (!p) {
          setError(`no project matches “${props.param ?? ''}”`);
          return;
        }
        setProject(p);
        setIssues(await fetchProjectIssues(ctx.cfg, p.id));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [resolveProject, ctx.cfg]);

  useEffect(() => refresh(), []);

  const ordered = useMemo(
    () =>
      STATE_COLUMNS.flatMap((col) => issues.filter((i) => col.types.includes(i.stateType ?? 'backlog'))),
    [issues],
  );
  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, ordered.length - 1))), [ordered.length]);
  const current = ordered[cursor];

  const picked = useCallback(
    () => (selected.size ? issues.filter((i) => selected.has(i.id)) : current ? [current] : []),
    [selected, issues, current],
  );

  const dispatch = useCallback(
    (picked: LinearIssue[], opts?: DispatchOptions) => {
      const eligible = picked.filter((i) => i.stateType !== 'completed');
      if (!eligible.length) return;
      // enqueue self-assigns and moves the Linear state to started
      ctx.dispatcher.enqueue(eligible, opts);
      ctx.toast(`dispatched ${eligible.length}`, 'ok');
      ctx.navigate('board');
    },
    [ctx],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow || input === 'h' || key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow || input === 'l' || key.downArrow || input === 'j') {
        setCursor((c) => Math.min(ordered.length - 1, c + 1));
      }
      if (input === ' ' && current) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(current.id)) next.delete(current.id);
          else next.add(current.id);
          return next;
        });
      }
      if (input === 'd' && picked().length) dispatch(picked());
      if (input === 'c' && picked().length) setAsking(true);
      if (input === 'r') refresh();
      if (input === 'o' && current) openUrl(current.url);
      if (input === 'p' && project) ctx.navigate('plan', project.name);
      if (key.return && current && store.get(current.id)) ctx.navigate('task', current.identifier);
    },
    { isActive: !asking && !ctx.cmdOpen },
  );

  if (loading) return <Text color={theme.warn}>Loading project…</Text>;
  if (error)
    return (
      <Box flexDirection="column">
        <Text color={theme.err}>{error}</Text>
        <Text dimColor>usage: :project NAME (or pick from :projects)</Text>
      </Box>
    );
  if (!project) return null;

  const colWidth = Math.max(20, Math.floor((ctx.size.columns - STATE_COLUMNS.length) / STATE_COLUMNS.length));

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          {project.name}
        </Text>
        <Text dimColor>
          {' '}· {project.state} · {Math.round(project.progress * 100)}% · {issues.length} issues
          {selected.size ? ` · ${selected.size} selected` : ''}
        </Text>
      </Text>
      {project.description && (
        <Text dimColor wrap="truncate">
          {project.description}
        </Text>
      )}
      {asking && (
        <DispatchModal
          count={picked().length}
          repos={ctx.cfg.repos}
          onSubmit={(opts) => {
            setAsking(false);
            dispatch(picked(), opts);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
      <Box gap={1} flexGrow={1} marginTop={1}>
        {STATE_COLUMNS.map((col) => {
          const colIssues = issues.filter((i) => col.types.includes(i.stateType ?? 'backlog'));
          return (
            <Box key={col.title} flexDirection="column" width={colWidth} flexShrink={0}>
              <Text bold color={col.color}>
                {col.title}({colIssues.length})
              </Text>
              {colIssues.map((issue) => {
                const task = store.get(issue.id);
                const isCursor = issue.id === current?.id;
                return (
                  <Box
                    key={issue.id}
                    flexDirection="column"
                    borderStyle={isCursor ? 'double' : 'round'}
                    borderColor={isCursor ? theme.borderFocus : col.color}
                    paddingX={1}
                  >
                    <Text bold wrap="truncate">
                      <Text color={selected.has(issue.id) ? theme.selection : undefined}>
                        {selected.has(issue.id) ? '◉ ' : ''}
                      </Text>
                      {issue.identifier} <Text dimColor>{issue.title}</Text>
                    </Text>
                    <Text dimColor wrap="truncate">
                      {issue.assignee ?? 'unassigned'}
                      {task && (
                        <Text color={STATUS_COLORS[task.status]} bold>
                          {'  ⚒ '}
                          {task.status}
                        </Text>
                      )}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export const projectKeys: Array<[string, string]> = [
  ['space', 'select'],
  ['d', 'dispatch'],
  ['c', 'custom dispatch'],
  ['o', 'open in browser'],
  ['p', 'plan chat'],
  ['enter', 'task detail'],
  ['r', 'refresh'],
];
