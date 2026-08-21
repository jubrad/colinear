import { Box, Text } from 'ink';
import { spinner } from './format.js';
import { theme } from '../theme.js';

/**
 * What a drafting agent is doing, from submit to result.
 *
 * Creating an issue or a project runs a one-off agent for up to a minute, and
 * a toast at each end left the middle invisible: the prompt disappeared, then
 * something was "maybe created some time later". This stays on screen instead
 * — the agent's activity streaming while it works, and the outcome held until
 * dismissed, so success and failure both land somewhere the eye already is.
 */
export interface CreationState {
  /** what is being made — "new issue in CLO", "new project" */
  title: string;
  startedAt: number;
  /** the drafting session's activity lines, newest last */
  activity: string[];
  /** set when the run finished, either way */
  done?: { ok: boolean; summary: string; url?: string };
}

/** Append an activity line, capped so a chatty session can't grow the state unbounded. */
export function pushActivity(state: CreationState, line: string): CreationState {
  return { ...state, activity: [...state.activity.slice(-30), line] };
}

export function CreationProgress(props: { state: CreationState; width: number; lines: number; now: number }) {
  const { state, width, lines, now } = props;
  const tail = state.activity.slice(-lines);
  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={theme.accent} wrap="truncate">
        {state.title}
      </Text>
      {state.done ? (
        <Text color={state.done.ok ? theme.ok : theme.err} wrap="truncate">
          {state.done.summary}
        </Text>
      ) : (
        <Text color={theme.warn}>
          {spinner(now)} drafting — {Math.max(0, Math.round((now - state.startedAt) / 1000))}s
        </Text>
      )}
      <Box flexDirection="column" marginTop={1} height={lines} overflow="hidden">
        {tail.map((line, i) => (
          <Text key={`${i}-${line.slice(0, 8)}`} dimColor wrap="truncate">
            {line}
          </Text>
        ))}
        {!tail.length && <Text dimColor>…</Text>}
      </Box>
      <Text dimColor>
        {state.done ? `${state.done.url ? 'o: open · ' : ''}esc: close` : 'esc: hide — it keeps running, the toast still lands'}
      </Text>
    </Box>
  );
}

/** Popup height for a CreationProgress body with `lines` activity rows. */
export function creationHeight(lines: number): number {
  // title + status + gap + activity + footer, plus the border rows
  return lines + 6;
}
