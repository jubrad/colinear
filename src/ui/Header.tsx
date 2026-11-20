import { Box, Text } from 'ink';
import { theme } from '../theme.js';

/**
 * The one line over every view: who you are, what your agents are doing and
 * what they have cost, and the name on the right. It used to be four rows —
 * this plus a grid of keys and a logo — and the keys now live behind `` ` ``
 * (KeysPopup), so the line is always there, full screen included, and costs
 * one row instead of four.
 *
 * ASCII and box-drawing only: an ambiguous-width glyph here wraps the line on
 * some terminals, pushing the frame past the screen and forcing full redraws.
 */
export function TitleBar(props: {
  user: string;
  /** e.g. "work" when a named context is in use */
  context?: string;
  running: number;
  waiting: number;
  total: number;
  cost: number;
  /** the window the cost covers, in days */
  costDays?: number;
  width: number;
  version: string;
}) {
  const { user, context, running, waiting, total, cost, costDays, width, version } = props;
  return (
    <Box width={width} justifyContent="space-between" flexShrink={0} height={1}>
      <Text wrap="truncate">
        <Text bold>{user}</Text>
        {context ? <Text color={theme.warn}> ctx {context}</Text> : null}
        <Text dimColor> · </Text>
        <Text color={running ? theme.ok : theme.dim} bold={running > 0}>
          {running} running
        </Text>
        {waiting ? <Text color={theme.warn}> · {waiting} waiting on you</Text> : null}
        <Text dimColor> / {total}</Text>
        <Text dimColor> · </Text>
        <Text>${cost.toFixed(2)}</Text>
        <Text dimColor>{costDays ? `/${costDays}d` : ''}</Text>
      </Text>
      <Text wrap="truncate">
        <Text dimColor>` keys · : views  </Text>
        <Text color={theme.key} bold>
          colinear
        </Text>
        <Text dimColor> v{version}</Text>
      </Text>
    </Box>
  );
}

/**
 * `` ` ``: every key that works here, this view's first and then the global
 * ones, in columns. Floats over the view (render it last, like any Popup);
 * `` ` ``, esc or q closes it.
 */
export function KeysPopupBody(props: { view: string; keys: Array<[string, string]>; global: Array<[string, string]>; width: number }) {
  const { view, keys, global, width } = props;
  const section = (title: string, list: Array<[string, string]>) => {
    const keyWidth = Math.max(5, ...list.map(([k]) => k.length + 2));
    const cellWidth = Math.max(24, ...list.map(([k, v]) => keyWidth + v.length + 2));
    const perRow = Math.max(1, Math.floor(width / cellWidth));
    const rows: Array<Array<[string, string]>> = [];
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow));
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.header}>
          {title}
        </Text>
        {rows.map((row, i) => (
          <Text key={i} wrap="truncate">
            {row.map(([k, v]) => (
              <Text key={k}>
                <Text color={theme.key} bold>
                  {k.padEnd(keyWidth)}
                </Text>
                <Text dimColor>{v.padEnd(cellWidth - keyWidth)}</Text>
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    );
  };
  return (
    <Box flexDirection="column">
      {keys.length > 0 && section(`:${view}`, keys)}
      {section('everywhere', global)}
      <Text dimColor>` esc or q closes · ? the full help</Text>
    </Box>
  );
}

/** Rows the keys popup needs inside its frame, so the Popup can be given its height. */
export function keysPopupRows(keys: Array<[string, string]>, global: Array<[string, string]>, width: number): number {
  const rowsFor = (list: Array<[string, string]>) => {
    if (!list.length) return 0;
    const keyWidth = Math.max(5, ...list.map(([k]) => k.length + 2));
    const cellWidth = Math.max(24, ...list.map(([k, v]) => keyWidth + v.length + 2));
    const perRow = Math.max(1, Math.floor(width / cellWidth));
    return 2 + Math.ceil(list.length / perRow); // title, rows, the gap after
  };
  return rowsFor(keys) + rowsFor(global) + 1;
}
