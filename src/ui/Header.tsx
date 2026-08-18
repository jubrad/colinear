import { Box, Text } from 'ink';
import { theme } from '../theme.js';

// ASCII only: ambiguous-width glyphs here wrap header lines on some terminals,
// pushing the tree past the screen height and forcing full-clear renders
const LOGO = [' >> colinear', '    agents on rails'];

const KEY_PAD = 9;

export function Header(props: {
  info: Array<[string, string]>;
  keys: Array<[string, string]>;
  width: number;
  version: string;
}) {
  const { info, keys, width, version } = props;
  // k9s layout: info block left, hotkeys middle (2+ columns), logo right
  // cap the grid at 4 rows so header height stays constant
  const perCol = 4;
  const all: Array<Array<[string, string]>> = [];
  for (let i = 0; i < Math.ceil(keys.length / perCol); i++) all.push(keys.slice(i * perCol, (i + 1) * perCol));

  // Whole columns are dropped from the right rather than letting flex shrink
  // starve every cell into "<o> …": the rightmost columns are the global keys
  // (:, R, esc, q), which cost the least to lose, and what survives renders
  // in full. A key list that shows half its descriptions is worse than a
  // shorter one that shows all of them.
  const infoWidth = Math.max(0, ...info.map(([k, v]) => 10 + v.length));
  const logoWidth = Math.max(...LOGO.map((l) => l.length), version.length + 1);
  const colWidth = (col: Array<[string, string]>) =>
    Math.max(...col.map(([k, v]) => Math.max(KEY_PAD, `<${k}>`.length + 1) + v.length));
  const available = width - Math.min(infoWidth, 28) - logoWidth - 4;
  const columns: Array<Array<[string, string]>> = [];
  let used = 0;
  for (const col of all) {
    const w = colWidth(col) + (columns.length ? 3 : 0);
    if (columns.length && used + w > available) break;
    columns.push(col);
    used += w;
  }
  if (!columns.length && all.length) columns.push(all[0]);

  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Box flexDirection="column" marginRight={2} flexShrink={1}>
        {info.map(([k, v]) => (
          <Text key={k} wrap="truncate">
            <Text color={theme.key} bold>
              {k.padEnd(10)}
            </Text>
            <Text>{v}</Text>
          </Text>
        ))}
      </Box>
      <Box gap={3} flexShrink={0}>
        {columns.map((col, i) => (
          <Box key={i} flexDirection="column">
            {col.map(([k, v]) => (
              <Text key={k} wrap="truncate">
                <Text color={theme.key} bold>
                  {`<${k}>`.padEnd(KEY_PAD)}
                </Text>
                <Text dimColor>{v}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
        <Text color={theme.key} bold>
          {LOGO[0]}
        </Text>
        <Text dimColor>{LOGO[1]}</Text>
        <Text dimColor>v{version}</Text>
      </Box>
    </Box>
  );
}
