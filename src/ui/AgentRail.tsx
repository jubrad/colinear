import { Box, Text } from 'ink';
import { age, GROUP_LABEL, isUnread, type FleetEntry, type FleetGroup } from '../core/fleet.js';
import { theme } from '../theme.js';
import { spinner } from './format.js';

/** Columns the rail takes, border included. */
export const RAIL_WIDTH = 34;
/** Narrower than this, the rail stays hidden: the view needs the room more. */
export const RAIL_MIN_COLUMNS = 150;

const GROUP_COLOR: Record<FleetGroup, string> = {
  needs: theme.info,
  running: theme.warn,
  finished: theme.dim,
};

/**
 * Every agent, beside whatever view you are in: which ones are waiting on you,
 * which are working and on what, which just finished. Two rows an agent — what
 * it is on and how long, then what it is doing — and bold where something has
 * happened since you last opened it.
 *
 * Read-only and keyless: it answers "what is going on" from any view, and
 * `:agents` is where you act on it. Sized by hand, whole entries only — Ink
 * squashes an overfull box rather than clipping it.
 */
export function AgentRail(props: {
  entries: FleetEntry[];
  seen?: Record<string, number>;
  now: number;
  height: number;
}) {
  const { entries, seen, now } = props;
  const inner = RAIL_WIDTH - 4;
  // border top and bottom, and the title row
  let room = Math.max(0, props.height - 3);
  const rows: Array<{ kind: 'group'; group: FleetGroup; count: number } | { kind: 'entry'; entry: FleetEntry }> = [];
  let shown = 0;
  let lastGroup: FleetGroup | undefined;
  for (const e of entries) {
    const header = e.group !== lastGroup ? 1 : 0;
    // keep a row for "N more" unless this is the last entry
    const reserve = shown + 1 < entries.length ? 1 : 0;
    if (header + 2 + reserve > room) break;
    if (header) {
      rows.push({ kind: 'group', group: e.group, count: entries.filter((x) => x.group === e.group).length });
      lastGroup = e.group;
    }
    rows.push({ kind: 'entry', entry: e });
    room -= header + 2;
    shown++;
  }
  const more = entries.length - shown;
  const unread = entries.filter((e) => isUnread(e, seen)).length;

  return (
    <Box
      flexDirection="column"
      width={RAIL_WIDTH}
      height={props.height}
      flexShrink={0}
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          agents
        </Text>
        <Text dimColor>
          {unread ? ` · ${unread} new` : ''} · \ hides
        </Text>
      </Text>
      {!entries.length && (
        <Text dimColor wrap="wrap">
          nothing running
        </Text>
      )}
      {rows.map((r) =>
        r.kind === 'group' ? (
          <Text key={`g-${r.group}`} color={GROUP_COLOR[r.group]} bold wrap="truncate">
            {GROUP_LABEL[r.group]} {r.count > 1 ? <Text dimColor>{r.count}</Text> : null}
          </Text>
        ) : (
          <Entry key={r.entry.key} entry={r.entry} unread={isUnread(r.entry, seen)} now={now} width={inner} />
        ),
      )}
      {more > 0 && (
        <Text dimColor wrap="truncate">
          +{more} more · :agents
        </Text>
      )}
    </Box>
  );
}

function Entry(props: { entry: FleetEntry; unread: boolean; now: number; width: number }) {
  const { entry, unread, now, width } = props;
  const when = age(entry.since, now);
  const glyph =
    entry.group === 'needs' ? '?' : entry.group === 'running' ? spinner(now) : entry.ok === false ? '✖' : '✓';
  const glyphColor =
    entry.group === 'needs' ? theme.info : entry.group === 'running' ? theme.warn : entry.ok === false ? theme.err : theme.ok;
  // the label and what it is: "CLO-211 work", cut before the age column
  const kind = entry.kind === 'question' ? '' : ` ${entry.kind}`;
  const head = `${entry.label}${kind}`;
  const room = Math.max(4, width - 2 - when.length - 1);
  const shownHead = head.length > room ? `${head.slice(0, room - 1)}…` : head.padEnd(room);
  return (
    <>
      <Text wrap="truncate">
        <Text color={glyphColor}>{glyph} </Text>
        <Text bold={unread} dimColor={!unread && entry.group === 'finished'}>
          {shownHead}
        </Text>{' '}
        <Text dimColor>{when}</Text>
      </Text>
      <Text wrap="truncate" color={entry.group === 'needs' ? theme.info : undefined} dimColor={entry.group !== 'needs'}>
        {'  '}
        {entry.line}
      </Text>
    </>
  );
}
