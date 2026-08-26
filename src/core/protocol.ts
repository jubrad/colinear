import { join } from 'node:path';
import type { ChannelMessage } from './channel.js';
import type { Change, Delta, Snapshot } from './delta.js';
import { STATE_DIR } from './log.js';
import type { AgentSession } from './sessions.js';
import type { ProjectBrief } from './newproject.js';
import type { Config, Issue, RepoConfig, TaskEdits } from './types.js';

/**
 * Normally the socket sits with the rest of the state. COLINEAR_SOCKET moves
 * it, which matters in a container on macOS: Docker Desktop's file sharing
 * cannot represent a unix socket, so one created on a bind mount is invisible
 * from both sides. Point this at a container-internal path (/run/coli.sock)
 * and keep the bind mount for the files you actually want on the host.
 */
export const SOCKET_PATH = process.env.COLINEAR_SOCKET || join(STATE_DIR, 'coli.sock');

/** Bumped when the wire format changes; a mismatched client refuses to attach. */
export const PROTOCOL_VERSION = 13;

/** Backend calls the UI makes. Anything the daemon owns lives here. */
export type Command =
  | { name: 'enqueue'; issues: Issue[]; opts?: { instructions?: string; model?: string; repo?: RepoConfig; skipTriage?: boolean; manual?: boolean } }
  | { name: 'cancel'; id: string }
  | { name: 'resume'; id: string }
  | { name: 'force'; id: string }
  | { name: 'rebase'; id: string }
  | { name: 'suspend'; id: string }
  | { name: 'redispatch'; id: string; repo: RepoConfig; opts?: { retriage?: boolean; skipTriage?: boolean } }
  | { name: 'answer'; id: string; answers: string[] }
  | { name: 'pollPrs' }
  | { name: 'applyEdits'; id: string; edits: TaskEdits }
  | { name: 'setViewer'; viewer: { id: string; displayName: string } }
  | { name: 'reloadConfig' }
  | { name: 'startReview'; id: string }
  | { name: 'cancelReview'; id: string }
  | { name: 'suspendReview'; id: string }
  | { name: 'reviewChat'; id: string; text: string }
  | { name: 'reloadReviewDoc'; id: string }
  | { name: 'postReview'; id: string }
  | { name: 'reviewVerdict'; id: string; verdict: 'approve' | 'request-changes' }
  | { name: 'startPlan'; projectId: string }
  | { name: 'planChat'; projectId: string; text: string }
  | { name: 'reloadPlanDoc'; projectId: string }
  | { name: 'publishPlan'; projectId: string }
  | { name: 'approvePlan'; projectId: string; drop: string[]; dispatch: boolean }
  | { name: 'removePlan'; projectId: string }
  /** deterministic post of the plan summary as a tracker project update */
  | { name: 'postPlanUpdate'; projectId: string }
  /** the diff of a task's own branch, for reading it before promoting the PR */
  | { name: 'taskDiff'; id: string }
  /** review a task's own work with a fresh session */
  | { name: 'reviewTask'; id: string }
  /** edit, add or drop a finding on a task's self-review */
  | { name: 'editTaskFinding'; id: string; file: string; line: number; comment: string; severity?: string }
  /** hand the self-review back to the agent that wrote the code */
  | { name: 'sendFindings'; id: string }
  /** the PR's diff, for the annotated review view */
  | { name: 'reviewDiff'; id: string }
  /** edit, add or drop the comment anchored at a line (rewrites the document) */
  | { name: 'editFinding'; id: string; file: string; line: number; comment: string; severity?: string }
  /** every agent the daemon is running, for :agents and the creation popup */
  | { name: 'listAgents' }
  /** draft an issue from a description and file it (runs in the daemon) */
  | { name: 'createIssue'; scopeId: string; request: string }
  /** draft a project from a brief and create it (runs in the daemon) */
  | { name: 'createProject'; brief: ProjectBrief }
  /** cut a worktree and mint a session id, then hand them back to attach with */
  | { name: 'startPlanChat'; projectId: string }
  | { name: 'pollReviews' }
  | { name: 'gcScan'; olderThanDays: number }
  /** say something to a task's agent without attaching */
  | { name: 'message'; id: string; text: string; wake?: boolean }
  /** EXPERIMENTAL: operator message onto a coordination channel */
  | { name: 'channelPost'; channel: string; text: string }
  /** the daemon's own disk, for a client that isn't on the same machine */
  | { name: 'logTail'; bytes?: number }
  | { name: 'channelList' }
  | { name: 'channelHistory'; channel: string }
  | { name: 'gcRemove'; paths: string[] }
  /** store writes the UI makes directly (escalation flags, task edits, …) */
  | { name: 'change'; change: Change };

export type ClientMsg = { t: 'sync'; version: number } | { t: 'cmd'; cmd: Command };

export type ServerMsg =
  | { t: 'gc'; items: Array<{ path: string; kilobytes: number; label: string; reason: string; ageDays: number }> }
  /** one per worktree as it goes, so the UI can show progress rather than hang */
  | { t: 'gcProgress'; done: number; total: number; path: string; ok: boolean; finished: boolean }
  | { t: 'hello'; protocol: number; pid: number; cfg: Config; snapshot: Snapshot }
  | { t: 'delta'; delta: Delta }
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'toast'; text: string; kind: 'info' | 'ok' | 'err' }
  | { t: 'logTail'; text: string }
  | { t: 'agents'; list: AgentSession[] }
  | { t: 'reviewDiff'; id: string; diff: string }
  | { t: 'taskDiff'; id: string; diff: string }
  /** a daemon-side draft started; watch it in :agents by this id */
  | { t: 'creating'; agentId: string }
  /**
   * A design session is ready to be attached to. `fresh` decides the verb:
   * a new conversation is started under the id we minted (with `primer` as
   * its opening turn), an existing one is resumed.
   */
  | { t: 'planChatReady'; projectId: string; worktree: string; sessionId: string; fresh: boolean; primer?: string }
  | { t: 'channels'; list: Array<{ name: string; messages: number }> }
  | { t: 'channelHistory'; channel: string; messages: ChannelMessage[] }
  /** something the operator should see — raised by whoever has a screen */
  | { t: 'notify'; title: string; body: string; url?: string };

/** Newline-delimited JSON: one message per line, in both directions. */
export function encode(msg: ClientMsg | ServerMsg): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Feed raw chunks in, get whole messages out. */
export function createDecoder<T>(onMessage: (msg: T) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) onMessage(JSON.parse(line) as T);
      nl = buffer.indexOf('\n');
    }
  };
}
