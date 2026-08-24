import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { channels, projectChannel, type SessionChannels } from './channel.js';
import { experimentOn } from './config.js';
import type { CoordinatorTools } from './coordinator.js';
import { isDemo } from './demo.js';
import { extractFencedJson, hasFenceOpening, stripFence } from './fence.js';
import { guidanceFor } from './guidance.js';
import { STATE_DIR, log } from './log.js';
import { notify } from './notify.js';
import { providerFor } from './provider.js';
import { store } from './store.js';
import { sessionExists } from './transcripts.js';
import type { ChatTurn, Config, Issue, PlanIssue, PlanMilestone, Project, ProjectPlan } from './types.js';

const exec = promisify(execFile);

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
  /**
   * Outside-edit debounce: a tracker revision seen by one sweep but not yet
   * announced. Linear saves continuously while someone types, so a change
   * only counts once it has survived a full sweep unchanged. In-memory on
   * purpose — after a restart the next two sweeps re-detect and announce.
   */
  private pendingDocChange = new Map<string, string>();

  constructor(
    private cfg: Config,
    /**
     * The dispatcher's hands, lent rather than owned: wave-1 dispatch goes
     * through the normal pipeline, and (coordination on) the plan session may
     * message or cancel its project's agents — reach the operator already has,
     * never authority they don't.
     */
    private dispatch: {
      enqueue: (issues: Issue[]) => void;
      message: (id: string, text: string) => void;
      cancel: (id: string) => boolean;
    },
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
   * Outside-edit detection, run on the poll cadence: when a planned project's
   * tracker doc moved past what we last announced, say so — an activity line
   * and a toast, plus (coordination on) a deterministic notice to the project
   * channel. Never a session, never a rewrite of anyone's instructions, and
   * never touching docUpdatedAt: the publish guard stays armed until the
   * operator reopens the plan and pulls the new revision.
   */
  async sweepDocChanges() {
    if (!providerFor(this.cfg).capabilities.documents) return;
    for (const plan of store.listPlans()) {
      if (!plan.docId) continue;
      const docs = await providerFor(this.cfg).projectDocuments(plan.id).catch(() => []);
      const doc = docs.find((d) => d.id === plan.docId);
      if (!doc) continue;
      const seen = plan.docSeenAt ?? plan.docUpdatedAt;
      if (!seen || doc.updatedAt === seen) {
        this.pendingDocChange.delete(plan.id);
        continue;
      }
      if (this.pendingDocChange.get(plan.id) !== doc.updatedAt) {
        // first sighting, or still moving — wait for one quiet sweep
        this.pendingDocChange.set(plan.id, doc.updatedAt);
        continue;
      }
      this.pendingDocChange.delete(plan.id);
      store.updatePlan(plan.id, { docSeenAt: doc.updatedAt });
      store.addPlanActivity(plan.id, `the tracker design changed (${doc.updatedAt}) — reopen the plan to pull it`);
      this.toast(`${plan.projectName}: the design changed in the tracker`, 'info');
      if (experimentOn(this.cfg, 'coordination')) {
        this.notice(
          plan.projectName,
          `the project design ("${DOC_TITLE}") changed in the tracker (${doc.updatedAt}). Re-read it before opening a PR.`,
        );
      }
    }
  }

  /** Deterministic post to the project channel, as colinear — never the operator, never a session. */
  private notice(projectName: string, text: string) {
    channels.post(projectChannel(projectName), 'colinear', 'agent', text);
  }

  /**
   * EXPERIMENTAL (coordination): the plan session's hands on the project.
   * The same family tools a tracking parent's coordinator gets, scoped to the
   * project's dispatched issues instead of a parent's children. Reach the
   * operator already has — message, cancel — never authority they don't:
   * propose points back at the draft's fence, because the fence is the one
   * proposal surface and `A` is the one gate.
   */
  private planCoordinator(id: string): CoordinatorTools {
    const projectTasks = () => store.list().filter((t) => t.issue.projectId === id);
    const find = (identifier: string) =>
      projectTasks().find((t) => t.issue.identifier.toLowerCase() === identifier.toLowerCase());
    return {
      status: () => {
        const tasks = projectTasks();
        if (!tasks.length) return 'No dispatched issues in this project yet.';
        return tasks
          .map((t) => {
            const pr = t.prs[0];
            const bits: string[] = [t.status];
            if (t.maintenance) bits.push(t.maintenance);
            if (pr) bits.push(`PR #${pr.number} ${pr.isDraft ? 'draft' : pr.state.toLowerCase()} ${pr.checksStatus}`);
            if (t.blockedBy?.length) bits.push(`blocked by ${t.blockedBy.map((b) => b.identifier).join(', ')}`);
            if (t.error) bits.push(`error: ${t.error.slice(0, 80)}`);
            const last = t.activity.at(-1);
            return `- ${t.issue.identifier} ${t.issue.title} — ${bits.join(' · ')}${last ? `\n    last: ${last.slice(0, 100)}` : ''}`;
          })
          .join('\n');
      },
      message: (identifier, text) => {
        const target = find(identifier);
        if (!target) return `${identifier} is not a dispatched issue in this project`;
        this.dispatch.message(target.issue.id, `${text}\n\n(relayed by the project plan session)`);
        store.addPlanActivity(id, `→ ${identifier}: ${text.slice(0, 80)}`);
        return `sent to ${identifier}`;
      },
      cancel: (identifier, reason) => {
        const target = find(identifier);
        if (!target) return `${identifier} is not a dispatched issue in this project`;
        const stopped = this.dispatch.cancel(target.issue.id);
        store.addActivity(target.issue.id, `cancelled by the plan session: ${reason.slice(0, 100)}`);
        store.addPlanActivity(id, `cancelled ${identifier}: ${reason.slice(0, 80)}`);
        return stopped ? `cancelled ${identifier}` : `${identifier} had nothing running; it is parked`;
      },
      propose: (subtasks) =>
        `not here: revise the \`\`\`plan fence in your draft instead (${subtasks.length} issue${subtasks.length === 1 ? '' : 's'} noted). ` +
        'The fence is the proposal list, and the operator approves it with A — a second path around that gate is exactly what must not exist.',
    };
  }

  /**
   * What a plan session gets beyond the draft, when the coordination
   * experiment is on: membership in the project channel (as `plan`, distinct
   * from agents' issue names, the operator, and deterministic `colinear`
   * notices) and the coordinator tools above.
   */
  private sessionExtras(id: string, projectName: string): { channels?: SessionChannels; coordinator?: CoordinatorTools } {
    if (!experimentOn(this.cfg, 'coordination')) return {};
    return {
      channels: { username: 'plan', scopes: [{ scope: 'project', id: projectChannel(projectName) }] },
      coordinator: this.planCoordinator(id),
    };
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
        store.updatePlan(id, { docId: doc.id, docUpdatedAt: doc.updatedAt, docSeenAt: doc.updatedAt, published: doc.content });
        store.addPlanActivity(id, `pulled "${doc.title}" from the tracker (${doc.updatedAt})`);
        this.pendingDocChange.delete(id);
        docContent = doc.content;
      }
    }
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

    // Deliberately no session here. Planning is collaborative: the operator
    // opens the discussion (a chat turn, or `d` for the agent to open it),
    // and the design is written down when the direction is agreed — never
    // produced unprompted for the operator to react to. The first chat turn
    // starts the session with the context gathered above.
    this.absorbDraft(id);
    store.updatePlan(id, { status: 'ready' });
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
      // the first turn starts the session, primed with everything the
      // discussion (and the plan tasks it may end in) needs: the project, its
      // issues, the published design, the repo. Later turns resume it.
      const cwd = plan.worktree ?? this.cfg.repos[0]?.path ?? process.cwd();
      const prompt = plan.sessionId && sessionExists(cwd, plan.sessionId)
        ? `${text}\n\n(Draft discipline still applies: notes as we converge, the full design — prose + \`\`\`plan fence — only once the direction is agreed or I ask you to write it up.)`
        : await this.discussionOpener(id, text);
      if (prompt === undefined) return; // opener could not resolve the project; noted in chat
      const result = await runSession({
        permissions: { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools },
        prompt,
        // a session that was started interactively lives in its worktree:
        // Claude Code files transcripts per directory, so resuming from
        // anywhere else would not find the conversation
        cwd,
        // same rule as `c`: a stored id that has no transcript here would
        // fail the turn outright, so start a conversation instead of losing one
        resume: plan.sessionId && sessionExists(cwd, plan.sessionId) ? plan.sessionId : undefined,
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
        ...this.sessionExtras(id, plan.projectName),
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
      const after = store.getPlan(id);
      const count = after?.issues?.length ?? 0;
      if (count === 0 && after?.draft && hasFenceOpening(after.draft, FENCE_NAMES)) {
        store.addPlanActivity(id, '⚠ no issues parsed from the draft — check its ```plan fence');
        this.toast(`${plan.projectName}: the draft's fence did not parse`, 'err');
      } else if (count && count !== (plan.issues?.length ?? 0)) {
        store.addPlanActivity(id, `draft proposes ${count} issue${count === 1 ? '' : 's'}`);
        notify(this.cfg, plan.projectName, `plan drafted (${count} issues)`, undefined);
      }
    } finally {
      this.aborts.delete(id);
      const current = store.getPlan(id);
      if (current?.chatting) store.updatePlan(id, { chatting: false });
    }
  }

  /**
   * The first chat turn's prompt: the discussion-stance brief plus everything
   * a later "write it up" needs — the project, its issues, the published
   * design, the repo it runs in. Returns undefined (with a note in the chat)
   * when the project can't be resolved from the tracker.
   */
  private async discussionOpener(id: string, text: string): Promise<string | undefined> {
    const plan = store.getPlan(id);
    if (!plan) return undefined;
    const provider = providerFor(this.cfg);
    const project = (await provider.projects().catch(() => [] as Project[])).find((p) => p.id === id);
    if (!project) {
      store.updatePlan(id, {
        chat: [
          ...(store.getPlan(id)?.chat ?? []),
          { role: 'note', text: 'could not load the project from the tracker — reopen the plan (s) and try again', at: Date.now() },
        ],
      });
      return undefined;
    }
    const issues = await provider.projectIssues(id).catch(() => [] as Issue[]);
    store.updatePlan(id, { startedAt: plan.startedAt ?? Date.now() });
    store.addPlanActivity(id, 'discussion opened');
    return discussionPrompt(
      this.cfg,
      project,
      this.draftPath(id),
      plan.published ?? '',
      issues,
      experimentOn(this.cfg, 'coordination'),
      text,
    );
  }

  /**
   * Prepare an interactive design session: a checkout to think in and a
   * session id to think under. Both land on the plan record, and the client
   * hands them to a real `claude` in that directory.
   *
   * The id is minted here rather than discovered afterwards (`--session-id`),
   * so the conversation is colinear's from the first turn: `:plan`'s typed
   * chat resumes the same one, and `c` re-enters it.
   */
  async startChat(project: Project): Promise<{ worktree: string; sessionId: string; fresh: boolean } | undefined> {
    const id = project.id;
    if (!store.getPlan(id)) await this.start(project);
    const plan = store.getPlan(id);
    if (!plan) return undefined;
    if (isDemo(this.cfg)) {
      this.toast('demo mode — there is no repository to open a session in', 'info');
      return undefined;
    }
    const repo = this.cfg.repos[0];
    if (!repo) {
      this.toast('no repository configured to open a design session in', 'err');
      return undefined;
    }

    store.updatePlan(id, { preparingChat: true, error: undefined });
    try {
      const worktree = plan.worktree ?? (await this.planWorktree(project, repo));
      // Resume only what can actually be resumed. A stored id is not evidence
      // that a session exists: the first attempt may have died before Claude
      // Code wrote anything, or the id may belong to a conversation started in
      // another directory. Both leave `claude --resume` saying "session
      // doesn't exist" forever, so an unusable id is replaced rather than
      // retried — minting a new one also keeps --session-id from colliding
      // with a live conversation.
      const resumable = plan.sessionId && sessionExists(worktree, plan.sessionId);
      const sessionId = resumable ? plan.sessionId! : randomUUID();
      if (plan.sessionId && !resumable) {
        store.addPlanActivity(id, 'the previous design session left no transcript — starting a new one');
      }
      store.updatePlan(id, { worktree, sessionId, preparingChat: false });
      store.addPlanActivity(id, `design session ready in ${worktree}`);
      return { worktree, sessionId, fresh: !resumable };
    } catch (err) {
      store.updatePlan(id, { preparingChat: false, error: `worktree failed: ${String(err).slice(0, 200)}` });
      this.toast(`${project.name}: could not cut a worktree — ${String(err).slice(0, 80)}`, 'err');
      return undefined;
    }
  }

  /**
   * A checkout for the design conversation, on its own branch off the default
   * one. Nothing pushes it: it exists so the session can read the code, and
   * `:gc` reclaims it once the plan is gone.
   */
  private async planWorktree(
    project: Project,
    repo: { path: string; defaultBranch: string; remote?: string; worktreeRoot: string },
  ): Promise<string> {
    const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    const worktree = join(repo.worktreeRoot, `plan-${slug}`);
    if (existsSync(worktree)) return worktree;
    const remote = repo.remote ?? 'origin';
    mkdirSync(repo.worktreeRoot, { recursive: true });
    await exec('git', ['-C', repo.path, 'fetch', remote, repo.defaultBranch]).catch(() => {});
    try {
      await exec('git', ['-C', repo.path, 'worktree', 'add', worktree, '-b', `plan/${slug}`, `${remote}/${repo.defaultBranch}`]);
    } catch {
      // the branch already exists (a previous plan chat) — attach to it
      await exec('git', ['-C', repo.path, 'worktree', 'add', worktree, `plan/${slug}`]);
    }
    return worktree;
  }

  /**
   * The primer an interactive session opens with: the same brief a typed
   * first turn would build, with an opener that asks the agent to orient
   * itself and hand the conversation straight back.
   */
  async chatPrimer(id: string): Promise<string | undefined> {
    return this.discussionOpener(
      id,
      'Open the discussion: from what you can see of this project, its issues and the repository, ' +
        'frame the problem in a few lines and ask me the questions that matter most. Be brief — ' +
        'we are talking this through together, so do not write a design yet.',
    );
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
        docSeenAt: saved.updatedAt,
        published: content,
        publishedAt: Date.now(),
        status: 'published',
      });
      this.pendingDocChange.delete(id);
      store.addPlanActivity(id, `published to the tracker (${saved.updatedAt})`);
      this.toast(`${plan.projectName}: design published`, 'ok');
      if (experimentOn(this.cfg, 'coordination')) {
        this.notice(plan.projectName, `the project design ("${DOC_TITLE}") was republished (${saved.updatedAt}). Re-read it before opening a PR.`);
      }
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

    // milestones first, so issues can be filed under them at creation.
    // Same reconciliation contract: create what's missing (matched by name),
    // reuse what exists, and never delete — a milestone the plan dropped may
    // hold issues the plan never knew about.
    const milestoneIds = new Map<string, string>();
    const wantMilestones = plan.milestones ?? [];
    if (wantMilestones.length && !provider.capabilities.milestones) {
      store.addPlanActivity(
        id,
        `⚠ the fence proposes ${wantMilestones.length} milestone${wantMilestones.length === 1 ? '' : 's'} — ${provider.name} has no milestones, they were ignored`,
      );
    } else if (wantMilestones.length) {
      const have = await provider.projectMilestones(id).catch(() => []);
      for (const m of have) milestoneIds.set(normalizeTitle(m.name), m.id);
      for (const m of wantMilestones) {
        if (milestoneIds.has(normalizeTitle(m.name))) continue;
        try {
          const made = await provider.createMilestone(id, {
            name: m.name,
            targetDate: m.targetDate,
            description: m.description,
          });
          milestoneIds.set(normalizeTitle(m.name), made.id);
          store.addPlanActivity(id, `created milestone "${m.name}"`);
        } catch (err) {
          store.addPlanActivity(id, `could not create milestone "${m.name}": ${String(err).slice(0, 80)}`);
        }
      }
    }

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
      const milestoneId = issue.milestone ? milestoneIds.get(normalizeTitle(issue.milestone)) : undefined;
      if (issue.milestone && !milestoneId && provider.capabilities.milestones) {
        store.addPlanActivity(id, `⚠ "${issue.title.slice(0, 50)}" names milestone "${issue.milestone}" — not in the fence, not in the tracker; created without it`);
      }
      const made = await provider.create({
        scopeId,
        title: issue.title,
        description: `${issue.description}${provenance}`,
        projectId: id,
        priority: issue.priority,
        milestoneId,
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
        this.dispatch.enqueue(fresh);
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

  /**
   * Post the plan's summary as a tracker project update. Deterministic text
   * from the mirrored record — the review-posting rule: what reaches the
   * tracker is never a session's claim about itself.
   */
  async postUpdate(id: string) {
    const plan = store.getPlan(id);
    if (!plan) return;
    if (isDemo(this.cfg)) return this.toast('demo mode — project updates are not wired to anything', 'info');
    const provider = providerFor(this.cfg);
    if (!provider.capabilities.projectUpdates) {
      return this.toast(`${provider.name} has no project updates to post to`, 'err');
    }
    const summary = plan.summary?.trim();
    if (!summary) return this.toast('nothing to post — the plan has no summary yet', 'err');
    const counts = [
      plan.milestones?.length ? `${plan.milestones.length} milestone${plan.milestones.length === 1 ? '' : 's'}` : '',
      plan.issues?.length ? `${plan.issues.length} issue${plan.issues.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const body =
      summary +
      (counts.length ? `\n\nThe plan proposes ${counts.join(' and ')}.` : '') +
      `\n\n---\n_Posted from colinear (:plan), design revision ${plan.docUpdatedAt ?? 'draft'}._`;
    try {
      const posted = await provider.postProjectUpdate(id, body);
      store.addPlanActivity(id, `posted a project update${posted.url ? ` (${posted.url})` : ''}`);
      this.toast(`${plan.projectName}: project update posted`, 'ok');
    } catch (err) {
      store.updatePlan(id, { error: `update post failed: ${String(err).slice(0, 200)}` });
      this.toast(`${plan.projectName}: update post failed — ${String(err).slice(0, 80)}`, 'err');
    }
  }

  /** Forget a plan: abort, unwatch, drop the record and the draft file. */
  remove(id: string) {
    this.aborts.get(id)?.abort();
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.pendingDocChange.delete(id);
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
  return `# ${project.name} — design

_No design yet — this is a conversation first. Two ways to have it:_

- _**c** — a worktree and a live \`claude\` session you talk to directly, with the code to hand.
  This page is what it writes down._
- _the chat box below (**ctrl+d** sends), or **d** to have the agent open with what it can see —
  the same conversation, composed a turn at a time._

_The agent keeps notes here as you converge; say "write it up" when the direction is agreed, and
the full design (with its \`\`\`plan fence) replaces this page._
`;
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

function discussionPrompt(
  cfg: Config,
  project: Project,
  draftPath: string,
  published: string,
  issues: Issue[],
  coordinating: boolean,
  opener: string,
): string {
  const existing = issues.map((i) => `- ${i.identifier} [${i.stateName}] ${i.title}`).join('\n');
  const coordination = coordinating
    ? `

You are also this project's coordinator. Your mcp__colinear__family_* tools work on the project's dispatched issues (the "family" here is the project): family_status is the live board, fresher than the list above — use it before deciding anything; family_message reaches an issue's agent; family_cancel stops one (say why; the operator can resume it). family_propose only points you back at the fence: proposing means revising the draft, and the operator approves with A. You are in the project channel (mcp__colinear__channel_read / channel_post) as "plan" — read it before big decisions, and post what the agents working these issues need to know. Coordinate when asked or when the board plainly needs it; the discussion with the operator is still the job.`
    : '';
  return `You are the design partner for the project "${project.name}" inside colinear, a TUI that dispatches coding agents against tracker issues. The operator opened this chat to think the design through WITH you — discuss first, write later. Keep replies conversational and short, ask the questions that matter, and ground what you say in the repository you are in (read-only, briefly) whenever the discussion needs a fact.${coordination}

Existing issues in this project:
${existing || '(none yet)'}

${published.trim() ? `The published design ("${DOC_TITLE}") is in the draft file below — the discussion is presumably about changing it.` : 'There is no published design yet.'}

The draft file at ${draftPath} is your only writable artifact (use the Write tool, only that file). The tracker's copy is the source of truth; the operator publishes prose and approves issues separately. You never create or modify tracker state yourself. Draft discipline:

- While the direction is still forming, you may keep a short "## Notes from the discussion" section current at the top of the draft — agreed points, open questions, nothing more. The operator watches it to see the shared understanding form.
- Only once the direction is agreed — or the operator says to write it up — replace the draft with the full design: prose for humans (the problem, what is in scope, what is explicitly not, how anyone will know it worked; no schedules, no owners), ending in one \`\`\`plan fence holding JSON: {"milestones": [{"name", "targetDate"?, "description"?}], "issues": [{"title", "description", "repo"?, "milestone"?, "priority"?, "blockedBy"?: [sibling titles]}]}. Each issue must be completable by one coding agent in one PR. The fence never publishes — it is scaffolding the operator approves into real issues.

The operator opens:
${opener}${guidanceFor(cfg.guidance, 'plan')}`;
}
