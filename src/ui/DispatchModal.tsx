import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
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
}

/** Custom-dispatch modal: free-text instructions + model tier. */
export function DispatchModal(props: {
  count: number;
  onSubmit: (opts: DispatchOptions) => void;
  onCancel: () => void;
}) {
  const { count, onSubmit, onCancel } = props;
  const [instructions, setInstructions] = useState('');
  const [modelIdx, setModelIdx] = useState(0);
  const [focus, setFocus] = useState<'instructions' | 'model'>('instructions');

  const submit = () =>
    onSubmit({
      instructions: instructions.trim() || undefined,
      model: MODEL_OPTIONS[modelIdx].value,
    });

  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.tab) setFocus((f) => (f === 'instructions' ? 'model' : 'instructions'));
    if (focus === 'model') {
      if (key.leftArrow || input === 'h') setModelIdx((i) => (i + MODEL_OPTIONS.length - 1) % MODEL_OPTIONS.length);
      if (key.rightArrow || input === 'l') setModelIdx((i) => (i + 1) % MODEL_OPTIONS.length);
      if (key.return) submit();
    }
  });

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
      <Box>
        <Text bold color={focus === 'model' ? theme.accent : theme.dim}>
          {'model         '}
        </Text>
        {MODEL_OPTIONS.map((m, i) => (
          <Text
            key={m.label}
            inverse={focus === 'model' && i === modelIdx}
            color={i === modelIdx ? theme.selection : theme.dim}
            bold={i === modelIdx}
          >
            {` ${m.label} `}
          </Text>
        ))}
      </Box>
      <Text dimColor>tab: switch field · ←→: model · enter: dispatch · esc: cancel</Text>
    </Box>
  );
}
