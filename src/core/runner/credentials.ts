import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inside } from '../workspace.js';

/** One file a runner needs, relative to its credentials directory. */
export interface CredentialFile {
  path: string;
  content: string;
}

/** A complete set: every file a runner needs right now, and when it stops being good. */
export interface CredentialSet {
  /** only ever increases; a runner ignores anything older than what it holds */
  version: number;
  files: CredentialFile[];
  /** epoch ms; the earliest expiry among the files, for whoever renews them */
  expiresAt?: number;
}

/**
 * Where a daemon's runner credentials come from. The real sources are the
 * connections in design/multi-user/credentials.md; until they exist, a test
 * source stands in, and the mechanism — push, write, acknowledge — is the
 * same either way.
 */
export interface CredentialSource {
  current(): CredentialSet | undefined;
  /** called with each new set, so it can be pushed to every live runner */
  onChange(fn: (set: CredentialSet) => void): () => void;
}

/** A source whose set is replaced by hand: tests, and a fixed set of files. */
export function settableCredentials(initial?: Omit<CredentialSet, 'version'>): CredentialSource & {
  set(next: Omit<CredentialSet, 'version'>): CredentialSet;
} {
  let version = 0;
  let current: CredentialSet | undefined = initial ? { ...initial, version: ++version } : undefined;
  const listeners = new Set<(set: CredentialSet) => void>();
  return {
    current: () => current,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set: (next) => {
      current = { ...next, version: ++version };
      for (const fn of listeners) fn(current);
      return current;
    },
  };
}

/**
 * The runner's side: put a set on disk, each file whole or not at all.
 *
 * Written beside its target and renamed over it, so a CLI reading its
 * credentials never sees half a file. Owner-only. A file the new set no
 * longer names is removed: a set is complete, not a patch. Paths are relative
 * to the credentials directory and may not leave it.
 */
export function writeCredentials(dir: string, set: CredentialSet, previous?: CredentialSet): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const file of set.files) {
    const target = inside(dir, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(target), `.${process.pid}.${set.version}.tmp`);
    writeFileSync(tmp, file.content, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  }
  const kept = new Set(set.files.map((f) => f.path));
  for (const old of previous?.files ?? []) {
    if (kept.has(old.path)) continue;
    const target = inside(dir, old.path);
    if (existsSync(target)) rmSync(target, { force: true });
  }
}
