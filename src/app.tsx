import { Box, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatcher } from './core/dispatcher.js';
import { useTasks } from './core/hooks.js';
import { fetchTeams, fetchViewer } from './core/linear.js';
import { startPrPolling } from './core/prs.js';
import { store } from './core/store.js';
import type { Config, LinearTeam } from './core/types.js';
import { CommandBar } from './ui/CommandBar.js';
import { AppContext, type AppCtx, type ToastKind } from './ui/context.js';
import { Crumbs } from './ui/Crumbs.js';
import { formatTokens } from './ui/format.js';
import { Header } from './ui/Header.js';
import { commandCandidates, findView, reloadCustomViews, views } from './views/registry.js';
import { theme } from './theme.js';

export const VERSION = '0.2.0';

const GLOBAL_KEYS: Array<[string, string]> = [
  [':', 'command'],
  ['esc', 'back'],
  ['q', 'quit view'],
];

interface StackEntry {
  name: string;
  param?: string;
  key: number;
}

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

function useClock(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function App(props: { cfg: Config; dispatcher: Dispatcher }) {
  const { cfg, dispatcher } = props;
  const { exit } = useApp();
  const size = useTerminalSize();
  const now = useClock();
  const tasks = useTasks();

  const keyCounter = useRef(1);
  // land on the board when a previous run's tasks were restored
  const [stack, setStack] = useState<StackEntry[]>([
    { name: store.list().length ? 'board' : 'issues', key: 0 },
  ]);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [toast, setToastState] = useState<{ text: string; kind: ToastKind; at: number }>();
  const [viewer, setViewer] = useState<{ id: string; displayName: string }>();
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const captureRef = useRef(false);
  const [capture, setCaptureState] = useState(false);
  const escHandlerRef = useRef<(() => boolean) | null>(null);

  const current = stack[stack.length - 1];
  const viewDef = findView(current.name) ?? views[0];

  useEffect(() => {
    fetchViewer(cfg)
      .then((v) => {
        setViewer(v);
        dispatcher.setViewer(v);
      })
      .catch(() => {});
    fetchTeams(cfg)
      .then(setTeams)
      .catch(() => {});
    return startPrPolling(cfg, dispatcher);
  }, []);

  // toasts auto-expire
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToastState(undefined), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const navigate = useCallback((name: string, param?: string) => {
    setStack((s) => {
      // replace if navigating to the same view type to avoid stack spam
      const next = s.filter((e) => e.name !== name || e.param !== param);
      return [...next, { name, param, key: keyCounter.current++ }];
    });
  }, []);

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const ctx = useMemo<AppCtx>(
    () => ({
      cfg,
      dispatcher,
      viewer,
      teams,
      size,
      now,
      navigate,
      back,
      quit: exit,
      toast: (text, kind = 'info') => setToastState({ text, kind, at: Date.now() }),
      setCapture: (on) => {
        captureRef.current = on;
        setCaptureState(on);
      },
      setEscHandler: (fn) => {
        escHandlerRef.current = fn;
      },
    }),
    [cfg, dispatcher, viewer, teams, size, now, navigate, back, exit],
  );

  useInput(
    (input, key) => {
      if (input === ':') {
        setCmdOpen(true);
        return;
      }
      if (key.escape) {
        if (escHandlerRef.current?.()) return;
        back();
        return;
      }
      if (input === 'q') {
        if (stack.length > 1) back();
        else exit();
      }
      if (input === '?') navigate('help');
    },
    { isActive: !capture && !cmdOpen },
  );

  const active = tasks.filter((t) => ['triage', 'working', 'checks'].includes(t.status)).length;
  const needsInput = tasks.filter((t) => t.status === 'needs_input').length;
  const totalTokens = tasks.reduce(
    (acc, t) => ({ input: acc.input + t.tokens.input, output: acc.output + t.tokens.output }),
    { input: 0, output: 0 },
  );
  const totalCost = tasks.reduce((n, t) => n + t.costUsd, 0);

  const info: Array<[string, string]> = [
    ['User', viewer?.displayName ?? '…'],
    ['Repo', cfg.repo.split('/').slice(-1)[0]],
    ['Agents', `${active} active${needsInput ? `, ${needsInput} waiting` : ''} / ${tasks.length}`],
    ['Tokens', `${formatTokens(totalTokens)} ($${totalCost.toFixed(2)})`],
  ];

  const ViewComponent = viewDef.Component;

  return (
    <AppContext.Provider value={ctx}>
      <Box flexDirection="column" width={size.columns} height={size.rows} paddingX={1}>
        <Header info={info} keys={[...viewDef.keys, ...GLOBAL_KEYS]} width={size.columns - 2} version={VERSION} />
        {cmdOpen && (
          <Box borderStyle="round" borderColor={theme.key} paddingX={1}>
            <CommandBar
              prefix="🐶> "
              placeholder="view (issues, board, …)"
              candidates={commandCandidates()}
              onCancel={() => setCmdOpen(false)}
              onSubmit={(value, top) => {
                setCmdOpen(false);
                const [name, ...rest] = value.trim().split(/\s+/);
                if (name === 'reload' || top?.value === 'reload') {
                  const n = reloadCustomViews();
                  ctx.toast(`custom views reloaded (${n})`, 'ok');
                  return;
                }
                const target = findView(name || '') ?? (top ? findView(top.value) : undefined);
                if (target) navigate(target.name, rest.join(' ') || undefined);
                else if (value.trim()) ctx.toast(`unknown view: ${name}`, 'err');
              }}
            />
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
          <ViewComponent key={current.key} param={current.param} />
        </Box>
        <Crumbs
          trail={stack.map((e) => (e.param ? `${e.name}(${e.param})` : e.name))}
          toast={toast && now - toast.at < 5000 ? toast : undefined}
          width={size.columns - 2}
        />
      </Box>
    </AppContext.Provider>
  );
}
