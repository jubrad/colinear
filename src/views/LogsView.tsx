import { Box, Text, useInput } from 'ink';
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { useEffect, useMemo, useState } from 'react';
import { STATE_DIR } from '../core/log.js';
import { CommandBar } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';

const LOG_FILE = `${STATE_DIR}/colinear.log`;
/** how much of the tail to hold: enough to scroll back through a session */
const TAIL_BYTES = 512 * 1024;

/** Read the last chunk of the log without pulling a large file into memory. */
async function readTail(): Promise<string[]> {
  const { size } = statSync(LOG_FILE);
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(LOG_FILE, 'r');
  try {
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(Math.min(TAIL_BYTES, size)),
      position: start,
    });
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // a partial first line when we started mid-file
    return (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean);
  } finally {
    await handle.close();
  }
}

/**
 * The debug log, live. Everything colinear does lands here — including stderr
 * diverted while the TUI owns the screen, which is otherwise invisible.
 *
 * With a remote daemon the interesting log is on *its* disk, so the tail comes
 * over the socket instead. The client's own log stays local (that's where this
 * process's diverted stderr goes) and its path is shown, since a rendering bug
 * won't appear in the daemon's copy.
 */
export function LogsView(_props: { param?: string }) {
  const ctx = useColinear();
  const remote = ctx.cfg.remote;
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [follow, setFollow] = useState(true);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);

  useEffect(() => {
    let live = true;
    if (remote) {
      const stop = ctx.onLogTail?.((text) => {
        if (live) setLines(text.split('\n').filter(Boolean));
      });
      const tick = () => ctx.dispatcher.requestLogTail();
      tick();
      const timer = setInterval(tick, 1000);
      return () => {
        live = false;
        clearInterval(timer);
        stop?.();
      };
    }
    const tick = () =>
      readTail()
        .then((l) => live && setLines(l))
        .catch((err) => live && setError(String(err)));
    void tick();
    const timer = setInterval(tick, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [remote]);

  useEffect(() => ctx.setCapture(filtering), [filtering]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  const shown = useMemo(() => {
    if (!query.trim()) return lines;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return lines.filter((l) => terms.every((t) => l.toLowerCase().includes(t)));
  }, [lines, query]);

  const rows = Math.max(3, ctx.size.rows - 10);
  const maxOffset = Math.max(0, shown.length - rows);
  const start = follow ? maxOffset : Math.min(offset, maxOffset);

  useInput((input, key) => {
    const move = (delta: number) => {
      setFollow(false);
      setOffset((o) => Math.max(0, Math.min(maxOffset, (follow ? maxOffset : o) + delta)));
    };
    if (input === 'j' || key.downArrow) move(1);
    if (input === 'k' || key.upArrow) move(-1);
    if (key.pageDown || input === ' ') move(rows - 1);
    if (key.pageUp) move(-(rows - 1));
    if (input === 'g') {
      setFollow(false);
      setOffset(0);
    }
    if (input === 'G' || input === 'F') setFollow(true);
    if (input === '/') setFiltering(true);
  }, { isActive: !filtering && !ctx.cmdOpen });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          debug log{' '}
        </Text>
        <Text dimColor>
          {shown.length} lines{query ? ` matching /${query}` : ''} ·{' '}
        </Text>
        <Text color={follow ? theme.ok : theme.warn}>{follow ? 'following' : `${start}/${maxOffset}`}</Text>
        <Text dimColor>
          {' '}· {remote ? `${remote.label}:…/colinear.log · local client log ${LOG_FILE}` : LOG_FILE}
        </Text>
      </Box>
      <Text dimColor>j/k scroll · space/pgdn page · g top · G follow · / filter</Text>
      {filtering && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setFiltering(false)}
          onCancel={() => {
            setQuery('');
            setFiltering(false);
          }}
        />
      )}
      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {error && <Text color={theme.err}>{error}</Text>}
        {shown.slice(start, start + rows).map((line, i) => (
          <Text key={`${start}-${i}`} wrap="truncate" color={lineColor(line)}>
            {line}
          </Text>
        ))}
        {!error && !shown.length && <Text dimColor>nothing logged yet</Text>}
      </Box>
    </Box>
  );
}

/** Enough colour to spot trouble while scrolling. */
function lineColor(line: string): string | undefined {
  const body = line.slice(25); // past the ISO timestamp
  if (/failed|error|could not|rejected/i.test(body)) return theme.err;
  if (/^stderr:/.test(body)) return theme.warn;
  if (/daemon|spawned|listening|shutting down/i.test(body)) return theme.accent;
  return undefined;
}

export const logsKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'scroll'],
  ['space', 'page'],
  ['g/G', 'top/follow'],
  ['/', 'filter'],
];
