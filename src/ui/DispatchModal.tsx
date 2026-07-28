import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import type { RepoConfig } from '../core/types.js';
import { theme } from '../theme.js';

const MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: 'default' },
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'haiku', value: 'haiku' },
];

export interface DispatchOptions {
  instructions?: string;
  model?: string;
  repo?: RepoConfig;
  /** go straight to the work pass — no triage session */
  skipTriage?: boolean;
}

type Field = 'instructions' | 'model' | 'repo' | 'triage';

const TRIAGE_OPTIONS = ['triage first', 'skip triage'];

/** Custom-dispatch modal: instructions + model tier + target repo. */
export function DispatchModal(props: {
  count: number;
  repos: RepoConfig[];
  onSubmit: (opts: DispatchOptions) => void;
  onCancel: () => void;
}) {
  const { count, repos, onSubmit, onCancel } = props;
  const [instructions, setInstructions] = useState('');
  const [modelIdx, setModelIdx] = useState(0);
  const [repoIdx, setRepoIdx] = useState(0);
  const [triageIdx, setTriageIdx] = useState(0);
  const [focus, setFocus] = useState<Field>('instructions');

  const fields = useMemo<Field[]>(
    () =>
      repos.length > 1
        ? ['instructions', 'model', 'repo', 'triage']
        : ['instructions', 'model', 'triage'],
    [repos.length],
  );

  const submit = () =>
    onSubmit({
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
      repo: repos[repoIdx],
      skipTriage: triageIdx === 1,
    });

  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.tab) setFocus((f) => fields[(fields.indexOf(f) + 1) % fields.length]);
    const cycle = (len: number, set: (fn: (i: number) => number) => void) => {
      if (key.leftArrow || input === 'h') set((i) => (i + len - 1) % len);
      if (key.rightArrow || input === 'l') set((i) => (i + 1) % len);
    };
    if (focus === 'model') {
      cycle(MODEL_OPTIONS.length, setModelIdx);
      if (key.return) submit();
    }
    if (focus === 'repo') {
      cycle(repos.length, setRepoIdx);
      if (key.return) submit();
    }
    if (focus === 'triage') {
      cycle(TRIAGE_OPTIONS.length, setTriageIdx);
      if (key.return) submit();
    }
  });

  const optionRow = (label: string, field: Field, options: string[], activeIdx: number) => (
    <Box>
      <Text bold color={focus === field ? theme.accent : theme.dim}>
        {label.padEnd(14)}
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
    <Box flexDirection="column" borderStyle="double" borderColor={theme.key} paddingX={2}>
      <Text bold color={theme.key}>
        custom dispatch — {count} issue{count > 1 ? 's' : ''}
      </Text>
      <Box>
        <Text bold color={focus === 'instructions' ? theme.accent : theme.dim}>
          {'instructions  '}
        </Text>
        <TextInput
          focus={focus === 'instructions'}
          value={instructions}
          placeholder="optional guidance for the agents"
          onChange={setInstructions}
          onSubmit={submit}
        />
      </Box>
      {optionRow('model', 'model', MODEL_OPTIONS.map((m) => m.label), modelIdx)}
      {repos.length > 1 && optionRow('repo', 'repo', repos.map((r) => r.name), repoIdx)}
      {optionRow('triage', 'triage', TRIAGE_OPTIONS, triageIdx)}
      <Text dimColor>tab: switch field · ←→: pick · enter: dispatch · esc: cancel</Text>
    </Box>
  );
}
