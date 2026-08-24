import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import { store } from '../core/store.js';
import { useColinear } from '../ui/context.js';
import { cell, formatTokens, spinner } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { prState, PR_STATE_COLOR } from './BoardView.js';
import { ciColor, ciText, statusText } from './taskLens.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';

/**
 * Work that was split, shown as the thing it actually is.
 *
 * A tracking parent's children are ordinary tasks, so the board scatters them
 * across its columns with nothing to say they belong together — and the parent
 * card has room for a progress bar and three titles. Colinear already builds
 * the full picture (see `familyStatus` in coordinator.ts), but only ever hands
 * it to a coordinator agent. This is that picture, for the operator.
 *
 * `:family` lists every family; `:family CLO-67` narrows to one. A sub-issue
 * that was never dispatched still gets a row — "which of these has nobody on
 * it" is most of the question.
 */
export function FamilyView(props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const actions = useTaskActions();
  const [cursor, setCursor] = useState(0);

  const families = useMemo(() => {
    const wanted = props.param?.trim().toLowerCase();
    const parents = tasks
      .filter((t) => t.subIssues?.length)
      .filter((t) => !wanted || t.issue.identifier.toLowerCase() === wanted)
      .sort((a, b) => a.issue.identifier.localeCompare(b.issue.identifier));
    return parents.map((parent) => ({
      parent,
      children: (parent.subIssues ?? []).map((sub) => ({
        sub,
        // the child's own task, when it has been dispatched
        task: store.get(sub.id),
      })),
    }));
  }, [tasks, props.param]);

  /** every selectable line, in the order they are drawn */
  const rows = useMemo(
    () =>
      families.flatMap((f) => [
        { kind: 'parent' as const, task: f.parent, label: f.parent.issue.identifier, title: f.parent.issue.title },
        ...f.children.map((c) => ({
          kind: 'child' as const,
          task: c.task,
          label: c.sub.identifier,
          title: c.sub.title,
          done: c.sub.done,
        })),
      ]),
    [families],
  );

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);
  useEffect(() => ctx.setCapture(actions.busy), [actions.busy]);
  useEffect(() => () => ctx.setCapture(false), []);

  const selected = rows[Math.min(cursor, rows.length - 1)];

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === 'g') setCursor(0);
      if (input === 'G') setCursor(Math.max(0, rows.length - 1));
      if (key.return && selected?.task) return ctx.navigate('task', selected.task.issue.identifier);
      // every other key is the board's, on whichever task the cursor is on —
      // a row with no task (never dispatched) simply has nothing to act on
      actions.handleKey(input, key, selected?.task);
    },
    { isActive: !actions.busy && !ctx.cmdOpen },
  );

  if (!families.length) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>
          {props.param
            ? `no family for “${props.param}” — the parent has to be dispatched and tracking sub-issues`
            : 'no split work: nothing on the board is tracking sub-issues'}
        </Text>
      </Box>
    );
  }

  const width = ctx.size.columns - 4;
  const titleWidth = Math.max(16, width - 12 - 15 - 17 - 10 - 9 - 4);

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text bold color={theme.header} wrap="truncate">
        {'  '}
        {cell('ISSUE', 12)}
        {cell('STATUS', 15)}
        {cell('PR', 17)}
        {cell('CI', 10)}
        {cell('TOKENS', 9)}
        {cell('TITLE', titleWidth)}
      </Text>
      {rows.map((row, i) => {
        const onCursor = i === cursor;
        const task = row.task;
        const isParent = row.kind === 'parent';
        const family = isParent ? families.find((f) => f.parent === task) : undefined;
        const done = family?.children.filter((c) => c.sub.done).length ?? 0;
        return (
          <Text key={`${row.kind}-${row.label}`} wrap="truncate" inverse={onCursor}>
            <Text bold={isParent} color={onCursor ? undefined : isParent ? theme.accent : undefined}>
              {cell(isParent ? row.label : `  ↳ ${row.label}`, 12)}
            </Text>
            <Text color={onCursor ? undefined : task ? STATUS_COLORS[task.status] : theme.dim}>
              {cell(
                isParent
                  ? `${done}/${family?.children.length ?? 0} done`
                  : task
                    ? statusText(task)
                    : row.done
                      ? 'done'
                      : 'not dispatched',
                15,
              )}
            </Text>
            <Text
              color={
                onCursor ? undefined : (task && prState(task) && PR_STATE_COLOR[prState(task)!]) || theme.dim
              }
            >
              {cell(task?.prs[0] ? `#${task.prs[0].number} ${prState(task) ?? ''}` : '', 17)}
            </Text>
            <Text color={onCursor || !task ? undefined : ciColor(task)}>{cell(task ? ciText(task) : '', 10)}</Text>
            <Text dimColor={!onCursor}>
              {cell(
                isParent
                  ? formatTokens(
                      [task, ...(family?.children.map((c) => c.task) ?? [])].reduce(
                        (sum, t) => ({
                          input: sum.input + (t?.tokens.input ?? 0),
                          output: sum.output + (t?.tokens.output ?? 0),
                          cacheRead: sum.cacheRead + (t?.tokens.cacheRead ?? 0),
                          cacheWrite: sum.cacheWrite + (t?.tokens.cacheWrite ?? 0),
                        }),
                        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      ),
                    )
                  : task
                    ? formatTokens(task.tokens)
                    : '',
                9,
              )}
            </Text>
            <Text dimColor={!onCursor}>
              {task && ['triage', 'working', 'checks'].includes(task.status) ? `${spinner(ctx.now)} ` : ''}
              {cell(row.title, titleWidth)}
            </Text>
          </Text>
        );
      })}
      {actions.modals}
    </Box>
  );
}

export const familyKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'row'],
  ['enter', 'open the task'],
  ...TASK_ACTION_KEYS,
];
