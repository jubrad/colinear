import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import type { RepoConfig, Task, TaskEdits } from '../core/types.js';

export type { TaskEdits };
import { theme } from '../theme.js';

const MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: 'default' },
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'fable', value: 'fable' },
  { label: 'haiku', value: 'haiku' },
];

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
  // with a plan: keep it, redo it, or drop it and go straight to work;
  // without one: triage as usual, or skip straight to work
  const triageOptions = hasTriage ? ['keep plan', 'fresh triage', 'skip triage'] : ['triage', 'skip triage'];

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
  const [triageIdx, setTriageIdx] = useState(!hasTriage && task.skipTriage ? 1 : 0);
  const [focus, setFocus] = useState<Field>('repo');

  const fields = useMemo<Field[]>(() => ['repo', 'pin', 'instructions', 'model', 'triage'], []);

  const submit = (requeue: boolean) => {
    // accepts "123", "#123", or a full PR URL (…/pull/123)
    const pinMatch = pin.trim().match(/(\d+)\/?\s*$/);
    const choice = triageOptions[triageIdx];
    onSubmit({
      repo: repos[repoIdx],
      pinnedPr: pinMatch ? Number.parseInt(pinMatch[1], 10) : undefined,
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
      retriage: choice !== 'keep plan',
      // keep plan leaves the stored flag alone (dispatcher derives it)
      skipTriage: choice === 'keep plan' ? undefined : choice === 'skip triage',
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
      cycle(triageOptions.length, setTriageIdx);
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
    // flexShrink 0: when vertical space is tight, yoga must squeeze the board
    // behind us, never the modal's own rows
    <Box flexDirection="column" flexShrink={0} borderStyle="double" borderColor={theme.key} paddingX={2}>
      <Text bold color={theme.key}>
        edit {task.issue.identifier}
      </Text>
      {optionRow('repo', 'repo', repos.map((r) => r.name), repoIdx)}
      {textRow('pinned PR', 'pin', pin, setPin, 'auto-match (number, #123, or PR URL to pin)')}
      {textRow('instructions', 'instructions', instructions, setInstructions, 'none')}
      {optionRow('model', 'model', MODEL_OPTIONS.map((m) => m.label), modelIdx)}
      {optionRow('on requeue', 'triage', triageOptions, triageIdx)}
      <Text dimColor>
        tab: field · ←→: pick · enter: save · ctrl+r: save + requeue{' '}
        {task.repo ? `(repo change implies requeue)` : ''}
      </Text>
    </Box>
  );
}
