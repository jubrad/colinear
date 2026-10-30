import type { Subtask } from './types.js';
import type { Workspace } from './workspace.js';

/** The checklist an agent keeps: `- [ ] item` / `- [x] item` lines, anything else ignored. */
export function parseSubtasks(content: string): Subtask[] {
  const subtasks: Subtask[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
    if (m) subtasks.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  return subtasks;
}

/**
 * Follow an agent's checklist file while it works, through its workspace.
 *
 * One read at a time: through a runner a read is a round trip, and a slow one
 * must not let the next tick overtake it with an older file. Stopping reads
 * once more, so the card ends on what the file said when the session ended.
 */
export function watchSubtasks(
  workspace: Workspace,
  file: string,
  onRead: (subtasks: Subtask[]) => void,
  everyMs = 2_000,
): () => Promise<void> {
  const read = async () => {
    const content = await workspace.readFile(file).catch(() => undefined);
    if (content !== undefined) onRead(parseSubtasks(content));
  };
  let reading: Promise<void> = read();
  const timer = setInterval(() => {
    reading = reading.then(read);
  }, everyMs);
  return async () => {
    clearInterval(timer);
    reading = reading.then(read);
    await reading;
  };
}
