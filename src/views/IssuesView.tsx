import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CustomViewSpec } from '../core/customviews.js';
import { fetchFilteredIssues, fetchIssues } from '../core/linear.js';
import { getUiState, setUiState } from '../core/persist.js';
import { store } from '../core/store.js';
import type { LinearIssue } from '../core/types.js';
import { CommandBar, fuzzyMatch, type Candidate } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { theme } from '../theme.js';

const PRIORITY_LABELS = ['—', 'Urgent', 'High', 'Med', 'Low'];
const PRIORITY_COLORS: Array<string | undefined> = [undefined, 'red', 'yellow', 'white', 'gray'];

type BarMode = 'fuzzy' | 'team' | 'label' | 'sort' | 'dispatch';

export function filterIssues(issues: LinearIssue[], query: string, labelFilters: string[]): LinearIssue[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return issues.filter((issue) => {
    const haystack = `${issue.identifier} ${issue.title}`.toLowerCase();
    const labels = issue.labels.map((l) => l.name.toLowerCase());
    if (!labelFilters.every((f) => labels.some((l) => l.includes(f.toLowerCase())))) return false;
    return tokens.every((token) => {
      const labelTerm = token.startsWith('#')
        ? token.slice(1)
        : token.startsWith('label:')
          ? token.slice(6)
          : null;
      if (labelTerm !== null) return labels.some((l) => l.includes(labelTerm));
      return fuzzyMatch(haystack, token);
    });
  });
}

function resolveTeamParam(param: string | undefined, fallback: string | undefined): string | undefined {
  if (!param) return fallback;
  const p = param.toLowerCase();
  if (p === 'mine' || p === 'me') return undefined;
  if (p === 'all' || p === '*') return '*';
  return param.toUpperCase();
}

