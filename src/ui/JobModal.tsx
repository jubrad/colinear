import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { nextRun } from '../core/jobs.js';
import { JOB_ACTIONS, type Job, type JobAction } from '../core/types.js';
import { modelOptions } from './DispatchModal.js';
import { ChoiceRow, FieldHeading, FormTitle, HelpArea, KeyHints, LABEL_WIDTH } from './Form.js';
import { TextArea } from './TextArea.js';

/** What the form hands back: the job's editable fields. */
export type JobFields = Pick<Job, 'name' | 'prompt' | 'schedule' | 'model' | 'actions' | 'userSettings' | 'permissionMode' | 'deny'>;

const PERMISSION_MODES = ['auto', 'acceptEdits', 'default', 'plan', 'dontAsk'];

const ACTION_HELP: Record<JobAction, string> = {
  review: "review_pr: run colinear's pre-review of a PR and read its findings. Reads only — nothing is posted.",
  approve: 'approve_pr: submit an approval through colinear. Refused unless its review finished with no findings asking for a change.',
  comment: "comment_pr: post a review's findings to the PR as comments, through colinear.",
};

type Field = 'name' | 'prompt' | 'schedule' | 'model' | JobAction | 'user' | 'mode' | 'deny';
const FIELDS: Field[] = ['name', 'prompt', 'schedule', 'model', ...JOB_ACTIONS, 'user', 'mode', 'deny'];
const TEXT: Field[] = ['name', 'prompt', 'schedule', 'deny'];

/** Rows the form takes inside its popup border, prompt lines aside. */
export const JOB_FORM_ROWS = 16;

/**
 * A job's whole definition in one popup: what to do, when, on what model, and
 * what it may do. Every action starts off — a new job can read and report and
 * nothing else until you grant more, row by row.
 */
