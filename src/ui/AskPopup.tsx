import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { AskState } from '../core/ask.js';
import { theme } from '../theme.js';
import { spinner } from './format.js';
import { TextArea, wrap } from './TextArea.js';

/**
 * `@`: a chat with an agent that can run colinear. Ask it for something —
 * "find every PR in this stack, add them to reviews and start a local review
 * on each" — and it does it with colinear's own tools and `gh`, then says
 * what it did. The conversation lives in the daemon: close this and it keeps
 * working, and it is still here when you come back.
 */
export function AskPopup(props: {
  state: AskState;
  /** inner width and height, inside the popup frame */
  width: number;
  height: number;
  now: number;
  onSend: (text: string) => void;
  onClose: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const { state, width, height, now, onSend, onClose, onReset, onCancel } = props;
  const [draft, setDraft] = useState('');
  /** lines scrolled up from the bottom of the conversation */
  const [back, setBack] = useState(0);

  // the conversation as rows, newest at the bottom
  const lines = useMemo(() => {
    const out: Array<{ text: string; who?: 'you' | 'colinear' }> = [];
    for (const m of state.messages) {
      const label = m.from === 'you' ? 'you' : 'colinear';
      const body = m.text.split('\n').flatMap((l) => (l ? wrap(l, width - 2).map((w) => w.text) : ['']));
      // a gap between messages, not after the last: the newest line sits on the bottom
      if (out.length) out.push({ text: '' });
      out.push({ text: label, who: m.from });
      for (const b of body) out.push({ text: `  ${b}` });
    }
    return out;
  }, [state.messages, width]);

  // title, status, a rule, the two-line input, the hints
  const room = Math.max(3, height - 7);
  const maxBack = Math.max(0, lines.length - room);
  const from = Math.max(0, lines.length - room - Math.min(back, maxBack));
  const shown = lines.slice(from, from + room);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.pageUp) return setBack((b) => Math.min(maxBack, b + room - 1));
    if (key.pageDown) return setBack((b) => Math.max(0, b - (room - 1)));
    if (key.ctrl && input === 'n') {
      setBack(0);
      return onReset();
    }
    if (key.ctrl && input === 'x' && state.busy) return onCancel();
  });

  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text bold color={theme.key}>
          ask colinear
        </Text>
        <Text dimColor> — it can find PRs, add them to reviews and start local reviews; it never posts</Text>
      </Text>
      <Box flexDirection="column" height={room}>
        {!lines.length && (
          <Text dimColor>
            {'  '}e.g. "find all PRs in the stack under owner/repo#123, add them to reviews and start a local review on each"
          </Text>
        )}
        {shown.map((l, i) =>
          l.who ? (
            <Text key={i} bold color={l.who === 'you' ? theme.accent : theme.ok}>
              {l.text}
            </Text>
          ) : (
            <Text key={i} wrap="truncate">
              {l.text}
            </Text>
          ),
        )}
      </Box>
      <Text wrap="truncate" color={state.busy ? theme.warn : theme.dim}>
        {state.busy ? `${spinner(now)} ${state.activity ?? 'working…'}${state.queued ? ` · ${state.queued} more queued` : ''}` : back ? `↑ ${back} lines up · pgdn` : ' '}
      </Text>
      <Text color={theme.border}>{'─'.repeat(Math.max(0, width))}</Text>
      <TextArea
        value={draft}
        onChange={setDraft}
        focus
        width={width}
        height={2}
        submitOnEnter
        placeholder={state.busy ? 'type the next thing — it waits its turn' : 'ask colinear to do something…'}
        onSubmit={() => {
          if (!draft.trim()) return;
          onSend(draft);
          setDraft('');
          setBack(0);
        }}
      />
      <Text dimColor wrap="truncate">
        enter sends · pgup/pgdn scroll · {state.busy ? 'ctrl-x stops it · ' : ''}ctrl-n new conversation · esc closes (it keeps working)
      </Text>
    </Box>
  );
}
