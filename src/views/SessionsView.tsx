import { Box, Text, useInput } from 'ink';
import { homedir } from 'node:os';
import { useEffect, useMemo, useState } from 'react';
import { setPendingAction } from '../core/attach.js';
import type { DiskSession } from '../core/disksessions.js';
import { age } from '../core/fleet.js';
import { CommandBar } from '../ui/CommandBar.js';
import { SortBar } from '../ui/SortBar.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { useHeldIndex } from '../ui/held.js';
import { theme } from '../theme.js';

const HOME = homedir();
const tilde = (path: string) => (path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path);

/**
 * Every Claude Code and Codex conversation on this machine, newest first —
 * the ones you had at a terminal by default, colinear's own headless ones
 * with `h`. `enter` resumes one where it ran, in this terminal, and colinear
 * comes back when you quit the CLI. Read from the daemon's disk, so with a
 * remote daemon these are that machine's sessions, resumed there.
 */
export function SessionsView(_props: { param?: string }) {
  const ctx = useColinear();
  const pane = useViewSize();
  const [list, setList] = useState<DiskSession[] | undefined>();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [bar, setBar] = useState<'fuzzy' | 'sort' | null>(null);
  const [sortKey, setSortKey] = useState('when');
  const [sortDesc, setSortDesc] = useState(false);
  /** `h`: the sessions programs ran too — colinear's, SDK and exec runs */
  const [showHeadless, setShowHeadless] = useState(false);

  const load = () => void ctx.dispatcher.diskSessions().then(setList);
  useEffect(load, []);
  useEffect(() => ctx.setCapture(bar !== null), [bar]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  const columns = useMemo<Array<Column<DiskSession>>>(
    () => [
      { key: 'when', label: 'WHEN', width: 6, text: (s) => age(s.updatedAt, ctx.now), sort: (a, b) => b.updatedAt - a.updatedAt },
      { key: 'cli', label: 'CLI', width: 7, text: (s) => s.runtime, color: (s) => (s.runtime === 'claude' ? theme.accent : theme.info) },
      { key: 'where', label: 'WHERE', width: 28, text: (s) => tilde(s.cwd) },
      { key: 'branch', label: 'BRANCH', width: 18, text: (s) => s.branch ?? '', color: () => theme.dim },
      { key: 'by', label: 'BY', width: 12, text: (s) => (s.interactive ? 'you' : (s.label ?? 'program')), color: (s) => (s.interactive ? undefined : theme.dim) },
      { key: 'title', label: 'FIRST PROMPT', width: 'flex', text: (s) => s.title },
    ],
    [ctx.now],
  );

  const all = list ?? [];
  const headless = all.filter((s) => !s.interactive).length;
  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = all.filter((s) => {
      if (!showHeadless && !s.interactive) return false;
      if (!terms.length) return true;
      const hay = `${s.runtime} ${s.cwd} ${s.branch ?? ''} ${s.label ?? ''} ${s.title}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const col = columns.find((c) => c.key === sortKey) ?? columns[0];
    const sorted = [...shown].sort(defaultSort(col));
    return sortDesc ? sorted.reverse() : sorted;
  }, [all, query, showHeadless, sortKey, sortDesc, columns]);

  // a refresh re-sorts the list; the cursor stays on the session it was on
  const at = useHeldIndex(rows, cursor, setCursor, (s) => `${s.runtime}:${s.id}`);
  const selected = rows[Math.min(at, Math.max(0, rows.length - 1))];

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'i') setCursor(Math.max(0, at - 1));
      if (key.downArrow || input === 'k') setCursor(Math.min(rows.length - 1, at + 1));
      if (input === 'g') setCursor(0);
      if (input === 'G') setCursor(Math.max(0, rows.length - 1));
      if (input === '/') return setBar('fuzzy');
      if (input === ',') return setBar('sort');
      if (input === 'h') return setShowHeadless((v) => !v);
      if (input === 'u') {
        load();
        return ctx.toast('re-reading sessions', 'info');
      }
      if (key.return && selected) {
        // resumed where it ran, by the CLI that wrote it; colinear returns after
        setPendingAction({
          kind: 'attach',
          mode: 'claude',
          worktree: selected.cwd,
          sessionId: selected.id,
          runtime: selected.runtime,
          identifier: selected.label ?? `${selected.runtime} session in ${tilde(selected.cwd)}`,
          issueId: '',
          waitMs: 0,
        });
        ctx.quit();
      }
    },
    { isActive: bar === null && !ctx.cmdOpen },
  );

  // header, column header, the resume line, and a bar when one is open
  const maxRows = Math.max(3, pane.height - 4 - (bar ? 1 : 0));
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text wrap="truncate">
          <Text bold color={theme.header}>
            sessions{' '}
          </Text>
          <Text dimColor>
            {list === undefined ? 'reading…' : `${rows.length} shown`}
            {headless ? ` · ${headless} run by programs ${showHeadless ? 'shown (h hides)' : 'hidden (h shows)'}` : ''}
          </Text>
        </Text>
        {query ? <Text color={theme.accent}>/{query}</Text> : <Text dimColor>enter resumes · / filter · , sort · u refresh</Text>}
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
      {bar === 'sort' && (
        <SortBar
          options={columns.map((c) => ({ key: c.key, label: c.label.toLowerCase() }))}
          current={sortKey}
          desc={sortDesc}
          onApply={(k, desc) => {
            setSortKey(k);
            setSortDesc(desc);
            setBar(null);
          }}
          onCancel={() => setBar(null)}
        />
      )}
      <Table
        rows={rows}
        columns={columns}
        getId={(s) => `${s.runtime}:${s.id}`}
        cursor={at}
        width={pane.width}
        maxRows={maxRows}
        sortKey={sortKey}
        sortDesc={sortDesc}
        emptyText={list === undefined ? 'reading ~/.claude and ~/.codex…' : 'No sessions match.'}
      />
      {selected && (
        <Text dimColor wrap="truncate">
          {selected.runtime === 'claude' ? `claude --resume ${selected.id}` : `codex resume ${selected.id}`} · in {tilde(selected.cwd)}
        </Text>
      )}
    </Box>
  );
}

export const sessionsKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'move'],
  ['enter', 'resume it here'],
  ['/', 'filter'],
  [',', 'sort'],
  ['h', "show programs' sessions"],
  ['u', 'refresh'],
];
