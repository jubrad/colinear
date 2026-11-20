import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { parseSlug } from '../core/repoimport.js';
import type { RepoConfig } from '../core/types.js';
import { theme } from '../theme.js';
import { TextArea } from './TextArea.js';

/**
 * The picker's options: whatever the runtime offers, with "default" first for
 * "whatever the config says". The list is the runtime's rather than a constant
 * here, so a different runtime offers its own models instead of Claude's.
 */
export function modelOptions(models: string[]): Array<{ label: string; value?: string }> {
  return [{ label: 'default' }, ...models.map((label) => ({ label, value: label }))];
}

export interface DispatchOptions {
  instructions?: string;
  model?: string;
  /** unset means "let triage choose" — see AUTO_REPO */
  repo?: RepoConfig;
  /** go straight to the work pass — no triage session */
  skipTriage?: boolean;
  /** cut the worktree and stop: no agent until you say so */
  manual?: boolean;
  /** owner/repo to clone and add to the config first — "clone from GitHub" on the repo row */
  importRepo?: string;
}

type Field = 'model' | 'repo' | 'slug' | 'triage' | 'start' | 'instructions';

/**
 * The repo row's last choice: a repo you have not cloned. The line under the
 * options becomes an input for `owner/repo`, and dispatching clones it next
 * to the others, adds it to the config, and starts the work there.
 */
const CLONE_REPO = '+ clone from GitHub…';

/**
 * Letting triage pick the repository.
 *
 * Triage already reads the allowlist's descriptions and names the repo the
 * work belongs in — it is how a mis-routed task gets moved today. What was
 * missing was a way to say up front that you do not know, so the field forced
 * a guess, and a guess is wrong often enough on a set of sub-issues spread
 * across repositories.
 *
 * First in the list and selected by default, because "I don't know" is the
 * honest starting point for the case this exists for.
 */
const AUTO_REPO = 'auto — triage picks';

/** The label gutter every row shares, so the rows line up and the hint can too. */
const LABEL_WIDTH = 14;

const TRIAGE_OPTIONS = ['triage first', 'skip triage'];
const START_OPTIONS = ['start now', 'manual — worktree only'];

