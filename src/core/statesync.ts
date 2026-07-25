import { fetchWorkflowStates, updateIssueState } from './linear.js';
import { log } from './log.js';
import { store } from './store.js';
import type { Config, LinearIssue, WorkflowState } from './types.js';

const stateCache = new Map<string, WorkflowState[]>();

async function statesFor(cfg: Config, teamId: string): Promise<WorkflowState[]> {
  const cached = stateCache.get(teamId);
  if (cached) return cached;
  const states = await fetchWorkflowStates(cfg, teamId);
  stateCache.set(teamId, states);
  return states;
}

/**
 * Best-effort Linear state moves (config stateSync):
 * dispatch -> first `started` state; PR opened -> a review-ish started state.
 */
export async function syncIssueState(cfg: Config, issue: LinearIssue, kind: 'started' | 'review'): Promise<void> {
  if (!cfg.stateSync || !issue.teamId) return;
  try {
    const states = await statesFor(cfg, issue.teamId);
    const started = states.filter((s) => s.type === 'started').sort((a, b) => a.position - b.position);
    const target =
      kind === 'review' ? started.find((s) => /review/i.test(s.name)) : started[0];
    if (!target || target.name === issue.stateName) return;
    await updateIssueState(cfg, issue.id, target.id);
    store.addActivity(issue.id, `linear state → ${target.name}`);
  } catch (err) {
    log(`state sync failed for ${issue.identifier}: ${err}`);
  }
}
