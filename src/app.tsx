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
import { AppContext, type AppCtx, type ToastKind } from './ui/context.js';
import { Crumbs } from './ui/Crumbs.js';
import { KeysPopupBody, keysPopupRows, TitleBar } from './ui/Header.js';
import { CommandPalette } from './ui/CommandPalette.js';
import { AskPopup } from './ui/AskPopup.js';
import type { AskState } from './core/ask.js';
import { Popup } from './ui/Popup.js';
import { AgentRail, RAIL_MIN_COLUMNS, RAIL_WIDTH } from './ui/AgentRail.js';
import { fleet, markSeen } from './core/fleet.js';
import type { AgentSession } from './core/sessions.js';
import { findView, reloadCustomViews, views } from './views/registry.js';
import { applyTheme, theme } from './theme.js';

export const VERSION = '0.2.0';

const GLOBAL_KEYS: Array<[string, string]> = [
  [':', 'go to a view'],
  ['`', 'these keys'],
  ['@', 'ask colinear to do something'],
  ['?', 'help'],
  ['esc', 'back'],
  ['q', 'quit view'],
  ['\\', 'agent rail'],
  ['R', 'reload ui'],
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
  /** the @ chat's conversation, as the daemon pushes it */
  onAsk?: (fn: (state: AskState) => void) => () => void;
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
  const { cfg, dispatcher, onToast, onGc, onGcProgress, onPlanChatReady, onAgents, onAsk, onReviewDiff, onTaskDiff, onCreating, onLogTail, onChannels, onChannelHistory, onNotify } = props;
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
  /** `` ` ``: the keys for this view and the global ones, over the view */
  const [keysOpen, setKeysOpen] = useState(false);
  /** `@`: the chat with colinear's assistant */
  const [askOpen, setAskOpen] = useState(false);
  const [askState, setAskState] = useState<AskState>({ messages: [], busy: false, queued: 0 });
  /** any overlay has the keyboard: views stand down while one is open */
  const overlay = cmdOpen || keysOpen || askOpen;
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
  // the chat's conversation, pushed on every change; asked for once at start
  const askOpenRef = useRef(false);
  askOpenRef.current = askOpen;
  useEffect(
    () =>
      onAsk?.((state) => {
        setAskState((prev) => {
          // a reply landing while the chat is closed says so, once
          const replied = state.messages.length > prev.messages.length && state.messages.at(-1)?.from === 'colinear';
          if (replied && !askOpenRef.current) setTimeout(() => ctx.toast('colinear replied — @ to read it', 'info'), 0);
          return state;
        });
      }),
    [onAsk],
  );
  useEffect(() => dispatcher.askState(), []);
  useEffect(() => {
    // The registry is not CDC state: it changes inside sessions that never
    // touch the store, so it is asked for rather than pushed. Always, not
    // only while the rail is up: the title bar counts from it too, and a
    // review, job or plan session exists nowhere else.
    dispatcher.listAgents();
    const timer = setInterval(() => dispatcher.listAgents(), 2000);
    return () => clearInterval(timer);
  }, []);
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
      cmdOpen: overlay,
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
    [cfg, dispatcher, onGc, onGcProgress, onPlanChatReady, onAgents, onReviewDiff, onTaskDiff, onCreating, onLogTail, onChannels, onChannelHistory, viewer, teams, size, now, navigate, back, exit, overlay, ui, setUi, fullScreen],
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
        setKeysOpen(true);
        return;
      }
      if (input === '@') {
        setAskOpen(true);
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
    { isActive: !capture && !overlay },
  );
  // the keys popup is read and dismissed; nothing else happens while it is up
  useInput(
    (input, key) => {
      if (input === '`' || input === 'q' || key.escape) setKeysOpen(false);
      if (input === '?') {
        setKeysOpen(false);
        navigate('help');
      }
    },
    { isActive: keysOpen },
  );

  // Counted from the fleet — the list the rail and :agents show — rather than
  // from task statuses, which only ever saw work sessions: a pre-review, a
  // job, a plan or a draft running was in the rail and missing from here.
  const active = entries.filter((e) => e.group === 'running').length;
  // what :agents puts at the top: a question waiting, or your move
  const needsInput = entries.filter((e) => e.group === 'needs' || e.group === 'yours').length;
  // reviews burn agent sessions too — the headline figure covers both, over
  // the retention window, since anything older has been dropped anyway
  const horizon = cfg.retentionDays ? Date.now() - cfg.retentionDays * 86_400_000 : 0;
  const spend = [...tasks, ...reviews].filter((t) => (t.startedAt ?? t.endedAt ?? Date.now()) >= horizon);
  const totalCost = spend.reduce((n, t) => n + t.costUsd, 0);

  const ViewComponent = viewDef.Component;
  // one title row, always, then the view, then the crumbs and a spare row
  const viewHeight = Math.max(8, size.rows - 1 - 2);
  // The view is told the terminal is the size of what is left of it. Every
  // view sizes itself from ctx.size against the old four-row header (none in
  // full screen) and four more rows while `:` is open, so the rows it is told
  // about are corrected to what is really there: one title row, always, and
  // the palette floating over the view rather than pushing it down. Same trick
  // the rail plays on the width — no view needs to know any of this.
  const rowsBack = (fullScreen ? -1 : 3) + (overlay ? 4 : 0);
  const viewCtx = useMemo<AppCtx>(
    () =>
      railShown || rowsBack
        ? { ...ctx, size: { columns: size.columns - (railShown ? RAIL_WIDTH : 0), rows: size.rows + rowsBack } }
        : ctx,
    [ctx, railShown, rowsBack, size],
  );
  const paletteItems = useMemo(
    () => [
      ...views.map((v) => ({ value: v.name, aliases: v.aliases, detail: v.describe })),
      { value: 'reload', detail: 'reload custom views' },
    ],
    [views.length, cmdOpen],
  );

  return (
    <AppContext.Provider value={ctx}>
      {/* rows - 1: Ink full-clears every frame when output height >= terminal
          rows (equality included) — one spare row keeps it on the incremental
          diff path, which is what stops the flicker */}
      <Box flexDirection="column" width={size.columns} height={size.rows - 1} paddingX={1} overflow="hidden">
        <TitleBar
          user={viewer?.displayName ?? '…'}
          context={CONTEXT === DEFAULT_CONTEXT ? undefined : CONTEXT}
          running={active}
          waiting={needsInput}
          cost={totalCost}
          costDays={cfg.retentionDays || undefined}
          width={size.columns - 2}
          version={VERSION}
        />
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
        {/* last: a Popup is overdrawn by anything rendered after it */}
        {cmdOpen &&
          (() => {
            const w = Math.min(100, size.columns - 4);
            const listRows = Math.max(3, Math.min(paletteItems.length, size.rows - 10, 16));
            return (
              <Popup width={w} height={listRows + 5} top={1} left={Math.max(0, Math.floor((size.columns - 2 - w) / 2))}>
                <CommandPalette
                  items={paletteItems}
                  width={w - 4}
                  listRows={listRows}
                  onCancel={() => setCmdOpen(false)}
                  onSubmit={(value, picked) => {
                    setCmdOpen(false);
                    const [typed, ...rest] = value.trim().split(/\s+/);
                    // what was typed wins when it names something (an alias, an
                    // exact name); otherwise the row the cursor is on
                    const name = findView(typed || '') || typed === 'reload' ? typed : (picked?.value ?? typed);
                    if (name === 'reload') {
                      const n = reloadCustomViews();
                      ctx.toast(`custom views reloaded (${n})`, 'ok');
                      return;
                    }
                    const target = findView(name || '');
                    if (target) navigate(target.name, rest.join(' ') || undefined);
                    else if (value.trim()) ctx.toast(`unknown view: ${typed}`, 'err');
                  }}
                />
              </Popup>
            );
          })()}
        {askOpen &&
          (() => {
            const w = Math.min(120, size.columns - 4);
            const h = Math.max(12, size.rows - 4);
            return (
              <Popup width={w} height={h} top={1} left={Math.max(0, Math.floor((size.columns - 2 - w) / 2))}>
                <AskPopup
                  state={askState}
                  width={w - 4}
                  height={h - 2}
                  now={now}
                  onSend={(text) => dispatcher.ask(text)}
                  onClose={() => setAskOpen(false)}
                  onReset={() => dispatcher.askReset()}
                  onCancel={() => dispatcher.askCancel()}
                />
              </Popup>
            );
          })()}
        {keysOpen &&
          (() => {
            const w = Math.min(110, size.columns - 4);
            const h = Math.min(size.rows - 3, keysPopupRows(viewDef.keys, GLOBAL_KEYS, w - 4) + 2);
            return (
              <Popup width={w} height={h} top={1} left={Math.max(0, Math.floor((size.columns - 2 - w) / 2))}>
                <KeysPopupBody view={viewDef.name} keys={viewDef.keys} global={GLOBAL_KEYS} width={w - 4} />
              </Popup>
            );
          })()}
      </Box>
    </AppContext.Provider>
  );
}
