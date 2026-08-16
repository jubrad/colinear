import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './log.js';
import type { PendingQuestion } from './types.js';

const ANSWERS_DIR = join(STATE_DIR, 'answers');

/**
 * Answering in $EDITOR, for when the reply is a paragraph rather than one of
 * the offered options. The form covers picking; this covers writing.
 *
 * Lives in the state dir rather than the worktree: it is a message to the
 * agent, not a file the change should carry.
 */
export function answerDocPath(subject: string): string {
  return join(ANSWERS_DIR, `${subject.replace(/[^\w.-]/g, '-')}.md`);
}

/** Write the question set out as a form to fill in. Returns the path. */
export function writeAnswerDoc(subject: string, question: PendingQuestion, drafts: string[] = []): string {
  const lines: string[] = [
    `# ${subject} — ${question.questions.length === 1 ? 'a question' : `${question.questions.length} questions`} from the agent`,
    '',
    '<!-- Write your reply under each "Answer:" heading, then save and quit.',
    '     Anything you leave blank is sent as "you decide". -->',
    '',
  ];
  question.questions.forEach((q, i) => {
    lines.push(`## ${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.text}`, '');
    if (q.options.length) {
      lines.push('Options:');
      for (const opt of q.options) {
        lines.push(`- **${opt.label}**${opt.description ? ` — ${opt.description}` : ''}`);
      }
      lines.push('');
    }
    lines.push('Answer:', drafts[i]?.trim() || '', '');
  });
  mkdirSync(ANSWERS_DIR, { recursive: true });
  const path = answerDocPath(subject);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

/**
 * Read the filled-in form back. Forgiving on purpose — this is a file a human
 * edited in vim, so anything under an `Answer:` heading counts, and a question
 * left blank becomes "you decide" rather than an empty string the agent has to
 * interpret.
 */
export function parseAnswerDoc(text: string, count: number): string[] {
  const answers: string[] = [];
  // split on the numbered question headings the doc was written with
  const sections = text.split(/^##\s+\d+\.\s.*$/m).slice(1);
  for (let i = 0; i < count; i++) {
    const section = sections[i] ?? '';
    const idx = section.search(/^Answer:/m);
    if (idx === -1) {
      answers.push('you decide');
      continue;
    }
    const body = section
      .slice(idx)
      .replace(/^Answer:/, '')
      // stop at the next heading, in case an editor left one behind
      .split(/^#{1,6}\s/m)[0]
      .trim();
    answers.push(body || 'you decide');
  }
  return answers;
}
