import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { useTasks } from './hooks.js';
import { assignIssue, fetchIssues, fetchTeams, fetchViewer, postComment } from './linear.js';
import { startPrPolling } from './prs.js';
import { store } from './store.js';
import { Board, columnTasks, formatTokens } from './components/Board.js';
import { DetailPane } from './components/DetailPane.js';
import { IssuePicker } from './components/IssuePicker.js';
import type { Config, LinearIssue, LinearTeam } from './types.js';

const cfg = loadConfig();
const dispatcher = new Dispatcher(cfg);

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 40 });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 40 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function HelpBar(props: { items: Array<[string, string]> }) {
  return (
    <Text>
      {props.items.map(([key, label], i) => (
        <Text key={key}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text color="cyan" bold>
            {key}
          </Text>
          <Text dimColor> {label}</Text>
        </Text>
      ))}
    </Text>
  );
}

function App(props: { cfg: Config }) {
  const { cfg } = props;
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const now = useClock();
  const [pickerOpen, setPickerOpen] = useState(true);
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [linearError, setLinearError] = useState<string>();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [answering, setAnswering] = useState(false);
  const [pickerSearching, setPickerSearching] = useState(false);
  const [team, setTeam] = useState<string | undefined>(cfg.team);
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [viewer, setViewer] = useState<{ id: string; displayName: string }>();

  const tasks = useTasks();
  const ordered = useMemo(() => columnTasks(tasks), [tasks, store.version]);
  const selected = ordered[Math.min(selectedIdx, Math.max(0, ordered.length - 1))];

  const refreshIssues = useCallback(
    (teamKey: string | undefined) => {
      setLoading(true);
      setLinearError(undefined);
      fetchIssues(cfg, teamKey)
        .then((all) => setIssues(all.filter((i) => !store.get(i.id))))
        .catch((e) => setLinearError(String(e)))
        .finally(() => setLoading(false));
    },
    [cfg],
  );

  useEffect(() => {
    refreshIssues(team);
    // preload teams (t> completion) and viewer (self-assign on dispatch)
    fetchTeams(cfg)
      .then(setTeams)
      .catch(() => {});
    fetchViewer(cfg)
      .then(setViewer)
      .catch(() => {});
    return startPrPolling(cfg);
  }, []);

  useInput((input, key) => {
    if (answering) {
      if (key.escape) setAnswering(false);
      return; // text input owns the keyboard
    }
    if (pickerSearching) return; // command bar owns the keyboard
    if (input === 'q') exit();
    if (input === 'n' || key.tab) {
      setPickerOpen((open) => {
        if (!open) refreshIssues(team);
        return !open;
      });
      return;
    }
    if (pickerOpen) return; // picker handles its own keys

    if (key.leftArrow || input === 'h' || key.upArrow || input === 'k') {
      setSelectedIdx((i) => Math.max(0, i - 1));
    }
    if (key.rightArrow || input === 'l' || key.downArrow || input === 'j') {
      setSelectedIdx((i) => Math.min(ordered.length - 1, i + 1));
    }
    if (input === 'a' && selected?.question) setAnswering(true);
    if (input === 'o' && selected?.prs[0]) {
      execFile('open', [selected.prs[0].url], () => {});
    }
    if (input === 'c' && selected?.status === 'escalated' && selected.verdict && !selected.escalationCommented) {
      const v = selected.verdict;
      const body =
        v.verdict === 'too_big'
          ? `**foreman triage: too big for a single agent.**\n\n${v.reason}\n\nSuggest creating a project and splitting this up.`
          : `**foreman triage: needs more info.**\n\n${v.reason}`;
      void postComment(cfg, selected.issue.id, body)
        .then(() => store.update(selected.issue.id, { escalationCommented: true }))
        .catch((e) => store.addActivity(selected.issue.id, `linear comment failed: ${e}`));
    }
  });

  const totalTokens = tasks.reduce(
    (acc, t) => ({ input: acc.input + t.tokens.input, output: acc.output + t.tokens.output }),
    { input: 0, output: 0 },
  );
  const active = tasks.filter((t) => ['triage', 'working', 'checks'].includes(t.status)).length;

  const helpItems: Array<[string, string]> = answering
    ? [
        ['enter', 'send answer'],
        ['esc', 'cancel'],
      ]
    : pickerSearching
      ? [
          ['type', 'filter'],
          ['tab', 'complete'],
          ['↑↓', 'move'],
          ['enter', 'apply'],
          ['esc', 'cancel'],
        ]
      : pickerOpen
        ? [
            ['↑↓/jk', 'move'],
            ['space', 'select'],
            ['/', 'fuzzy'],
            ['t', 'team'],
            ['l', 'label'],
            ['s', 'sort'],
            ['enter', 'dispatch'],
            ['n/tab', 'board'],
            ['q', 'quit'],
          ]
      : [
          ['←→/hl', 'card'],
          ['a', 'answer'],
          ['1-9', 'pick option'],
          ['c', 'escalate→Linear'],
          ['o', 'open PR'],
          ['n/tab', 'add issues'],
          ['q', 'quit'],
        ];

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box justifyContent="space-between">
        <Text bold inverse>
          {' '}foreman{' '}
        </Text>
        <HelpBar items={helpItems} />
        <Text dimColor>
          {active} active · {formatTokens(totalTokens)} tok
        </Text>
      </Box>

      {pickerOpen && (
        <Box borderStyle="single" borderColor="blue" paddingX={1} flexDirection="column" flexShrink={0}>
          <Text dimColor>
            viewing: {team === '*' ? 'all teams' : team ? `team ${team}` : 'my issues'}
          </Text>
          <IssuePicker
            issues={issues}
            teams={teams}
            currentTeam={team}
            loading={loading}
            error={linearError}
            onSearchingChange={setPickerSearching}
            maxRows={Math.max(5, rows - 12)}
            width={columns - 4}
            onTeamChange={(teamKey) => {
              setTeam(teamKey);
              refreshIssues(teamKey);
            }}
            onStart={(picked) => {
              dispatcher.enqueue(picked);
              setPickerOpen(false);
              // self-assign anything picked that isn't already mine
              if (viewer) {
                for (const issue of picked.filter((i) => i.assigneeId !== viewer.id)) {
                  void assignIssue(cfg, issue.id, viewer.id)
                    .then(() => store.addActivity(issue.id, `assigned to ${viewer.displayName}`))
                    .catch((e) => store.addActivity(issue.id, `assign failed: ${e}`));
                }
              }
            }}
          />
        </Box>
      )}

      <Board tasks={tasks} selectedId={selected?.issue.id} width={columns} now={now} />

      {selected && !pickerOpen && (
        <DetailPane task={selected} answering={answering} onAnswerDone={() => setAnswering(false)} />
      )}
    </Box>
  );
}

// Alternate screen buffer: fill the terminal, restore the shell on exit.
process.stdout.write('\x1b[?1049h\x1b[H');
const app = render(<App cfg={cfg} />, { patchConsole: true });
void app.waitUntilExit().finally(() => {
  process.stdout.write('\x1b[?1049l');
});
