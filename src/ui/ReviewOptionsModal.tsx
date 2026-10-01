import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import { modelOptions } from './DispatchModal.js';
import { TextArea } from './TextArea.js';

type Field = 'model' | 'instructions';

const LABEL_WIDTH = 14;

/**
 * A model and instructions for an agent. `c` in :reviews runs the review that
 * way (kept on the review); `c` in the annotated diff asks about the marked
 * lines that way (this once). The form starts from what it is given.
 */
export function ReviewOptionsModal(props: {
  /** "re-review cloud#12" or "review cloud#12" */
  title: string;
  /** models the configured runtimes offer */
  models: string[];
  /** the review's current choices, which the form starts from */
  model?: string;
  instructions?: string;
  /** what "default" resolves to, so the row says what you'd get */
  configured?: string;
  width: number;
  instructionLines: number;
  /** the line under the model row (default: that the choice is kept on the review) */
  hint?: string;
  placeholder?: string;
  /** what enter / ctrl-d does, for the footer */
  verb?: string;
  onSubmit: (opts: { model?: string; instructions?: string }) => void;
  onCancel: () => void;
}) {
  const { width, instructionLines, onSubmit, onCancel } = props;
  const verb = props.verb ?? 'start';
  // a model set some other way (an exact id) is kept as an option rather than
  // silently dropped back to default
  const choices = modelOptions(
    props.model && !props.models.includes(props.model) ? [...props.models, props.model] : props.models,
  );
  const [modelIdx, setModelIdx] = useState(Math.max(0, choices.findIndex((c) => c.value === props.model)));
  const [instructions, setInstructions] = useState(props.instructions ?? '');
  const [focus, setFocus] = useState<Field>('model');

  const submit = () =>
    onSubmit({ model: choices[modelIdx].value, instructions: instructions.trim() || undefined });

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.tab) return setFocus((f) => (f === 'model' ? 'instructions' : 'model'));
    // the text area owns every other key while it has focus, enter included
    if (focus === 'instructions') return;
    if (key.leftArrow || input === 'h') setModelIdx((i) => (i + choices.length - 1) % choices.length);
    if (key.rightArrow || input === 'l') setModelIdx((i) => (i + 1) % choices.length);
    if (key.return) submit();
  });

  const avail = width - LABEL_WIDTH - 4;
  const labels = choices.map((c, i) => (i === 0 && props.configured ? `default (${props.configured})` : c.label));
  const fits = labels.reduce((n, o) => n + o.length + 2, 0) <= avail;
  const shown = fits ? labels.map((l, i) => [l, i] as const) : [[labels[modelIdx], modelIdx] as const];

  return (
    // the frame and the opaque backdrop belong to Popup; this is the contents
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color={theme.key} wrap="truncate">
        {props.title}
      </Text>
      <Box>
        <Text bold color={focus === 'model' ? theme.accent : theme.dim}>
          {'model'.padEnd(LABEL_WIDTH)}
        </Text>
        <Text dimColor>{fits ? ' ' : '‹'}</Text>
        {shown.map(([label, idx]) => (
          <Text
            key={`${label}-${idx}`}
            wrap="truncate"
            inverse={focus === 'model' && idx === modelIdx}
            color={idx === modelIdx ? theme.selection : theme.dim}
            bold={idx === modelIdx}
          >
            {` ${label} `}
          </Text>
        ))}
        <Text dimColor>{fits ? ' ' : '›'}</Text>
        {!fits && (
          <Text dimColor>
            {'  '}
            {modelIdx + 1}/{choices.length}
          </Text>
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {' '.repeat(LABEL_WIDTH)}
        {props.hint ?? 'kept on this review — a plain r later runs the same way'}
      </Text>
      <Box marginTop={1}>
        <Text bold color={focus === 'instructions' ? theme.accent : theme.dim}>
          instructions
        </Text>
        <Text dimColor>{focus === 'instructions' ? ' — enter starts a new line' : ' — tab to write'}</Text>
      </Box>
      <TextArea
        value={instructions}
        onChange={setInstructions}
        focus={focus === 'instructions'}
        width={width}
        height={instructionLines}
        placeholder={props.placeholder ?? 'optional: what to look at, what to ignore, how hard to push'}
        onSubmit={submit}
      />
      <Text dimColor>
        {focus === 'instructions'
          ? `tab: switch field · ctrl-d: ${verb} · ctrl-u: clear · esc: cancel`
          : `tab: switch field · ←→: pick · enter: ${verb} · esc: cancel`}
      </Text>
    </Box>
  );
}
