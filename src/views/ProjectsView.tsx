import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchProjects } from '../core/linear.js';
import type { LinearProject } from '../core/types.js';
import { CommandBar, fuzzyMatch } from '../ui/CommandBar.js';
import { useForeman } from '../ui/context.js';
import { Table, type Column } from '../ui/Table.js';
import { theme } from '../theme.js';

/** module cache so ProjectView can resolve a param without refetching */
export let projectCache: LinearProject[] = [];

export function ProjectsView(_props: { param?: string }) {
  const ctx = useForeman();
  const [projects, setProjects] = useState<LinearProject[]>(projectCache);
  const [loading, setLoading] = useState(projectCache.length === 0);
  const [error, setError] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const refresh = useCallback(() => {
    setLoading(projectCache.length === 0);
    fetchProjects(ctx.cfg)
      .then((p) => {
        projectCache = p;
        setProjects(p);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [ctx.cfg]);

  useEffect(() => refresh(), []);
  useEffect(() => ctx.setCapture(searching), [searching]);
  useEffect(() => () => ctx.setCapture(false), []);

  const rows = useMemo(
    () => projects.filter((p) => !query || fuzzyMatch(p.name.toLowerCase(), query.toLowerCase())),
    [projects, query],
  );
  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);

  const columns = useMemo<Array<Column<LinearProject>>>(
    () => [
      { key: 'name', label: 'PROJECT', width: 'flex', text: (p) => p.name },
      { key: 'state', label: 'STATE', width: 10, text: (p) => p.state, color: (p) => (p.state === 'started' ? theme.ok : theme.dim) },
      {
        key: 'progress',
        label: 'PROGRESS',
        width: 16,
        text: (p) => `${bar(p.progress)} ${Math.round(p.progress * 100)}%`,
        color: (p) => (p.progress >= 1 ? theme.ok : theme.warn),
        sort: (a, b) => a.progress - b.progress,
      },
      { key: 'teams', label: 'TEAMS', width: 14, text: (p) => p.teams.map((t) => t.key).join(','), color: () => theme.dim },
      { key: 'target', label: 'TARGET', width: 12, text: (p) => p.targetDate ?? '', color: () => theme.dim },
    ],
    [],
  );

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === '/') setSearching(true);
      if (input === 'r') refresh();
      if (key.return && rows[cursor]) ctx.navigate('project', rows[cursor].name);
    },
    { isActive: !searching },
  );

  if (loading) return <Text color={theme.warn}>Loading projects…</Text>;
  if (error) return <Text color={theme.err}>Linear error: {error}</Text>;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.accent}>
            projects
          </Text>
          <Text dimColor>
            [{rows.length}/{projects.length}]
          </Text>
        </Text>
        {query && <Text color={theme.accent}>/{query}</Text>}
      </Box>
      {searching && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setSearching(false)}
          onCancel={() => {
            setQuery('');
            setSearching(false);
          }}
        />
      )}
      <Table
        rows={rows}
        columns={columns}
        getId={(p) => p.id}
        cursor={cursor}
        width={ctx.size.columns - 2}
        maxRows={Math.max(4, ctx.size.rows - 12)}
        emptyText="No active projects."
      />
    </Box>
  );
}

function bar(progress: number, width = 8): string {
  const filled = Math.round(progress * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const projectsKeys: Array<[string, string]> = [
  ['enter', 'open project'],
  ['/', 'filter'],
  ['r', 'refresh'],
];
