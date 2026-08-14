import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import type { Review } from '../core/types.js';
import { theme } from '../theme.js';

/**
 * Full-screen reader for a review: the agent's document on one side, a
 * conversation with the agent that wrote it on the other. Side by side when
 * there's width for it, stacked when there isn't — two 40-column panes are
 * worse than one readable one.
 */
export function ReviewDocModal(props: {
  review: Review;
  width: number;
  height: number;
  busy: boolean;
  onSend: (text: string) => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const { review, width, height, busy, onSend, onEdit, onClose } = props;
  const [focus, setFocus] = useState<'doc' | 'chat'>('doc');
  const [draft, setDraft] = useState('');
  const [scroll, setScroll] = useState(0);

  const side = width >= 120;
  const docWidth = side ? Math.floor(width * 0.58) : width;
  const chatWidth = side ? width - docWidth - 1 : width;
  // borders + title + the input line
  const paneHeight = side ? height - 3 : Math.floor((height - 3) / 2);

  const lines = wrap(review.doc ?? review.summary ?? 'No review document yet — press r to run a pre-review.', docWidth - 4);
  const maxScroll = Math.max(0, lines.length - (paneHeight - 2));
  useEffect(() => setScroll((s) => Math.min(s, maxScroll)), [maxScroll]);

  useInput((input, key) => {
    if (key.escape) return onClose();
    if (key.tab) {
      setFocus((f) => (f === 'doc' ? 'chat' : 'doc'));
      return;
    }
    if (focus !== 'doc') return; // the input owns every other key while it's focused
    if (input === 'j' || key.downArrow) setScroll((s) => Math.min(maxScroll, s + 1));
    if (input === 'k' || key.upArrow) setScroll((s) => Math.max(0, s - 1));
    if (input === ' ' || key.pageDown) setScroll((s) => Math.min(maxScroll, s + paneHeight - 3));
    if (key.pageUp) setScroll((s) => Math.max(0, s - (paneHeight - 3)));
    if (input === 'g') setScroll(0);
    if (input === 'G') setScroll(maxScroll);
    if (input === 'e') onEdit();
    if (input === 'q') onClose();
  });

  const chat = review.chat ?? [];
  const chatLines: Array<{ role: 'operator' | 'agent'; line: string }> = chat.flatMap((turn) =>
    wrap(turn.text, chatWidth - 4).map((line) => ({ role: turn.role, line })),
  );
  const chatBody = chatLines.slice(-(paneHeight - 4));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection={side ? 'row' : 'column'} gap={side ? 1 : 0}>
        <Box
          flexDirection="column"
          width={docWidth}
          height={paneHeight}
          borderStyle={focus === 'doc' ? 'double' : 'round'}
          borderColor={focus === 'doc' ? theme.borderFocus : theme.border}
          paddingX={1}
          overflow="hidden"
          flexShrink={0}
        >
          <Text bold color={theme.header} wrap="truncate">
            {review.repository}#{review.number}
            <Text dimColor>
              {' '}
              — review{maxScroll ? ` · ${scroll}/${maxScroll}` : ''}
            </Text>
          </Text>
          {lines.slice(scroll, scroll + paneHeight - 2).map((line, i) => (
            <Text key={`${scroll}-${i}`} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>

        <Box
          flexDirection="column"
          width={chatWidth}
          height={paneHeight}
          borderStyle={focus === 'chat' ? 'double' : 'round'}
          borderColor={focus === 'chat' ? theme.borderFocus : theme.border}
          paddingX={1}
          overflow="hidden"
          flexShrink={0}
        >
          <Text bold color={theme.header}>
            talk to the reviewer{busy ? <Text color={theme.warn}> · thinking…</Text> : null}
          </Text>
          {!chat.length && (
            <Text dimColor wrap="wrap">
              It still has the whole PR in context. Ask why it flagged something, or tell it what to
              change — it rewrites the document.
            </Text>
          )}
          {chatBody.map((entry, i) => (
            <Text key={i} color={entry.role === 'operator' ? theme.accent : undefined} wrap="truncate">
              {entry.line}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color={focus === 'chat' ? theme.accent : theme.dim}>{'> '}</Text>
            <TextInput
              focus={focus === 'chat'}
              value={draft}
              placeholder={focus === 'chat' ? 'ask or instruct…' : 'tab to type'}
              onChange={setDraft}
              onSubmit={(value) => {
                if (!value.trim()) return;
                onSend(value.trim());
                setDraft('');
              }}
            />
          </Box>
        </Box>
      </Box>
      <Text dimColor>
        tab: {focus === 'doc' ? 'chat' : 'doc'} · j/k g/G: scroll · e: edit in $EDITOR · esc: back
      </Text>
    </Box>
  );
}

/**
 * Wrap for reading: prose paragraphs reflow to the pane, while headings, list
 * items, quotes, tables and fenced code keep the author's line breaks — the
 * agent's own hard wraps would otherwise leave every other line half empty.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let paragraph: string[] = [];
  let inFence = false;

  const flush = () => {
    if (!paragraph.length) return;
    out.push(...fill(paragraph.join(' '), width));
    paragraph = [];
  };

  for (const raw of text.split('\n')) {
    if (raw.trim().startsWith('```')) {
      flush();
      inFence = !inFence;
      out.push(raw);
      continue;
    }
    if (inFence || /^\s*([#>|*-]|\d+\.|\s{4})/.test(raw)) {
      flush();
      out.push(...fill(raw, width));
      continue;
    }
    if (!raw.trim()) {
      flush();
      out.push('');
      continue;
    }
    paragraph.push(raw.trim());
  }
  flush();
  return out;
}

function fill(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  return out;
}
