/**
 * Drafting an issue: what the agent is asked to decide, and what it isn't.
 * `team: auto` lets it pick among the tracker's teams — by key, from a fixed
 * list — and a team or priority set in the form is never put to it at all.
 *
 * Run with `npx tsx src/core/newissue.check.ts`. `bin/check` runs it.
 */
import { draftPrompt, issueSchema, resolveTeam } from './newissue.js';
import type { Scope } from './types.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const teams: Scope[] = [
  { id: 't1', key: 'CLOUD', name: 'Cloud' },
  { id: 't2', key: 'CNS', name: 'Console' },
];

const auto = draftPrompt('the console crashes on login', undefined, teams);
check('auto lists every team by key and name', auto.includes('CLOUD — Cloud') && auto.includes('CNS — Console'), auto);
check('and asks for a key', auto.includes('team: the key of the team'));
const set = draftPrompt('the console crashes on login', undefined, undefined);
check('a team set in the form is never put to the agent', !set.includes('team:') && !set.includes('CLOUD'));
check('a priority left open is the agent\'s to judge', set.includes('priority (optional)'));
check('a priority set in the form is not', draftPrompt('x', 2, undefined).includes('omit it — the user has already set one'));

const schema = issueSchema(teams) as { properties: { team?: { enum?: string[] } }; required: string[] };
check('the schema makes team one of the keys', JSON.stringify(schema.properties.team?.enum) === '["CLOUD","CNS"]');
check('and required', schema.required.includes('team'));
check('no team field when the form chose it', !('team' in (issueSchema() as { properties: object }).properties));

check('a named team resolves to its scope', resolveTeam(teams, 'CNS').id === 't2');
let refused = '';
try {
  resolveTeam(teams, 'MADEUP');
} catch (err) {
  refused = String(err);
}
check('a team that is not one of yours is refused, not guessed', refused.includes('not one of your teams'), refused);

if (failures.length) {
  console.error(`new issue: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log('ok — auto lets the drafting agent pick a team from yours and nothing else; a team or\n     priority set in the form is filed as given and never put to it');
