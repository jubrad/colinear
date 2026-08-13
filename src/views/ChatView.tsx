import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchProjectIssues, fetchProjects } from '../core/linear.js';
import { plannerFor, type Planner } from '../core/planner.js';
import { fuzzyMatch } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { spinner } from '../ui/format.js';
import { theme } from '../theme.js';
import { projectCache } from './ProjectsView.js';

const ROLE_PREFIX = { user: 'you   ', assistant: 'plan  ', tool: '      ' } as const;
const ROLE_COLOR = { user: theme.selection, assistant: theme.accent, tool: theme.dim } as const;

export function ChatView(props: { param?: string }) {
  const ctx = useColinear();
  const [planner, setPlanner] = useState<Planner>();
  const [error, setError] = useState<string>();
  const [, bump] = useState(0);
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState<'input' | 'drafts'>('input');
  const [draftCursor, setDraftCursor] = useState(0);

  useEffect(() => {
    const param = (props.param ?? '').toLowerCase();
    (async () => {
      const pool = projectCache.length ? projectCache : await fetchProjects(ctx.cfg);
      if (!param) {
        setError(
          `:plan needs a project — try ${pool.slice(0, 3).map((p) => `“${p.name}”`).join(', ')}` +
            ', or pick one in :projects and press p',
        );
        return;
      }
      const project =
        pool.find((p) => p.id === props.param) ??
        pool.find((p) => p.name.toLowerCase() === param) ??
        pool.find((p) => fuzzyMatch(p.name.toLowerCase(), param));
      if (!project) {
        setError(`no project matches “${props.param ?? ''}”`);
        return;
      }
      const issues = await fetchProjectIssues(ctx.cfg, project.id).catch(() => []);
      setPlanner(plannerFor(ctx.cfg, project, issues));
    })().catch((e) => setError(String(e)));
  }, [props.param]);

  useEffect(() => {
    if (!planner) return;
    return planner.subscribe(() => bump((n) => n + 1));
  }, [planner]);

  useEffect(() => ctx.setCapture(focus === 'input'), [focus]);
  useEffect(() => () => ctx.setCapture(false), []);

  const approve = useCallback(
    (dispatchAfter: boolean) => {
      if (!planner) return;
      void planner
        .approve()
        .then(async (created) => {
          if (!created.length) return ctx.toast('nothing selected', 'err');
          ctx.toast(`created ${created.join(', ')}`, 'ok');
          if (dispatchAfter) {
            const issues = await fetchProjectIssues(ctx.cfg, planner.project.id);
            const fresh = issues.filter((i) => created.includes(i.identifier));
            ctx.dispatcher.enqueue(fresh);
            ctx.toast(`created + dispatched ${fresh.length}`, 'ok');
            ctx.navigate('board');
          }
        })
        .catch((e) => ctx.toast(`create failed: ${e}`, 'err'));
    },
    [planner, ctx],
  );

  // focus toggle works from either side (TextInput ignores tab/esc)
  useInput(
    (_input, key) => {
      if (key.tab) setFocus((f) => (f === 'input' ? 'drafts' : 'input'));
      if (key.escape && focus === 'input') setFocus('drafts');
    },
    { isActive: !ctx.cmdOpen },
  );

  // drafts-focus keys
  useInput(
    (input, key) => {
      if (!planner) return;
      if (input === 'i') setFocus('input');
      if (key.upArrow || input === 'k') setDraftCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setDraftCursor((c) => Math.min(planner.drafts.length - 1, c + 1));
      if (input === ' ' && planner.drafts[draftCursor]) {
        planner.drafts[draftCursor].selected = !planner.drafts[draftCursor].selected;
        bump((n) => n + 1);
      }
      if (input === 'A') approve(false);
      if (input === 'D') approve(true);
    },
    { isActive: focus === 'drafts' && !ctx.cmdOpen },
  );

  const lines = useMemo(() => {
    const out: Array<{ role: keyof typeof ROLE_PREFIX; text: string }> = [];
    for (const m of planner?.messages ?? []) {
      const parts = m.text.split('\n');
      parts.forEach((p, i) => out.push({ role: m.role, text: i === 0 ? p : `      ${p}` }));
    }
    return out;
  }, [planner?.messages.length, planner?.busy]);

  if (error)
    return (
      <Box flexDirection="column">
        <Text color={theme.err}>{error}</Text>
        <Text dimColor>usage: :plan PROJECT (or p inside a project)</Text>
      </Box>
    );
  if (!planner) return <Text color={theme.warn}>Loading project…</Text>;

  const chatRows = Math.max(
    4,
    ctx.size.rows - 14 - (planner.drafts.length ? Math.min(planner.drafts.length, 8) + 2 : 0),
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text wrap="truncate">
        <Text bold color={theme.accent}>
          plan({planner.project.name})
        </Text>
        {planner.busy && (
          <Text color={theme.warn}>
            {' '}
            {spinner(ctx.now)} thinking…
          </Text>
        )}
        {planner.error && <Text color={theme.err}> {planner.error.slice(0, 80)}</Text>}
      </Text>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {lines.length === 0 && (
          <Text dimColor>
            Describe what this project should accomplish — the agent will investigate the repo and propose
            subtask issues you can approve into Linear.
          </Text>
        )}
        {lines.slice(-chatRows).map((l, i) => (
          <Text key={i} wrap="truncate">
            <Text color={ROLE_COLOR[l.role]} bold={l.role === 'user'}>
              {l.text.startsWith('      ') ? '' : ROLE_PREFIX[l.role]}
            </Text>
            <Text color={l.role === 'tool' ? theme.dim : undefined}>{l.text}</Text>
          </Text>
        ))}
      </Box>

      {planner.drafts.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'drafts' ? theme.borderFocus : theme.border}
          paddingX={1}
        >
          <Text bold color={theme.header}>
            DRAFT SUBTASKS{' '}
            <Text dimColor>
              (tab: focus · space: toggle · A: approve → Linear · D: approve + dispatch)
            </Text>
          </Text>
          {planner.drafts.slice(0, 8).map((d, i) => (
            <Text key={d.title} inverse={focus === 'drafts' && i === draftCursor} wrap="truncate">
              {d.selected ? '◉' : '○'} {d.title}
              {d.priority ? <Text dimColor> p{d.priority}</Text> : null}
            </Text>
          ))}
        </Box>
      )}

      <Box borderStyle="round" borderColor={focus === 'input' ? theme.borderFocus : theme.border} paddingX={1}>
        <Text color={theme.key} bold>
          {'> '}
        </Text>
        {focus === 'input' ? (
          <TextInput
            value={draft}
            placeholder={planner.busy ? 'agent is working…' : 'message the planner'}
            onChange={setDraft}
            onSubmit={(value) => {
              const text = value.trim();
              if (!text || planner.busy) return;
              planner.send(text);
              setDraft('');
            }}
          />
        ) : (
          <Text dimColor>{draft || 'press i to type'}</Text>
        )}
      </Box>
    </Box>
  );
}

export const chatKeys: Array<[string, string]> = [
  ['enter', 'send'],
  ['tab', 'input ↔ drafts'],
  ['space', 'toggle draft'],
  ['A', 'approve'],
  ['D', 'approve+dispatch'],
];
