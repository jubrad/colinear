import { Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { expandTabs } from '../core/diff.js';
import type { ChatTurn } from '../core/types.js';
import { theme } from '../theme.js';
import { useColinear } from './context.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Something is working on what you asked: a spinner, how long it has been at
 * it, and the last thing it said it was doing.
 *
 * It keeps its own clock instead of reading the app's. The app clock ticks
 * once a second and only while a task runs (app.tsx), so a spinner on it sits
 * frozen through exactly the wait it is there to show. This one runs four
 * times per app tick, and only while it is mounted — which is only while
 * something is in flight, so an idle screen still writes no frames.
 */
export function Working(props: { label: string; since?: number; detail?: string; width?: number }) {
  const { label, since, detail } = props;
  const frame = useFrame(true);
  const elapsed = since ? elapsedLabel(Date.now() - since) : '';
  return (
    <Text wrap="truncate">
      <Text color={theme.accent}>{spinFrame(frame)} </Text>
      <Text color={theme.warn}>{label}</Text>
      <Text color={theme.warn}>{'.'.repeat(1 + (Math.floor(frame / 3) % 3)).padEnd(3)}</Text>
      {elapsed ? <Text dimColor> {elapsed}</Text> : null}
      {detail ? <Text dimColor> · {detail}</Text> : null}
    </Text>
  );
}

/**
 * A frame counter for an animation that only exists while `active`: four
 * frames per app tick (`tickMs`, so whoever slowed the clock to stop a
 * flicker slows this too), and no timer at all otherwise.
 */
export function useFrame(active: boolean): number {
  const { cfg } = useColinear();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), Math.max(120, Math.round((cfg.tickMs ?? 1000) / 4)));
    return () => clearInterval(t);
  }, [active, cfg.tickMs]);
  return frame;
}

export function spinFrame(frame: number): string {
  return FRAMES[frame % FRAMES.length];
}

