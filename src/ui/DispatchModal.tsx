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

  const optionRow = (label: string, field: Field, options: string[], activeIdx: number) => {
    // Options are values, not prose: a row wider than the modal used to wrap
    // mid-name, so "terraform-provider-materialize" arrived as two fragments on
    // two lines and the selection landed on a syllable. Show whole names and
    // scroll instead — the ‹ › say the rest are still there.
    const { start, end } = optionWindow(options, activeIdx, width - 14 - 4);
    return (
      <Box>
        <Text bold color={focus === field ? theme.accent : theme.dim}>
          {label.padEnd(14)}
        </Text>
        <Text dimColor>{start > 0 ? '‹' : ' '}</Text>
        {options.slice(start, end).map((opt, i) => (
          <Text
            key={opt}
            wrap="truncate"
            inverse={focus === field && start + i === activeIdx}
            color={start + i === activeIdx ? theme.selection : theme.dim}
            bold={start + i === activeIdx}
          >
            {` ${opt} `}
          </Text>
        ))}
        <Text dimColor>{end < options.length ? '›' : ' '}</Text>
      </Box>
    );
  };

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

/**
 * The widest run of whole options that fits, always containing the active one.
 *
 * Growing outward from the selection rather than from the left keeps the thing
 * you are choosing on screen no matter where in the list it sits — and every
 * name stays whole, which is the point: a truncated repo name is ambiguous
 * exactly when the repos are similarly named.
 */
export function optionWindow(
  options: string[],
  activeIdx: number,
  avail: number,
): { start: number; end: number } {
  if (!options.length) return { start: 0, end: 0 };
  const active = Math.max(0, Math.min(activeIdx, options.length - 1));
  const cost = (i: number) => options[i].length + 2; // the padding around each
  let start = active;
  let end = active + 1;
  let used = cost(active);
  // Alternate outward so the selection stays roughly centred. Each side is
  // re-tested against the *updated* width — testing both against the width
  // before either grew is how a window ends up one option too wide.
  for (;;) {
    let grew = false;
    if (end < options.length && used + cost(end) <= avail) {
      used += cost(end);
      end++;
      grew = true;
    }
    if (start > 0 && used + cost(start - 1) <= avail) {
      start--;
      used += cost(start);
      grew = true;
    }
    if (!grew) break;
  }
  return { start, end };
}
