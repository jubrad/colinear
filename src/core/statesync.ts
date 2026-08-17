import { providerFor } from './provider.js';
import { log } from './log.js';
import { store } from './store.js';
import type { Config, Issue, WorkflowState } from './types.js';

const stateCache = new Map<string, WorkflowState[]>();

async function statesFor(cfg: Config, teamId: string): Promise<WorkflowState[]> {
  const cached = stateCache.get(teamId);
  if (cached) return cached;
  const states = await providerFor(cfg).workflowStates(teamId);
  stateCache.set(teamId, states);
  return states;
}

/**
 * Best-effort issue-state moves (config stateSync): dispatch -> first
 * `started` state; PR opened -> a review-ish started state. A tracker with no
 * workflow states (GitHub Issues has open and closed) simply doesn't do this.
 */
export async function syncIssueState(cfg: Config, issue: Issue, kind: 'started' | 'review'): Promise<void> {
  if (!cfg.stateSync || !issue.teamId) return;
  if (!providerFor(cfg).capabilities.workflowStates) return;
  try {
    const states = await statesFor(cfg, issue.teamId);
    const started = states.filter((s) => s.type === 'started').sort((a, b) => a.position - b.position);
    const target =
      kind === 'review' ? started.find((s) => /review/i.test(s.name)) : started[0];
    if (!target || target.name === issue.stateName) return;
    await providerFor(cfg).setState(issue.id, target.id);
    store.addActivity(issue.id, `issue state → ${target.name}`);
  } catch (err) {
    log(`state sync failed for ${issue.identifier}: ${err}`);
  }
}
