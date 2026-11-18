import { spawnSync } from 'node:child_process';

/**
 * Put text on the operator's clipboard. Where colinear's terminal is on this
 * machine, the platform's own tool does it — pbcopy, wl-copy, xclip. Over ssh
 * that would fill the remote machine's clipboard, which nobody is looking at,
 * so there (and when no tool is installed) it asks the terminal instead with
 * OSC 52, which iTerm2, kitty, WezTerm, Ghostty, Alacritty and Windows
 * Terminal honour — through tmux too, wrapped so tmux passes it on.
 *
 * Says how it went: `false` only when nothing could even be tried. OSC 52 has
 * no reply, so a terminal that ignores it still counts as tried.
 */
export function copyText(text: string): { ok: boolean; via: string } {
  const remote = Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
  if (!remote) {
    const tools: Array<[string, string[]]> =
      process.platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
    for (const [bin, args] of tools) {
      const r = spawnSync(bin, args, { input: text });
      if (!r.error && r.status === 0) return { ok: true, via: bin };
    }
  }
  if (!process.stdout.isTTY) return { ok: false, via: 'none' };
  process.stdout.write(osc52(text, Boolean(process.env.TMUX)));
  return { ok: true, via: 'terminal' };
}

/** The OSC 52 "set clipboard" sequence, wrapped for tmux's passthrough when inside it. */
export function osc52(text: string, tmux: boolean): string {
  const seq = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  return tmux ? `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\` : seq;
}
