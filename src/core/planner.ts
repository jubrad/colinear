import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createIssue } from './linear.js';
import { log } from './log.js';
import type { Config, LinearIssue, LinearProject } from './types.js';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

export interface DraftSubtask {
  title: string;
  description?: string;
  priority?: number;
  selected: boolean;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/**
 * A long-lived planning conversation for one project. The agent investigates
 * the repo read-only; subtask proposals arrive as a fenced JSON block which we
 * parse into a draft list. Nothing touches Linear until approve().
 */
export class Planner {
  messages: ChatMessage[] = [];
  drafts: DraftSubtask[] = [];
  busy = false;
  error?: string;

  private q?: Query;
  private inbox: SDKUserMessage[] = [];
  private wake?: () => void;
  private stopped = false;
  private turnText = '';
  private listeners = new Set<() => void>();
  private abort = new AbortController();

  constructor(
    private cfg: Config,
    readonly project: LinearProject,
    private existingIssues: LinearIssue[],
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  send(text: string) {
    if (this.busy) return;
    this.messages.push({ role: 'user', text });
    this.busy = true;
    this.turnText = '';
    this.emit();
    const first = !this.q;
    this.push(first ? `${this.seedPrompt()}\n\n${text}` : text);
    if (first) this.start();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
  }

  /** Create the selected drafts as Linear issues in this project. */
  async approve(): Promise<string[]> {
    const teamId = this.project.teams[0]?.id;
    if (!teamId) throw new Error('project has no team');
    const picked = this.drafts.filter((d) => d.selected);
    const created: string[] = [];
    for (const draft of picked) {
      const issue = await createIssue(this.cfg, {
        teamId,
        title: draft.title,
        description: draft.description,
        projectId: this.project.id,
        priority: draft.priority,
      });
      created.push(issue.identifier);
    }
    this.drafts = this.drafts.filter((d) => !d.selected);
    this.emit();
    return created;
  }

  private push(text: string) {
    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.wake?.();
  }

  private async *inputStream(): AsyncIterable<SDKUserMessage> {
    while (!this.stopped) {
      const next = this.inbox.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private start() {
    this.q = query({
      prompt: this.inputStream(),
      options: {
        cwd: this.cfg.repo,
        model: this.cfg.model,
        permissionMode: 'default',
        settingSources: ['project'],
        abortController: this.abort,
        canUseTool: async (toolName, input) => {
          if (WRITE_TOOLS.has(toolName)) {
            return { behavior: 'deny', message: 'Planning is read-only; do not modify files.', interrupt: false };
          }
          return { behavior: 'allow', updatedInput: input };
        },
      },
    });
    void this.consume();
  }

  private async consume() {
    try {
      for await (const msg of this.q!) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.turnText += block.text;
              this.messages.push({ role: 'assistant', text: block.text.trim() });
            } else if (block.type === 'tool_use') {
              const hint = (block.input as Record<string, unknown>)?.file_path ?? (block.input as Record<string, unknown>)?.pattern ?? '';
              this.messages.push({ role: 'tool', text: `⚒ ${block.name} ${String(hint).slice(0, 60)}` });
            }
          }
          this.emit();
        }
        if (msg.type === 'result') {
          this.busy = false;
          this.parseDrafts(this.turnText);
          this.emit();
        }
      }
    } catch (err) {
      if (!this.stopped) {
        this.error = String(err);
        this.busy = false;
        log(`planner error: ${err}`);
        this.emit();
      }
    }
  }

  private parseDrafts(text: string) {
    const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
    const last = fences[fences.length - 1];
    if (!last) return;
    try {
      const parsed = JSON.parse(last[1]) as { subtasks?: Array<{ title?: string; description?: string; priority?: number }> };
      if (!Array.isArray(parsed.subtasks)) return;
      this.drafts = parsed.subtasks
        .filter((s) => s.title)
        .map((s) => ({ title: s.title!, description: s.description, priority: s.priority, selected: true }));
    } catch (err) {
      log(`draft parse failed: ${err}`);
    }
  }

  private seedPrompt(): string {
    const existing = this.existingIssues
      .map((i) => `- ${i.identifier} [${i.stateName}] ${i.title}`)
      .join('\n');
    return `You are a planning assistant inside colinear, a TUI that dispatches coding agents against Linear issues. We are planning the Linear project "${this.project.name}".

Project description: ${this.project.description || '(none)'}
Existing issues in this project:
${existing || '(none yet)'}

Your job: discuss the project with the user and converge on a set of small, well-scoped subtask issues (each completable by one coding agent in one PR). Investigate this repository (read-only) to ground scope estimates in reality.

Whenever you propose or revise the subtask breakdown, END your reply with a single fenced block of this exact shape (full replacement of any earlier proposal):

\`\`\`json
{"subtasks": [{"title": "...", "description": "context + acceptance criteria, markdown", "priority": 2}]}
\`\`\`

priority: 1 urgent, 2 high, 3 medium, 4 low. Titles must be actionable and self-contained. The user will review, toggle, and approve them into Linear — never create anything yourself.`;
  }
}

const planners = new Map<string, Planner>();

/** One persistent planner per project so navigating away keeps the conversation. */
export function plannerFor(cfg: Config, project: LinearProject, issues: LinearIssue[]): Planner {
  let p = planners.get(project.id);
  if (!p) {
    p = new Planner(cfg, project, issues);
    planners.set(project.id, p);
  }
  return p;
}
