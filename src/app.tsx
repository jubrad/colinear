import { Box, useApp, useInput, useStdout } from 'ink';
import { providerFor } from './core/provider.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DispatcherApi } from './client.js';
import { consumeResumeView, rememberView, setPendingAction } from './core/attach.js';
import { CONTEXT, DEFAULT_CONTEXT } from './core/context.js';
import { useReviews, useTasks } from './core/hooks.js';
import { notify } from './core/notify.js';
import { store } from './core/store.js';
import type { Config, Scope, UiState } from './core/types.js';
import { CommandBar } from './ui/CommandBar.js';
import { AppContext, type AppCtx, type ToastKind } from './ui/context.js';
import { Crumbs } from './ui/Crumbs.js';
import { formatTokens } from './ui/format.js';
import { Header } from './ui/Header.js';
import { AgentRail, RAIL_MIN_COLUMNS, RAIL_WIDTH } from './ui/AgentRail.js';
import { fleet, markSeen } from './core/fleet.js';
import type { AgentSession } from './core/sessions.js';
import { commandCandidates, findView, reloadCustomViews, views } from './views/registry.js';
import { applyTheme, theme } from './theme.js';

export const VERSION = '0.2.0';

const GLOBAL_KEYS: Array<[string, string]> = [
  [':', 'command'],
  ['R', 'reload ui'],
  ['esc', 'back'],
  ['q', 'quit view'],
  ['\\', 'agent rail'],
  ['`', 'hide header'],
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
  onPlanChatReady?: AppCtx['onPlanChatReady'];
  onAgents?: AppCtx['onAgents'];
  onReviewDiff?: AppCtx['onReviewDiff'];
  onTaskDiff?: AppCtx['onTaskDiff'];
  onCreating?: AppCtx['onCreating'];
  onLogTail?: AppCtx['onLogTail'];
  onChannels?: AppCtx['onChannels'];
  onChannelHistory?: AppCtx['onChannelHistory'];
  onNotify?: (fn: (n: { title: string; body: string; url?: string }) => void) => () => void;
  /** persisted operator preferences, and the way back to the daemon that owns them */
  ui?: UiState;
  setUi?: (patch: Partial<UiState>) => void;
}) {
  const { cfg, dispatcher, onToast, onGc, onGcProgress, onPlanChatReady, onAgents, onReviewDiff, onTaskDiff, onCreating, onLogTail, onChannels, onChannelHistory, onNotify } = props;
  const { exit } = useApp();
  const size = useTerminalSize();
  const tasks = useTasks();
  const reviews = useReviews();
  // nothing on screen is timing/spinning -> stop ticking, so an idle board
  // writes zero frames (matters for unfocused panes)
  // a review an agent is working on counts too: its elapsed time is on screen
  const anyTicking =
    tasks.some((t) => t.startedAt && !t.endedAt) ||
    reviews.some((r) => r.chatting || r.status === 'reviewing' || r.status === 'posting');
  const now = useClock(cfg.tickMs, anyTicking);

  // the daemon owns the file; this is the local mirror so a preference
  // repaints immediately instead of after a reconnect
  const [ui, setUiLocal] = useState<UiState>(props.ui ?? {});
  // before anything below renders: every view reads the theme's colours at render time
  applyTheme(ui.theme);
  const setUi = useCallback(
    (patch: Partial<UiState>) => {
      setUiLocal((u) => ({ ...u, ...patch }));
      props.setUi?.(patch);
    },
    [props.setUi],
  );

  const keyCounter = useRef(1);
  // land on the board when a previous run's tasks were restored
  const [stack, setStack] = useState<StackEntry[]>(() => {
    // coming back from an editor or an attached session: pick up where we left
    const resume = consumeResumeView();
    if (resume) return [{ name: resume.name, param: resume.param, key: 0 }];
    return [{ name: store.list().length ? 'board' : 'issues', key: 0 }];
  });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [toast, setToastState] = useState<{ text: string; kind: ToastKind; at: number }>();
  const [viewer, setViewer] = useState<{ id: string; displayName: string }>();
  const [teams, setTeams] = useState<Scope[]>([]);
  const captureRef = useRef(false);
  const [capture, setCaptureState] = useState(false);
  const escHandlerRef = useRef<(() => boolean) | null>(null);

  const current = stack[stack.length - 1];
  const viewDef = findView(current.name) ?? views[0];

  // The rail: every agent beside every view. Hidden full screen (the annotated
  // diff wants the room) and on a terminal too narrow to give it any.
  // Not on :agents either, which is the same list with room to act on it.
  const railShown = Boolean(ui.rail) && !fullScreen && size.columns >= RAIL_MIN_COLUMNS && viewDef.name !== 'agents';
  const [agents, setAgents] = useState<AgentSession[]>([]);
  useEffect(() => onAgents?.(setAgents), [onAgents]);
  useEffect(() => {
    if (!railShown) return;
    // the registry is not CDC state: it changes inside sessions that never
    // touch the store, so it is asked for rather than pushed
    dispatcher.listAgents();
    const timer = setInterval(() => dispatcher.listAgents(), 2000);
    return () => clearInterval(timer);
  }, [railShown]);
  const entries = useMemo(() => fleet(tasks, reviews, agents, now), [tasks, reviews, agents, now]);

  // Opening a task or a review is looking at it: stamped on the way in and on
  // the way out, so what happened while you were on it is not news after.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  useEffect(() => {
    const stamp = () => {
      const seen = markSeen(uiRef.current.seen, current.name, current.param, Date.now());
      if (seen) setUi({ seen });
    };
    stamp();
    return stamp;
  }, [current.name, current.param]);

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
  // a remote daemon's own terminal-notifier would fire on the VM, where nobody
  // is looking — raise it here instead, on the machine with the screen
  useEffect(
    () =>
      onNotify?.((n) => {
        if (!cfg.remote) return;
        notify(cfg, n.title, n.body, n.url);
        setToastState({ text: `${n.title}: ${n.body}`, kind: 'info', at: Date.now() });
      }),
    [onNotify, cfg],
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
      onPlanChatReady,
      onAgents,
      onReviewDiff,
      onTaskDiff,
      onCreating,
      onLogTail,
      onChannels,
      onChannelHistory,
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
      ui,
      setUi,
      fullScreen,
      setFullScreen,
    }),
    [cfg, dispatcher, onGc, onGcProgress, onPlanChatReady, onAgents, onReviewDiff, onTaskDiff, onCreating, onLogTail, onChannels, onChannelHistory, viewer, teams, size, now, navigate, back, exit, cmdOpen, ui, setUi, fullScreen],
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
      if (input === '`') {
        setUi({ headerHidden: !ui.headerHidden });
        return;
      }
      if (input === '\\') {
        if (!ui.rail && size.columns < RAIL_MIN_COLUMNS) {
          ctx.toast(`the agent rail needs ${RAIL_MIN_COLUMNS} columns — :agents has the same list`, 'info');
          return;
        }
        setUi({ rail: !ui.rail });
      }
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
  const headerShown = !fullScreen && !ui.headerHidden;
  const viewHeight = Math.max(8, size.rows - (headerShown ? 4 : 0) - 2 - (cmdOpen ? 4 : 0));
  // the view is told the terminal is the size of what is left of it: every view
  // sizes itself from ctx.size against a four-row header, and none of them
  // should have to know a rail exists or that the header is folded away
  const reclaimed = !fullScreen && !headerShown ? 4 : 0;
  const viewCtx = useMemo<AppCtx>(
    () =>
      railShown || reclaimed
        ? { ...ctx, size: { columns: size.columns - (railShown ? RAIL_WIDTH : 0), rows: size.rows + reclaimed } }
        : ctx,
    [ctx, railShown, reclaimed, size],
  );

  return (
    <AppContext.Provider value={ctx}>
      {/* rows - 1: Ink full-clears every frame when output height >= terminal
          rows (equality included) — one spare row keeps it on the incremental
          diff path, which is what stops the flicker */}
      <Box flexDirection="column" width={size.columns} height={size.rows - 1} paddingX={1} overflow="hidden">
        {headerShown && (
          <Header info={info} keys={[...viewDef.keys, ...GLOBAL_KEYS]} width={size.columns - 2} version={VERSION} />
        )}
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
        <Box flexDirection="row" height={viewHeight}>
          {railShown && <AgentRail entries={entries} seen={ui.seen} now={now} height={viewHeight} />}
          <Box
            flexDirection="column"
            // hard height: flex-basis is content size in yoga, so a grown pane
            // would otherwise push the whole app taller than the terminal and
            // scroll the header off the top
            // full screen has no header above it, so the view keeps those 4 rows
            height={viewHeight}
            width={railShown ? size.columns - 2 - RAIL_WIDTH : undefined}
            flexGrow={1}
            overflow="hidden"
            borderStyle="round"
            borderColor={theme.border}
            paddingX={1}
          >
            <AppContext.Provider value={viewCtx}>
              <ViewComponent key={current.key} param={current.param} />
            </AppContext.Provider>
          </Box>
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