export function IssuesView(props: { param?: string; spec?: CustomViewSpec }) {
  const { spec } = props;
  const ctx = useColinear();
  const { cfg, teams } = ctx;
  const [team, setTeam] = useState<string | undefined>(() =>
    resolveTeamParam(props.param, resolveTeamParam(getUiState().team, cfg.team)),
  );
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [bar, setBar] = useState<BarMode | null>(null);
  const [sortKey, setSortKey] = useState(spec?.sort ?? 'updated');
  const [sortDesc, setSortDesc] = useState(false);

  const refresh = useCallback(
    (teamKey: string | undefined) => {
      setLoading(true);
      setError(undefined);
      const fetch = spec ? fetchFilteredIssues(cfg, spec.filter ?? {}) : fetchIssues(cfg, teamKey);
      fetch
        .then((all) => setIssues(all.filter((i) => !store.get(i.id))))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    },
    [cfg, spec],
  );

  useEffect(() => refresh(team), []);
  useEffect(() => ctx.setCapture(bar !== null), [bar]);
  useEffect(() => () => ctx.setCapture(false), []);

  const columns = useMemo<Array<Column<LinearIssue>>>(
    () => [
      { key: 'issue', label: 'ISSUE', width: 11, text: (i) => i.identifier },
      {
        key: 'priority',
        label: 'PRI',
        width: 8,
        text: (i) => PRIORITY_LABELS[i.priority] ?? '—',
        color: (i) => PRIORITY_COLORS[i.priority],
        sort: (a, b) => (a.priority || 5) - (b.priority || 5),
      },
      { key: 'title', label: 'TITLE', width: 'flex', text: (i) => i.title },
      {
        key: 'labels',
        label: 'LABELS',
        width: 22,
        text: (i) => i.labels.map((l) => l.name).join(' '),
        render: (i, w) => <LabelsCell labels={i.labels} width={w} />,
        sort: (a, b) => (a.labels[0]?.name ?? '￿').localeCompare(b.labels[0]?.name ?? '￿'),
      },
      { key: 'state', label: 'STATE', width: 12, text: (i) => i.stateName, color: () => theme.dim },
      {
        key: 'assignee',
        label: 'ASSIGNEE',
        width: 16,
        text: (i) => i.assignee ?? '',
        color: () => theme.dim,
        sort: (a, b) => (a.assignee ?? '￿').localeCompare(b.assignee ?? '￿'),
      },
    ],
    [],
  );

  const visibleColumns = useMemo(
    () => (spec?.columns?.length ? columns.filter((c) => spec.columns!.includes(c.key)) : columns),
    [columns, spec],
  );

  const rows = useMemo(() => {
    const matched = filterIssues(issues, query, labelFilters);
    if (sortKey === 'updated') return sortDesc ? [...matched].reverse() : matched;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return matched;
    const sorted = [...matched].sort(defaultSort(col));
    return sortDesc ? sorted.reverse() : sorted;
  }, [issues, query, labelFilters, sortKey, sortDesc, columns]);

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);

  const hasFilters = query !== '' || labelFilters.length > 0;
  useEffect(() => {
    ctx.setEscHandler(
      hasFilters
        ? () => {
            setQuery('');
            setLabelFilters([]);
            return true;
          }
        : null,
    );
    return () => ctx.setEscHandler(null);
  }, [hasFilters]);

  const picked = useCallback(
    () =>
      selected.size ? issues.filter((i) => selected.has(i.id)) : rows[cursor] ? [rows[cursor]] : [],
    [selected, issues, rows, cursor],
  );

  const dispatch = useCallback(
    (picked: LinearIssue[], instructions?: string) => {
      if (!picked.length) return;
      // enqueue self-assigns and moves the Linear state to started
      ctx.dispatcher.enqueue(picked, instructions);
      ctx.toast(`dispatched ${picked.length} issue${picked.length > 1 ? 's' : ''}`, 'ok');
      ctx.navigate('board');
    },
    [ctx],
  );

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === '/') setBar('fuzzy');
      if (input === 't') setBar('team');
      if (input === 'l') setBar('label');
      if (input === 's') setBar('sort');
      if (input === 'r') refresh(team);
      if (input === 'b') ctx.navigate('board');
      if (input === ' ') {
        const issue = rows[cursor];
        if (!issue) return;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(issue.id)) next.delete(issue.id);
          else next.add(issue.id);
          return next;
        });
      }
      if (key.return && picked().length) dispatch(picked());
      if (input === 'c' && picked().length) setBar('dispatch');
    },
    { isActive: bar === null },
  );

  const barCandidates = useMemo<Candidate[]>(() => {
    if (bar === 'team') {
      return [
        { label: 'mine — my issues, any team', value: 'mine' },
        { label: 'all — every team', value: 'all' },
        ...teams.map((t) => ({ label: `${t.key} — ${t.name}`, value: t.key })),
      ];
    }
    if (bar === 'label') {
      return [...new Set(issues.flatMap((i) => i.labels.map((l) => l.name)))]
        .sort()
        .map((n) => ({ label: n, value: n }));
    }
    if (bar === 'sort') {
      return ['updated', ...columns.map((c) => c.key)].map((k) => ({ label: k, value: k }));
    }
    return [];
  }, [bar, teams, issues, columns]);

  const submitBar = (value: string, top?: Candidate) => {
    const pick = top?.value ?? value;
    if (bar === 'team' && pick) {
      const next = resolveTeamParam(pick, undefined);
      setTeam(next);
      setUiState({ team: next ?? 'mine' }); // survives restarts
      refresh(next);
    }
    if (bar === 'label' && pick) {
      setLabelFilters((prev) => (prev.includes(pick) ? prev : [...prev, pick]));
    }
    if (bar === 'sort' && pick) {
      if (pick === sortKey) setSortDesc((d) => !d);
      else {
        setSortKey(pick);
        setSortDesc(false);
      }
    }
    if (bar === 'dispatch') {
      setBar(null);
      dispatch(picked(), value.trim() || undefined);
      return;
    }
    setBar(null);
  };

  if (loading) return <Text color={theme.warn}>Loading Linear issues…</Text>;
  if (error)
    return (
      <Box flexDirection="column">
        <Text color={theme.err}>Linear error: {error}</Text>
        <Text dimColor>press r to retry</Text>
      </Box>
    );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.accent}>
            {spec ? spec.name : `issues(${team === '*' ? 'all' : (team ?? 'mine')})`}
          </Text>
          <Text dimColor>
            [{rows.length}/{issues.length}]
          </Text>
          {selected.size > 0 && <Text color={theme.selection}> {selected.size} selected</Text>}
        </Text>
        <Text>
          {query && <Text color={theme.accent}>/{query} </Text>}
          {labelFilters.map((f) => (
            <Text key={f} color={theme.info}>
              #{f}{' '}
            </Text>
          ))}
        </Text>
      </Box>
      {bar === 'fuzzy' && (
        <CommandBar prefix="/" initial={query} onChange={setQuery} onSubmit={() => setBar(null)} onCancel={() => { setQuery(''); setBar(null); }} />
      )}
      {bar === 'dispatch' && (
        <CommandBar
          prefix={`dispatch ${picked().length} ▸ instructions> `}
          placeholder="optional — enter to dispatch, esc to cancel"
          onSubmit={submitBar}
          onCancel={() => setBar(null)}
        />
      )}
      {bar && bar !== 'fuzzy' && bar !== 'dispatch' && (
        <CommandBar prefix={`${bar}> `} candidates={barCandidates} onSubmit={submitBar} onCancel={() => setBar(null)} />
      )}
      <Table
        rows={rows}
        columns={visibleColumns}
        getId={(i) => i.id}
        cursor={cursor}
        selectedIds={selected}
        width={ctx.size.columns - 2}
        maxRows={Math.max(4, ctx.size.rows - 12)}
        sortKey={sortKey === 'updated' ? undefined : sortKey}
        sortDesc={sortDesc}
        emptyText="No issues match."
      />
    </Box>
  );
}

function LabelsCell(props: { labels: Array<{ name: string; color: string }>; width: number }) {
  const { labels, width } = props;
  let used = 0;
  const parts: Array<{ name: string; color: string; text: string }> = [];
  for (const l of labels) {
    const sep = parts.length ? 1 : 0;
    const room = width - used - sep;
    if (room < 2) break;
    const text = l.name.length > room ? `${l.name.slice(0, room - 1)}…` : l.name;
    parts.push({ name: l.name, color: l.color, text: (sep ? ' ' : '') + text });
    used += text.length + sep;
  }
  return (
    <Text>
      {parts.map((p) => (
        <Text key={p.name} color={p.color} bold>
          {p.text}
        </Text>
      ))}
      {' '.repeat(Math.max(0, width - used))}
    </Text>
  );
}

export const issuesKeys: Array<[string, string]> = [
  ['space', 'select'],
  ['enter', 'dispatch'],
  ['c', 'custom dispatch'],
  ['b', 'board'],
  ['/', 'filter'],
  ['t', 'team'],
  ['l', 'label'],
  ['s', 'sort'],
  ['r', 'refresh'],
];
