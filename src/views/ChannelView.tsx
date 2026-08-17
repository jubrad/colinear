import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import { channels, type ChannelMessage } from '../core/channel.js';
import { experimentOn } from '../core/config.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';

/**
 * `:chan` lists channels, `:chan CLO-67` tails one with an operator input.
 *
 * The agents posting here live in the daemon, so the messages arrive as file
 * writes rather than store deltas — this polls instead of subscribing. Posts
 * go the other way, through the daemon, so the log has one writer per process
 * boundary rather than two racing appenders.
 */
export function ChannelView(props: { param?: string }) {
  const ctx = useColinear();
  const enabled = experimentOn(ctx.cfg, 'coordination');
  const name = props.param ? normalize(props.param) : undefined;
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState('');
  const [list, setList] = useState<string[]>(() => channels.channels());
  const [history, setHistory] = useState<ChannelMessage[]>(() => (name ? channels.history(name) : []));

  // the daemon owns the writers; a 1s re-read is the whole sync mechanism
  useEffect(() => {
    const tick = () => {
      setList(channels.channels());
      setHistory(name ? channels.history(name) : []);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [name]);

  // the tail's text input owns the keyboard
  useEffect(() => ctx.setCapture(Boolean(name)), [name]);
  useEffect(() => () => ctx.setCapture(false), []);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(list.length - 1, c + 1));
      if (key.return && list[cursor]) ctx.navigate('chan', list[cursor]);
    },
    { isActive: !name && !ctx.cmdOpen },
  );

  useInput(
    (_input, key) => {
      if (key.escape) ctx.back();
    },
    { isActive: Boolean(name) },
  );

  if (!name) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={theme.accent}>
          channels <Text dimColor>— experimental · one per issue family</Text>
        </Text>
        {!enabled && <DisabledNote />}
        {list.length ? (
          list.map((c, i) => (
            <Text key={c} inverse={i === cursor}>
              #{c}{' '}
              <Text dimColor>
                ({channels.history(c).length} messages · {c.startsWith('proj-') ? 'project' : 'issue family'})
              </Text>
            </Text>
          ))
        ) : (
          <Text dimColor>
            {enabled
              ? 'No channels yet — one appears when a sub-issue family starts working.'
              : ' '}
          </Text>
        )}
      </Box>
    );
  }

  // view pane inner height is rows-8; title 1 + input box 3 is the chrome
  const rows = Math.max(3, ctx.size.rows - 8 - (ctx.cmdOpen ? 4 : 0) - 4);
  const visible = history.slice(-rows);
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent} wrap="truncate">
        #{name}{' '}
        <Text dimColor>
          — {history.length} messages
          {enabled ? ' · your message reaches every agent in this family at its next read' : ''}
        </Text>
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visible.map((m, i) => (
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
      {/* posting into a channel no agent is reading is worse than not being
          able to: the history is still worth keeping visible */}
      {!enabled ? (
        <Box borderStyle="round" borderColor={theme.dim} paddingX={1} flexShrink={0}>
          <Text dimColor>
            coordination is off — nothing is reading this channel (
            <Text color={theme.warn}>experimental</Text> + <Text color={theme.warn}>experiments.coordination</Text>)
          </Text>
        </Box>
      ) : (
      <Box borderStyle="round" borderColor={theme.key} paddingX={1} flexShrink={0}>
        <Text color={theme.key} bold>
          {'> '}
        </Text>
        <TextInput
          value={draft}
          placeholder="message every agent on this channel (esc to leave)"
          onChange={setDraft}
          onSubmit={(value) => {
            const text = value.trim();
            if (!text) return;
            ctx.dispatcher.channelPost(name, text);
            setDraft('');
          }}
        />
      </Box>
      )}
    </Box>
  );
}

function DisabledNote() {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.warn}>Coordination channels are off.</Text>
      <Text dimColor>Both switches have to be on, in {'~/.config/colinear/config.json'}:</Text>
      <Text color={theme.header}>{'  "experimental": true,'}</Text>
      <Text color={theme.header}>{'  "experiments": { "coordination": true }'}</Text>
      <Text dimColor>Then restart the backend: coli daemon stop &amp;&amp; coli. See COORDINATION.md.</Text>
    </Box>
  );
}

/**
 * Channel names are file names, so case matters. Issue families are upper
 * (`CLO-67`) and project channels are slugs (`proj-cloud-migration`) — match
 * an existing channel case-insensitively before assuming either.
 */
function normalize(param: string): string {
  const raw = param.replace(/^#/, '');
  const existing = channels.channels().find((c) => c.toLowerCase() === raw.toLowerCase());
  if (existing) return existing;
  return /^[a-z]+-\d+$/i.test(raw) ? raw.toUpperCase() : raw;
}

export const channelKeys: Array<[string, string]> = [
  ['enter', 'open / send'],
  ['j/k', 'move'],
  ['esc', 'back'],
];
