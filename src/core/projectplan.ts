import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { runSession, type SessionCallbacks } from './agent.js';
import { isDemo } from './demo.js';
import { extractFencedJson, hasFenceOpening, stripFence } from './fence.js';
import { guidanceFor } from './guidance.js';
import { STATE_DIR, log } from './log.js';
import { notify } from './notify.js';
import { providerFor } from './provider.js';
import { store } from './store.js';
import type { ChatTurn, Config, Issue, PlanIssue, PlanMilestone, Project, ProjectPlan } from './types.js';

const PLANS_DIR = join(STATE_DIR, 'plans');
const FENCE_NAMES = ['plan'];
const DOC_TITLE = 'Design';

/**
 * Project plans, on the review-document pattern with the storage inverted:
 * the tracker's project document is the source of truth, the file under
 * plans/ is a draft workspace, and nothing reaches the tracker until the
 * operator publishes (the prose) or approves (the fence).
 */
export class PlanManager {
  private aborts = new Map<string, AbortController>();
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private cfg: Config,
    /** dispatch hook — approval's wave 1 goes through the normal pipeline */
    private enqueue: (issues: Issue[]) => void,
  ) {
    // the drafts directory exists from birth: every entry point (start,
    // reload, an $EDITOR write) may be the first to touch it
    mkdirSync(PLANS_DIR, { recursive: true });
  }

  onToast?: (text: string, kind: 'info' | 'ok' | 'err') => void;
  private toast(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    this.onToast?.(text, kind);
  }

  draftPath(projectId: string): string {
    return join(PLANS_DIR, `${projectId.replace(/[^\w.-]/g, '-')}.md`);
  }

  shutdown() {
    for (const [id, controller] of this.aborts) {
      store.addPlanActivity(id, 'colinear quit — plan session stopped');
      controller.abort();
    }
  }

  /** After a restart, pick the draft watches back up. */
  resumeWatching() {
    for (const plan of store.listPlans()) {
      if (existsSync(this.draftPath(plan.id))) this.watchDraft(plan.id);
    }
  }

  /**
   * Open (or reopen) a project's plan: pull the tracker's design doc — the
   * source of truth — seed the draft from it, and start the agent.
   */
  async start(project: Project) {
    const id = project.id;
    if (this.aborts.has(id)) return this.toast(`${project.name}: plan session already running`, 'info');

    const existing = store.getPlan(id);
    if (!existing) {
      store.upsertPlan({
        id,
        projectName: project.name,
        status: 'drafting',
        activity: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
      });
    } else {
      store.updatePlan(id, { status: 'drafting', error: undefined });
    }
    store.addPlanActivity(id, existing ? 'reopening the plan' : 'starting a plan');

    // the tracker's copy wins: reopening always pulls fresh
    let docContent = '';
    if (providerFor(this.cfg).capabilities.documents) {
      const docs = await providerFor(this.cfg).projectDocuments(id).catch(() => []);
      const doc = docs.find((d) => d.title === DOC_TITLE) ?? docs[0];
      if (doc) {
        store.updatePlan(id, { docId: doc.id, docUpdatedAt: doc.updatedAt, published: doc.content });
        store.addPlanActivity(id, `pulled "${doc.title}" from the tracker (${doc.updatedAt})`);
        docContent = doc.content;
      }
    }
    const issues = await providerFor(this.cfg).projectIssues(id).catch(() => [] as Issue[]);

    const path = this.draftPath(id);
    writeFileSync(path, seedDraft(project, docContent));
    this.watchDraft(id);

    if (isDemo(this.cfg)) {
      // no agents in demo: the seed is the draft, parsed as-is
      writeFileSync(path, demoDraft(project));
      this.absorbDraft(id);
      store.updatePlan(id, { status: 'ready' });
      store.addPlanActivity(id, 'demo draft written — no agent ran');
      return;
    }

    const controller = new AbortController();
    this.aborts.set(id, controller);
    store.updatePlan(id, { startedAt: store.getPlan(id)?.startedAt ?? Date.now() });
    try {
      const result = await runSession({
        permissions: { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools },
        prompt: planPrompt(this.cfg, project, path, docContent, issues),
        cwd: this.cfg.repos[0]?.path ?? process.cwd(),
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
      });
      if (controller.signal.aborted) {
        store.updatePlan(id, { status: 'ready', endedAt: Date.now() });
        return;
      }
      if (result.isError) {
        store.updatePlan(id, { status: 'error', error: result.errors.join('; ').slice(0, 300), endedAt: Date.now() });
        return;
      }
      this.absorbDraft(id);
      const plan = store.getPlan(id);
      store.updatePlan(id, {
        status: 'ready',
        costUsd: (plan?.costUsd ?? 0) + result.costUsd,
        endedAt: Date.now(),
      });
      const count = store.getPlan(id)?.issues?.length ?? 0;
      if (count === 0 && hasFenceOpening(readDraft(path), FENCE_NAMES)) {
        store.addPlanActivity(id, '⚠ no issues parsed from the draft — check its ```plan fence');
        this.toast(`${project.name}: plan ready but its fence did not parse`, 'err');
      } else {
        store.addPlanActivity(id, `plan ready: ${count} issue${count === 1 ? '' : 's'} proposed`);
      }
      notify(this.cfg, project.name, `plan ready (${count} issues)`, undefined);
    } catch (err) {
      store.updatePlan(id, { status: 'error', error: String(err).slice(0, 300), endedAt: Date.now() });
      log(`plan ${id} failed: ${err}`);
    } finally {
      this.aborts.delete(id);
    }
  }

  /** One chat turn against the plan session; the reply lands in plan.chat. */
  async chat(id: string, text: string) {
    const plan = store.getPlan(id);
    if (!plan) return;
    const withTurn = (turns: ChatTurn[]) => [...(plan.chat ?? []), ...turns];
    const now = Date.now();
    const typed: ChatTurn = { role: 'operator', text, at: now };
    if (isDemo(this.cfg)) {
      store.updatePlan(id, {
        chat: withTurn([typed, { role: 'note', text: 'demo mode — the plan chat is not wired to anything', at: now }]),
      });
      return;
    }
    if (!plan.sessionId) {
      store.updatePlan(id, {
        chat: withTurn([typed, { role: 'note', text: 'No plan session yet — reopen the plan first.', at: now }]),
      });
      return;
    }
    if (this.aborts.has(id)) {
      store.updatePlan(id, {
        chat: withTurn([typed, { role: 'note', text: 'The agent is still working on the previous turn — this one was not sent.', at: now }]),
      });
      return;
    }
    store.updatePlan(id, { chat: withTurn([typed]), chatting: true });
    const controller = new AbortController();
    this.aborts.set(id, controller);
    try {
      const result = await runSession({
        permissions: { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools },
        prompt: `${text}\n\n(Keep the draft at the path you were given current: rewrite it — prose and \`\`\`plan fence — whenever this turn changes the plan.)`,
        cwd: this.cfg.repos[0]?.path ?? process.cwd(),
        resume: plan.sessionId,
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
      });
      const reply = result.isError
        ? `(the session failed: ${result.errors.join('; ').slice(0, 200)})`
        : result.text.trim() || '(no reply)';
      const current = store.getPlan(id);
      store.updatePlan(id, {
        chat: [...(current?.chat ?? []), { role: 'agent', text: reply, at: Date.now() }],
        chatting: false,
        costUsd: (current?.costUsd ?? 0) + result.costUsd,
      });
      this.absorbDraft(id);
    } finally {
      this.aborts.delete(id);
      const current = store.getPlan(id);
      if (current?.chatting) store.updatePlan(id, { chatting: false });
    }
  }

  /** Re-read the draft after an $EDITOR edit; also re-establishes the watch. */
  reloadDraft(id: string) {
    this.watchDraft(id);
    if (this.absorbDraft(id)) store.addPlanActivity(id, 'draft reloaded from disk');
  }

  /**
   * Publish: the prose (fence stripped) becomes the tracker's design doc.
   * Refuses when the tracker copy moved since the draft was cut — the tracker
   * is the source of truth, and publishing over someone's edit blind is how
   * a shared doc loses work.
   */
  async publish(id: string) {
    const plan = store.getPlan(id);
    if (!plan?.draft) return this.toast('nothing to publish — the draft is empty', 'err');
    if (isDemo(this.cfg)) return this.toast('demo mode — publishing is not wired to anything', 'info');
    if (!providerFor(this.cfg).capabilities.documents) {
      return this.toast(`${providerFor(this.cfg).name} has no project documents to publish to`, 'err');
    }
    if (plan.docId) {
      const docs = await providerFor(this.cfg).projectDocuments(id).catch(() => []);
      const current = docs.find((d) => d.id === plan.docId);
      if (current && plan.docUpdatedAt && current.updatedAt !== plan.docUpdatedAt) {
        store.addPlanActivity(id, `publish refused: the tracker doc changed (${current.updatedAt}) since this draft was cut`);
        this.toast(`${plan.projectName}: the design changed in the tracker — reopen the plan to pull it, then re-apply`, 'err');
        return;
      }
    }
    const content = stripFence(plan.draft, FENCE_NAMES);
    try {
      const saved = await providerFor(this.cfg).saveProjectDocument(id, {
        id: plan.docId,
        title: DOC_TITLE,
        content,
      });
      store.updatePlan(id, {
        docId: saved.id,
        docUpdatedAt: saved.updatedAt,
        published: content,
        publishedAt: Date.now(),
        status: 'published',
      });
      store.addPlanActivity(id, `published to the tracker (${saved.updatedAt})`);
      this.toast(`${plan.projectName}: design published`, 'ok');
    } catch (err) {
      store.updatePlan(id, { error: `publish failed: ${String(err).slice(0, 200)}` });
      this.toast(`${plan.projectName}: publish failed — ${String(err).slice(0, 80)}`, 'err');
    }
  }

  /**
   * Approve the fence: reconciliation, not creation. Creates what's missing,
   * skips what exists (and says so), lists what's no longer planned without
   * cancelling it, and dispatches wave 1 when asked.
   */
  async approve(id: string, opts: { drop: string[]; dispatch: boolean }) {
    const plan = store.getPlan(id);
    if (!plan) return;
    if (isDemo(this.cfg)) return this.toast('demo mode — approval is not wired to anything', 'info');
    const proposed = (plan.issues ?? []).filter((i) => !opts.drop.includes(i.title));
    if (!proposed.length) return this.toast('nothing to approve — the fence proposes no issues', 'err');

    const provider = providerFor(this.cfg);
    const project = (await provider.projects().catch(() => [] as Project[])).find((p) => p.id === id);
    const scopeId = project?.scopes[0]?.id;
    if (!scopeId) return this.toast(`${plan.projectName}: no ${provider.scopeLabel} to create issues in`, 'err');

    const existing = await provider.projectIssues(id).catch(() => [] as Issue[]);
    const byTitle = new Map(existing.map((i) => [normalizeTitle(i.title), i]));
    const created = new Map<string, { id: string; identifier: string }>();
    const skipped: string[] = [];

    for (const issue of proposed) {
      const match = byTitle.get(normalizeTitle(issue.title));
      if (match) {
        skipped.push(match.identifier);
        created.set(normalizeTitle(issue.title), { id: match.id, identifier: match.identifier });
        continue;
      }
      const provenance = plan.docId
        ? `\n\n---\n_From the project design (${DOC_TITLE}, ${plan.docUpdatedAt ?? 'draft'})._`
        : '';
      const made = await provider.create({
        scopeId,
        title: issue.title,
        description: `${issue.description}${provenance}`,
        projectId: id,
        priority: issue.priority,
      });
      created.set(normalizeTitle(issue.title), made);
      store.addPlanActivity(id, `created ${made.identifier}: ${issue.title.slice(0, 60)}`);
    }

    // dependencies second, once every title has an id
    if (provider.capabilities.blockers) {
      for (const issue of proposed) {
        const target = created.get(normalizeTitle(issue.title));
        if (!target) continue;
        for (const blockerTitle of issue.blockedBy ?? []) {
          const blocker = created.get(normalizeTitle(blockerTitle));
          if (!blocker) continue;
          await provider.blockIssue(blocker.id, target.id).catch((err) => {
            store.addPlanActivity(id, `could not link ${blocker.identifier} → ${target.identifier}: ${String(err).slice(0, 80)}`);
          });
        }
      }
    }

    // reality the plan no longer mentions — reported, never cancelled
    const planned = new Set(proposed.map((i) => normalizeTitle(i.title)));
    const obsolete = existing.filter(
      (i) => !planned.has(normalizeTitle(i.title)) && i.stateType !== 'completed' && i.stateType !== 'canceled',
    );
    if (obsolete.length) {
      store.addPlanActivity(id, `no longer in the plan (not cancelled): ${obsolete.map((i) => i.identifier).join(', ')}`);
    }
    if (skipped.length) {
      store.addPlanActivity(id, `already existed (skipped): ${skipped.join(', ')}`);
    }

    if (opts.dispatch) {
      // wave 1: proposed issues with no in-plan blockers; the blocked-recheck
      // sweep pulls later waves as these land
      const wave = proposed.filter((i) => !(i.blockedBy ?? []).some((b) => planned.has(normalizeTitle(b))));
      const ids = wave
        .map((i) => created.get(normalizeTitle(i.title))?.id)
        .filter((v): v is string => Boolean(v));
      const fresh = await provider.issuesByIds(ids).catch(() => [] as Issue[]);
      if (fresh.length) {
        this.enqueue(fresh);
        store.addPlanActivity(id, `dispatched wave 1: ${fresh.map((i) => i.identifier).join(', ')}`);
      }
    }
    const madeCount = [...created.values()].length - skipped.length;
    this.toast(
      `${plan.projectName}: ${madeCount} issue${madeCount === 1 ? '' : 's'} created` +
        (skipped.length ? `, ${skipped.length} existed` : '') +
        (opts.dispatch ? ', wave 1 dispatched' : ''),
      'ok',
    );
  }

  /** Forget a plan: abort, unwatch, drop the record and the draft file. */
  remove(id: string) {
    this.aborts.get(id)?.abort();
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const path = this.draftPath(id);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* the draft is scratch; a failed unlink costs nothing */
    }
    store.deletePlan(id);
  }

  private watchDraft(id: string) {
    this.watchers.get(id)?.close();
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(PLANS_DIR, (_event, filename) => {
        if (filename !== `${id.replace(/[^\w.-]/g, '-')}.md`) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.absorbDraft(id), 300);
        timer.unref();
      });
      watcher.unref();
      this.watchers.set(id, watcher);
    } catch (err) {
      log(`plan ${id}: cannot watch ${PLANS_DIR}: ${String(err).slice(0, 80)}`);
    }
  }

  private absorbDraft(id: string): boolean {
    const path = this.draftPath(id);
    if (!existsSync(path)) return false;
    const draft = readDraft(path);
    const { summary, milestones, issues } = parseDraft(draft);
    store.updatePlan(id, { draft, summary, milestones, issues });
    return true;
  }

  private callbacks(id: string): SessionCallbacks {
    return {
      onActivity: (line) => store.addPlanActivity(id, line),
      onSessionId: (sessionId) => store.updatePlan(id, { sessionId }),
      onUsage: (u) => {
        const plan = store.getPlan(id);
        if (!plan) return;
        store.updatePlan(id, {
          tokens: {
            input: plan.tokens.input + u.input,
            output: plan.tokens.output + u.output,
            cacheRead: plan.tokens.cacheRead + u.cacheRead,
            cacheWrite: plan.tokens.cacheWrite + u.cacheWrite,
          },
        });
      },
      // the chat IS the steering channel: routing AskUserQuestion through the
      // mirror would need its own answer path for a question the operator can
      // simply answer in the next turn. Tell the agent to ask there instead.
      onQuestion: (question) => {
        question.answer(
          question.questions.map(
            () => 'use your best judgment, and put the question in your reply text so the operator sees it in the chat',
          ),
        );
      },
    };
  }
}

