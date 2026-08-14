import { createContext, useContext } from 'react';
import type { DispatcherApi, GcItem } from '../client.js';
import type { Config, LinearTeam } from '../core/types.js';

export type ToastKind = 'info' | 'ok' | 'err';

export interface AppCtx {
  cfg: Config;
  dispatcher: DispatcherApi;
  /** gcScan results (the daemon does the scanning); returns an unsubscribe */
  onGc?: (fn: (items: GcItem[]) => void) => () => void;
  viewer?: { id: string; displayName: string };
  teams: LinearTeam[];
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
}

export const AppContext = createContext<AppCtx>(null as unknown as AppCtx);

export function useColinear(): AppCtx {
  return useContext(AppContext);
}
