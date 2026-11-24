import { familyStatus, type CoordinatorTools } from './coordinator.js';
import { Dispatcher } from './dispatcher.js';
import { store } from './store.js';
import type { Config, Task } from './types.js';

/**
 * A coordinator can propose sub-issues and never create them; the operator
 * approves. What is pinned: the coordinator sees what it already proposed
 * (it re-proposed and told the operator nothing was left when it could
 * not), the same proposal twice is one, and every answer names the keys
 * that approve it.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const parent = {
  issue: { id: 'P', identifier: 'APP-1', title: 'parent' },
  status: 'tracking', activity: [], subtasks: [], prs: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  subIssues: [{ id: 'C1', identifier: 'APP-2', title: 'Backend change', done: false }],
} as unknown as Task;
store.upsert(parent);

const dispatcher = new Dispatcher({ repos: [] } as unknown as Config) as unknown as { coordinatorTools(id: string, operatorAsked?: boolean): CoordinatorTools };
const tools = dispatcher.coordinatorTools('P');
const first = tools.propose([{ title: 'Docs: document the new role', description: 'd' }]);
check('a proposal is not reported as created', /NOT created/.test(first));
check('and names the keys that approve it', /enter on APP-1 opens them, A creates them, D creates and starts them/.test(first), first);
check('it waits on the parent', store.get('P')?.proposals?.length === 1);

const again = tools.propose([{ title: 'docs: Document the new role ', description: 'same thing again' }]);
check('the same proposal twice is kept once', store.get('P')?.proposals?.length === 1 && /nothing new/.test(again), again);
tools.propose([{ title: 'Backend change', description: 'already a sub-issue' }]);
check('nor is an existing sub-issue proposed again', store.get('P')?.proposals?.length === 1);

const status = familyStatus(store.get('P')!);
check('the family status shows what is waiting for approval', /Proposed, waiting for the operator to approve/.test(status) && /Docs: document the new role/.test(status));
check('and how the operator approves it', /A creates them, D creates and starts them/.test(status));
check('a family with nothing proposed says nothing about it', !/Proposed/.test(familyStatus({ ...parent, proposals: undefined } as Task)));

// creating is the operator's to grant: only a turn they opened with a message can
check('a coordinator woken on its own cannot create', tools.create === undefined);
const asked = dispatcher.coordinatorTools('P', true);
check('one the operator messaged can', typeof asked.create === 'function');

if (failures.length) {
  console.error(`coordinator: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a coordinator sees what it already proposed, proposes each thing once, names the keys\n     that approve it, and can create only in a turn the operator opened with a message');
