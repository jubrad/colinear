import { Box, Text } from 'ink';
import { VIEWS_DIR } from '../core/customviews.js';
import { theme } from '../theme.js';
import { views } from './registry.js';

export function HelpView(_props: { param?: string }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>
        help
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.header}>
          VIEWS <Text dimColor>(open with :name, tab completes)</Text>
        </Text>
        {views.map((v) => (
          <Text key={v.name} wrap="truncate">
            <Text color={theme.key} bold>
              {`:${v.name}`.padEnd(12)}
            </Text>
            <Text dimColor>{(v.aliases.join(', ') || ' ').padEnd(10)}</Text>
            {v.describe}
            {v.custom && <Text color={theme.info}> (custom)</Text>}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.header}>
          GLOBAL KEYS
        </Text>
        {(
          [
            [':', 'command bar (view name + optional arg, e.g. :project promsql)'],
            ['?', 'this help'],
            ['esc', 'clear filters, then back'],
            ['q', 'back / quit at root'],
            ['R', 'reload the frontend on new code (agents keep running)'],
            ['ctrl+c', 'quit'],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <Text key={k}>
            <Text color={theme.key} bold>
              {k.padEnd(12)}
            </Text>
            <Text dimColor>{v}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.header}>
          CLI
        </Text>
        {(
          [
            ['coli -c NAME', 'run against another context: its own config, daemon and state'],
            ['coli contexts', 'list contexts and which have a daemon running'],
            ['coli gc', 'reclaim worktree disk (prints first; --yes removes)'],
            ['coli daemon', 'status | stop — the backend that keeps agents alive'],
          ] as Array<[string, string]>
        ).map(([k, v]) => (
          <Text key={k} wrap="truncate">
            <Text color={theme.key} bold>
              {k.padEnd(16)}
            </Text>
            <Text dimColor>{v}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.header}>
          CUSTOM VIEWS
        </Text>
        <Text dimColor>Drop JSON files in {VIEWS_DIR} and run :reload —</Text>
        <Text dimColor>
          {'{"name":"cloud-bugs","aliases":["cb"],"filter":{"team":"CLOUD","labels":["Bug"],"assignee":"any","project":null},"columns":["issue","priority","title","labels"],"sort":"priority"}'}
        </Text>
      </Box>
    </Box>
  );
}

export const helpKeys: Array<[string, string]> = [['esc', 'back']];
