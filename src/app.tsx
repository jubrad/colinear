import { Box, useApp, useInput, useStdout } from 'ink';
import { providerFor } from './core/provider.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatcherApi } from './client.js';
import { consumeResumeView, rememberView, setPendingAction } from './core/attach.js';
import { CONTEXT, DEFAULT_CONTEXT } from './core/context.js';
import { useReviews, useTasks } from './core/hooks.js';
import { store } from './core/store.js';
import type { Config, Scope } from './core/types.js';
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
  ['R', 'reload ui'],
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
    const onResize = () => {
      // wipe the alt screen so stale cells from the old geometry can't linger
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      setSize({ columns: stdout.columns ?? 120, rows: stdout.rows ?? 40 });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

// NOTE: renders happen on every tick; if the tree is ever taller than the
// terminal, Ink falls back to full-screen clears per frame (visible flicker).
// Keep this slow-ish and keep the root Box clipped.
function useClock(intervalMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, active]);
  return now;
}

export function App(props: {
  cfg: Config;
  dispatcher: DispatcherApi;
  /** daemon-side messages surface as toasts; returns an unsubscribe */
  onToast?: (fn: (text: string, kind: ToastKind) => void) => () => void;
  onGc?: AppCtx['onGc'];
  onGcProgress?: AppCtx['onGcProgress'];
}) {
  const { cfg, dispatcher, onToast, onGc, onGcProgress } = props;
  const { exit } = useApp();
  const size = useTerminalSize();
  const tasks = useTasks();
  const reviews = useReviews();
  // nothing on screen is timing/spinning -> stop ticking, so an idle board
  // writes zero frames (matters for unfocused panes)
  const anyTicking = tasks.some((t) => t.startedAt && !t.endedAt);
  const now = useClock(cfg.tickMs, anyTicking);

  const keyCounter = useRef(1);
  // land on the board when a previous run's tasks were restored
  const [stack, setStack] = useState<StackEntry[]>(() => {
    // coming back from an editor or an attached session: pick up where we left
    const resume = consumeResumeView();
    if (resume) return [{ name: resume.name, param: resume.param, key: 0 }];
    return [{ name: store.list().length ? 'board' : 'issues', key: 0 }];
  });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [toast, setToastState] = useState<{ text: string; kind: ToastKind; at: number }>();
  const [viewer, setViewer] = useState<{ id: string; displayName: string }>();
  const [teams, setTeams] = useState<Scope[]>([]);
  const captureRef = useRef(false);
  const [capture, setCaptureState] = useState(false);
  const escHandlerRef = useRef<(() => boolean) | null>(null);

  const current = stack[stack.length - 1];
  const viewDef = findView(current.name) ?? views[0];

  // so a pending action (attach, $EDITOR) can restore this view afterwards
  useEffect(() => rememberView(current.name, current.param), [current.name, current.param]);

  useEffect(() => {
    providerFor(cfg).viewer()
      .then((v) => {
        setViewer(v);
        dispatcher.setViewer(v);
      })
      .catch(() => {});
    providerFor(cfg).scopes()
      .then(setTeams)
      .catch(() => {});
  }, []);

  // messages the daemon originates (edit results, requeue outcomes)
  useEffect(
    () => onToast?.((text, kind) => setToastState({ text, kind, at: Date.now() })),
    [onToast],
  );

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
      onGc,
      onGcProgress,
      viewer,
      teams,
      size,
      now,
      navigate,
      back,
      cmdOpen,
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
    [cfg, dispatcher, onGc, onGcProgress, viewer, teams, size, now, navigate, back, exit, cmdOpen],
  );

  useInput(
    (input, key) => {
      if (input === ':') {
        setCmdOpen(true);
        return;
      }
      if (input === 'R') {
        // restart this process on new code; the daemon (and its agents) stay up
        setPendingAction({ kind: 'reload-ui' });
        exit();
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
  // reviews burn agent sessions too — the headline figure covers both, over
  // the retention window, since anything older has been dropped anyway
  const horizon = cfg.retentionDays ? Date.now() - cfg.retentionDays * 86_400_000 : 0;
  const spend = [...tasks, ...reviews].filter((t) => (t.startedAt ?? t.endedAt ?? Date.now()) >= horizon);
  const totalTokens = spend.reduce(
    (acc, t) => ({ input: acc.input + t.tokens.input, output: acc.output + t.tokens.output }),
    { input: 0, output: 0 },
  );
  const totalCost = spend.reduce((n, t) => n + t.costUsd, 0);

  const info: Array<[string, string]> = [
    ['User', viewer?.displayName ?? '…'],
    // the context rides on the repo row rather than taking a fifth: every view
    // sizes its panes against a four-row header
    ['Repo', cfg.repo.split('/').slice(-1)[0] + (CONTEXT === DEFAULT_CONTEXT ? '' : ` (ctx ${CONTEXT})`)],
    ['Agents', `${active} active${needsInput ? `, ${needsInput} waiting` : ''} / ${tasks.length}`],
    [
      cfg.retentionDays ? `Tokens/${cfg.retentionDays}d` : 'Tokens',
      `${formatTokens(totalTokens)} ($${totalCost.toFixed(2)})`,
    ],
  ];

  const ViewComponent = viewDef.Component;

  return (
    <AppContext.Provider value={ctx}>
      {/* rows - 1: Ink full-clears every frame when output height >= terminal
          rows (equality included) — one spare row keeps it on the incremental
          diff path, which is what stops the flicker */}
      <Box flexDirection="column" width={size.columns} height={size.rows - 1} paddingX={1} overflow="hidden">
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
        <Box
          flexDirection="column"
          // hard height: flex-basis is content size in yoga, so a grown pane
          // would otherwise push the whole app taller than the terminal and
          // scroll the header off the top
          height={Math.max(8, size.rows - 4 - 2 - (cmdOpen ? 4 : 0))}
          overflow="hidden"
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
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
