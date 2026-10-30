import { useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { setPendingAction } from '../core/attach.js';
import { configPath } from '../core/config.js';
import { CONTEXT, DEFAULT_CONTEXT, listContexts } from '../core/context.js';
import { agentFor } from '../core/agent.js';
import { providerFor } from '../core/provider.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';
import type { ConfigSource } from '../core/types.js';

/** Resolved config, secrets masked, with in-place $EDITOR editing. */
export function ConfigView(_props: { param?: string }) {
  const ctx = useColinear();
  const { cfg } = ctx;
  const [offset, setOffset] = useState(0);
  const path = configPath();
  const contexts = listContexts();
  const provider = providerFor(cfg);
  const off = Object.entries(provider.capabilities)
    .filter(([, on]) => !on)
    .map(([name]) => name);
  // the runtime gets the same treatment as the tracker: what it cannot do is
  // said here, where an operator looks when a key does nothing
  const agent = agentFor(cfg);
  const agentOff = Object.entries(agent.capabilities)
    .filter(([, on]) => !on)
    .map(([name]) => name);

  const { layers, ...shown } = cfg;
  const masked = {
    ...shown,
    // the daemon keeps the key and makes the calls; a client is never sent it
    linearApiKey: cfg.linearApiKey ? `${cfg.linearApiKey.slice(0, 12)}…` : (cfg.provider ?? 'linear') === 'linear' ? 'held by the daemon' : 'unused',
  };

  // one list of rows under a fixed header, so a config taller than the
  // terminal scrolls instead of overprinting itself
  const body: ReactNode[] = [];
  if (layers?.ignored.length) {
    body.push(
      <Text bold color={theme.header}>
        set but not applied
      </Text>,
    );
    for (const i of layers.ignored) {
      body.push(
        <Text>
          <Text dimColor>{(i.from === 'you' ? 'yours' : 'org').padEnd(SOURCE_WIDTH)}</Text>
          <Text color={theme.warn}>{i.key}</Text>
          <Text dimColor> — {i.reason}</Text>
        </Text>,
      );
    }
    body.push(<Text> </Text>);
  }
  for (const line of JSON.stringify(masked, null, 2).split('\n')) {
    // a top-level key says where its value came from; everything else lines up under it
    const key = /^ {2}"([^"]+)":/.exec(line)?.[1];
    const from = key ? (layers?.sources[key] ?? 'default') : undefined;
    const locked = key !== undefined && layers?.locked.includes(key);
    body.push(
      <Text>
        {layers && (
          <Text color={locked ? theme.warn : from === 'default' ? theme.dim : undefined}>
            {(from ? `${SOURCE_LABEL[from]}${locked ? ' locked' : ''}` : '').padEnd(SOURCE_WIDTH)}
          </Text>
        )}
        <Text color={/^\s*"/.test(line) ? theme.header : undefined}>{line}</Text>
      </Text>,
    );
  }

  const showContexts = CONTEXT !== DEFAULT_CONTEXT || contexts.length > 1;
  const headerRows = 5 + (showContexts ? 1 : 0) + (layers?.org ? 1 : 0);
  // the app's own chrome above and below a view: the header, the frame, the tab line
  const rows = Math.max(3, ctx.size.rows - 8 - headerRows);
  const maxOffset = Math.max(0, body.length - rows);
  const start = Math.min(offset, maxOffset);

  useInput(
    (input, key) => {
      const move = (delta: number) => setOffset(Math.max(0, Math.min(maxOffset, start + delta)));
      if (input === 'e') {
        setPendingAction({ kind: 'edit-config', path });
        ctx.quit();
      }
      if (input === 'j' || key.downArrow) move(1);
      if (input === 'k' || key.upArrow) move(-1);
      if (key.pageDown || input === ' ') move(rows - 1);
      if (key.pageUp) move(-(rows - 1));
      if (input === 'g') setOffset(0);
      if (input === 'G') setOffset(maxOffset);
    },
    { isActive: !ctx.cmdOpen },
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          config
        </Text>
        <Text dimColor> {path}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        press <Text color={theme.key}>e</Text> to edit in $EDITOR — changes apply when colinear returns
        {maxOffset > 0 ? ` · j/k scroll · ${start}/${maxOffset}` : ''}
      </Text>
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          tracker{'  '}
        </Text>
        <Text color={theme.selection} bold>
          {provider.name}
        </Text>
        <Text dimColor>
          {' '}— scope: {provider.scopeLabel}
          {off.length ? ` · unsupported here: ${off.join(', ')}` : ' · all features supported'}
        </Text>
      </Text>
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          runtime{'  '}
        </Text>
        <Text color={theme.selection} bold>
          {agent.name}
        </Text>
        <Text dimColor>
          {' '}— models: {agent.models.join(', ')}
          {agentOff.length ? ` · unsupported here: ${agentOff.join(', ')}` : ' · all features supported'}
        </Text>
      </Text>
      {showContexts && (
        <Text wrap="truncate">
          <Text bold color={theme.header}>
            context{'  '}
          </Text>
          {contexts.map((name) => (
            <Text key={name} color={name === CONTEXT ? theme.selection : theme.dim} bold={name === CONTEXT}>
              {name === CONTEXT ? `[${name}] ` : `${name} `}
            </Text>
          ))}
          <Text dimColor>— coli --context NAME (own daemon, own state)</Text>
        </Text>
      )}
      {layers?.org && (
        <Text wrap="truncate">
          <Text bold color={theme.header}>
            org{'  '}
          </Text>
          <Text dimColor>
            {layers.locked.length ? `locked: ${layers.locked.join(', ')} · ` : ''}the org's defaults, under yours ·{' '}
          </Text>
          <Text>{layers.org}</Text>
        </Text>
      )}
      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {body.slice(start, start + rows).map((row, i) => (
          <Box key={start + i} flexShrink={0}>
            <Text wrap="truncate">{row}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const SOURCE_LABEL: Record<ConfigSource, string> = { default: 'default', org: 'org', you: 'yours', both: 'org+yours' };
const SOURCE_WIDTH = 17;

export const configKeys: Array<[string, string]> = [
  ['e', 'edit config'],
  ['j/k', 'scroll'],
];
