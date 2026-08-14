import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useEffect, useState } from 'react';
import type { ChatTurn, Review } from '../core/types.js';
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
  // rows inside the pane: its height less both borders, less the title line.
  // Overflowing by even one row makes Ink paint the overflow over the title.
  const docRows = Math.max(1, paneHeight - 3);
  const maxScroll = Math.max(0, lines.length - docRows);
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
    if (input === ' ' || key.pageDown) setScroll((s) => Math.min(maxScroll, s + docRows - 1));
    if (key.pageUp) setScroll((s) => Math.max(0, s - (docRows - 1)));
    if (input === 'g') setScroll(0);
    if (input === 'G') setScroll(maxScroll);
    if (input === 'e') onEdit();
    if (input === 'q') onClose();
  });

  const chat = review.chat ?? [];
  const chatLines: Array<{ role: ChatTurn['role']; line: string; first: boolean }> = chat.flatMap((turn) =>
    wrap(`${turn.role === 'operator' ? 'you: ' : turn.role === 'note' ? '' : ''}${turn.text}`, chatWidth - 4).map(
      (line, i) => ({ role: turn.role, line, first: i === 0 }),
    ),
  );
  // borders (2) + title (1) + input and its margin (2) + the activity line
  const chatRows = Math.max(1, paneHeight - (busy ? 6 : 5));
  const chatBody = chatLines.slice(-chatRows);

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
          {lines.slice(scroll, scroll + docRows).map((line, i) => (
            <Text key={`${scroll}-${i}`} wrap="truncate" {...markdownStyle(line)}>
              {/* a truly empty Text has no height, which eats the blank lines */}
              {stripMarks(line) || ' '}
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
          <Text bold color={theme.header} wrap="truncate">
            discuss
            {review.question ? (
              <Text color={theme.info}> · it asked you something</Text>
            ) : busy ? (
              <Text color={theme.warn}> · thinking…</Text>
            ) : null}
          </Text>
          {!chat.length &&
            wrap(
              review.sessionId
                ? 'It still has the whole PR in context. Ask why it flagged something, or tell it what to change — it rewrites the document.'
                : 'No pre-review has run yet, so there is no session to talk to. Press esc, then r.',
              chatWidth - 4,
            )
              .slice(0, chatRows)
              .map((line, i) => (
                <Text key={i} dimColor wrap="truncate">
                  {line}
                </Text>
              ))}
          {chatBody.map((entry, i) => (
            <Text
              key={i}
              color={entry.role === 'operator' ? theme.accent : entry.role === 'note' ? theme.warn : undefined}
              wrap="truncate"
            >
              {entry.line}
            </Text>
          ))}
          {busy && review.activity.length ? (
            <Text dimColor wrap="truncate">
              ⋯ {review.activity[review.activity.length - 1]}
            </Text>
          ) : null}
          <Box marginTop={busy ? 0 : 1}>
            <Text color={focus === 'chat' ? theme.accent : theme.dim}>{'> '}</Text>
            <TextInput
              focus={focus === 'chat'}
              value={draft}
              placeholder={
                focus !== 'chat'
                  ? 'tab to type'
                  : review.question
                    ? 'answer it (or 1-9)…'
                    : 'ask or instruct…'
              }
              onChange={setDraft}
              onSubmit={(value) => {
                const text = value.trim();
                if (!text) return;
                setDraft('');
                // a pending question takes the reply; a bare number picks an option
                const question = review.question;
                if (question) {
                  const pick = Number.parseInt(text, 10);
                  question.answer(
                    !Number.isNaN(pick) && question.options[pick - 1] ? question.options[pick - 1] : text,
                  );
                  return;
                }
                onSend(text);
              }}
            />
          </Box>
        </Box>
      </Box>
      <Text dimColor wrap="truncate">
        tab: {focus === 'doc' ? 'discuss' : 'doc'} · j/k g/G: scroll · e: edit in $EDITOR · esc: back
      </Text>
    </Box>
  );
}

/** Enough markdown to read by: headings stand out, code recedes. */
function markdownStyle(line: string): { bold?: boolean; color?: string; dimColor?: boolean } {
  const text = line.trimStart();
  if (/^#{1,2}\s/.test(text)) return { bold: true, color: theme.header };
  if (/^#{3,}\s/.test(text)) return { bold: true };
  if (text.startsWith('```') || /^\s{4}\S/.test(line)) return { dimColor: true };
  if (/^([*-]|\d+\.)\s/.test(text)) return { color: theme.accent };
  if (text.startsWith('>')) return { dimColor: true };
  return {};
}

/** Heading hashes and bold markers are noise once the line is styled. */
function stripMarks(line: string): string {
  return line.replace(/^(\s*)#{1,6}\s+/, '$1').replace(/\*\*(.+?)\*\*/g, '$1');
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
