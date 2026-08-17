import { Box, Text, useInput } from 'ink';
import { providerFor } from '../core/provider.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openUrl } from '../core/open.js';
import type { Project } from '../core/types.js';
import { CommandBar, fuzzyMatch, type Candidate } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { theme } from '../theme.js';

/** module cache so ProjectView/ChatView can resolve a param without refetching */
export let projectCache: Project[] = [];

type BarMode = 'fuzzy' | 'team' | 'sort';

export function ProjectsView(_props: { param?: string }) {
  const ctx = useColinear();
  const [projects, setProjects] = useState<Project[]>(projectCache);
  const [loading, setLoading] = useState(projectCache.length === 0);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState<string>();
  const [bar, setBar] = useState<BarMode | null>(null);
  const [sortKey, setSortKey] = useState('name');
  const [sortDesc, setSortDesc] = useState(false);

  const refresh = useCallback(() => {
    setLoading(projectCache.length === 0);
    providerFor(ctx.cfg).projects()
      .then((p) => {
        projectCache = p;
        setProjects(p);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [ctx.cfg]);

  useEffect(() => refresh(), []);
  useEffect(() => ctx.setCapture(bar !== null), [bar]);
  useEffect(() => () => ctx.setCapture(false), []);

  const hasFilters = query !== '' || teamFilter !== undefined;
  useEffect(() => {
    ctx.setEscHandler(
      hasFilters
        ? () => {
            setQuery('');
            setTeamFilter(undefined);
            return true;
          }
        : null,
    );
    return () => ctx.setEscHandler(null);
  }, [hasFilters]);

  const columns = useMemo<Array<Column<Project>>>(
    () => [
      { key: 'name', label: 'PROJECT', width: 'flex', text: (p) => p.name },
      {
        key: 'state',
        label: 'STATE',
        width: 10,
        text: (p) => p.state,
        color: (p) => (p.state === 'started' ? theme.ok : theme.dim),
      },
      {
        key: 'progress',
        label: 'PROGRESS',
        width: 16,
        text: (p) => `${bar10(p.progress)} ${Math.round(p.progress * 100)}%`,
        color: (p) => (p.progress >= 1 ? theme.ok : theme.warn),
        sort: (a, b) => a.progress - b.progress,
      },
      { key: 'lead', label: 'LEAD', width: 16, text: (p) => p.lead ?? '', color: () => theme.dim },
      {
        key: 'teams',
        label: 'TEAMS',
        width: 14,
        text: (p) => p.scopes.map((t) => t.key).join(','),
        color: () => theme.dim,
      },
      { key: 'target', label: 'TARGET', width: 12, text: (p) => p.targetDate ?? '', color: () => theme.dim },
    ],
    [],
  );

  const rows = useMemo(() => {
    let matched = projects;
    if (teamFilter) matched = matched.filter((p) => p.scopes.some((t) => t.key === teamFilter));
    if (query) matched = matched.filter((p) => fuzzyMatch(p.name.toLowerCase(), query.toLowerCase()));
    const col = columns.find((c) => c.key === sortKey);
    const sorted = col ? [...matched].sort(defaultSort(col)) : matched;
    return sortDesc ? sorted.reverse() : sorted;
  }, [projects, query, teamFilter, sortKey, sortDesc, columns]);

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === '/') setBar('fuzzy');
      if (input === 't') setBar('team');
      if (input === 's') setBar('sort');
      if (input === 'r') refresh();
      if (input === 'o' && rows[cursor]) openUrl(rows[cursor].url);
      if (input === 'p' && rows[cursor]) ctx.navigate('plan', rows[cursor].name);
      if (key.return && rows[cursor]) ctx.navigate('project', rows[cursor].name);
    },
    { isActive: bar === null && !ctx.cmdOpen },
  );

  const barCandidates = useMemo<Candidate[]>(() => {
    if (bar === 'team') {
      const keys = [...new Set(projects.flatMap((p) => p.scopes.map((t) => t.key)))].sort();
      return [{ label: 'all — clear team filter', value: 'all' }, ...keys.map((k) => ({ label: k, value: k }))];
    }
    if (bar === 'sort') return columns.map((c) => ({ label: c.key, value: c.key }));
    return [];
  }, [bar, projects, columns]);

  const submitBar = (value: string, top?: Candidate) => {
    const pick = top?.value ?? value;
    if (bar === 'team' && pick) {
      setTeamFilter(pick.toLowerCase() === 'all' ? undefined : pick.toUpperCase());
    }
    if (bar === 'sort' && pick) {
      if (pick === sortKey) setSortDesc((d) => !d);
      else {
        setSortKey(pick);
        setSortDesc(false);
      }
    }
    setBar(null);
  };

  if (!providerFor(ctx.cfg).capabilities.projects) {
    return (
      <Text dimColor>
        {providerFor(ctx.cfg).name} has no projects — this view needs a tracker that groups issues.
      </Text>
    );
  }
  if (loading) return <Text color={theme.warn}>Loading projects…</Text>;
  if (error) return <Text color={theme.err}>Linear error: {error}</Text>;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.accent}>
            projects{teamFilter ? `(${teamFilter})` : ''}
          </Text>
          <Text dimColor>
            [{rows.length}/{projects.length}] · sort: {sortKey}
            {sortDesc ? '↓' : '↑'}
          </Text>
        </Text>
        {query && <Text color={theme.accent}>/{query}</Text>}
      </Box>
      {bar === 'fuzzy' && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setBar(null)}
          onCancel={() => {
            setQuery('');
            setBar(null);
          }}
        />
      )}
      {bar && bar !== 'fuzzy' && (
        <CommandBar prefix={`${bar}> `} candidates={barCandidates} onSubmit={submitBar} onCancel={() => setBar(null)} />
      )}
      <Table
        rows={rows}
        columns={columns}
        getId={(p) => p.id}
        cursor={cursor}
        width={ctx.size.columns - 2}
        maxRows={Math.max(4, ctx.size.rows - 12)}
        sortKey={sortKey}
        sortDesc={sortDesc}
        emptyText="No projects match."
      />
    </Box>
  );
}

function bar10(progress: number, width = 8): string {
  const filled = Math.round(progress * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const projectsKeys: Array<[string, string]> = [
  ['enter', 'open project'],
  ['p', 'plan chat'],
  ['o', 'open in browser'],
  ['/', 'filter'],
  ['t', 'team'],
  ['s', 'sort'],
  ['r', 'refresh'],
];
