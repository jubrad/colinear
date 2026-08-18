import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { RepoConfig } from '../core/types.js';
import { theme } from '../theme.js';
import { TextArea } from './TextArea.js';

const MODEL_OPTIONS: Array<{ label: string; value?: string }> = [
  { label: 'default' },
  { label: 'sonnet', value: 'sonnet' },
  { label: 'opus', value: 'opus' },
  { label: 'fable', value: 'fable' },
  { label: 'haiku', value: 'haiku' },
];

export interface DispatchOptions {
  instructions?: string;
  model?: string;
  repo?: RepoConfig;
  /** go straight to the work pass — no triage session */
  skipTriage?: boolean;
  /** cut the worktree and stop: no agent until you say so */
  manual?: boolean;
}

type Field = 'model' | 'repo' | 'triage' | 'start' | 'instructions';

const TRIAGE_OPTIONS = ['triage first', 'skip triage'];
const START_OPTIONS = ['start now', 'manual — worktree only'];

/** Custom-dispatch modal: model tier, target repo, how it starts, instructions. */
export function DispatchModal(props: {
  count: number;
  repos: RepoConfig[];
  /** inner width of the popup, so the instructions area can use all of it */
  width: number;
  /** lines to give the instructions area */
  instructionLines: number;
  onSubmit: (opts: DispatchOptions) => void;
  onCancel: () => void;
}) {
  const { count, repos, width, instructionLines, onSubmit, onCancel } = props;
  const [instructions, setInstructions] = useState('');
  const [modelIdx, setModelIdx] = useState(0);
  const [repoIdx, setRepoIdx] = useState(0);
  const [triageIdx, setTriageIdx] = useState(0);
  const [startIdx, setStartIdx] = useState(0);
  // the options are the quick part; instructions are where you linger, so they
  // come last in tab order and last on screen
  const [focus, setFocus] = useState<Field>('model');

  const fields = useMemo<Field[]>(
    () =>
      repos.length > 1
        ? ['model', 'repo', 'triage', 'start', 'instructions']
        : ['model', 'triage', 'start', 'instructions'],
    [repos.length],
  );

  const submit = () =>
    onSubmit({
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
      repo: repos[repoIdx],
      skipTriage: triageIdx === 1,
      manual: startIdx === 1,
    });

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) return setFocus((f) => fields[(fields.indexOf(f) + 1) % fields.length]);
    // the text area owns every other key while it has focus — including enter,
    // which has to mean "newline" in a box you are writing a paragraph into
    if (focus === 'instructions') return;
    const cycle = (len: number, set: (fn: (i: number) => number) => void) => {
      if (key.leftArrow || input === 'h') set((i) => (i + len - 1) % len);
      if (key.rightArrow || input === 'l') set((i) => (i + 1) % len);
    };
    if (focus === 'model') cycle(MODEL_OPTIONS.length, setModelIdx);
    if (focus === 'repo') cycle(repos.length, setRepoIdx);
    if (focus === 'triage') cycle(TRIAGE_OPTIONS.length, setTriageIdx);
    if (focus === 'start') cycle(START_OPTIONS.length, setStartIdx);
    if (key.return) submit();
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

  const manual = startIdx === 1;
  return (
    // the frame and the opaque backdrop belong to Popup; this is the contents
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color={theme.key}>
        custom dispatch — {count} issue{count > 1 ? 's' : ''}
      </Text>
      {optionRow('model', 'model', MODEL_OPTIONS.map((m) => m.label), modelIdx)}
      {repos.length > 1 && optionRow('repo', 'repo', repos.map((r) => r.name), repoIdx)}
      {optionRow('triage', 'triage', TRIAGE_OPTIONS, triageIdx)}
      {optionRow('start', 'start', START_OPTIONS, startIdx)}
      {manual && (
        <Text dimColor>
          {'              '}worktree and branch only — <Text color={theme.key}>r</Text> starts the agent
        </Text>
      )}
      <Box marginTop={1}>
        <Text bold color={focus === 'instructions' ? theme.accent : theme.dim}>
          instructions
        </Text>
        {/* only while it's true: this hint and the footer's "enter: dispatch"
            used to be on screen together, contradicting each other */}
        <Text dimColor>{focus === 'instructions' ? ' — enter starts a new line' : ' — tab to write'}</Text>
      </Box>
      <TextArea
        value={instructions}
        onChange={setInstructions}
        focus={focus === 'instructions'}
        width={width}
        height={instructionLines}
        placeholder="optional guidance for the agents"
        onSubmit={submit}
      />
      <Text dimColor>
        {focus === 'instructions'
          ? 'tab: switch field · ctrl-d: dispatch · ctrl-u: clear · esc: cancel'
          : 'tab: switch field · ←→: pick · enter: dispatch · esc: cancel'}
      </Text>
    </Box>
  );
}
