import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useMemo, useState } from 'react';
import { theme } from '../theme.js';
import { fuzzyMatch } from './CommandBar.js';

export interface PaletteItem {
  /** what is typed, and what is submitted */
  value: string;
  /** other names that reach it */
  aliases?: string[];
  /** one line on what it is */
  detail?: string;
}

/**
 * Best matches first: a name or alias the query starts, then one it appears
 * in, then the description, then a loose subsequence of the name. An empty
 * query lists everything, in the order given.
 */
export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
  const q = query.toLowerCase();
  if (!q) return items;
  const score = (item: PaletteItem): number => {
    const names = [item.value, ...(item.aliases ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n.startsWith(q))) return 0;
    if (names.some((n) => n.includes(q))) return 1;
    if (item.detail?.toLowerCase().includes(q)) return 2;
    if (names.some((n) => fuzzyMatch(n, q))) return 3;
    return -1;
  };
  return items
    .map((item, i) => ({ item, s: score(item), i }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.item);
}

/**
 * `:`, as a palette: the input on top and every view under it as a list,
 * narrowed as you type — the editor's command palette rather than a prompt
 * with a line of suggestions. ↑↓ (or ctrl-p/ctrl-n) pick, tab completes the
 * picked name into the input, enter opens it. Anything after the first word
 * is an argument and survives completion (`:task CLO-142`).
 */
export function CommandPalette(props: {
  items: PaletteItem[];
  /** inner width */
  width: number;
  /** rows the list may use */
  listRows: number;
  onSubmit: (value: string, picked?: PaletteItem) => void;
  onCancel: () => void;
}) {
  const { items, width, listRows, onSubmit, onCancel } = props;
  const [value, setValue] = useState('');
  const [picked, setPicked] = useState(0);
  /** an arrow chose the row: then enter opens that row, whatever the input says */
  const [moved, setMoved] = useState(false);

  const space = value.indexOf(' ');
  const head = space === -1 ? value : value.slice(0, space);
  const tail = space === -1 ? '' : value.slice(space);
  const ranked = useMemo(() => rankItems(items, head), [items, head]);
  const at = Math.min(picked, Math.max(0, ranked.length - 1));
  // keep the pick in view: the window slides once it reaches either edge
  const top = Math.max(0, Math.min(at - listRows + 1, ranked.length - listRows, at));
  const shown = ranked.slice(Math.max(0, top), Math.max(0, top) + listRows);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow || (key.ctrl && input === 'p')) {
      setMoved(true);
      return setPicked(Math.max(0, at - 1));
    }
    if (key.downArrow || (key.ctrl && input === 'n')) {
      setMoved(true);
      return setPicked(Math.min(ranked.length - 1, at + 1));
    }
    if (key.tab && ranked[at]) setValue(`${ranked[at].value}${tail || ' '}`);
  });

  const nameWidth = Math.min(16, Math.max(6, ...items.map((i) => i.value.length + 1)));
  const aliasWidth = Math.min(14, Math.max(0, ...items.map((i) => (i.aliases ?? []).join(' ').length + 1)));
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.key} bold>
          :{' '}
        </Text>
        <TextInput
          value={value}
          placeholder="go to a view — type to narrow, ↑↓ pick, enter opens"
          onChange={(v) => {
            setValue(v);
            setPicked(0);
            setMoved(false);
          }}
          // typed and not arrowed: the input as written (an alias, an
          // argument), with the top row as the fallback. Arrowed: that row.
          onSubmit={(v) => onSubmit(moved && ranked[at] ? `${ranked[at].value}${tail}` : v, ranked[at])}
        />
      </Box>
      <Text color={theme.border}>{'─'.repeat(Math.max(0, width))}</Text>
      {shown.map((item) => {
        const on = item === ranked[at];
        return (
          <Text key={item.value} wrap="truncate" inverse={on}>
            <Text color={on ? undefined : theme.key} bold>
              {` ${item.value}`.padEnd(nameWidth + 1)}
            </Text>
            <Text dimColor={!on}>{(item.aliases ?? []).join(' ').slice(0, Math.max(0, aliasWidth - 1)).padEnd(aliasWidth)}</Text>
            <Text dimColor={!on}>{` ${item.detail ?? ''}`.padEnd(Math.max(0, width - nameWidth - aliasWidth - 1))}</Text>
          </Text>
        );
      })}
      {!ranked.length && <Text dimColor> no view matches "{head}" — enter tries it anyway</Text>}
      {/* the list keeps its height, so the box never jumps as it narrows */}
      {Array.from({ length: Math.max(0, listRows - Math.max(shown.length, ranked.length ? 0 : 1)) }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
      <Text dimColor wrap="truncate">
        {ranked.length > shown.length ? `${at + 1}/${ranked.length} · ` : ''}↑↓ pick · tab complete · enter open · esc close
      </Text>
    </Box>
  );
}
