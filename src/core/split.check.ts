/**
 * Splitting a too_big issue: what gets filed, how dependencies survive items
 * being dropped, what a failure part way says, and when the daemon splits on
 * its own (`autoSplit`) rather than parking the plan for the operator.
 *
 * Run with `npx tsx src/core/split.check.ts`. `bin/check` runs it.
 */
import { registerProvider, type CreateIssueInput, type IssueProvider } from './provider.js';
import { autoSplitDecision, fileSplit, trackingFields } from './split.js';
import type { Config, PlannedSubtask, Task, TriageVerdict } from './types.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

let filed: CreateIssueInput[] = [];
let blocks: Array<[string, string]> = [];
let failAt = -1;
registerProvider('splitfake', () => ({
  name: 'splitfake',
  capabilities: { subIssues: true },
  create: async (input: CreateIssueInput) => {
    if (filed.length === failAt) throw new Error('Error: tracker said no');
    filed.push(input);
    return { id: `id${filed.length}`, identifier: `ENG-${filed.length}` };
  },
  blockIssue: async (blocker: string, blocked: string) => {
    blocks.push([blocker, blocked]);
  },
}) as unknown as IssueProvider);

const cfg = {
  provider: 'splitfake',
  autoSplit: true,
  repos: [{ name: 'api' }, { name: 'web' }],
} as unknown as Config;

const parent = {
  issue: { id: 'p', identifier: 'ENG-100', teamId: 'team', title: 'big' },
  status: 'triage',
  subIssues: [{ id: 'old', identifier: 'ENG-90', title: 'already there', done: false }],
} as unknown as Task;

const plan: PlannedSubtask[] = [
  { title: 'schema', description: 'add the column', repo: 'api' },
  { title: 'endpoint', description: 'serve it', repo: 'api', blockedBy: [0] },
  { title: 'page', description: 'show it', repo: 'web', blockedBy: [0, 1] },
  { title: 'somewhere else', description: '?', repo: 'nowhere' },
];

const run = async (): Promise<void> => {
  const all = await fileSplit(cfg, parent, plan);
  check('every item is filed under the parent, in its team', filed.length === 4 && filed.every((f) => f.parentId === 'p' && f.scopeId === 'team'));
  check('each says where it came from', filed.every((f) => f.description?.includes('Split from ENG-100')));
  check('repos resolve by name', all[0].repo?.name === 'api' && all[2].repo?.name === 'web');
  check('a repo off the allowlist resolves to none', all[3].repo === undefined);
  check(
    'every dependency becomes a blocks relation',
    JSON.stringify(blocks) === JSON.stringify([['id1', 'id2'], ['id1', 'id3'], ['id2', 'id3']]),
    JSON.stringify(blocks),
  );

  filed = [];
  blocks = [];
  const kept = await fileSplit(cfg, parent, plan, (i) => i !== 1);
  check('a dropped item is not filed', kept.map((c) => c.index).join() === '0,2,3');
  check('and a dependency on it is dropped, not pointed at a neighbour', JSON.stringify(blocks) === JSON.stringify([['id1', 'id2']]), JSON.stringify(blocks));

  filed = [];
  blocks = [];
  failAt = 2;
  const err = await fileSplit(cfg, parent, plan).then(
    () => '',
    (e: unknown) => String(e),
  );
  check('a failure part way names what was already filed', err.includes('tracker said no') && err.includes('after filing ENG-1, ENG-2'), err);
  filed = [];
  failAt = 0;
  const first = await fileSplit(cfg, parent, plan).then(
    () => '',
    (e: unknown) => String(e),
  );
  check('a failure before anything was filed is just the failure', first.includes('tracker said no') && !first.includes('after filing'), first);
  failAt = -1;

  const noTeam = { ...parent, issue: { ...parent.issue, teamId: undefined } } as unknown as Task;
  check('a parent without a team files nothing', (await fileSplit(cfg, noTeam, plan).then(() => '', String)).includes('no team id'));

  const fields = trackingFields(parent, all);
  check('the parent tracks its children', fields.status === 'tracking' && fields.proposals === undefined);
  check('alongside the siblings it already had', fields.subIssues?.map((s) => s.identifier).join() === 'ENG-90,ENG-1,ENG-2,ENG-3,ENG-4');

  const tooBig: TriageVerdict = { verdict: 'too_big', reason: 'two repos', subtasks: plan };
  check('too_big with a plan splits', autoSplitDecision(cfg, parent, tooBig, true).split);
  check('the option off parks it', !autoSplitDecision({ autoSplit: false }, parent, tooBig, true).split);
  check('no plan parks it', !autoSplitDecision(cfg, parent, { ...tooBig, subtasks: [] }, true).split);
  check('needs_info is never split', !autoSplitDecision(cfg, parent, { ...tooBig, verdict: 'needs_info' }, true).split);
  check('do is never split', !autoSplitDecision(cfg, parent, { ...tooBig, verdict: 'do' }, true).split);
  const flat = autoSplitDecision(cfg, parent, tooBig, false);
  check('a tracker without sub-issues parks it, and says why', !flat.split && Boolean(flat.note));
  const child = { ...parent, issue: { ...parent.issue, parent: { id: 'gp', identifier: 'ENG-1' } } } as unknown as Task;
  const again = autoSplitDecision(cfg, child, tooBig, true);
  check('a sub-issue is not split again on its own', !again.split && Boolean(again.note?.includes('ENG-1')));
};

await run();
if (failures.length) {
  console.error(`split: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a too_big plan is filed with its dependencies intact, a failure part way names\n     what it filed, and the daemon splits on its own only one level deep');
