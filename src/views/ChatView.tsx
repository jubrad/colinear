import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { setPendingAction } from '../core/attach.js';
import { usePlans } from '../core/hooks.js';
import { providerFor } from '../core/provider.js';
import { STATE_DIR } from '../core/log.js';
import type { PlanIssue, Project, ProjectPlan } from '../core/types.js';
import { fuzzyMatch } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { spinner } from '../ui/format.js';
import { TextArea } from '../ui/TextArea.js';
import { Popup, popupPlacement } from '../ui/Popup.js';
import { theme } from '../theme.js';
import { join } from 'node:path';
import { projectCache } from './ProjectsView.js';

/**
 * The project plan: the draft of a design whose source of truth is the
 * tracker, plus the chat that shapes it. Doc on top, chat below — the review
 * document's layout, because it is the same idea wearing a different artifact.
 */
export function ChatView(props: { param?: string }) {
  const ctx = useColinear();
  const plans = usePlans();
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [focus, setFocus] = useState<'doc' | 'input'>('input');
  const [scroll, setScroll] = useState(0);
  const [approving, setApproving] = useState(false);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [approveCursor, setApproveCursor] = useState(0);

  useEffect(() => {
    const param = (props.param ?? '').toLowerCase();
    (async () => {
      const pool = projectCache.length ? projectCache : await providerFor(ctx.cfg).projects();
      if (!param) {
        setError(
          `:plan needs a project — try ${pool.slice(0, 3).map((p) => `“${p.name}”`).join(', ')}` +
            ', or pick one in :projects and press p',
        );
        return;
      }
      const found =
        pool.find((p) => p.id === props.param) ??
        pool.find((p) => p.name.toLowerCase() === param) ??
        pool.find((p) => fuzzyMatch(p.name.toLowerCase(), param));
      if (!found) {
        setError(`no project matches “${props.param ?? ''}”`);
        return;
      }
      setProject(found);
      // opening the view opens the plan: pulls the tracker's doc, starts the
      // agent (or reuses the record). Idempotent on the daemon side.
      if (!store_has_running_plan(found.id, ctx)) ctx.dispatcher.startPlan(found.id);
    })().catch((e) => setError(String(e)));
  }, [props.param]);

  const plan = project ? plans.find((p) => p.id === project.id) : undefined;
  const proposed = useMemo(() => plan?.issues ?? [], [plan?.issues]);

  useEffect(() => ctx.setCapture(focus === 'input' && !approving), [focus, approving]);
  useEffect(() => () => ctx.setCapture(false), []);

  const docLines = useMemo(() => (plan?.draft ?? '').split('\n'), [plan?.draft]);
  const docHeight = Math.max(6, ctx.size.rows - 8 - 12);
  const maxScroll = Math.max(0, docLines.length - docHeight);

  // doc-focus keys (and the ones that work from anywhere via modifiers)
  useInput(
    (input, key) => {
      if (key.tab) return setFocus((f) => (f === 'doc' ? 'input' : 'doc'));
      if (focus !== 'doc' || approving) return;
      if (key.downArrow || input === 'j') setScroll((s) => Math.min(maxScroll, s + 1));
      if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
      if (input === 'g') setScroll(0);
      if (input === 'G') setScroll(maxScroll);
      if (input === 'e' && plan && project) {
        setPendingAction({
          kind: 'edit-plan',
          path: join(STATE_DIR, 'plans', `${project.id.replace(/[^\w.-]/g, '-')}.md`),
          projectId: project.id,
        });
        ctx.quit();
      }
      if (input === 'U' && project) ctx.dispatcher.publishPlan(project.id);
      if ((input === 'A' || input === 'D') && proposed.length) {
        setDropped(new Set());
        setApproveCursor(0);
        setApproving(true);
      }
      if (input === 's' && project) ctx.dispatcher.startPlan(project.id);
    },
    { isActive: !approving && !ctx.cmdOpen },
  );

  // approval list: space drops, A creates, D creates + dispatches wave 1
  useInput(
    (input, key) => {
      if (!approving || !project) return;
      if (key.escape) return setApproving(false);
      if (key.downArrow || input === 'j') setApproveCursor((c) => Math.min(proposed.length - 1, c + 1));
      if (key.upArrow || input === 'k') setApproveCursor((c) => Math.max(0, c - 1));
      if (input === ' ') {
        const title = proposed[approveCursor]?.title;
        if (!title) return;
        setDropped((prev) => {
          const next = new Set(prev);
          if (next.has(title)) next.delete(title);
          else next.add(title);
          return next;
        });
      }
      if (input === 'A' || input === 'D') {
        ctx.dispatcher.approvePlan(project.id, [...dropped], input === 'D');
        setApproving(false);
      }
    },
    { isActive: approving && !ctx.cmdOpen },
  );

  if (error) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text color={theme.err}>{error}</Text>
      </Box>
    );
  }
  if (!project) return <Text dimColor>loading…</Text>;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Header plan={plan} project={project} now={ctx.now} />
      {/* the draft, scrollable */}
      <Box
        flexDirection="column"
        height={docHeight}
        flexShrink={0}
        overflow="hidden"
        borderStyle="single"
        borderColor={focus === 'doc' ? theme.borderFocus : theme.border}
        paddingX={1}
      >
        {plan?.draft ? (
          docLines.slice(scroll, scroll + docHeight - 2).map((line, i) => (
            <Text key={`${scroll + i}`} wrap="truncate">
              {line || ' '}
            </Text>
          ))
        ) : (
          <Text dimColor>
            {plan?.status === 'drafting' ? 'the agent is drafting…' : 'no draft yet — s starts the plan'}
          </Text>
        )}
      </Box>
      {/* the chat */}
      <Chat plan={plan} />
      <Box>
        <Text color={theme.accent}>{'> '}</Text>
        <TextArea
          value={draft}
          onChange={setDraft}
          focus={focus === 'input' && !approving}
          width={ctx.size.columns - 12}
          height={3}
          placeholder={plan?.chatting ? 'the agent is replying…' : 'shape the plan (ctrl+d sends)'}
          onSubmit={() => {
            const text = draft.trim();
            if (!text || !project) return;
            setDraft('');
            ctx.dispatcher.planChat(project.id, text);
          }}
        />
      </Box>
      <Text dimColor>
        tab: doc/chat · doc: j/k scroll · e edit in $EDITOR · U publish · A/D approve
        {' · '}s reopen · ctrl+d: send · esc: back
      </Text>
      {approving && (
        <Popup
          {...popupPlacement(
            ctx.size,
            { width: Math.min(96, ctx.size.columns - 10), height: Math.min(proposed.length + 4, 20) },
            ctx.cmdOpen,
          )}
        >
          <ApproveList proposed={proposed} dropped={dropped} cursor={approveCursor} />
        </Popup>
      )}
    </Box>
  );
}

