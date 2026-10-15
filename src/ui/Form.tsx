import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { viewPaneSize } from './context.js';
import { popupPlacement } from './Popup.js';
import { wrap } from './TextArea.js';

/**
 * The pieces a popup form is made of, so forms built from them look like one
 * family. The new-issue form is the first; the older forms (dispatch, the new
 * project, review options) still draw their own option rows, and each does it
 * a little differently — values start in different columns depending on
 * whether a row fits, and choices run together. The rules here:
 *
 * - one label column, the same width everywhere, and a `›` on the focused row;
 * - a row is always exactly one line, whatever fits;
 * - the focused row explains its current choice in a fixed-height help area,
 *   so arrowing through options never changes the form's height (it lives in a
 *   popup whose height was fixed before it rendered);
 * - key hints live in the footer and nowhere else.
 */

/** Label column, including the focus marker and the gap after it. */
export const LABEL_WIDTH = 13;

/** An option a form row can hold, with what picking it means. */
export interface FormOption {
  label: string;
  /** shown in the help area while this option is the focused row's choice */
  help?: string;
}

function Label(props: { label: string; focused: boolean }) {
  return (
    <Text bold color={props.focused ? theme.accent : theme.dim}>
      {props.focused ? '› ' : '  '}
      {props.label.padEnd(LABEL_WIDTH - 2)}
    </Text>
  );
}

/**
 * One row of choices. Every option shows, separated, when they fit; otherwise
 * only the chosen one does, with where it sits in the list — a list that
 * scrolled sideways moved under the cursor and cut names in half.
 */
export function ChoiceRow(props: {
  label: string;
  options: FormOption[];
  index: number;
  focused: boolean;
  width: number;
  /** a fixed answer: shown, not chosen (e.g. triage when the repo is auto) */
  locked?: boolean;
}) {
  const { label, options, index, focused, width, locked } = props;
  const room = width - LABEL_WIDTH;
  const sep = ' · ';
  const fits = options.reduce((n, o) => n + o.label.length, 0) + sep.length * (options.length - 1) <= room;
  const chosen: FormOption = options[Math.max(0, Math.min(index, options.length - 1))] ?? { label: '—' };
  const pill = (opt: FormOption, on: boolean) => (
    <Text
      inverse={focused && on && !locked}
      bold={on}
      color={on ? (locked ? theme.dim : theme.selection) : theme.dim}
    >
      {opt.label}
    </Text>
  );
  return (
    <Box flexShrink={0}>
      <Label label={label} focused={focused && !locked} />
      {locked ? (
        <Text wrap="truncate">{pill(chosen, true)}</Text>
      ) : fits ? (
        <Text wrap="truncate">
          {options.map((opt, i) => (
            <Text key={`${opt.label}-${i}`}>
              {i > 0 && <Text dimColor>{sep}</Text>}
              {pill(opt, i === index)}
            </Text>
          ))}
        </Text>
      ) : (
        <Text wrap="truncate">
          <Text dimColor>‹ </Text>
          {pill(chosen, true)}
          <Text dimColor>
            {' ›  '}
            {index + 1} of {options.length}
          </Text>
        </Text>
      )}
    </Box>
  );
}

/**
 * The focused row's explanation, word-wrapped under the value column and
 * always exactly `lines` tall: padded when short, cut with an ellipsis when
 * long. A form whose height moved as you arrowed would jump inside its popup.
 */
export function HelpArea(props: { text?: string; width: number; lines?: number }) {
  const lines = props.lines ?? 2;
  const room = Math.max(10, props.width - LABEL_WIDTH);
  const wrapped = props.text ? wrap(props.text, room).map((l) => l.text) : [];
  if (wrapped.length > lines) {
    wrapped.length = lines;
    const last = wrapped[lines - 1];
    wrapped[lines - 1] = `${last.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  }
  while (wrapped.length < lines) wrapped.push('');
  return (
    <Box flexDirection="column" flexShrink={0}>
      {wrapped.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">
          {' '.repeat(LABEL_WIDTH)}
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}

/** The heading over a text area: the field's name, focused like a row, and a note. */
export function FieldHeading(props: { label: string; focused: boolean; note?: string }) {
  return (
    <Text wrap="truncate">
      <Label label={props.label} focused={props.focused} />
      {props.note && <Text dimColor>{props.note}</Text>}
    </Text>
  );
}

/** The form's title: what it does, and to what. */
export function FormTitle(props: { title: string; detail?: string }) {
  return (
    <Text wrap="truncate">
      <Text bold color={theme.key}>
        {props.title}
      </Text>
      {props.detail && <Text dimColor> — {props.detail}</Text>}
    </Text>
  );
}

/** Key hints, the one place a form lists them: `key what · key what`. */
export function KeyHints(props: { hints: Array<[string, string]> }) {
  return (
    <Text wrap="truncate">
      {props.hints.map(([key, what], i) => (
        <Text key={key}>
          {i > 0 && <Text dimColor> · </Text>}
          <Text color={theme.key}>{key}</Text>
          <Text dimColor> {what}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** Cycle an index with ←/→ (or h/l) — the one way every row is driven. */
export function cycleKey(
  input: string,
  key: { leftArrow: boolean; rightArrow: boolean },
  length: number,
  set: (fn: (i: number) => number) => void,
): void {
  if (length <= 1) return;
  if (key.leftArrow || input === 'h') set((i) => (i + length - 1) % length);
  if (key.rightArrow || input === 'l') set((i) => (i + 1) % length);
}

/**
 * The height of the standard form — a title, some choice rows, the help area,
 * a text area, the key hints — inside its popup border. Compact drops the
 * spacer rows and takes one line of help instead of two: what a 24-row
 * terminal can afford, where the roomy form pushes its key hints off the end.
 */
export function textFormHeight(rows: number, textLines: number, compact = false): number {
  const gaps = compact ? 0 : 3;
  const help = compact ? 1 : 2;
  return 1 + rows + help + 1 + textLines + 1 + gaps + 2;
}

/**
 * Where a standard form's popup goes and how big it is. Narrower than the
 * terminal on purpose: a form spread over 180 columns puts its labels and
 * values a head-turn apart. Roomy when three lines of text still fit with it,
 * compact when they do not; the text area takes what the rows leave, up to a
 * paragraph.
 */
export function textFormPopup(
  size: { columns: number; rows: number },
  cmdOpen: boolean,
  rows: number,
  /**
   * A form whose point is the writing — a new issue — asks for more: a wider
   * popup and a text area that takes whatever the view can spare.
   */
  room: { maxWidth?: number; maxLines?: number } = {},
): { place: { width: number; height: number; top: number; left: number }; inner: number; lines: number; compact: boolean } {
  const inner = Math.max(40, Math.min(room.maxWidth ?? 92, size.columns - 10)) - 4;
  const pane = viewPaneSize(size, cmdOpen).height;
  const compact = textFormHeight(rows, 3) > pane;
  const lines = Math.max(3, Math.min(room.maxLines ?? 8, pane - textFormHeight(rows, 0, compact) - 2));
  return {
    place: popupPlacement(size, { width: inner + 4, height: textFormHeight(rows, lines, compact) }, cmdOpen),
    inner,
    lines,
    compact,
  };
}
