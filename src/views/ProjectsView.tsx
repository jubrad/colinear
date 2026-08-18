import { Box, Text, useInput } from 'ink';
import { providerFor } from '../core/provider.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openUrl } from '../core/open.js';
import type { Project, Scope } from '../core/types.js';
import { CommandBar, fuzzyMatch, type Candidate } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { NewProjectModal, type NewProject } from '../ui/NewProjectModal.js';
import { Popup, formHeight, popupPlacement } from '../ui/Popup.js';
import { createProjectFromPrompt } from '../core/newproject.js';
import { theme } from '../theme.js';
import { PRIORITY_COLORS, PRIORITY_LABELS } from './IssuesView.js';

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
  const [creating, setCreating] = useState(false);
  const [scopes, setScopes] = useState<Scope[]>([]);

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
  // the form needs real scope ids, and asking for them once beats asking on open
  useEffect(() => {
    if (!providerFor(ctx.cfg).capabilities.createProjects) return;
    void providerFor(ctx.cfg).scopes().then(setScopes).catch(() => setScopes([]));
  }, [ctx.cfg]);
  useEffect(() => ctx.setCapture(bar !== null || creating), [bar, creating]);
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

  const create = useCallback(
    (draft: NewProject) => {
      setCreating(false);
      ctx.toast('drafting the project…', 'info');
      void createProjectFromPrompt(ctx.cfg, draft)
        .then((project) => {
          ctx.toast(`created ${project.name}`, 'ok');
          refresh();
        })
        .catch((e) => ctx.toast(`project creation failed: ${String(e).slice(0, 80)}`, 'err'));
    },
    [ctx, refresh],
  );

  const columns = useMemo<Array<Column<Project>>>(
    () => [
      { key: 'name', label: 'PROJECT', width: 'flex', text: (p) => p.name },
      {
        key: 'priority',
        label: 'PRI',
        width: 7,
        // you can set this when creating one, so it has to be visible after
        text: (p) => PRIORITY_LABELS[p.priority ?? 0] ?? '—',
        color: (p) => PRIORITY_COLORS[p.priority ?? 0],
        sort: (a, b) => ((a.priority || 5) - (b.priority || 5)),
      },
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
      // gated on the provider: a tracker without projects has nothing to create
      if (input === 'n' && providerFor(ctx.cfg).capabilities.createProjects) setCreating(true);
      if (input === 'o' && rows[cursor]) openUrl(rows[cursor].url);
      if (input === 'p' && rows[cursor]) ctx.navigate('plan', rows[cursor].name);
      if (key.return && rows[cursor]) ctx.navigate('project', rows[cursor].name);
    },
    { isActive: bar === null && !creating && !ctx.cmdOpen },
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
      {/* last on purpose: an absolute box is painted in tree order */}
      {creating &&
        (() => {
          const rowCount = scopes.length > 1 ? 3 : 3;
          const inner = Math.min(88, ctx.size.columns - 8) - 4;
          const lines = Math.max(3, Math.min(10, ctx.size.rows - 8 - formHeight(rowCount) - 4));
          return (
            <Popup
              {...popupPlacement(
                ctx.size,
                { width: inner + 4, height: formHeight(rowCount, lines + 2) },
                ctx.cmdOpen,
              )}
            >
              <NewProjectModal
                scopes={scopes}
                scopeKey={teamFilter}
                width={inner}
                briefLines={lines}
                onSubmit={create}
                onCancel={() => setCreating(false)}
              />
            </Popup>
          );
        })()}
    </Box>
  );
}

function bar10(progress: number, width = 8): string {
  const filled = Math.round(progress * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const projectsKeys: Array<[string, string]> = [
  ['enter', 'open project'],
  ['n', 'new project'],
  ['p', 'plan chat'],
  ['o', 'open in browser'],
  ['/', 'filter'],
  ['t', 'team'],
  ['s', 'sort'],
  ['r', 'refresh'],
];
