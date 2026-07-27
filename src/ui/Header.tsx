import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const LOGO = [' ⎈ colinear', '   agents on rails'];

export function Header(props: {
  info: Array<[string, string]>;
  keys: Array<[string, string]>;
  width: number;
  version: string;
}) {
  const { info, keys, width, version } = props;
  // k9s layout: info block left, hotkeys middle (2 columns), logo right
  // cap the grid at 4 rows so header height stays constant
  const perCol = 4;
  const keyCols = Math.ceil(keys.length / perCol);
  const columns: Array<Array<[string, string]>> = [];
  for (let i = 0; i < keyCols; i++) columns.push(keys.slice(i * perCol, (i + 1) * perCol));

  return (
    <Box width={width} justifyContent="space-between" flexShrink={0}>
      <Box flexDirection="column" marginRight={2}>
        {info.map(([k, v]) => (
          <Text key={k} wrap="truncate">
            <Text color={theme.key} bold>
              {k.padEnd(10)}
            </Text>
            <Text>{v}</Text>
          </Text>
        ))}
      </Box>
      <Box gap={3}>
        {columns.map((col, i) => (
          <Box key={i} flexDirection="column">
            {col.map(([k, v]) => (
              <Text key={k} wrap="truncate">
                <Text color={theme.key} bold>
                  {`<${k}>`.padEnd(9)}
                </Text>
                <Text dimColor>{v}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text color={theme.key} bold>
          {LOGO[0]}
        </Text>
        <Text dimColor>{LOGO[1]}</Text>
        <Text dimColor>v{version}</Text>
      </Box>
    </Box>
  );
}
