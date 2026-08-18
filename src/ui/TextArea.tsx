import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

/**
 * A few lines of editable text, for the places a single-line `TextInput` is
 * the wrong shape — dispatch instructions being the one that hurt: a paragraph
 * of guidance scrolling sideways through a 60-column field is unreadable while
 * you write it, which is exactly when you need to read it.
 *
 * Deliberately small: insert, backspace, newline, and a cursor that moves by
 * character or to either end of the buffer. Anything more (word motions,
 * selection, undo) is a text editor, and `$EDITOR` already exists for that.
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
  // the cursor lives at the end: this is a compose box, not an editor, and a
  // separate cursor position that survives re-renders invites drift
  const insert = (text: string) => onChange(value + text);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'd') {
        onSubmit?.();
        return;
      }
      if (key.return) return insert('\n');
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      // ctrl-u: clear, as in a shell prompt
      if (key.ctrl && input === 'u') return onChange('');
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) insert(input);
    },
    { isActive: focus },
  );

  const lines = wrap(value, width);
  // show the tail: while typing you are always looking at the end
  const visible = lines.slice(Math.max(0, lines.length - height));
  const empty = !value.length;

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {empty && placeholder ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        visible.map((line, i) => (
          <Text key={`${i}-${line.slice(0, 8)}`} wrap="truncate">
            {line}
            {focus && i === visible.length - 1 ? <Text color={theme.accent}>▌</Text> : null}
          </Text>
        ))
      )}
    </Box>
  );
}

/**
 * Wrap on words, keeping explicit newlines as line breaks. Word-aware because
 * a hard slice breaks mid-word and pushes the space it broke on to the front of
 * the next line, which reads as a stray indent.
 */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(' ')) {
      // a single word longer than the box still has to break somewhere
      if (word.length > width) {
        if (line) out.push(line);
        for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width));
        line = '';
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (next.length > width) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}