export function JobModal(props: {
  job?: Job;
  models: string[];
  /** what "default" resolves to */
  configured?: string;
  configuredMode: string;
  width: number;
  promptLines: number;
  onSubmit: (fields: JobFields) => void;
  onCancel: () => void;
}) {
  const { job, width } = props;
  const models = modelOptions(job?.model && !props.models.includes(job.model) ? [...props.models, job.model] : props.models);
  const [name, setName] = useState(job?.name ?? '');
  const [prompt, setPrompt] = useState(job?.prompt ?? '');
  const [schedule, setSchedule] = useState(job?.schedule ?? '');
  const [modelIdx, setModelIdx] = useState(Math.max(0, models.findIndex((m) => m.value === job?.model)));
  const [actions, setActions] = useState<Set<JobAction>>(new Set(job?.actions ?? []));
  const [user, setUser] = useState(Boolean(job?.userSettings));
  const modes = [`config (${props.configuredMode})`, ...PERMISSION_MODES];
  const [modeIdx, setModeIdx] = useState(job?.permissionMode ? Math.max(0, PERMISSION_MODES.indexOf(job.permissionMode) + 1) : 0);
  const [deny, setDeny] = useState((job?.deny ?? []).join(', '));
  const [focus, setFocus] = useState<Field>('name');
  const [error, setError] = useState<string>();

  const when = schedule.trim() ? nextRun(schedule) : undefined;

  const submit = () => {
    if (!name.trim()) return setError('give it a name');
    if (!prompt.trim()) return setError('say what it should do');
    if (when?.error) return setError(`schedule: ${when.error}`);
    props.onSubmit({
      name: name.trim(),
      prompt: prompt.trim(),
      schedule: schedule.trim() || undefined,
      model: models[modelIdx].value,
      actions: JOB_ACTIONS.filter((a) => actions.has(a)),
      userSettings: user || undefined,
      permissionMode: modeIdx ? PERMISSION_MODES[modeIdx - 1] : undefined,
      deny: deny.split(',').map((d) => d.trim()).filter(Boolean),
    });
  };

  const move = (by: number) => setFocus((f) => FIELDS[(FIELDS.indexOf(f) + by + FIELDS.length) % FIELDS.length]);
  const toggle = (on: boolean) => {
    if ((JOB_ACTIONS as string[]).includes(focus)) {
      setActions((s) => {
        const next = new Set(s);
        if (on) next.add(focus as JobAction);
        else next.delete(focus as JobAction);
        return next;
      });
    }
    if (focus === 'user') setUser(on);
  };

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.tab) return move(key.shift ? -1 : 1);
    if (key.ctrl && input === 's') return submit();
    // the text fields own every other key while focused
    if (TEXT.includes(focus)) return;
    if (key.upArrow || input === 'k') return move(-1);
    if (key.downArrow || input === 'j') return move(1);
    if (key.return) return submit();
    const left = key.leftArrow || input === 'h';
    const right = key.rightArrow || input === 'l';
    if (!left && !right && input !== ' ') return;
    if (focus === 'model') setModelIdx((i) => (i + (left ? models.length - 1 : 1)) % models.length);
    else if (focus === 'mode') setModeIdx((i) => (i + (left ? modes.length - 1 : 1)) % modes.length);
    else if (input === ' ') toggle(focus === 'user' ? !user : !actions.has(focus as JobAction));
    else toggle(right);
  });

  const help: Partial<Record<Field, string>> = {
    name: 'what the list calls it',
    schedule: when?.at
      ? `next: ${new Date(when.at).toLocaleString()} — a cron expression: minute hour day month weekday`
      : when?.error
        ? `not a schedule: ${when.error}`
        : 'blank: you run it with r. Or cron — "0 9 * * 1-5" is 9:00 on weekdays, "*/30 * * * *" every half hour',
    model: modelIdx ? `this job runs on ${models[modelIdx].label}` : `the config's job model${props.configured ? ` (${props.configured})` : ''}`,
    user: 'Load your own Claude settings — your MCP servers (Slack, Linear, …) come with them. Off, the job sees only what colinear gives it.',
    mode: 'how much it may do without asking — and nobody is there to ask, so anything it would have asked about is refused',
    deny: 'tools refused on top of the config\'s denyTools, comma-separated: "Bash(git push:*), WebFetch"',
    prompt: 'the job\'s whole brief, in your words — it runs with nobody watching and reports back',
    ...ACTION_HELP,
  };

  return (
    <Box flexDirection="column" flexShrink={0}>
      <FormTitle title={job ? `edit ${job.name}` : 'new job'} detail="once by hand, or on a schedule" />
      <Box marginTop={1}>
        <FieldHeading label="name" focused={focus === 'name'} />
        <Box width={width - LABEL_WIDTH}>
          <TextArea value={name} onChange={setName} focus={focus === 'name'} width={width - LABEL_WIDTH} height={1} submitOnEnter onSubmit={() => move(1)} placeholder="dependabot sweep" />
        </Box>
      </Box>
      <FieldHeading label="prompt" focused={focus === 'prompt'} note={focus === 'prompt' ? 'enter: new line · tab: next field' : undefined} />
      <TextArea
        value={prompt}
        onChange={setPrompt}
        focus={focus === 'prompt'}
        width={width}
        height={props.promptLines}
        placeholder="Look at every open PR by dependabot in my repos. Review each with colinear; approve the ones with no findings."
        onSubmit={submit}
      />
      <Box>
        <FieldHeading label="schedule" focused={focus === 'schedule'} />
        <Box width={width - LABEL_WIDTH}>
          <TextArea value={schedule} onChange={setSchedule} focus={focus === 'schedule'} width={width - LABEL_WIDTH} height={1} submitOnEnter onSubmit={() => move(1)} placeholder="blank = by hand · 0 9 * * 1-5" />
        </Box>
      </Box>
      <ChoiceRow
        label="model"
        options={models.map((m, i) => ({ label: i === 0 && props.configured ? `default (${props.configured})` : m.label }))}
        index={modelIdx}
        focused={focus === 'model'}
        width={width}
      />
      <Text dimColor wrap="truncate">
        {'  '}may, through colinear:
      </Text>
      {JOB_ACTIONS.map((a) => (
        <ChoiceRow key={a} label={a} options={[{ label: 'off' }, { label: 'on' }]} index={actions.has(a) ? 1 : 0} focused={focus === a} width={width} />
      ))}
      <ChoiceRow label="user tools" options={[{ label: 'off' }, { label: 'on' }]} index={user ? 1 : 0} focused={focus === 'user'} width={width} />
      <ChoiceRow label="mode" options={modes.map((label) => ({ label }))} index={modeIdx} focused={focus === 'mode'} width={width} />
      <Box>
        <FieldHeading label="deny" focused={focus === 'deny'} />
        <Box width={width - LABEL_WIDTH}>
          <TextArea value={deny} onChange={setDeny} focus={focus === 'deny'} width={width - LABEL_WIDTH} height={1} submitOnEnter onSubmit={submit} placeholder="optional: Bash(git push:*), WebFetch" />
        </Box>
      </Box>
      <HelpArea text={error ? `✖ ${error}` : help[focus]} width={width} lines={2} />
      <KeyHints
        hints={[
          ['tab', 'next field'],
          ['←→ space', 'choose'],
          ['ctrl-s', job ? 'save' : 'create'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}
