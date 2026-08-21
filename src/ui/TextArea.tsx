import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * A few lines of editable text, for the places a single-line `TextInput` is
 * the wrong shape — dispatch instructions being the one that hurt: a paragraph
 * of guidance scrolling sideways through a 60-column field is unreadable while
 * you write it, which is exactly when you need to read it.
 *
 * Editing is readline-shaped: arrows move by character or wrapped line,
 * ctrl-a/ctrl-e jump to the ends of the logical line, backspace deletes at the
 * cursor, ctrl-u clears. Anything more (word motions, selection, undo) is a
 * text editor, and `$EDITOR` already exists for that.
 *
 * Input is sanitized on the way in: a raw `\r` — which is what shift-enter
 * arrives as in some terminals, and what pastes carry as `\r\n` — renders as
 * "jump to column 0 of the screen", straight through the box border. It
 * becomes `\n` here so that can never reach the frame.
 */
export function TextArea(props: {
  value: string;
  onChange: (value: string) => void;
  focus: boolean;
  width: number;
  height: number;
  placeholder?: string;
  /** ctrl-d, the "I'm done" key everywhere else in a terminal */
  onSubmit?: () => void;
}) {
  const { value, onChange, focus, width, height, placeholder, onSubmit } = props;
  const [cursor, setCursor] = useState(value.length);
  // the parent owns the value and may hand us anything (an old draft, a paste
  // it assembled itself); heal control characters once rather than rendering them
  useEffect(() => {
    const clean = sanitize(value);
    if (clean !== value) onChange(clean);
  }, [value]);
  const cur = Math.min(cursor, value.length);

  const lines = wrap(value, width);
  let cursorLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (cur <= lines[i].start + lines[i].text.length) {
      cursorLine = i;
      break;
    }
  }
  const col = Math.min(Math.max(0, cur - lines[cursorLine].start), lines[cursorLine].text.length);

  const insertAt = (text: string) => {
    const clean = sanitize(text);
    onChange(value.slice(0, cur) + clean + value.slice(cur));
    setCursor(cur + clean.length);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'd') return void onSubmit?.();
      if (key.return) return insertAt('\n');
      if (key.backspace || key.delete) {
        if (cur === 0) return;
        onChange(value.slice(0, cur - 1) + value.slice(cur));
        setCursor(cur - 1);
        return;
      }
      if (key.leftArrow) return setCursor(Math.max(0, cur - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cur + 1));
      if (key.upArrow || key.downArrow) {
        const target = cursorLine + (key.upArrow ? -1 : 1);
        if (target < 0 || target >= lines.length) return;
        setCursor(lines[target].start + Math.min(col, lines[target].text.length));
        return;
      }
      // ctrl-a / ctrl-e: ends of the logical line (up to the nearest \n), as in a shell
      if (key.ctrl && input === 'a') return setCursor(value.lastIndexOf('\n', cur - 1) + 1);
      if (key.ctrl && input === 'e') {
        const end = value.indexOf('\n', cur);
        return setCursor(end === -1 ? value.length : end);
      }
      // ctrl-u: clear, as in a shell prompt
      if (key.ctrl && input === 'u') {
        onChange('');
        setCursor(0);
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) insertAt(input);
    },
    { isActive: focus },
  );

  // the window follows the cursor: tail by default (you are usually typing at
  // the end), scrolling up only when the cursor leaves through the top
  let windowStart = Math.max(0, lines.length - height);
  if (cursorLine < windowStart) windowStart = cursorLine;
  const visible = lines.slice(windowStart, windowStart + height);
  const empty = !value.length;

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {empty && placeholder ? (
        <Text dimColor>
          {focus ? <Text inverse> </Text> : null}
          {placeholder}
        </Text>
      ) : (
        visible.map((line, i) => {
          const isCursorLine = focus && windowStart + i === cursorLine;
          if (!isCursorLine) {
            return (
              <Text key={`${i}-${line.text.slice(0, 8)}`} wrap="truncate">
                {line.text || ' '}
              </Text>
            );
          }
          return (
            <Text key={`${i}-${line.text.slice(0, 8)}`} wrap="truncate">
              {line.text.slice(0, col)}
              <Text inverse>{line.text[col] ?? ' '}</Text>
              {line.text.slice(col + 1)}
            </Text>
          );
        })
      )}
    </Box>
  );
}

/** `\r` renders as "jump to screen column 0"; tabs render as who-knows-what. Exported for the check. */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    // every other C0 control (and DEL) — escape sequences land here too
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/**
 * Word wrap that keeps explicit newlines and remembers where each visual line
 * starts in the buffer, so a cursor index maps to a screen position. Word-aware
 * because a hard slice breaks mid-word; the space a line breaks on is dropped
 * (it is start-1 of the next line, which is why `start` is tracked per line
 * rather than recomputed). Exported for the check.
 */
export function wrap(text: string, width: number): Array<{ text: string; start: number }> {
  const w = Math.max(1, width);
  const out: Array<{ text: string; start: number }> = [];
  let start = 0;
  let lastSpace = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      out.push({ text: text.slice(start, i), start });
      start = i + 1;
      lastSpace = -1;
      continue;
    }
    if (ch === ' ') lastSpace = i;
    if (i - start + 1 > w) {
      if (lastSpace >= start) {
        out.push({ text: text.slice(start, lastSpace), start });
        start = lastSpace + 1;
      } else {
        out.push({ text: text.slice(start, i), start });
        start = i;
      }
      lastSpace = -1;
    }
  }
  out.push({ text: text.slice(start), start });
  return out;
}
