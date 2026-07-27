import { Box, Text, useInput } from 'ink';
import { setPendingAction } from '../core/attach.js';
import { configPath } from '../core/config.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';

/** Resolved config, secrets masked, with in-place $EDITOR editing. */
export function ConfigView(_props: { param?: string }) {
  const ctx = useColinear();
  const { cfg } = ctx;
  const path = configPath();

  useInput(
    (input) => {
      if (input === 'e') {
        setPendingAction({ kind: 'edit-config', path });
        ctx.quit();
      }
    },
    { isActive: !ctx.cmdOpen },
  );

  const masked = {
    ...cfg,
    linearApiKey: `${cfg.linearApiKey.slice(0, 12)}…`,
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text>
        <Text bold color={theme.accent}>
          config
        </Text>
        <Text dimColor> {path}</Text>
      </Text>
      <Text dimColor>
        press <Text color={theme.key}>e</Text> to edit in $EDITOR — changes apply when colinear returns
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {JSON.stringify(masked, null, 2)
          .split('\n')
          .map((line, i) => (
            <Text key={i} wrap="truncate">
              <Text color={/^\s*"/.test(line) ? theme.header : undefined}>{line}</Text>
            </Text>
          ))}
      </Box>
    </Box>
  );
}

export const configKeys: Array<[string, string]> = [['e', 'edit config']];
