import type { AgentKind } from '../sessions.js';
import type { AskedQuestion, Config } from '../types.js';
import type { RunSessionOpts, SessionResult } from '../agents/shared.js';
import type { WireTool } from '../agents/tools.js';

/** Bumped when a frame changes shape; a mismatched pair refuses to talk. */
export const RUNNER_PROTOCOL = 1;

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
  | { t: 'hello'; protocol: number; cfg: Config }
  | { t: 'session.start'; sid: string; runtime: string; opts: WireOpts; tools: WireTool[] }
  | { t: 'session.message'; sid: string; text: string }
  | { t: 'session.answer'; sid: string; qid: number; answers: string[] }
  | { t: 'session.abort'; sid: string }
  | { t: 'tool.result'; cid: number; ok: boolean; text: string };

export type FromRunner =
  | { t: 'hello'; protocol: number; version: string; runtimes: string[] }
  | { t: 'session.activity'; sid: string; line: string }
  | { t: 'session.id'; sid: string; id: string }
  | { t: 'session.usage'; sid: string; usage: { input: number; output: number; cacheRead: number; cacheWrite: number } }
  | { t: 'session.question'; sid: string; qid: number; kind: 'ask' | 'permission'; questions: AskedQuestion[] }
  | { t: 'session.delivered'; sid: string }
  | { t: 'session.result'; sid: string; ok: true; result: SessionResult }
  | { t: 'session.result'; sid: string; ok: false; error: string }
  | { t: 'tool.call'; sid: string; cid: number; name: string; input: Record<string, unknown> };