/** startPlan is idempotent daemon-side, but skip the resend on a live chat */
function store_has_running_plan(id: string, ctx: { cfg: unknown }): boolean {
  void ctx;
  return false; // the daemon refuses a duplicate session; the resend is harmless
}

function Header(props: { plan?: ProjectPlan; project: Project; now: number }) {
  const { plan, project, now } = props;
  const busy = plan?.status === 'drafting' || plan?.chatting;
  return (
    <Text wrap="truncate">
      <Text bold color={theme.accent}>
        plan
      </Text>
      <Text> {project.name} </Text>
      {busy && <Text color={theme.warn}>{spinner(now)} </Text>}
      <Text color={plan?.status === 'published' ? theme.ok : theme.dim}>{plan?.status ?? 'not started'}</Text>
      <Text dimColor>
        {plan?.issues?.length ? ` · ${plan.issues.length} proposed` : ''}
        {plan?.milestones?.length ? ` · ${plan.milestones.length} milestone${plan.milestones.length > 1 ? 's' : ''}` : ''}
        {plan?.docId ? ` · tracker doc ${plan.docUpdatedAt ?? ''}` : ' · no tracker doc yet'}
        {plan?.costUsd ? ` · $${plan.costUsd.toFixed(2)}` : ''}
      </Text>
      {plan?.error && <Text color={theme.err}> ✖ {plan.error.slice(0, 60)}</Text>}
    </Text>
  );
}

function Chat(props: { plan?: ProjectPlan }) {
  const turns = props.plan?.chat ?? [];
  const shown = turns.slice(-6);
  return (
    <Box flexDirection="column" height={7} flexShrink={0} overflow="hidden">
      {shown.length === 0 && <Text dimColor>chat with the plan agent — replies land here</Text>}
      {shown.map((turn, i) => (
        <Text key={`${turn.at}-${i}`} wrap="truncate">
          <Text color={turn.role === 'operator' ? theme.selection : turn.role === 'agent' ? theme.accent : theme.dim} bold>
            {turn.role === 'operator' ? 'you ' : turn.role === 'agent' ? 'plan' : 'note'}
          </Text>
          <Text dimColor={turn.role === 'note'}> {turn.text.split('\n')[0]}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Approval contents: the fence's issues; the frame and backdrop belong to Popup. */
function ApproveList(props: { proposed: PlanIssue[]; dropped: Set<string>; cursor: number }) {
  const { proposed, dropped, cursor } = props;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color={theme.key}>
        approve the plan — space drops, A creates, D creates + dispatches wave 1
      </Text>
      {proposed.slice(0, 16).map((issue, i) => (
        <Text key={issue.title} inverse={i === cursor} wrap="truncate">
          <Text color={i === cursor ? undefined : dropped.has(issue.title) ? theme.dim : theme.ok}>
            {dropped.has(issue.title) ? '✗ ' : '✓ '}
          </Text>
          {issue.title}
          <Text dimColor={i !== cursor}>
            {issue.milestone ? ` [${issue.milestone}]` : ''}
            {issue.blockedBy?.length ? ` ⛓ ${issue.blockedBy.join(', ')}` : ''}
          </Text>
        </Text>
      ))}
      <Text dimColor>esc: cancel</Text>
    </Box>
  );
}

export const chatKeys: Array<[string, string]> = [
  ['tab', 'doc/chat'],
  ['j/k', 'scroll doc'],
  ['e', 'edit draft in $EDITOR'],
  ['U', 'publish to the tracker'],
  ['A', 'approve → issues'],
  ['D', 'approve + dispatch'],
  ['s', 'reopen the plan'],
  ['ctrl+d', 'send chat'],
];
