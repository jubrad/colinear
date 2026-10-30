import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * `owner/name` from a GitHub remote URL, in any of the shapes git accepts:
 * `git@github.com:o/n.git`, `ssh://git@github.com/o/n`, `https://github.com/o/n.git`.
 * Undefined for anything that doesn't name a repository that way.
 */
export function slugFromUrl(url: string): string | undefined {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^:/]+[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

const cache = new Map<string, string | undefined>();

/**
 * The GitHub repository PRs for this repo land in, as `owner/name`.
 *
 * Asked by name rather than by running `gh` inside the main checkout, because
 * the daemon will not always have one: in a cluster, repos are addressed by
 * URL and checkouts live in workspace pods. `github` in the config says it
 * outright; otherwise it is read once from the upstream remote's URL, which is
 * the repo the docs already promise PRs land in.
 */
export async function repoSlug(repo: { path: string; remote?: string; github?: string }): Promise<string | undefined> {
  if (repo.github) return repo.github;
  const key = `${repo.path}\0${repo.remote ?? 'origin'}`;
  if (cache.has(key)) return cache.get(key);
  const { stdout } = await exec('git', ['-C', repo.path, 'remote', 'get-url', repo.remote ?? 'origin']).catch(() => ({ stdout: '' }));
  const slug = slugFromUrl(stdout);
  cache.set(key, slug);
  return slug;
}
