/**
 * colinear's own tools as data: the scope rules an agent sees, and that a
 * tool keeps them when it crosses a process boundary without its handler.
 *
 * Builds specs and validates arguments; never calls a channel handler, so it
 * touches no state directory.
 *
 * Run with `npx tsx src/core/agents/tools.check.ts`. `bin/check` runs it.
 */
import { z } from 'zod';
import type { CoordinatorTools } from '../coordinator.js';
import { colinearTools, fromWire, toWire, type ToolSpec } from './tools.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const calls: string[] = [];
const coordinator: CoordinatorTools = {
  status: () => 'all green',
  message: (id, text) => (calls.push(`message ${id} ${text}`), `sent to ${id}`),
  cancel: (id, reason) => (calls.push(`cancel ${id} ${reason}`), `cancelled ${id}`),
  propose: (subtasks) => (calls.push(`propose ${subtasks.length}`), `proposed ${subtasks.length}`),
};
const membership = { username: 'ENG-7', scopes: [{ scope: 'family' as const, id: '#ENG-1' }] };

const accepts = (spec: ToolSpec | undefined, args: unknown): boolean => Boolean(spec && z.object(spec.input).safeParse(args).success);
const named = (specs: ToolSpec[], name: string) => specs.find((s) => s.name === name);

const run = async (): Promise<void> => {
  check('no channels and no coordinator: no tools', colinearTools({}).length === 0);
  check('a session in no channel gets no channel tools', colinearTools({ channels: { username: 'x', scopes: [] } }).length === 0);

  const specs = colinearTools({ channels: membership, coordinator });
  check(
    'channels and a coordinator give all six',
    specs.map((s) => s.name).join() === 'channel_read,channel_post,family_status,family_message,family_cancel,family_propose',
    specs.map((s) => s.name).join(),
  );
  const post = named(specs, 'channel_post');
  check('a post within its limit is accepted', accepts(post, { message: 'claiming the auth module' }));
  check('an empty post is refused', !accepts(post, { message: '' }));
  check('an over-long post is refused', !accepts(post, { message: 'x'.repeat(501) }));
  check('a scope the session is in is accepted', accepts(post, { message: 'hi', scope: 'family' }));
  check('a scope it is not in is refused', !accepts(post, { message: 'hi', scope: 'project' }));

  check('the coordinator answers through its handler', (await named(specs, 'family_status')!.handler({})) === 'all green');
  await named(specs, 'family_message')!.handler({ identifier: 'ENG-2', text: 'rebase first' });
  check('and reaches the family it closed over', calls.includes('message ENG-2 rebase first'), calls.join('; '));

  // across a process boundary: specs out without handlers, rebuilt on the far
  // side with every call forwarded back
  const wire = JSON.parse(JSON.stringify(toWire(specs))) as ReturnType<typeof toWire>;
  check('the wire form carries no handler', wire.every((w) => !('handler' in w)));
  const forwarded: Array<[string, Record<string, unknown>]> = [];
  const far = fromWire(wire, async (name, args) => (forwarded.push([name, args]), `ok ${name}`));
  check('every tool survives the trip', far.map((s) => s.name).join() === specs.map((s) => s.name).join());
  check('with its description', far.every((s, i) => s.description === specs[i].description));
  const farPost = named(far, 'channel_post');
  check('the scope rule survives', accepts(farPost, { message: 'hi', scope: 'family' }) && !accepts(farPost, { message: 'hi', scope: 'project' }));
  check('the length rules survive', !accepts(farPost, { message: '' }) && !accepts(farPost, { message: 'x'.repeat(501) }));
  const farPropose = named(far, 'family_propose');
  check('nested arguments survive', accepts(farPropose, { subtasks: [{ title: 't', description: 'd', blockedBy: [0] }] }));
  check('and their rules', !accepts(farPropose, { subtasks: [] }) && !accepts(farPropose, { subtasks: [{ title: 't' }] }));
  check('a far call is forwarded, not run there', (await farPost!.handler({ message: 'hi' })) === 'ok channel_post' && forwarded[0]?.[0] === 'channel_post');
};

await run();
if (failures.length) {
  console.error(`tools: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log("ok — colinear's tools keep their scope rules as data, and across a process boundary\n     without their handlers");
