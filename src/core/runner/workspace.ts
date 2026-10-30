import type { ExecResult, Workspace } from '../workspace.js';
import type { RunnerLink } from './backend.js';
import type { ToRunner } from './frames.js';

type Request = Extract<ToRunner, { id: number }>;
// spread across a union keeps it a union: each request minus its id
type Unsent = Request extends infer R ? (R extends Request ? Omit<R, 'id'> : never) : never;

/**
 * A worktree a runner serves, as a Workspace: every operation is a frame, and
 * the runner answers it with its own local Workspace — including the refusal
 * of any path that climbs out of the worktree. The daemon's code can't tell
 * this from a worktree on its own disk, which is the point; the same contract
 * check runs against both.
 *
 * `path` is the worktree as the runner sees it, which is what an agent's cwd
 * and the prompts name.
 */
export function runnerWorkspace(link: RunnerLink, path: string): Workspace {
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const watchers = new Map<number, () => void>();
  let gone: string | undefined;

  link.onFrame((frame) => {
    if (frame.t === 'reply') {
      const call = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.ok) call?.resolve(frame.value);
      else call?.reject(new Error(frame.error));
    } else if (frame.t === 'watch.changed') {
      watchers.get(frame.id)?.();
    }
  });
  link.onClose((reason) => {
    gone = `the runner went away${reason ? `: ${reason}` : ''}`;
    for (const call of pending.values()) call.reject(new Error(gone));
    pending.clear();
  });

  const request = (frame: Unsent, id = ++next): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (gone) return reject(new Error(gone));
      pending.set(id, { resolve, reject });
      link.send({ ...frame, id } as Request);
    });

  return {
    path,
    exec: async (argv, opts = {}) => {
      const { signal, ...rest } = opts;
      const id = ++next;
      const cancel = () => link.send({ t: 'exec.cancel', id });
      if (signal?.aborted) {
        return { code: -1, stdout: '', stderr: 'aborted', output: 'aborted', truncated: false };
      }
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        return (await request({ t: 'exec', argv, opts: rest }, id)) as ExecResult;
      } catch (err) {
        // the contract: exec never throws for a command, so a lost runner is a failed one
        const text = err instanceof Error ? err.message : String(err);
        return { code: -1, stdout: '', stderr: text, output: text, truncated: false };
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    readFile: async (rel) => ((await request({ t: 'fs.read', path: rel })) as string | null) ?? undefined,
    writeFile: async (rel, content) => {
      await request({ t: 'fs.write', path: rel, content });
    },
    exists: async (rel) => Boolean(await request({ t: 'fs.exists', path: rel })),
    watch: (rel, onChange) => {
      const id = ++next;
      watchers.set(id, onChange);
      void request({ t: 'watch', path: rel }, id).catch(() => watchers.delete(id));
      return () => {
        watchers.delete(id);
        if (!gone) link.send({ t: 'unwatch', id });
      };
    },
  };
}
