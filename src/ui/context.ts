import { createContext, useContext } from 'react';
import type { Dispatcher } from '../core/dispatcher.js';
import type { Config, LinearTeam } from '../core/types.js';

export type ToastKind = 'info' | 'ok' | 'err';

export interface AppCtx {
  cfg: Config;
  dispatcher: Dispatcher;
  viewer?: { id: string; displayName: string };
  teams: LinearTeam[];
  size: { columns: number; rows: number };
  now: number;
  navigate: (name: string, param?: string) => void;
  back: () => void;
  quit: () => void;
  toast: (text: string, kind?: ToastKind) => void;
  /** views with active text inputs set this so global keys (: q esc) stand down */
  setCapture: (on: boolean) => void;
  /** view claims esc (e.g. clear filters); return true to consume, else app pops the view */
  setEscHandler: (fn: (() => boolean) | null) => void;
}

export const AppContext = createContext<AppCtx>(null as unknown as AppCtx);

export function useForeman(): AppCtx {
  return useContext(AppContext);
}
