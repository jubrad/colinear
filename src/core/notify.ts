import { execFile } from 'node:child_process';
import type { Config } from './types.js';

let hasTerminalNotifier: boolean | undefined;

function checkTerminalNotifier(cb: (ok: boolean) => void) {
  if (hasTerminalNotifier !== undefined) return cb(hasTerminalNotifier);
  execFile('which', ['terminal-notifier'], (err) => {
    hasTerminalNotifier = !err;
    cb(hasTerminalNotifier);
  });
}

/**
 * macOS notification. With terminal-notifier installed (`brew install
 * terminal-notifier`) clicking opens `url` (e.g. the PR). The osascript
 * fallback cannot set a click action — clicks open Script Editor, a macOS
 * limitation of osascript-sourced notifications.
 */
/** Set by the daemon so a notification also reaches whoever has a screen. */
let forward: ((n: { title: string; body: string; url?: string }) => void) | undefined;

export function onNotifyForward(fn: (n: { title: string; body: string; url?: string }) => void): void {
  forward = fn;
}

export function notify(cfg: Config, title: string, body: string, url?: string): void {
  if (!cfg.notifications) return;
  // tell the client too: on a remote daemon this machine has no screen
  forward?.({ title, body, url });
  if (process.platform !== 'darwin') return;
  const esc = (s: string) => s.replace(/["\\]/g, '');
  checkTerminalNotifier((ok) => {
    if (ok) {
      const args = [
        '-title', 'colinear',
        '-subtitle', title.slice(0, 60),
        '-message', body.slice(0, 160),
        '-group', 'colinear',
      ];
      if (url) args.push('-open', url);
      execFile('terminal-notifier', args, () => {});
    } else {
      execFile(
        'osascript',
        ['-e', `display notification "${esc(body).slice(0, 120)}" with title "colinear" subtitle "${esc(title)}"`],
        () => {},
      );
    }
  });
}
