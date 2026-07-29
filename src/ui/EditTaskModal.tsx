import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import type { RepoConfig, Task } from '../core/types.js';
import { theme } from '../theme.js';

const MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: 'default' },
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'haiku', value: 'haiku' },
];

const TRIAGE_OPTIONS = ['keep plan', 'fresh triage'];

export interface TaskEdits {
  repo: RepoConfig;
  /** undefined = auto-match, number = pinned */
  pinnedPr?: number;
  instructions?: string;
  model?: string;
  retriage: boolean;
  /** true when the operator asked to requeue (ctrl+r) */
  requeue: boolean;
}

type Field = 'repo' | 'pin' | 'instructions' | 'model' | 'triage';

/** Edit a task's metadata; enter saves, ctrl+r saves and requeues. */
export function EditTaskModal(props: {
  task: Task;
  repos: RepoConfig[];
  onSubmit: (edits: TaskEdits) => void;
  onCancel: () => void;
}) {
  const { task, repos, onSubmit, onCancel } = props;
  const hasTriage = task.verdict?.verdict === 'do';

  const [repoIdx, setRepoIdx] = useState(() => {
    const idx = repos.findIndex((r) => r.name === task.repo?.name);
    return idx === -1 ? 0 : idx;
  });
  const [pin, setPin] = useState(task.pinnedPr ? String(task.pinnedPr) : '');
  const [instructions, setInstructions] = useState(task.instructions ?? '');
  const [modelIdx, setModelIdx] = useState(() => {
    const idx = MODEL_OPTIONS.findIndex((m) => m.value === task.model);
    return idx === -1 ? 0 : idx;
  });
  const [triageIdx, setTriageIdx] = useState(hasTriage ? 0 : 1);
  const [focus, setFocus] = useState<Field>('repo');

  const fields = useMemo<Field[]>(() => {
    const f: Field[] = ['repo', 'pin', 'instructions', 'model'];
    if (hasTriage) f.push('triage');
    return f;
  }, [hasTriage]);

  const submit = (requeue: boolean) => {
    const pinNum = Number.parseInt(pin.trim(), 10);
    onSubmit({
      repo: repos[repoIdx],
      pinnedPr: Number.isNaN(pinNum) ? undefined : pinNum,
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
      retriage: !hasTriage || triageIdx === 1,
      requeue,
    });
  };

  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.tab) setFocus((f) => fields[(fields.indexOf(f) + 1) % fields.length]);
    if (key.ctrl && input === 'r') submit(true);
    const cycle = (len: number, set: (fn: (i: number) => number) => void) => {
      if (key.leftArrow || input === 'h') set((i) => (i + len - 1) % len);
      if (key.rightArrow || input === 'l') set((i) => (i + 1) % len);
    };
    if (focus === 'repo') {
      cycle(repos.length, setRepoIdx);
      if (key.return) submit(false);
    }
    if (focus === 'model') {
      cycle(MODEL_OPTIONS.length, setModelIdx);
      if (key.return) submit(false);
    }
    if (focus === 'triage') {
      cycle(TRIAGE_OPTIONS.length, setTriageIdx);
      if (key.return) submit(false);
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

  const textRow = (
    label: string,
    field: Field,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <Box>
      <Text bold color={focus === field ? theme.accent : theme.dim}>
        {label.padEnd(14)}
      </Text>
      <TextInput
        focus={focus === field}
        value={value}
        placeholder={placeholder}
        onChange={onChange}
        onSubmit={() => submit(false)}
      />
    </Box>
  );

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.key} paddingX={2}>
      <Text bold color={theme.key}>
        edit {task.issue.identifier}
      </Text>
      {optionRow('repo', 'repo', repos.map((r) => r.name), repoIdx)}
      {textRow('pinned PR', 'pin', pin, setPin, 'auto-match (set a number to pin)')}
      {textRow('instructions', 'instructions', instructions, setInstructions, 'none')}
      {optionRow('model', 'model', MODEL_OPTIONS.map((m) => m.label), modelIdx)}
      {hasTriage && optionRow('on requeue', 'triage', TRIAGE_OPTIONS, triageIdx)}
      <Text dimColor>
        tab: field · ←→: pick · enter: save · ctrl+r: save + requeue{' '}
        {task.repo ? `(repo change implies requeue)` : ''}
      </Text>
    </Box>
  );
}
