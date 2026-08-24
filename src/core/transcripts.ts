import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code files a session's transcript.
 *
 * Transcripts are stored per working directory — `~/.claude/projects/<encoded
 * cwd>/<session>.jsonl` — which is why a resume only works from the directory
 * the conversation was started in. The encoding replaces every character that
 * isn't alphanumeric with a dash, so `/Users/x/.claude/y` becomes
 * `-Users-x--claude-y` (the dot collapses into a second dash).
 */
export function transcriptDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Can this session actually be resumed from this directory?
 *
 * Asking the filesystem rather than trusting a stored id, because the two
 * disagree in ways that leave the operator stuck: an id minted for a session
 * that never started, or one created somewhere else entirely. `claude
 * --resume` answers both with "session doesn't exist" and no way forward.
 */
export function sessionExists(cwd: string, sessionId: string): boolean {
  return existsSync(join(transcriptDir(cwd), `${sessionId}.jsonl`));
}
