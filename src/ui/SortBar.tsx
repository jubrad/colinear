import { Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import { fuzzyMatch } from './CommandBar.js';

export interface SortOption {
  key: string;
  /** what the bar shows; defaults to the key */
  label?: string;
}

/**
 * Pick a sort without spelling it: the columns sit in a row, tab (or ←→)
 * walks them, and typing still jumps to a match. `enter` sorts by the one
 * under the cursor — on the column already sorted, it reverses it, so a
 * direction change is one keypress rather than reopening the bar. `↑` and `↓`
 * say the direction outright.
 *
 * Shift-enter reverses too, where the terminal reports it. Most send the same
 * carriage return for enter with or without shift, so it can't be the only
 * way: ↓ is the one that always works.
 */
export function SortBar(props: {
  options: SortOption[];
  current: string;
  desc: boolean;
  onApply: (key: string, desc: boolean) => void;
  onCancel: () => void;
}) {
  const { options, current, desc } = props;
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(Math.max(0, options.findIndex((o) => o.key === current)));

  const label = (o: SortOption) => o.label ?? o.key;
  const matches = (o: SortOption) => !query || fuzzyMatch(label(o).toLowerCase(), query.toLowerCase());
  /** the next option in `dir` that matches the query, wrapping */
  const step = (from: number, dir: 1 | -1) => {
    for (let i = 1; i <= options.length; i++) {
      const at = (from + dir * i + options.length * i) % options.length;
      if (matches(options[at])) return at;
    }
    return from;
  };

  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    const o = options[focus];
    if (key.upArrow) return props.onApply(o.key, false);
    if (key.downArrow) return props.onApply(o.key, true);
    if (key.return) {
      if (key.shift) return props.onApply(o.key, true);
      // the column already sorted: enter reverses it
      return props.onApply(o.key, o.key === current ? !desc : false);
    }
    if (key.tab) return setFocus((f) => step(f, key.shift ? -1 : 1));
    if (key.rightArrow) return setFocus((f) => step(f, 1));
    if (key.leftArrow) return setFocus((f) => step(f, -1));
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && /^[\w -]$/.test(input)) {
      const next = query + input;
      setQuery(next);
      // land on the best match: a prefix beats a subsequence
      const lower = next.toLowerCase();
      const prefix = options.findIndex((opt) => label(opt).toLowerCase().startsWith(lower));
      const loose = options.findIndex((opt) => fuzzyMatch(label(opt).toLowerCase(), lower));
      if (prefix !== -1 || loose !== -1) setFocus(prefix !== -1 ? prefix : loose);
    }
  });

  // one line, like the other bars: every view budgets one row for whichever is open
  return (
    <Text wrap="truncate">
      <Text color={theme.key}>sort › </Text>
      <Text color={theme.accent}>{query}</Text>
      <Text inverse> </Text>{' '}
      {options.map((o, i) => {
        const on = i === focus;
        const sorted = o.key === current;
        const dim = !matches(o);
        return (
          <Text
            key={o.key}
            inverse={on}
            bold={on || sorted}
            color={on ? theme.selection : sorted ? theme.accent : dim ? theme.dim : undefined}
            dimColor={dim && !on}
          >
            {` ${label(o)}${sorted ? (desc ? '↓' : '↑') : ''} `}
          </Text>
        );
      })}
      <Text dimColor>
        {'  '}tab ←→ · enter{options[focus]?.key === current ? ' reverses' : ' sorts'} · ↑↓ direction · esc
      </Text>
    </Text>
  );
}