function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Whether a message you just sent is still waiting on its answer. The store
 * says `chatting` once the daemon has started the turn, but that is a round
 * trip away — between enter and that echo, the pane would look as if nothing
 * happened. So the pane remembers that it sent, and lets go when the
 * transcript has grown by the two turns every send ends in (yours, then a
 * reply or a note saying why there won't be one), or when the daemon has said
 * busy and then stopped.
 */
export function useAwaitingReply(turns: ChatTurn[], busy: boolean): { awaiting: boolean; since?: number; sent: () => void } {
  const [sent, setSent] = useState<{ count: number; at: number } | null>(null);
  const sawBusy = useRef(false);
  useEffect(() => {
    if (!sent) return;
    if (busy) sawBusy.current = true;
    if (turns.length >= sent.count + 2 || (sawBusy.current && !busy)) setSent(null);
  }, [sent, busy, turns.length]);
  return {
    awaiting: sent !== null,
    since: sent?.at,
    sent: () => {
      sawBusy.current = false;
      setSent({ count: turns.length, at: Date.now() });
    },
  };
}

interface Line {
  text: string;
  role: ChatTurn['role'];
  first: boolean;
}

const GUTTER = 6;

/**
 * A conversation with an agent, wrapped to the pane instead of cut at its
 * edge, with every line of every turn. When a reply lands it is shown from its
 * first line — the tail of a long answer is the least useful part to see
 * first — and ↑/↓ and pgup/pgdn scroll the rest while `active`.
 */
export function ChatLog(props: {
  turns: ChatTurn[];
  width: number;
  rows: number;
  /** takes the scroll keys — the pane has focus */
  active: boolean;
  /**
   * ↑/↓ scroll too. Off while the input below spans more than one row, where
   * they move its cursor instead; pgup/pgdn always scroll.
   */
  arrows?: boolean;
  /** shown when there is no conversation yet */
  empty: string;
  /** what is in flight, if anything; it takes the last row */
  working?: { label: string; since?: number; detail?: string };
}) {
  const { turns, width, rows, active, empty, working, arrows = true } = props;
  const textWidth = Math.max(10, width - GUTTER);
  const { lines, lastStart } = useMemo(() => layout(turns, textWidth), [turns, textWidth]);
  const body = Math.max(1, rows - (working ? 1 : 0));
  // The "↑ earlier" and "↓ more" markers take rows of their own. They used to
  // be drawn over the window's first and last rows, and following a long new
  // turn puts that turn's first line exactly on the first row — so a question
  // of more than a few lines arrived with its opening line hidden behind
  // "↑ 3 earlier lines".
  const marks = body > 1;
  // scrolled to the end, the up marker is showing, so the end needs one row less
  const maxTop = lines.length <= body ? 0 : Math.max(0, lines.length - (marks ? body - 1 : body));
  // null follows the conversation; a number is where you scrolled to
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => setTop(null), [turns.length]);
  // following: the newest turn from its start if it does not fit, else the bottom
  const fitsBelowMark = lines.length - lastStart <= (marks ? body - 1 : body);
  const follow = Math.min(maxTop, fitsBelowMark ? maxTop : lastStart);
  const at = Math.min(maxTop, top ?? follow);

  useInput(
    (_input, key) => {
      const step = key.pageUp || key.pageDown ? Math.max(1, body - 1) : 1;
      if ((arrows && key.upArrow) || key.pageUp) setTop(Math.max(0, at - step));
      if ((arrows && key.downArrow) || key.pageDown) setTop(Math.min(maxTop, at + step));
    },
    { isActive: active },
  );

  if (!lines.length) {
    return (
      <>
        {wrapProse(empty, width)
          .slice(0, body)
          .map((line, i) => (
            <Text key={i} dimColor wrap="truncate">
              {line}
            </Text>
          ))}
        {working ? <Working {...working} /> : null}
      </>
    );
  }

  // the edges say there is more rather than letting the cut look like the end
  const up = marks && at > 0;
  let room = body - (up ? 1 : 0);
  if (marks && room > 1 && at + room < lines.length) room -= 1;
  const below = lines.length - (at + room);
  const view: Array<Line | { more: string }> = [
    ...(up ? [{ more: `↑ ${at} earlier line${at === 1 ? '' : 's'}${active ? ' · ↑/pgup' : ' · tab to scroll'}` }] : []),
    ...lines.slice(at, at + room),
    ...(marks && below > 0 ? [{ more: `↓ ${below} more${active ? ' · ↓/pgdn' : ' · tab to scroll'}` }] : []),
  ];

  return (
    <>
      {view.map((line, i) =>
        'more' in line ? (
          <Text key={`m${i}`} dimColor wrap="truncate">
            {line.more}
          </Text>
        ) : (
          <Text key={`${at + i}`} wrap="truncate">
            <Text color={line.role === 'operator' ? theme.key : line.role === 'note' ? theme.dim : theme.accent} bold={line.first}>
              {(line.first ? (line.role === 'operator' ? 'you' : line.role === 'note' ? 'note' : 'agent') : '').padEnd(GUTTER)}
            </Text>
            <Text dimColor={line.role === 'note'}>{line.text || ' '}</Text>
          </Text>
        ),
      )}
      {working ? <Working {...working} /> : null}
    </>
  );
}

/** Every turn wrapped, a blank row between turns, and where the newest one starts. */
function layout(turns: ChatTurn[], width: number): { lines: Line[]; lastStart: number } {
  const lines: Line[] = [];
  let lastStart = 0;
  turns.forEach((turn, t) => {
    if (t > 0) lines.push({ text: '', role: turn.role, first: false });
    lastStart = lines.length;
    const wrapped = wrapProse(turn.text.replace(/\*\*(.+?)\*\*/g, '$1'), width);
    wrapped.forEach((text, i) => lines.push({ text, role: turn.role, first: i === 0 }));
  });
  return { lines, lastStart };
}

/**
 * Word wrap that keeps the writer's line breaks (an agent's reply is markdown:
 * lists and code stay one item per line) and hard-breaks a word longer than
 * the pane, so a path or a URL is never silently cut.
 */
export function wrapProse(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of expandTabs(text.trim()).split('\n')) {
    const indent = (/^\s*/.exec(raw)?.[0] ?? '').slice(0, Math.floor(width / 2));
    const words = raw.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = indent;
    for (let word of words) {
      while (word.length > width - indent.length) {
        if (line.trim()) out.push(line);
        out.push(indent + word.slice(0, width - indent.length));
        word = word.slice(width - indent.length);
        line = indent;
      }
      if (!line.trim()) line = indent + word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = indent + word;
      }
    }
    if (line.trim()) out.push(line);
  }
  // runs of blank lines are the agent's spacing, not content
  return out.filter((l, i) => l || (i > 0 && out[i - 1]));
}
