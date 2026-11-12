import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useColinear } from '../ui/context.js';
import { cell } from '../ui/format.js';
import { currentTheme, REVIEW_COLORS, STATUS_COLORS, theme, THEMES, type ThemeTokens } from '../theme.js';

const NAMES = Object.keys(THEMES);

/** The tokens a row's swatch strip shows, in the order the eye meets them. */
const SWATCH: Array<keyof ThemeTokens> = ['key', 'accent', 'header', 'ok', 'warn', 'err', 'info', 'merged', 'changes', 'annotation', 'border', 'dim'];

/**
 * Pick a colour theme by trying it: moving the cursor puts the whole UI —
 * this view, the header, the crumbs — in that theme at once, `enter` keeps
 * it, `esc` puts back the one you came in with. Remembered across restarts
 * like the board's layout.
 */
export function ThemeView(_props: { param?: string }) {
  const ctx = useColinear();
  const original = useRef(currentTheme());
  const [cursor, setCursor] = useState(Math.max(0, NAMES.indexOf(currentTheme())));

  // esc puts it back, then goes back as usual
  useEffect(() => {
    ctx.setEscHandler(() => {
      ctx.setUi({ theme: original.current });
      return false;
    });
    return () => ctx.setEscHandler(null);
  }, []);

  const tryTheme = (i: number) => {
    const next = Math.max(0, Math.min(NAMES.length - 1, i));
    setCursor(next);
    ctx.setUi({ theme: NAMES[next] });
  };

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') tryTheme(cursor - 1);
      if (key.downArrow || input === 'j') tryTheme(cursor + 1);
      if (input === 'g') tryTheme(0);
      if (input === 'G') tryTheme(NAMES.length - 1);
      if (key.return) {
        original.current = NAMES[cursor];
        ctx.toast(`theme: ${NAMES[cursor]}`, 'ok');
        ctx.back();
      }
    },
    { isActive: !ctx.cmdOpen },
  );

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          theme{' '}
        </Text>
        <Text dimColor>j/k tries one · enter keeps it · esc puts back {original.current}</Text>
      </Text>
      <Box height={1} />
      {NAMES.map((name, i) => {
        const def = THEMES[name];
        const on = i === cursor;
        return (
          <Text key={name} wrap="truncate">
            <Text color={theme.selection}>{on ? '> ' : '  '}</Text>
            <Text bold={on}>{cell(name, 18)}</Text>
            <Text dimColor>{cell(def.ground === 'any' ? 'any bg' : `${def.ground} bg`, 9)}</Text>
            {SWATCH.map((t) => (
              <Text key={t} backgroundColor={def.tokens[t]}>
                {'  '}
              </Text>
            ))}
            <Text dimColor> {def.label}</Text>
          </Text>
        );
      })}
      <Box height={1} />
      <Sample />
      <Box flexGrow={1} />
      <Text dimColor wrap="wrap">
        Themes colour text and borders; the background is your terminal's. Pick a light theme for a light terminal — or
        `terminal`, which uses the terminal's own 16 colours.
      </Text>
    </Box>
  );
}

/** A little of everything a theme colours, so the choice is made against the real thing. */
function Sample() {
  const statuses = ['queued', 'working', 'needs_input', 'pr_open', 'blocked', 'done', 'error'];
  const reviews = ['reviewing', 'ready', 'commented', 'approved', 'changes_requested'];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text wrap="truncate">
        <Text color={theme.key}>{'<enter>'}</Text> task detail <Text color={theme.key}>{'<a>'}</Text> answer{' '}
        <Text color={theme.header} bold>
          ISSUE STATUS TITLE
        </Text>{' '}
        <Text color={theme.selection}>selected</Text> <Text color={theme.accent}>#412</Text>
      </Text>
      <Text wrap="truncate">
        {statuses.map((s) => (
          <Text key={s} color={STATUS_COLORS[s]}>
            {s}{' '}
          </Text>
        ))}
      </Text>
      <Text wrap="truncate">
        {reviews.map((s) => (
          <Text key={s} color={REVIEW_COLORS[s]}>
            {s}{' '}
          </Text>
        ))}
        <Text color={theme.merged}>merged</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={theme.ok}>+ retry with backoff</Text>
        {'  '}
        <Text color={theme.err}>- retry once</Text>
        {'  '}
        <Text color={theme.annotation}>info: explains the loop</Text>
        {'  '}
        <Text color={theme.changes}>changes requested</Text>
        {'  '}
        <Text color={theme.dim}>dim</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={theme.onBadge} backgroundColor={theme.border}>
          {' board '}
        </Text>
        <Text color={theme.onBadge} backgroundColor={theme.key}>
          {' theme '}
        </Text>{' '}
        <Text color={theme.ok}>✓ saved</Text> <Text color={theme.warn}>⚠ stalled</Text> <Text color={theme.err}>✖ failed</Text>{' '}
        <Text color={theme.info}>? a question</Text>
      </Text>
    </Box>
  );
}

export const themeKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'try a theme'],
  ['enter', 'keep it · esc puts back the old one'],
];
