import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { configPath } from './config.js';
import { STATE_DIR } from './log.js';
import { CONTEXT, DEFAULT_CONTEXT } from './context.js';
import { providerFor } from './provider.js';
import type { Config, RepoConfig } from './types.js';

const exec = promisify(execFile);

/**
 * `coli init` — the first five minutes.
 *
 * Everything here is discoverable from inside the app eventually, but not
 * before you have a config, and you can't get one without knowing where it
 * goes. This writes it: tracker, key, repos, scope. It asks rather than
 * guesses, shows what it found rather than assuming, and never overwrites
 * without being told.
 */
export async function runInit(opts: { yes?: boolean } = {}): Promise<void> {
  // scripted setup (a container, a dotfiles bootstrap, a README one-liner):
  // the key from the environment, the repo you are standing in, no questions
  if (opts.yes) return writeNonInteractive();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin can end under you — a ctrl-D, or piped input running out. readline
  // throws ERR_USE_AFTER_CLOSE on the next question; a setup wizard should
  // stop politely instead of showing a stack trace.
  // Note: don't pre-check for a closed interface — with piped input `close`
  // fires as soon as the stream ends, while answers are still buffered. Ask,
  // and treat the throw as the end.
  const ask = async (question: string): Promise<string | undefined> => {
    try {
      return await rl.question(question);
    } catch {
      return undefined;
    }
  };
  try {
    const path = configPath();
    console.log(`\ncolinear init — writing ${path}`);
    if (CONTEXT !== DEFAULT_CONTEXT) console.log(`(context: ${CONTEXT})`);

    if (existsSync(path)) {
      const answer = await ask(`\n${path} already exists. Overwrite it? [y/N] `);
      if (!/^y/i.test((answer ?? '').trim())) {
        console.log('left it alone. Edit it with `coli` → `:config` → `e`.');
        return;
      }
    }

    console.log('\nRequirements: the `claude` CLI logged in (subscription auth — leave');
    console.log('ANTHROPIC_API_KEY unset) and `gh` authenticated.');

    const provider = await askProvider(ask);
    if (provider === undefined) return console.log('\ninput ended — nothing written.');

    let linearApiKey = '';
    let scope: string | undefined;
    if (provider === 'linear') {
      const key = await askKey(ask);
      if (key === undefined) return console.log('\ninput ended — nothing written.');
      linearApiKey = key;
      scope = await askScope(ask, { provider, linearApiKey } as unknown as Config);
    } else {
      console.log(`\nA local tracker in ${join(STATE_DIR, 'local.db')} — no account, no key.`);
      console.log('File your first issue with: coli issue add "the thing"');
    }
    const repos = await askRepos(ask);

    const seed: Record<string, unknown> = {
      provider,
      // a key in the file is a key on disk: skip it when the env already has one
      ...(provider === 'linear' && !process.env.LINEAR_API_KEY ? { linearApiKey } : {}),
      ...(scope ? { team: scope } : {}),
      repos: repos.map((r) => ({
        name: r.name,
        path: r.path,
        defaultBranch: r.defaultBranch,
        ...(r.description ? { description: r.description } : {}),
      })),
      concurrency: 3,
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`);

    console.log(`\nwrote ${path}`);
    if (process.env.LINEAR_API_KEY) console.log('(key left in your environment, not written to the file)');
    console.log('\nNext:');
    console.log('  npm run doctor    check the CLI, gh auth, the key and the repos');
    console.log('  coli              start it — `?` for help, `:` to jump between views');
    console.log('\nWorth knowing before you dispatch: agents work in per-issue git worktrees,');
    console.log('never your checkout, and they only ever open draft PRs. docs/security.md.');
  } finally {
    rl.close();
  }
}

type Ask = (question: string) => Promise<string | undefined>;

/** Which tracker. sqlite exists so you can be running without an account. */
async function askProvider(ask: Ask): Promise<string | undefined> {
  console.log('\nWhich issue tracker?');
  console.log('  1. linear — your Linear workspace (needs an API key)');
  console.log('  2. sqlite — a local tracker in a file; no account, no network');
  const pick = await ask('choice [1]: ');
  if (pick === undefined) return undefined;
  return pick.trim() === '2' || pick.trim().toLowerCase() === 'sqlite' ? 'sqlite' : 'linear';
}

async function askKey(ask: Ask): Promise<string | undefined> {
  if (process.env.LINEAR_API_KEY) {
    console.log('\nLINEAR_API_KEY found in the environment — using it.');
    return process.env.LINEAR_API_KEY;
  }
  console.log('\nLinear personal API key (linear.app → Settings → Security & access → API keys).');
  console.log('It goes in the config file, readable by you — export LINEAR_API_KEY instead if');
  console.log('you would rather it stayed out of a file.');
  for (;;) {
    const key = await ask('key: ');
    if (key === undefined) return undefined;
    if (key.trim()) return key.trim();
    console.log('(needed — colinear has nothing to show without it)');
  }
}

/** Validate the key by using it, and let them pick a team from what comes back. */
async function askScope(ask: Ask, cfg: Config): Promise<string | undefined> {
  const provider = providerFor(cfg);
  process.stdout.write(`\nchecking the key… `);
  let scopes: Array<{ key: string; name: string }> = [];
  try {
    const viewer = await provider.viewer();
    scopes = await provider.scopes();
    console.log(`ok, hello ${viewer.displayName}`);
  } catch (err) {
    console.log(`could not reach ${provider.name}: ${String(err).slice(0, 120)}`);
    console.log('(carrying on — fix the key later with `:config`)');
    return undefined;
  }
  if (!scopes.length) return undefined;
  console.log(`\nWhich ${provider.scopeLabel} should the issue list open on?`);
  scopes.slice(0, 20).forEach((s, i) => console.log(`  ${i + 1}. ${s.key} — ${s.name}`));
  console.log(`  0. all of them (or your assigned issues, whichever you prefer later)`);
  const pick = (await ask('choice [0]: ')) ?? '';
  const idx = Number.parseInt(pick.trim(), 10);
  return Number.isNaN(idx) || idx <= 0 ? undefined : scopes[idx - 1]?.key;
}

/**
 * Repos agents may work in. Offered from git remotes rather than typed: the
 * common case is "the repo I'm standing in", and the allowlist is the one
 * setting where a typo is expensive.
 */
async function askRepos(ask: Ask): Promise<RepoConfig[]> {
  const repos: RepoConfig[] = [];
  const suggestion = await gitRoot(process.cwd());
  console.log('\nRepos agents may work in. They only ever touch these, and only through');
  console.log('worktrees — your checkout is never modified.');
  for (;;) {
    const hint = repos.length ? '(enter to finish)' : suggestion ? `[${suggestion}]` : '(a path)';
    const answer = await ask(`repo path ${hint}: `);
    if (answer === undefined) break;
    const path = answer.trim() || (repos.length ? '' : suggestion ?? '');
    if (!path) break;
    if (!existsSync(join(path, '.git'))) {
      console.log(`  ${path} is not a git repository`);
      continue;
    }
    const name = basename(path);
    const defaultBranch = await headBranch(path);
    const description = (
      (await ask(`  what lives in ${name}? (triage routes issues by this, enter to skip): `)) ?? ''
    ).trim();
    repos.push({
      name,
      path,
      defaultBranch,
      remote: 'origin',
      pushRemote: 'origin',
      prBase: defaultBranch,
      worktreeRoot: `${path}-worktrees`,
      checks: [],
      ...(description ? { description } : {}),
    });
    console.log(`  added ${name} (${defaultBranch}), worktrees in ${path}-worktrees`);
  }
  if (!repos.length) console.log('(none — add them later in `:config`; nothing can be dispatched until you do)');
  return repos;
}

/** `coli init --yes`: everything inferred, nothing asked. */
async function writeNonInteractive(): Promise<void> {
  const path = configPath();
  if (existsSync(path)) {
    console.log(`${path} already exists — not overwriting. Run \`coli init\` to redo it interactively.`);
    return;
  }
  const key = process.env.LINEAR_API_KEY;
  if (!key) {
    console.error('coli init --yes needs LINEAR_API_KEY in the environment.');
    process.exit(1);
  }
  const root = await gitRoot(process.cwd());
  if (!root) {
    console.error('coli init --yes uses the git repository you are standing in — cd into one first.');
    process.exit(1);
  }
  const defaultBranch = await headBranch(root);
  const seed = {
    provider: 'linear',
    repos: [{ name: basename(root), path: root, defaultBranch }],
    concurrency: 3,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`wrote ${path}`);
  console.log(`  repo: ${basename(root)} (${defaultBranch}) — worktrees in ${root}-worktrees`);
  console.log('  key:  from LINEAR_API_KEY, not written to the file');
  console.log('\nnpm run doctor to check it, then `coli`.');
}

async function gitRoot(from: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', from, 'rev-parse', '--show-toplevel']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The repo's default branch, so we don't assume main. */
async function headBranch(repo: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return stdout.trim().replace(/^origin\//, '') || 'main';
  } catch {
    try {
      const head = readFileSync(join(repo, '.git', 'HEAD'), 'utf8');
      return head.trim().replace('ref: refs/heads/', '') || 'main';
    } catch {
      return 'main';
    }
  }
}
