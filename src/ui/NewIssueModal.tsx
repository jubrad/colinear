import { Box, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { Scope } from '../core/types.js';
import { ChoiceRow, FieldHeading, FormTitle, HelpArea, KeyHints, cycleKey, textFormPopup, type FormOption } from './Form.js';
import { TextArea } from './TextArea.js';

/** 0..4 is the tracker's own scale; absent lets the drafting agent read it off the request. */
const PRIORITIES: Array<FormOption & { value?: number }> = [
  { label: 'auto', help: 'the drafting agent sets one only if your request implies it' },
  { label: 'urgent', value: 1, help: 'filed as urgent, whatever the request says' },
  { label: 'high', value: 2, help: 'filed as high priority' },
  { label: 'medium', value: 3, help: 'filed as medium priority' },
  { label: 'low', value: 4, help: 'filed as low priority' },
  { label: 'none', value: 0, help: 'filed with no priority, on purpose' },
];

export interface NewIssue {
  /** absent: the drafting agent picks the team */
  scopeId?: string;
  /** for the progress line: a team key, or "auto" */
  scopeLabel: string;
  /** absent: the drafting agent judges it */
  priority?: number;
  request: string;
}

type Field = 'team' | 'priority' | 'request';

/**
 * Where the popup goes and how big it is. Bigger than the other forms: the
 * request is the whole point, and a paragraph about a bug wants room to be
 * written in rather than scrolled through three lines at a time.
 */
export function newIssuePopup(size: { columns: number; rows: number }, cmdOpen: boolean) {
  return textFormPopup(size, cmdOpen, 2, { maxWidth: 120, maxLines: 40 });
}

/**
 * `n` in :issues: which team it belongs to, how much it matters, and what it
 * is. Either of the first two can be left to the agent that drafts the issue —
 * `auto` — or set here, where a set answer is filed exactly as given. The
 * agent always writes the title and the description.
 *
 * It replaces a one-line prompt that filed into whatever team the list was
 * showing — and refused outright on "mine" or "all", which is where most
 * people are when an issue occurs to them.
 */
export function NewIssueModal(props: {
  teams: Scope[];
  /** the team the view is on — where the form starts; otherwise it starts on auto */
  teamKey?: string;
  width: number;
  textLines: number;
  compact?: boolean;
  onSubmit: (issue: NewIssue) => void;
  onCancel: () => void;
}) {
  const { teams, width, textLines, compact, onSubmit, onCancel } = props;
  // index 0 is auto, so the teams themselves start at 1
  const [teamIdx, setTeamIdx] = useState(() => teams.findIndex((t) => t.key === props.teamKey) + 1);
  const [priorityIdx, setPriorityIdx] = useState(0);
  const [request, setRequest] = useState('');
  // straight into the writing: both rows already have a sensible answer
  const [focus, setFocus] = useState<Field>('request');
  const fields: Field[] = ['team', 'priority', 'request'];

  const teamOptions = useMemo<FormOption[]>(
    () => [
      {
        label: 'auto',
        help:
          teams.length > 1
            ? `the drafting agent picks one of your ${teams.length} teams from what the request is about`
            : `files into ${teams[0]?.key ?? 'your team'}, the only one there is`,
      },
      ...teams.map((t) => ({ label: t.key, help: t.name && t.name !== t.key ? `files into ${t.name}` : `files into ${t.key}` })),
    ],
    [teams],
  );
  const team = teamIdx > 0 ? teams[teamIdx - 1] : undefined;

  const submit = () => {
    if (!request.trim()) return;
    // auto with a single team is that team; there is nothing to pick
    const chosen = team ?? (teams.length === 1 ? teams[0] : undefined);
    onSubmit({
      scopeId: chosen?.id,
      scopeLabel: chosen?.key ?? 'auto',
      priority: PRIORITIES[priorityIdx].value,
      request: request.trim(),
    });
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) {
      const at = fields.indexOf(focus);
      return setFocus(fields[(at + (key.shift ? fields.length - 1 : 1)) % fields.length]);
    }
    // the text area owns every other key, enter included
    if (focus === 'request') return;
    if (focus === 'team') {
      cycleKey(input, key, teamOptions.length, setTeamIdx);
      // a long list of teams is quicker by letter: jump to the next key starting
      // with it (h and l stay arrows; `a` reaches auto by way of the A teams)
      if (/^[a-z0-9]$/i.test(input) && input !== 'h' && input !== 'l') {
        const n = teamOptions.length;
        for (let step = 1; step <= n; step++) {
          const i = (teamIdx + step) % n;
          if (teamOptions[i].label.toLowerCase().startsWith(input.toLowerCase())) {
            setTeamIdx(i);
            break;
          }
        }
      }
    }
    if (focus === 'priority') cycleKey(input, key, PRIORITIES.length, setPriorityIdx);
    if (key.return) {
      // enter on a row moves on to the writing, which is the part that's missing
      if (!request.trim()) setFocus('request');
      else submit();
    }
  });

  const help =
    focus === 'team'
      ? teamOptions[teamIdx]?.help
      : focus === 'priority'
        ? PRIORITIES[priorityIdx].help
        : 'say what is wrong or what should exist, in as much detail as you have — an agent writes the title and the description, and files it';

  const gap = compact ? null : <Box height={1} />;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <FormTitle title="new issue" detail={team ? `in ${team.key}` : 'the agent picks the team'} />
      {gap}
      <ChoiceRow label="team" options={teamOptions} index={teamIdx} focused={focus === 'team'} width={width} />
      <ChoiceRow label="priority" options={PRIORITIES} index={priorityIdx} focused={focus === 'priority'} width={width} />
      <HelpArea text={help} width={width} lines={compact ? 1 : 2} />
      {gap}
      <FieldHeading label="request" focused={focus === 'request'} />
      <Box paddingLeft={2}>
        <TextArea
          value={request}
          onChange={setRequest}
          focus={focus === 'request'}
          width={width - 2}
          height={textLines}
          placeholder="e.g. the retry backoff never resets after a success, so a flaky sink slows down for good. Seen on the webhook sink since Tuesday's deploy; restarting the worker clears it."
          onSubmit={submit}
        />
      </Box>
      {gap}
      <KeyHints
        hints={
          focus === 'request'
            ? [['tab', 'next'], ['ctrl-d', 'create'], ['ctrl-u', 'clear'], ['esc', 'cancel']]
            : focus === 'team'
              ? [['tab', 'next'], ['←→', 'choose'], ['a-z', 'jump'], ['enter', 'write'], ['esc', 'cancel']]
              : [['tab', 'next'], ['←→', 'choose'], ['enter', 'write'], ['esc', 'cancel']]
        }
      />
    </Box>
  );
}
