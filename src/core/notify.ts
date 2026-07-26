import { execFile } from 'node:child_process';
import type { Config } from './types.js';

/** macOS notification via osascript; silently a no-op elsewhere or on failure. */
export function notify(cfg: Config, title: string, body: string): void {
  if (!cfg.notifications || process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/["\\]/g, '');
  execFile(
    'osascript',
    ['-e', `display notification "${esc(body).slice(0, 120)}" with title "colinear" subtitle "${esc(title)}"`],
    () => {},
  );
}
