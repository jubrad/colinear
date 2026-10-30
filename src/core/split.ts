import { providerFor } from './provider.js';
import type { Config, Issue, PlannedSubtask, RepoConfig, Task, TriageVerdict } from './types.js';

export interface SplitChild {
  /** index into the plan it came from */
  index: number;
  id: string;
  identifier: string;
  title: string;
  /** the repo the plan put it in, when that names one on the allowlist */
  repo?: RepoConfig;
}

/**
 * File a split plan as sub-issues of `parent`, with a `blocks` relation for
 * every dependency between two items that were both filed. `keep` drops items
 * the operator unticked in plan review; the automatic split keeps them all.
 *
 * Shared by the two ways a plan becomes issues — `A`/`D` in plan review, and
 * the daemon acting on a too_big verdict by itself (`autoSplit`) — so both
 * file the same thing.
 */
export async function fileSplit(
  cfg: Config,
  parent: Task,
  plan: PlannedSubtask[],
  keep: (index: number) => boolean = () => true,
): Promise<SplitChild[]> {
  const teamId = parent.issue.teamId;
  if (!teamId) throw new Error('parent issue has no team id — refresh issues');
  const provider = providerFor(cfg);
  const children: SplitChild[] = [];
  try {
    for (let i = 0; i < plan.length; i++) {
      if (!keep(i)) continue;
      const st = plan[i];
      const created = await provider.create({
        scopeId: teamId,
        title: st.title,
        description: `${st.description}\n\n_Split from ${parent.issue.identifier} by colinear._`,
        priority: st.priority,
        parentId: parent.issue.id,
      });
      children.push({ index: i, ...created, title: st.title, repo: cfg.repos.find((r) => r.name === st.repo) });
    }
    for (const child of children) {
      for (const dep of plan[child.index].blockedBy ?? []) {
        const blocker = children.find((c) => c.index === dep);
        if (blocker) await provider.blockIssue(blocker.id, child.id);
      }
    }
  } catch (err) {
    // what was filed stays filed; say so, or approving the plan again files it twice
    if (!children.length) throw err;
    throw new Error(`${String(err).replace(/^Error: /, '')} — after filing ${children.map((c) => c.identifier).join(', ')}`);
  }
  return children;
}

/**
 * The parent's fields once its work lives in its children: it tracks them and
 * completes when they all land. Appends, because a coordinator adds to a
 * family that already exists — replacing the list would drop every sibling
 * until the next tracker sweep.
 */
export function trackingFields(parent: Task, children: SplitChild[]): Partial<Task> {
  return {
    status: 'tracking',
    subIssues: [...(parent.subIssues ?? []), ...children.map((c) => ({ id: c.id, identifier: c.identifier, title: c.title, done: false }))],
    proposals: undefined,
  };
}

/**
 * The children as issues to dispatch, each with its plan's repo. Fetched
 * fresh rather than built from what `create` returned, so they carry the
 * blocking relations just filed — that is what holds a dependent back until
 * its blocker lands.
 */
export async function childIssues(cfg: Config, children: SplitChild[]): Promise<Array<{ issue: Issue; repo?: RepoConfig }>> {
  const issues = await providerFor(cfg).issuesByIds(children.map((c) => c.id));
  return children.flatMap((c) => {
    const issue = issues.find((x) => x.id === c.id);
    return issue ? [{ issue, repo: c.repo }] : [];
  });
}

/**
 * Whether the daemon files and dispatches a too_big plan by itself, or why
 * not — in which case the verdict parks for the operator as it always has.
 * `note` is set only when the reason is worth an activity line.
 */
export function autoSplitDecision(
  cfg: Pick<Config, 'autoSplit'>,
  task: Task,
  verdict: TriageVerdict,
  subIssues: boolean,
): { split: true } | { split: false; note?: string } {
  if (verdict.verdict !== 'too_big' || !cfg.autoSplit || !verdict.subtasks?.length) return { split: false };
  if (!subIssues) return { split: false, note: 'too big, and this tracker has no sub-issues to split it into' };
  // one level, automatically: a sub-issue judged too big again is a plan
  // that did not work, and splitting it unattended could go on and on
  if (task.issue.parent) {
    return { split: false, note: `too big, but it is already a sub-issue of ${task.issue.parent.identifier} — not splitting it again on its own` };
  }
  return { split: true };
}