const readDraft = (path: string): string => readFileSync(path, 'utf8').slice(0, 200_000);

const normalizeTitle = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, ' ');

/** prose summary + the parsed fence, same contract as the review doc */
function parseDraft(text: string): { summary: string; milestones: PlanMilestone[]; issues: PlanIssue[] } {
  const fence = extractFencedJson(text, FENCE_NAMES);
  const value = (fence?.value ?? {}) as { milestones?: unknown; issues?: unknown };
  const milestones = Array.isArray(value.milestones)
    ? value.milestones.flatMap((raw) => {
        const m = raw as Partial<PlanMilestone>;
        return typeof m?.name === 'string' && m.name.trim()
          ? [{ name: m.name.trim(), targetDate: m.targetDate, description: m.description }]
          : [];
      })
    : [];
  const issues = Array.isArray(value.issues)
    ? value.issues.flatMap((raw) => {
        const i = raw as Partial<PlanIssue>;
        if (typeof i?.title !== 'string' || !i.title.trim()) return [];
        return [
          {
            title: i.title.trim(),
            description: typeof i.description === 'string' ? i.description : '',
            repo: typeof i.repo === 'string' ? i.repo : undefined,
            milestone: typeof i.milestone === 'string' ? i.milestone : undefined,
            priority: typeof i.priority === 'number' ? i.priority : undefined,
            blockedBy: Array.isArray(i.blockedBy) ? i.blockedBy.filter((b): b is string => typeof b === 'string') : undefined,
          },
        ];
      })
    : [];
  const prose = (fence ? text.slice(0, fence.start) + text.slice(fence.end) : text).trim();
  const summary =
    prose
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith('#')) ?? prose.slice(0, 500);
  return { summary, milestones, issues };
}

