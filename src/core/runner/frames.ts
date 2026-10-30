import type { AgentKind } from '../sessions.js';
import type { AskedQuestion, Config } from '../types.js';
import type { RunSessionOpts, SessionResult } from '../agents/shared.js';
import type { WireTool } from '../agents/tools.js';
import type { ExecOpts } from '../workspace.js';

/** Bumped when a frame changes shape; a mismatched pair refuses to talk. */
export const RUNNER_PROTOCOL = 2;

/** RunSessionOpts as data: what crosses, with what can't cross replaced by frames. */
export type WireOpts = Pick<
  RunSessionOpts,
  'prompt' | 'cwd' | 'outputSchema' | 'model' | 'fallbackModel' | 'maxTurns' | 'resume' | 'permissions'
> & {
  agent?: { kind: AgentKind; label: string; origin: string };
  /** the session stays open for messages (the daemon has a SessionInbox for it) */
  inbox: boolean;
};

export type ToRunner =
  /** workspace: the one worktree this runner serves; workspace operations are refused without it */
  | { t: 'hello'; protocol: number; cfg: Config; workspace?: string }
  | { t: 'session.start'; sid: string; runtime: string; opts: WireOpts; tools: WireTool[] }
  | { t: 'session.message'; sid: string; text: string }
  | { t: 'session.answer'; sid: string; qid: number; answers: string[] }
  | { t: 'session.abort'; sid: string }
  | { t: 'tool.result'; cid: number; ok: boolean; text: string }
  // ── the workspace: Workspace's operations, relative to its root ──
  | { t: 'exec'; id: number; argv: string[]; opts: Omit<ExecOpts, 'signal'> }
  | { t: 'exec.cancel'; id: number }
  | { t: 'fs.read'; id: number; path: string }
  | { t: 'fs.write'; id: number; path: string; content: string }
  | { t: 'fs.exists'; id: number; path: string }
  | { t: 'watch'; id: number; path: string }
  | { t: 'unwatch'; id: number };

export type FromRunner =
  | { t: 'hello'; protocol: number; version: string; runtimes: string[] }
  | { t: 'session.activity'; sid: string; line: string }
  | { t: 'session.id'; sid: string; id: string }
  | { t: 'session.usage'; sid: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { t: 'session.question'; sid: string; qid: number; kind: 'ask' | 'permission'; questions: AskedQuestion[] }
  | { t: 'session.delivered'; sid: string }
  | { t: 'session.result'; sid: string; ok: true; result: SessionResult }
  | { t: 'session.result'; sid: string; ok: false; error: string }
  | { t: 'tool.call'; sid: string; cid: number; name: string; input: Record<string, unknown> }
  /** the answer to a workspace request: `value` on success, `error` (with its message) on failure */
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'watch.changed'; id: number };
