import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useMemo, useState } from 'react';
import type { LinearIssue, LinearTeam } from '../types.js';

const PRIORITY_LABELS = ['—', 'Urgent', 'High', 'Med', 'Low'];
const PRIORITY_COLORS: Array<string | undefined> = [undefined, 'red', 'yellow', 'white', 'gray'];

type BarMode = 'fuzzy' | 'team' | 'label' | 'sort';

const SORT_KEYS = ['updated', 'priority', 'issue', 'title', 'labels', 'state', 'assignee'] as const;
type SortKey = (typeof SORT_KEYS)[number];

const SORT_COMPARATORS: Record<Exclude<SortKey, 'updated'>, (a: LinearIssue, b: LinearIssue) => number> = {
  priority: (a, b) => (a.priority || 5) - (b.priority || 5),
  issue: (a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
  title: (a, b) => a.title.localeCompare(b.title),
  labels: (a, b) => (a.labels[0]?.name ?? '￿').localeCompare(b.labels[0]?.name ?? '￿'),
  state: (a, b) => a.stateName.localeCompare(b.stateName),
  assignee: (a, b) => (a.assignee ?? '￿').localeCompare(b.assignee ?? '￿'),
};

interface Candidate {
  label: string;
  value: string;
}

function fuzzyMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/** prefix > substring > subsequence */
function rank(candidates: Candidate[], q: string): Candidate[] {
  const lq = q.toLowerCase();
  if (!lq) return candidates;
  return candidates
    .map((c) => {
      const lc = c.label.toLowerCase();
      const score = lc.startsWith(lq) ? 0 : lc.includes(lq) ? 1 : fuzzyMatch(lc, lq) ? 2 : -1;
      return { c, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.c);
}

/** Tokens fuzzy-match identifier + title; `#foo` / `label:foo` tokens match label names. */
export function filterIssues(issues: LinearIssue[], query: string, labelFilters: string[]): LinearIssue[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  return issues.filter((issue) => {
    const haystack = `${issue.identifier} ${issue.title}`.toLowerCase();
    const labels = issue.labels.map((l) => l.name.toLowerCase());
    const labelsOk = labelFilters.every((f) => labels.some((l) => l.includes(f.toLowerCase())));
    if (!labelsOk) return false;
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

export function IssuePicker(props: {
  issues: LinearIssue[];
  teams: LinearTeam[];
  currentTeam?: string;
  loading: boolean;
  error?: string;
  onStart: (selected: LinearIssue[]) => void;
  onTeamChange: (teamKey: string | undefined) => void;
  onSearchingChange?: (searching: boolean) => void;
  maxRows?: number;
  width?: number;
}) {
  const {
    issues,
    teams,
    currentTeam,
    loading,
    error,
    onStart,
    onTeamChange,
    onSearchingChange,
    maxRows = 15,
    width = 120,
  } = props;
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [labelFilters, setLabelFilters] = useState<string[]>([]);
  const [barMode, setBarMode] = useState<BarMode | null>(null);
  const [barValue, setBarValue] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [sortDesc, setSortDesc] = useState(false);

  const filtered = useMemo(() => {
    const matched = filterIssues(issues, query, labelFilters);
    const sorted =
      sortBy === 'updated' ? [...matched] : [...matched].sort(SORT_COMPARATORS[sortBy]);
    return sortDesc ? sorted.reverse() : sorted;
  }, [issues, query, labelFilters, sortBy, sortDesc]);

  const candidates = useMemo<Candidate[]>(() => {
    if (barMode === 'team') {
      return rank(
        [
          { label: 'mine — my issues, any team', value: 'mine' },
          { label: 'all — every team', value: 'all' },
          ...teams.map((t) => ({ label: `${t.key} — ${t.name}`, value: t.key })),
        ],
        barValue,
      );
    }
    if (barMode === 'label') {
      const names = [...new Set(issues.flatMap((i) => i.labels.map((l) => l.name)))].sort();
      return rank(
        names.map((n) => ({ label: n, value: n })),
        barValue,
      );
    }
    if (barMode === 'sort') {
      return rank(
        SORT_KEYS.map((k) => ({ label: k, value: k })),
        barValue,
      );
    }
    return [];
  }, [barMode, barValue, teams, issues]);

  useEffect(() => onSearchingChange?.(barMode !== null), [barMode, onSearchingChange]);
  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, filtered.length - 1)));
  }, [filtered.length]);

  const closeBar = () => {
    setBarMode(null);
    setBarValue('');
  };

  const submitBar = () => {
    if (barMode === 'team') {
      const pick = candidates[0]?.value ?? barValue;
      if (pick) {
        onTeamChange(pick === 'mine' ? undefined : pick === 'all' ? '*' : pick.toUpperCase());
      }
    }
    if (barMode === 'label') {
      const pick = candidates[0]?.value ?? barValue;
      if (pick) setLabelFilters((prev) => (prev.includes(pick) ? prev : [...prev, pick]));
    }
    if (barMode === 'sort') {
      const pick = candidates[0]?.value as SortKey | undefined;
      if (pick) {
        // picking the active column flips direction
        if (pick === sortBy) setSortDesc((d) => !d);
        else {
          setSortBy(pick);
          setSortDesc(false);
        }
      }
    }
    closeBar();
  };

  // list navigation + bar launchers (bar closed)
  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(filtered.length - 1, c + 1));
      if (input === '/') setBarMode('fuzzy');
      if (input === 't') setBarMode('team');
      if (input === 'l') setBarMode('label');
      if (input === 's') setBarMode('sort');
      if (key.escape) {
        setQuery('');
        setLabelFilters([]);
      }
      if (input === ' ') {
        const issue = filtered[cursor];
        if (!issue) return;
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(issue.id)) next.delete(issue.id);
          else next.add(issue.id);
          return next;
        });
      }
      if (key.return && selected.size > 0) {
        onStart(issues.filter((i) => selected.has(i.id)));
      }
    },
    { isActive: barMode === null },
  );

  // bar keys: tab completes, esc cancels, arrows still move the list (ink TextInput ignores them)
  useInput(
    (_input, key) => {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) setCursor((c) => Math.min(filtered.length - 1, c + 1));
      if (key.tab && candidates[0]) setBarValue(candidates[0].value);
      if (key.escape) {
        if (barMode === 'fuzzy') setQuery('');
        closeBar();
      }
    },
    { isActive: barMode !== null },
  );

  if (loading) return <Text color="yellow">Loading Linear issues…</Text>;
  if (error) return <Text color="red">Linear error: {error}</Text>;

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), filtered.length - maxRows));
  const visible = filtered.slice(windowStart, windowStart + maxRows);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>
          Pick issues to dispatch{selected.size ? ` (${selected.size} selected)` : ''}
          <Text dimColor>
            {' '}— {filtered.length}/{issues.length} · sort: {sortBy}
            {sortDesc ? '↓' : '↑'}
          </Text>
        </Text>
        <Text>
          {query && <Text color="cyan">/{query} </Text>}
          {labelFilters.map((f) => (
            <Text key={f} color="magenta">
              #{f}{' '}
            </Text>
          ))}
        </Text>
      </Box>

      {barMode && (
        <Box>
          <Text color="cyan" bold>
            {barMode === 'fuzzy' ? '/' : `${barMode}> `}
          </Text>
          {barMode === 'fuzzy' ? (
            <TextInput value={query} onChange={setQuery} onSubmit={closeBar} />
          ) : (
            <TextInput value={barValue} onChange={setBarValue} onSubmit={submitBar} />
          )}
          {barMode !== 'fuzzy' && candidates.length > 0 && (
            <Text dimColor>
              {'   '}
              {candidates.slice(0, 5).map((c, i) => (
                <Text key={c.value} bold={i === 0} color={i === 0 ? 'yellow' : undefined}>
                  {c.label}
                  {i < Math.min(candidates.length, 5) - 1 ? '  ·  ' : ''}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      )}

      {!filtered.length && <Text dimColor>No issues match.</Text>}
      {filtered.length > 0 && (
        <HeaderRow titleWidth={titleWidth(width)} sortBy={sortBy} sortDesc={sortDesc} />
      )}
      {visible.map((issue, i) => {
        const idx = windowStart + i;
        return (
          <IssueRow
            key={issue.id}
            issue={issue}
            isCursor={idx === cursor}
            isSelected={selected.has(issue.id)}
            titleWidth={titleWidth(width)}
          />
        );
      })}
    </Box>
  );
}

// table layout: SEL(2) ID(10) PRI(8) TITLE(flex) LABELS(22) STATE(12) ASSIGNEE(rest)
const COL = { sel: 2, id: 10, pri: 8, labels: 22, state: 12, assignee: 16 };

function titleWidth(width: number): number {
  const fixed = COL.sel + COL.id + COL.pri + COL.labels + COL.state + COL.assignee;
  return Math.max(24, width - fixed);
}

function cell(text: string, w: number): string {
  return text.length > w ? `${text.slice(0, w - 2)}… ` : text.padEnd(w);
}

function HeaderRow(props: { titleWidth: number; sortBy: SortKey; sortDesc: boolean }) {
  const { titleWidth: tw, sortBy, sortDesc } = props;
  const arrow = sortDesc ? '↓' : '↑';
  const col = (label: string, key: SortKey, w: number) => (
    <Text bold color={sortBy === key ? 'cyan' : undefined} dimColor={sortBy !== key}>
      {cell(sortBy === key ? `${label}${arrow}` : label, w)}
    </Text>
  );
  return (
    <Text>
      {' '.repeat(COL.sel)}
      {col('ISSUE', 'issue', COL.id)}
      {col('PRI', 'priority', COL.pri)}
      {col('TITLE', 'title', tw)}
      {col('LABELS', 'labels', COL.labels)}
      {col('STATE', 'state', COL.state)}
      {col('ASSIGNEE', 'assignee', COL.assignee)}
    </Text>
  );
}

function IssueRow(props: { issue: LinearIssue; isCursor: boolean; isSelected: boolean; titleWidth: number }) {
  const { issue, isCursor, isSelected, titleWidth: tw } = props;
  return (
    <Text inverse={isCursor} wrap="truncate">
      {cell(isSelected ? '◉' : '○', COL.sel)}
      {cell(issue.identifier, COL.id)}
      <Text color={PRIORITY_COLORS[issue.priority]} bold={issue.priority === 1}>
        {cell(PRIORITY_LABELS[issue.priority] ?? '—', COL.pri)}
      </Text>
      {cell(issue.title, tw)}
      <LabelsCell labels={issue.labels} width={COL.labels} />
      <Text dimColor>
        {cell(issue.stateName, COL.state)}
        {cell(issue.assignee ?? '', COL.assignee)}
      </Text>
    </Text>
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
