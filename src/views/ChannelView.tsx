import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { channels } from '../core/channel.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';

/** `:chan` — list channels; `:chan CLO-67` — live tail + operator input. */
export function ChannelView(props: { param?: string }) {
  const ctx = useColinear();
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState('');

  // re-render on any channel activity
  useSyncExternalStore(
    (cb) => channels.subscribe(cb),
    () => channels.channels().length + (props.param ? channels.history(normalize(props.param)).length : 0),
  );

  const list = channels.channels();
  const name = props.param ? normalize(props.param) : undefined;

  useEffect(() => ctx.setCapture(Boolean(name)), [name]);
  useEffect(() => () => ctx.setCapture(false), []);

  // list mode keys
  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(list.length - 1, c + 1));
      if (key.return && list[cursor]) ctx.navigate('chan', list[cursor]);
    },
    { isActive: !name },
  );

  // tail mode: esc backs out (input owns the rest of the keyboard)
  useInput(
    (_input, key) => {
      if (key.escape) ctx.back();
    },
    { isActive: Boolean(name) },
  );

  if (!name) {
    if (!list.length) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No coordination channels yet.</Text>
          <Text dimColor>
            Enable with {'"coordination": true'} in config — family channels appear when sub-issue
            agents run. See COORDINATION.md (highly experimental).
          </Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text bold color={theme.accent}>
          channels
        </Text>
        {list.map((c, i) => (
          <Text key={c} inverse={i === cursor}>
            #{c} <Text dimColor>({channels.history(c).length} messages)</Text>
          </Text>
        ))}
      </Box>
    );
  }

  const history = channels.history(name);
  const rows = Math.max(4, ctx.size.rows - 12);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>
        #{name} <Text dimColor>— {history.length} messages · operator posts reach every agent</Text>
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {history.slice(-rows).map((m, i) => (
          <Text key={`${m.ts}-${i}`} wrap="truncate">
            <Text dimColor>{new Date(m.ts).toLocaleTimeString()} </Text>
            <Text color={m.kind === 'operator' ? theme.key : theme.accent} bold>
              {m.kind === 'operator' ? 'OPERATOR' : m.from}
            </Text>
            <Text>: {m.text}</Text>
          </Text>
        ))}
        {!history.length && <Text dimColor>(empty — agents post as they work)</Text>}
      </Box>
      <Box borderStyle="round" borderColor={theme.key} paddingX={1} flexShrink={0}>
        <Text color={theme.key} bold>
          {'> '}
        </Text>
        <TextInput
          value={draft}
          placeholder="message all agents on this channel (esc to leave)"
          onChange={setDraft}
          onSubmit={(value) => {
            const text = value.trim();
            if (!text) return;
            channels.post(name, 'operator', 'operator', text);
            setDraft('');
          }}
        />
      </Box>
    </Box>
  );
}

function normalize(param: string): string {
  return param.replace(/^#/, '').toUpperCase();
}

export const channelKeys: Array<[string, string]> = [
  ['enter', 'open / send'],
  ['esc', 'back'],
];
