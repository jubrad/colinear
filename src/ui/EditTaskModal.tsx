import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import type { RepoConfig, Task, TaskEdits } from '../core/types.js';

export type { TaskEdits };
import { theme } from '../theme.js';

/** follow the config default, or override it for this task alone */
const REBASE_OPTIONS = ['config default', 'auto-rebase', 'leave it'];
/** only meaningful on a parent tracking sub-issues */
const SUBS_OPTIONS = ['config default', 'auto-dispatch', 'leave them'];

const MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: 'default' },
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'fable', value: 'fable' },
  { label: 'haiku', value: 'haiku' },
];

type Field = 'repo' | 'pin' | 'instructions' | 'model' | 'triage' | 'rebase' | 'subs';

/** Edit a task's metadata; enter saves, ctrl+r saves and requeues. */
/** what the focused field actually does — the room a real dialog buys us */
const FIELD_HELP: Record<Field, string> = {
  repo: 'which repo the agent works in. Changing it re-dispatches: the worktree is cut fresh from that repo.',
  pin: 'the PR this task owns. Empty auto-matches by branch and identifier; set it when the guess is wrong.',
  instructions: 'passed to the triage and work prompts on top of your standing guidance. Outranks both.',
  model: 'model for this task, overriding the config default.',
  triage: 'what a requeue does: keep the plan you already have, redo triage, or go straight to the work pass.',
  rebase: "when GitHub reports the PR conflicting with its base, dispatch a rebase. One attempt per conflict, re-armed once it's mergeable again.",
  subs: 'when this parent gains a sub-issue nobody has started, dispatch it. Five per sweep, and they get triaged.',
};

export function EditTaskModal(props: {
  task: Task;
  repos: RepoConfig[];
  /** config values, so "config default" can say what it currently means */
  defaults?: { autoRebase?: boolean; autoDispatchSubs?: boolean; model?: string };
  width?: number;
  onSubmit: (edits: TaskEdits) => void;
  onCancel: () => void;
}) {
  const { task, repos, defaults, width = 80, onSubmit, onCancel } = props;
  const followsConfig = (on: boolean | undefined) => `config default (${on ? 'on' : 'off'})`;
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
  const [rebaseIdx, setRebaseIdx] = useState(task.autoRebase === undefined ? 0 : task.autoRebase ? 1 : 2);
  const [subsIdx, setSubsIdx] = useState(
    task.autoDispatchSubs === undefined ? 0 : task.autoDispatchSubs ? 1 : 2,
  );
  const [focus, setFocus] = useState<Field>('repo');

  const fields = useMemo<Field[]>(
    () => ['repo', 'pin', 'instructions', 'model', 'triage', 'rebase', 'subs'],
    [],
  );

  const submit = (requeue: boolean) => {
    // accepts "123", "#123", or a full PR URL (…/pull/123)
    const pinMatch = pin.trim().match(/(\d+)\/?\s*$/);
    const choice = triageOptions[triageIdx];
    onSubmit({
      repo: repos[repoIdx],
      pinnedPr: pinMatch ? Number.parseInt(pinMatch[1], 10) : undefined,
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
      autoRebase: rebaseIdx === 0 ? undefined : rebaseIdx === 1,
      autoDispatchSubs: subsIdx === 0 ? undefined : subsIdx === 1,
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
    if (focus === 'rebase') {
      cycle(REBASE_OPTIONS.length, setRebaseIdx);
      if (key.return) submit(false);
    }
    if (focus === 'subs') {
      cycle(SUBS_OPTIONS.length, setSubsIdx);
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
        {`${label} `.padEnd(15)}
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
      <Text bold color={theme.key} wrap="truncate">
        edit {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
      </Text>
      <Text> </Text>
      {optionRow('repo', 'repo', repos.map((r) => r.name), repoIdx)}
      {textRow('pinned PR', 'pin', pin, setPin, 'auto-match (number, #123, or PR URL to pin)')}
      {textRow('instructions', 'instructions', instructions, setInstructions, 'none')}
      {optionRow(
        'model',
        'model',
        MODEL_OPTIONS.map((m) => (m.value ? m.label : `default${defaults?.model ? ` (${defaults.model})` : ''}`)),
        modelIdx,
      )}
      {optionRow('on requeue', 'triage', triageOptions, triageIdx)}
      {optionRow('on conflict', 'rebase', [followsConfig(defaults?.autoRebase), ...REBASE_OPTIONS.slice(1)], rebaseIdx)}
      {optionRow('new sub-issues', 'subs', [followsConfig(defaults?.autoDispatchSubs), ...SUBS_OPTIONS.slice(1)], subsIdx)}
      <Text> </Text>
      {/* the focused field explains itself; a modal with room can afford it */}
      <Box height={2} overflow="hidden">
        <Text wrap="wrap">
          <Text color={theme.accent}>▸ </Text>
          <Text dimColor>{FIELD_HELP[focus].slice(0, Math.max(40, (width - 10) * 2))}</Text>
        </Text>
      </Box>
      <Text dimColor>
        tab: field · ←→: pick · enter: save · ctrl+r: save + requeue · esc: cancel
      </Text>
    </Box>
  );
}
