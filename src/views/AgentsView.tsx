import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { AgentSession } from '../core/sessions.js';
import { useColinear } from '../ui/context.js';
import { cell, formatTokens, spinner } from '../ui/format.js';
import { theme } from '../theme.js';

const KIND_COLOR: Record<string, string> = {
  work: theme.accent,
  triage: theme.warn,
  maintenance: theme.ok,
  coordinator: theme.info,
  review: theme.accent,
  plan: theme.info,
  'draft-issue': theme.key,
  'draft-project': theme.key,
};

/**
 * Every agent the daemon is running, and what started it.
 *
 * Sessions belong to four different things — a task, a review, a plan, a
 * one-off draft — and each was only visible in its own view, if it had one at
 * all: drafting an issue showed a progress popup and then vanished, because
 * that session was tracked nowhere. This is the whole set, from the registry
 * `runSession` writes to.
 *
 * Read-only on purpose. What you can do to an agent depends on what it is
 * working on (`x` on a task, `x` on a review), so `enter` takes you to the
 * view that owns it rather than pretending one verb fits all of them.
 */
export function AgentsView(_props: { param?: string }) {
  const ctx = useColinear();
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => ctx.onAgents?.(setAgents), []);
  // the registry isn't CDC state — it changes on its own clock inside sessions
  // that never touch the store, so this view asks rather than subscribes
  useEffect(() => {
    ctx.dispatcher.listAgents();
    const timer = setInterval(() => ctx.dispatcher.listAgents(), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, agents.length - 1))), [agents.length]);
  const selected = agents[Math.min(cursor, agents.length - 1)];
  const running = useMemo(() => agents.filter((a) => a.status === 'running').length, [agents]);

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(agents.length - 1, c + 1));
    if (input === 'g') setCursor(0);
    if (input === 'G') setCursor(Math.max(0, agents.length - 1));
    if (key.return && selected) {
      // to whatever owns it; a draft has no home yet, which is why it needed
      // this view in the first place
      if (selected.kind === 'review') ctx.navigate('reviews', selected.label);
      else if (selected.kind === 'plan') ctx.navigate('plan', selected.label);
      else if (selected.kind.startsWith('draft')) ctx.toast('a draft has nothing to open yet', 'info');
      else ctx.navigate('task', selected.label);
    }
  });

  const width = ctx.size.columns - 4;
  const originWidth = Math.max(18, Math.floor((width - 14 - 20 - 9 - 9 - 8) * 0.4));
  const activityWidth = Math.max(16, width - 14 - 20 - 9 - 9 - 8 - originWidth);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box>
        <Text bold color={theme.header}>
          agents{' '}
        </Text>
        <Text dimColor>
          {running} running
          {agents.length - running > 0 ? ` · ${agents.length - running} just finished` : ''}
          {' · enter opens what it is working on'}
        </Text>
      </Box>
      <Box height={1} />
      <Text bold color={theme.header} wrap="truncate">
        {'  '}
        {cell('KIND', 14)}
        {cell('WORKING ON', 20)}
        {cell('STARTED BY', originWidth)}
        {cell('FOR', 9)}
        {cell('TOKENS', 9)}
        {cell('DOING', activityWidth)}
      </Text>
      {agents.map((agent, i) => {
        const onCursor = i === cursor;
        const live = agent.status === 'running';
        const seconds = Math.max(0, Math.round(((agent.endedAt ?? ctx.now) - agent.startedAt) / 1000));
        const forText = seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`;
        return (
          <Text key={agent.id} wrap="truncate" inverse={onCursor}>
            <Text color={onCursor ? undefined : live ? theme.warn : theme.dim}>{live ? `${spinner(ctx.now)} ` : '  '}</Text>
            <Text color={onCursor ? undefined : KIND_COLOR[agent.kind] ?? theme.dim}>{cell(agent.kind, 14)}</Text>
            <Text bold={live}>{cell(agent.label, 20)}</Text>
            <Text dimColor={!onCursor}>{cell(agent.origin, originWidth)}</Text>
            <Text dimColor={!onCursor}>{cell(forText, 9)}</Text>
            <Text dimColor={!onCursor}>{cell(formatTokens(agent.tokens), 9)}</Text>
            <Text
              color={
                onCursor ? undefined : agent.result ? (agent.result.ok ? theme.ok : theme.err) : undefined
              }
              dimColor={!onCursor && !agent.result}
            >
              {cell(agent.result?.summary ?? agent.activity ?? (live ? 'starting…' : 'finished'), activityWidth)}
            </Text>
          </Text>
        );
      })}
      {!agents.length && (
        <Text dimColor>
          Nothing running. Agents appear here the moment they start — dispatched work, reviews, plan
          sessions, and the drafts behind `n`.
        </Text>
      )}
      {selected?.sessionId && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor wrap="truncate">
            {selected.cwd}
          </Text>
          <Text dimColor wrap="truncate">
            claude --resume {selected.sessionId}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export const agentsKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'row'],
  ['enter', 'open what it is working on'],
];
