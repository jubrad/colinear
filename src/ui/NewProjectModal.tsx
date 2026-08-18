import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { Scope } from '../core/types.js';
import { theme } from '../theme.js';
import { TextArea } from './TextArea.js';

/** Linear's own vocabulary; a tracker without these ignores the field. */
const STATES = ['planned', 'started', 'paused'];
const PRIORITIES: Array<{ label: string; value?: number }> = [
  { label: 'none' },
  { label: 'urgent', value: 1 },
  { label: 'high', value: 2 },
  { label: 'medium', value: 3 },
  { label: 'low', value: 4 },
];

export interface NewProject {
  scopeIds: string[];
  state: string;
  priority?: number;
  request: string;
}

type Field = 'scope' | 'state' | 'priority' | 'brief';

/**
 * The template for a new project: where it lives, how it starts, how much it
 * matters, and what it is. An agent turns the last one into a name, a summary
 * and a brief — so this form asks for the facts a model should not be guessing,
 * and leaves the writing to it.
 */
export function NewProjectModal(props: {
  scopes: Scope[];
  /** the scope the view is currently on, if any */
  scopeKey?: string;
  width: number;
  briefLines: number;
  onSubmit: (project: NewProject) => void;
  onCancel: () => void;
}) {
  const { scopes, scopeKey, width, briefLines, onSubmit, onCancel } = props;
  const [scopeIdx, setScopeIdx] = useState(() => {
    const found = scopes.findIndex((s) => s.key === scopeKey);
    return found >= 0 ? found : 0;
  });
  const [stateIdx, setStateIdx] = useState(0);
  const [priorityIdx, setPriorityIdx] = useState(0);
  const [request, setRequest] = useState('');
  const [focus, setFocus] = useState<Field>(scopes.length > 1 ? 'scope' : 'state');

  const fields = useMemo<Field[]>(
    () => (scopes.length > 1 ? ['scope', 'state', 'priority', 'brief'] : ['state', 'priority', 'brief']),
    [scopes.length],
  );

  const scope = scopes[scopeIdx];
  const submit = () => {
    if (!request.trim() || !scope) return;
    onSubmit({
      scopeIds: [scope.id],
      state: STATES[stateIdx],
      priority: PRIORITIES[priorityIdx].value,
      request: request.trim(),
    });
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) return setFocus((f) => fields[(fields.indexOf(f) + 1) % fields.length]);
    // the brief owns every other key, enter included
    if (focus === 'brief') return;
    const cycle = (len: number, set: (fn: (i: number) => number) => void) => {
      if (key.leftArrow || input === 'h') set((i) => (i + len - 1) % len);
      if (key.rightArrow || input === 'l') set((i) => (i + 1) % len);
    };
    if (focus === 'scope') cycle(scopes.length, setScopeIdx);
    if (focus === 'state') cycle(STATES.length, setStateIdx);
    if (focus === 'priority') cycle(PRIORITIES.length, setPriorityIdx);
    if (key.return) submit();
  });

  const optionRow = (label: string, field: Field, options: string[], activeIdx: number) => (
    <Box>
      <Text bold color={focus === field ? theme.accent : theme.dim}>
        {label.padEnd(12)}
      </Text>
      {options.map((opt, i) => (
        <Text
          key={opt}
          inverse={focus === field && i === activeIdx}
          color={i === activeIdx ? theme.selection : theme.dim}
          bold={i === activeIdx}
        >
          {` ${opt} `}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color={theme.key}>
        new project
      </Text>
      {scopes.length > 1 && optionRow('team', 'scope', scopes.map((s) => s.key), scopeIdx)}
      {scopes.length === 1 && (
        <Box>
          <Text bold color={theme.dim}>
            {'team'.padEnd(12)}
          </Text>
          <Text color={theme.selection}>{scopes[0]?.key ?? '—'}</Text>
        </Box>
      )}
      {optionRow('state', 'state', STATES, stateIdx)}
      {optionRow('priority', 'priority', PRIORITIES.map((p) => p.label), priorityIdx)}
      <Box marginTop={1}>
        <Text bold color={focus === 'brief' ? theme.accent : theme.dim}>
          brief
        </Text>
        <Text dimColor>
          {focus === 'brief'
            ? ' — enter starts a new line; an agent writes the name and the body'
            : ' — tab to write'}
        </Text>
      </Box>
      <TextArea
        value={request}
        onChange={setRequest}
        focus={focus === 'brief'}
        width={width}
        height={briefLines}
        placeholder="what should exist that doesn't, and why now"
        onSubmit={submit}
      />
      <Text dimColor>
        {focus === 'brief'
          ? 'tab: switch field · ctrl-d: create · ctrl-u: clear · esc: cancel'
          : 'tab: switch field · ←→: pick · enter: create · esc: cancel'}
      </Text>
    </Box>
  );
}