function seedDraft(project: Project, published: string): string {
  if (published.trim()) return `${published.trim()}\n`;
  return `# ${project.name} — design\n\n_No design document yet. The plan agent drafts here; publish sends the prose to the tracker._\n`;
}

function demoDraft(project: Project): string {
  return `# ${project.name} — design

The demo plan: a short brief with a fence, so the whole flow is visible without an agent.

\`\`\`plan
{
  "milestones": [{ "name": "First cut" }],
  "issues": [
    { "title": "Lay out the data model", "description": "Tables and their owners.", "milestone": "First cut" },
    { "title": "Build the summary view", "description": "Reads the model above.", "milestone": "First cut", "blockedBy": ["Lay out the data model"] }
  ]
}
\`\`\`
`;
}

function planPrompt(cfg: Config, project: Project, draftPath: string, published: string, issues: Issue[]): string {
  const existing = issues.map((i) => `- ${i.identifier} [${i.stateName}] ${i.title}`).join('\n');
  return `You are the planning agent for the project "${project.name}" inside colinear, a TUI that dispatches coding agents against tracker issues.

Your artifact is the draft at ${draftPath} — the working copy of the project's design document. The tracker's copy is the source of truth; the operator publishes your prose there when it is right, and approves your proposed issues into the tracker separately. You never create or modify tracker state yourself.

${published.trim() ? 'The draft currently holds the published design — revise it rather than starting over.' : 'There is no published design yet — write the first draft.'}

Existing issues in this project:
${existing || '(none yet)'}

Investigate the repository you are in (read-only, briefly) to ground component names and scope estimates in reality. Then write the draft:

- Prose for humans: the problem, what is in scope, what is explicitly not, and how anyone will know it worked. No schedules, no owners — those live in the tracker.
- End the file with one \`\`\`plan fence holding JSON: {"milestones": [{"name", "targetDate"?, "description"?}], "issues": [{"title", "description", "repo"?, "milestone"?, "priority"?, "blockedBy"?: [sibling titles]}]}. Each issue must be completable by one coding agent in one PR. The fence never publishes — it is scaffolding the operator approves into real issues.

Write the whole file with the Write tool (only that file), keep it current on every revision, and reply briefly — the draft is the artifact, not your reply.${guidanceFor(cfg.guidance, 'plan')}`;
}
