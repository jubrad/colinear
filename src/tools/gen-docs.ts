import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { views } from '../views/registry.js';

/**
 * Keep the docs honest about the views that actually exist.
 *
 * The registry knows every view, its aliases and its one-line description, so
 * the index table in docs/README.md is generated from it — that table is the
 * one place a new view is most often forgotten. Everything else is *checked*
 * rather than rewritten: a page per view, and every alias mentioned on its own
 * page. Prose is written by hand and stays that way; a generator that edits
 * sentences does more damage than the drift it prevents.
 *
 *   bin/gen-docs            write it
 *   bin/gen-docs --check    fail if it would change anything
 */

const ROOT = new URL('../../', import.meta.url).pathname;
const VIEWS_DIR = join(ROOT, 'docs/views');
const INDEX = join(ROOT, 'docs/README.md');

const BEGIN = '<!-- generated: views (bin/gen-docs) -->';
const END = '<!-- /generated -->';

const check = process.argv.includes('--check');
const errors: string[] = [];
const stale: string[] = [];

// the registry loads custom views from the user's config dir on import; those
// are somebody's local JSON, not part of the shipped docs
const builtin = views.filter((v) => !v.custom);
const pages = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.md'));

/** Which page documents a view — its own, or a sibling's that covers both. */
function pageFor(name: string): string | undefined {
  if (pages.includes(`${name}.md`)) return `${name}.md`;
  return pages.find((p) => {
    const text = readFileSync(join(VIEWS_DIR, p), 'utf8');
    const heading = text.split('\n').find((l) => l.startsWith('# ')) ?? '';
    return heading.includes(`\`:${name}\``);
  });
}

const table = [
  '| view | aliases | what it\'s for |',
  '|---|---|---|',
  ...builtin.map((v) => {
    const page = pageFor(v.name);
    const link = page ? `[\`:${v.name}\`](views/${page})` : `\`:${v.name}\``;
    const aliases = v.aliases.length ? v.aliases.map((a) => `\`${a}\``).join(' ') : '—';
    return `| ${link} | ${aliases} | ${v.describe} |`;
  }),
].join('\n');

const index = readFileSync(INDEX, 'utf8');
const begin = index.indexOf(BEGIN);
const end = index.indexOf(END);
if (begin < 0 || end < 0) {
  errors.push(`docs/README.md has no ${BEGIN} … ${END} block for the views table`);
} else {
  const next = `${index.slice(0, begin + BEGIN.length)}\n${table}\n${index.slice(end)}`;
  if (next !== index) {
    stale.push('docs/README.md — views table');
    if (!check) writeFileSync(INDEX, next);
  }
}

for (const view of builtin) {
  const page = pageFor(view.name);
  if (!page) {
    errors.push(`:${view.name} has no page in docs/views/ — every view needs one`);
    continue;
  }
  // aliases are typed by hand into the page's opening line; they only have to
  // be *there*, in whatever sentence reads best
  const text = readFileSync(join(VIEWS_DIR, page), 'utf8');
  const missing = view.aliases.filter((a) => !text.includes(`\`${a}\``));
  if (missing.length) {
    errors.push(
      `docs/views/${page} never mentions ${missing.map((a) => `\`${a}\``).join(', ')} — an alias of :${view.name}`,
    );
  }
}

for (const page of pages) {
  const name = basename(page, '.md');
  if (!builtin.some((v) => v.name === name)) {
    errors.push(`docs/views/${page} documents ":${name}", which is not a view`);
  }
}

for (const e of errors) console.error(`error: ${e}`);
for (const s of stale) console.log(`${check ? 'stale' : 'updated'}: ${s}`);

if (errors.length) process.exit(1);
if (check && stale.length) {
  console.error('\ndocs are out of date — run bin/gen-docs and commit the result');
  process.exit(1);
}
if (!stale.length) console.log(`docs match the registry (${builtin.length} views)`);