/** Custom-dispatch modal: model tier, target repo, how it starts, instructions. */
export function DispatchModal(props: {
  /** models the configured runtime offers */
  models: string[];
  count: number;
  repos: RepoConfig[];
  /** inner width of the popup, so the instructions area can use all of it */
  width: number;
  /** lines to give the instructions area */
  instructionLines: number;
  /**
   * Open on "skip triage" — `D` with several repos, which cannot skip triage
   * without one named. The form starts on the first repo so `enter` goes.
   */
  skipTriage?: boolean;
  onSubmit: (opts: DispatchOptions) => void;
  onCancel: () => void;
}) {
  const { count, repos, width, instructionLines, models, onSubmit, onCancel } = props;
  const modelChoices = modelOptions(models);
  const [instructions, setInstructions] = useState('');
  const [modelIdx, setModelIdx] = useState(0);
  const [repoIdx, setRepoIdx] = useState(props.skipTriage && repos.length > 1 ? 1 : 0);
  const [triageIdx, setTriageIdx] = useState(props.skipTriage ? 1 : 0);
  const [startIdx, setStartIdx] = useState(0);
  const [slug, setSlug] = useState('');
  const [slugError, setSlugError] = useState(false);
  // the options are the quick part; instructions are where you linger, so they
  // come last in tab order and last on screen
  const [focus, setFocus] = useState<Field>(props.skipTriage && repos.length > 1 ? 'repo' : 'model');

  // auto first when there is a choice to leave to triage; clone always last
  const multi = repos.length > 1;
  const repoChoices = [...(multi ? [AUTO_REPO] : []), ...repos.map((r) => r.name), CLONE_REPO];
  const auto = multi && repoIdx === 0;
  const cloning = repoIdx === repoChoices.length - 1;
  const chosenRepo = auto || cloning ? undefined : repos[repoIdx - (multi ? 1 : 0)];

  const fields = useMemo<Field[]>(
    () => ['model', 'repo', ...(cloning ? (['slug'] as Field[]) : []), 'triage', 'start', 'instructions'],
    [cloning],
  );

  const submit = () => {
    const importRepo = cloning ? parseSlug(slug) : undefined;
    if (cloning && !importRepo) {
      setSlugError(true);
      setFocus('slug');
      return;
    }
    onSubmit({
      instructions: instructions.trim() || undefined,
      model: modelChoices[modelIdx].value,
      repo: chosenRepo,
      importRepo,
      // the two rows keep each other consistent (see the repo and triage
      // keys), so a skip here always comes with a repo named
      skipTriage: triageIdx === 1 && !auto,
      manual: startIdx === 1,
    });
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) return setFocus((f) => fields[(fields.indexOf(f) + 1) % fields.length]);
    // the text area owns every other key while it has focus — including enter,
    // which has to mean "newline" in a box you are writing a paragraph into
    if (focus === 'instructions') return;
    // the repo to clone is typed; enter there dispatches, through the text area
    if (focus === 'slug') return;
    const cycle = (len: number, set: (fn: (i: number) => number) => void) => {
      if (key.leftArrow || input === 'j') set((i) => (i + len - 1) % len);
      if (key.rightArrow || input === 'l') set((i) => (i + 1) % len);
    };
    if (focus === 'model') cycle(modelChoices.length, setModelIdx);
    // Triage is what picks the repo, so "auto" and "skip triage" cannot both
    // stand. Rather than hide one until the other is changed — which read as
    // custom dispatch being unable to skip triage at all — choosing either
    // moves the other: skipping triage on auto names the first repo, and auto
    // on a skipped triage turns triage back on. The hint row says which.
    const step = (len: number, at: number) =>
      key.leftArrow || input === 'j' ? (at + len - 1) % len : key.rightArrow || input === 'l' ? (at + 1) % len : at;
    if (focus === 'repo') {
      const next = step(repoChoices.length, repoIdx);
      setRepoIdx(next);
      if (multi && next === 0 && triageIdx === 1) setTriageIdx(0);
    }
    if (focus === 'triage') {
      const next = step(TRIAGE_OPTIONS.length, triageIdx);
      setTriageIdx(next);
      if (next === 1 && auto) setRepoIdx(1);
    }
    if (focus === 'start') cycle(START_OPTIONS.length, setStartIdx);
    if (key.return) submit();
  });

  const optionRow = (label: string, field: Field, options: string[], activeIdx: number) => {
    const active = Math.max(0, Math.min(activeIdx, options.length - 1));
    const avail = width - LABEL_WIDTH - 4;
    const fits = options.reduce((n, o) => n + o.length + 2, 0) <= avail;
    // Two shapes, because one never suited both. A pair like "triage first /
    // skip triage" wants to show both — you are comparing them. Nine repository
    // names do not fit on any row, and a window that scrolled them moved the
    // list under the cursor and wrapped names mid-word. So past the point where
    // they all fit, the row shows the one you have chosen and says where you
    // are in the list. Either way the row is exactly one line, which is what
    // stops the form's height changing as you arrow along it.
    const shown = fits ? options : [options[active]];
    return (
      <Box>
        <Text bold color={focus === field ? theme.accent : theme.dim}>
          {label.padEnd(LABEL_WIDTH)}
        </Text>
        <Text dimColor>{fits ? ' ' : '‹'}</Text>
        {shown.map((opt, i) => {
          const idx = fits ? i : active;
          return (
            <Text
              key={`${opt}-${idx}`}
              wrap="truncate"
              inverse={focus === field && idx === active}
              color={idx === active ? theme.selection : theme.dim}
              bold={idx === active}
            >
              {` ${opt} `}
            </Text>
          );
        })}
        <Text dimColor>{fits ? ' ' : '›'}</Text>
        {!fits && (
          <Text dimColor>
            {'  '}
            {active + 1}/{options.length}
          </Text>
        )}
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
      {optionRow('model', 'model', modelChoices.map((m) => m.label), modelIdx)}
      {optionRow('repo', 'repo', repoChoices, repoIdx)}
      {optionRow('triage', 'triage', TRIAGE_OPTIONS, triageIdx)}
      {optionRow('start', 'start', START_OPTIONS, startIdx)}
      {/*
        Always a row, never sometimes a row. It used to appear only while
        "manual" was selected, so arrowing along that field grew and shrank the
        form inside a popup whose height was already fixed — which is what made
        the spacing jump.
      */}
      {cloning ? (
        <Box>
          <Text bold color={focus === 'slug' ? theme.accent : slugError ? theme.err : theme.dim}>
            {(slugError ? 'owner/repo?' : 'clone').padEnd(LABEL_WIDTH)}
          </Text>
          <TextArea
            value={slug}
            onChange={(v) => {
              setSlug(v);
              setSlugError(false);
            }}
            focus={focus === 'slug'}
            width={Math.max(10, width - LABEL_WIDTH)}
            height={1}
            submitOnEnter
            onSubmit={submit}
            placeholder="owner/repo or a GitHub URL — tab to type it"
          />
        </Box>
      ) : (
      <Text dimColor wrap="truncate">
        {' '.repeat(LABEL_WIDTH)}
        {manual ? (
          <Text>
            worktree and branch only — <Text color={theme.key}>r</Text> starts the agent
          </Text>
        ) : auto ? (
          <Text>triage reads the repo descriptions and routes each issue</Text>
        ) : triageIdx === 1 && chosenRepo ? (
          <Text>
            no triage — straight to work in <Text color={theme.key}>{chosenRepo.name}</Text>
            {multi ? ' (repo: ←→ to change)' : ''}
          </Text>
        ) : (
          <Text> </Text>
        )}
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
