import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { writeAnswerDoc } from '../core/answers.js';
import { setPendingAction } from '../core/attach.js';
import type { AskedQuestion, PendingQuestion } from '../core/types.js';
import { theme } from '../theme.js';

/**
 * The answer form. An agent can ask up to four questions at once, each with
 * options that carry a description of what picking them means — all of which
 * used to be thrown away, leaving a truncated question and a list of bare
 * labels in a fifteen-row pane.
 *
 * One question per screen, arrow keys or number keys to pick, and a free-text
 * row for when none of the options is the answer.
 */
export function AnswerModal(props: {
  /** what the question is attached to, for the title */
  subject: string;
  question: PendingQuestion;
  width: number;
  /** the task id, so the $EDITOR path can submit after the TUI restarts */
  issueId?: string;
  /** hands the terminal to $EDITOR (unset disables the e key) */
  onEdit?: (path: string) => void;
  onCancel: () => void;
  onSubmit: (answers: string[]) => void;
}) {
  const { subject, question, width, issueId, onEdit, onCancel, onSubmit } = props;
  const questions = question.questions;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const [cursor, setCursor] = useState(0);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');

  const current: AskedQuestion | undefined = questions[index];
  const options = current?.options ?? [];
  // no options at all (a free-form ask): the text field is the only answer
  const rows = options.length ? options.length + 1 : 1;

  const record = (value: string) => {
    const next = [...answers];
    next[index] = value;
    setAnswers(next);
    if (index + 1 < questions.length) {
      setIndex(index + 1);
      setCursor(0);
      setTyping(false);
      setDraft('');
      return;
    }
    onSubmit(next);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (typing) {
        setTyping(false);
        return;
      }
      onCancel();
      return;
    }
    if (typing) return; // the text field owns everything else
    // longer than a line? write it in $EDITOR instead
    if (input === 'e' && onEdit && issueId) {
      onEdit(writeAnswerDoc(subject, question, answers));
      return;
    }
    if (key.upArrow || input === 'k') setCursor((c) => (c + rows - 1) % rows);
    if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % rows);
    // back up a question to change an answer
    if (key.leftArrow && index > 0) {
      setIndex(index - 1);
      setCursor(0);
    }
    const num = Number.parseInt(input, 10);
    if (!Number.isNaN(num) && options[num - 1]) {
      record(options[num - 1].label);
      return;
    }
    if (key.return) {
      const picked = cursor < options.length ? options[cursor] : undefined;
      if (picked) record(picked.label);
      else setTyping(true);
    }
  });

  if (!current) return null;

  const answered = answers.filter(Boolean).length;
  const inner = Math.max(20, width - 8);

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="double" borderColor={theme.info} paddingX={2}>
      <Text bold color={theme.info}>
        {question.kind === 'permission' ? 'permission' : 'question'} · {subject}
        {questions.length > 1 && (
          <Text dimColor>
            {' '}
            — {index + 1} of {questions.length}
            {answered ? ` (${answered} answered)` : ''}
          </Text>
        )}
      </Text>

      {current.header && (
        <Text color={theme.key} bold>
          [{current.header}]
        </Text>
      )}
      {/* the whole question, wrapped: this is the thing that used to be cut off */}
      <Text wrap="wrap">{current.text}</Text>
      <Text> </Text>

      {options.map((opt, i) => {
        const active = !typing && cursor === i;
        return (
          <Box key={`${opt.label}-${i}`} flexDirection="column">
            <Text wrap="truncate" color={active ? theme.selection : undefined} bold={active}>
              {active ? '▸' : ' '} {i + 1}. {opt.label}
            </Text>
            {opt.description && (
              <Text wrap="truncate" dimColor>
                {'      '}
                {opt.description.slice(0, inner)}
              </Text>
            )}
          </Box>
        );
      })}

      <Box>
        <Text color={!typing && cursor >= options.length ? theme.selection : undefined} bold={!typing && cursor >= options.length}>
          {!typing && cursor >= options.length ? '▸' : ' '} {options.length ? `${options.length + 1}. ` : ''}your own answer
          {typing ? ': ' : ''}
        </Text>
        {typing && (
          <TextInput
            value={draft}
            placeholder="type it, enter to submit"
            onChange={setDraft}
            onSubmit={(value) => (value.trim() ? record(value.trim()) : setTyping(false))}
          />
        )}
      </Box>

      <Text dimColor>
        {typing
          ? 'enter: submit · esc: back to the options'
          : `↑↓/1-${options.length || 1}: pick · enter: ${index + 1 < questions.length ? 'next question' : 'send'}` +
            (index > 0 ? ' · ←: previous' : '') +
            (onEdit ? ' · e: write it in $EDITOR' : '') +
            ' · esc: cancel'}
      </Text>
    </Box>
  );
}
