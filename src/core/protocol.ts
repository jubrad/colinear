import { join } from 'node:path';
import type { Change, Delta, Snapshot } from './delta.js';
import { STATE_DIR } from './log.js';
import type { Config, LinearIssue, RepoConfig, TaskEdits } from './types.js';

export const SOCKET_PATH = join(STATE_DIR, 'coli.sock');

/** Bumped when the wire format changes; a mismatched client refuses to attach. */
export const PROTOCOL_VERSION = 2;

/** Backend calls the UI makes. Anything the daemon owns lives here. */
export type Command =
  | { name: 'enqueue'; issues: LinearIssue[]; opts?: { instructions?: string; model?: string; repo?: RepoConfig; skipTriage?: boolean } }
  | { name: 'cancel'; id: string }
  | { name: 'resume'; id: string }
  | { name: 'force'; id: string }
  | { name: 'rebase'; id: string }
  | { name: 'suspend'; id: string }
  | { name: 'redispatch'; id: string; repo: RepoConfig; opts?: { retriage?: boolean; skipTriage?: boolean } }
  | { name: 'answer'; id: string; text: string }
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
  | { name: 'pollReviews' }
  | { name: 'gcScan'; olderThanDays: number }
  /** EXPERIMENTAL: operator message onto a coordination channel */
  | { name: 'channelPost'; channel: string; text: string }
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
  | { t: 'toast'; text: string; kind: 'info' | 'ok' | 'err' };

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
