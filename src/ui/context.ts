import { createContext, useContext } from 'react';
import type { DispatcherApi, GcItem, GcProgress, PlanChatReady } from '../client.js';
import type { AgentSession } from '../core/sessions.js';
import type { ChannelMessage } from '../core/channel.js';
import type { Config, Scope, UiState } from '../core/types.js';

export type ToastKind = 'info' | 'ok' | 'err';

export interface AppCtx {
  cfg: Config;
  dispatcher: DispatcherApi;
  /** gcScan results (the daemon does the scanning); returns an unsubscribe */
  onGc?: (fn: (items: GcItem[]) => void) => () => void;
  /** per-worktree progress while a gc removal runs */
  onGcProgress?: (fn: (p: GcProgress) => void) => () => void;
  onPlanChatReady?: (fn: (r: PlanChatReady) => void) => () => void;
  onAgents?: (fn: (list: AgentSession[]) => void) => () => void;
  onReviewDiff?: (fn: (id: string, diff: string) => void) => () => void;
  onTaskDiff?: (fn: (id: string, diff: string) => void) => () => void;
  onCreating?: (fn: (agentId: string) => void) => () => void;
  /** the daemon's own disk, for when it isn't this machine's disk */
  onLogTail?: (fn: (text: string) => void) => () => void;
  onChannels?: (fn: (list: Array<{ name: string; messages: number }>) => void) => () => void;
  onChannelHistory?: (fn: (channel: string, messages: ChannelMessage[]) => void) => () => void;
  viewer?: { id: string; displayName: string };
  teams: Scope[];
  size: { columns: number; rows: number };
  now: number;
  navigate: (name: string, param?: string) => void;
  back: () => void;
  quit: () => void;
  toast: (text: string, kind?: ToastKind) => void;
  /** true while the global : command bar is open — views must ignore input */
  cmdOpen: boolean;
  /** views with active text inputs set this so global keys (: q esc) stand down */
  setCapture: (on: boolean) => void;
  /** view claims esc (e.g. clear filters); return true to consume, else app pops the view */
  setEscHandler: (fn: (() => boolean) | null) => void;
  /** operator preferences that outlive the run (the daemon persists them) */
  ui: UiState;
  setUi: (patch: Partial<UiState>) => void;
}

export const AppContext = createContext<AppCtx>(null as unknown as AppCtx);

export function useColinear(): AppCtx {
  return useContext(AppContext);
}

/**
 * The pane a view actually gets to draw in — not the terminal.
 *
 * `size` is the whole terminal; between it and a view sit the root's padding
 * (2 columns), the view frame's border (2 each way), its padding (2 columns),
 * the four-row header, the crumbs line, and the command bar when it is open.
 * A view that sizes itself against `size` directly overruns its frame, and an
 * overrun does not simply clip: boxes laid out past the bottom are written
 * *over* the ones above them, so a row ends up holding two lines at once and
 * one of them appears to have gone missing. Ask for these numbers instead.
 */
export function viewPaneSize(
  size: { columns: number; rows: number },
  cmdOpen = false,
): { width: number; height: number } {
  return {
    width: Math.max(20, size.columns - 6),
    height: Math.max(6, size.rows - 8 - (cmdOpen ? 4 : 0)),
  };
}

/** The same, for a view that can just ask. */
export function useViewSize(): { width: number; height: number } {
  const { size, cmdOpen } = useColinear();
  return viewPaneSize(size, cmdOpen);
}
