import { z } from 'zod';
import { channels, formatMessages, type SessionChannels } from '../channel.js';
import type { CoordinatorTools } from '../coordinator.js';
import type { PlannedSubtask } from '../types.js';

/**
 * One of colinear's own tools, as data: what an agent sees, and what runs
 * when it calls it.
 *
 * Adapters build their tool server from these rather than from the channel
 * and coordinator objects directly. That is what lets a session run somewhere
 * other than the daemon: the specs travel without their handlers (`toWire`),
 * the far side rebuilds a tool that forwards each call back (`fromWire`), and
 * the handler — the only part that can touch the store — never leaves the
 * daemon. Identity and scope stay closed over here, so there is still no
 * parameter for an agent to lie in, however far away it runs.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** the arguments, as a zod object shape; the SDKs take this form */
  input: z.ZodRawShape;
  /** the text the agent gets back */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

/** A tool as it crosses a process boundary: no handler, and JSON Schema instead of zod. */
export interface WireTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The tools a session gets. Both surfaces are built per session with their
 * subject closed over — the channel and username for coordination, the family
 * for a coordinator — so identity and scope are enforced by construction.
 */
export function colinearTools(opts: { channels?: SessionChannels; coordinator?: CoordinatorTools }): ToolSpec[] {
  const tools: ToolSpec[] = [];
  const membership = opts.channels;
  if (membership && membership.scopes.length) {
    const { username, scopes } = membership;
    const byScope = new Map(scopes.map((s) => [s.scope, s.id]));
    const only = scopes[0].id;
    // the scope is an enum of the channels this session is actually in, so an
    // agent still cannot address one it doesn't belong to — the parameter
    // picks among memberships, it doesn't name a channel
    const scopeArg = z
      .enum(scopes.map((s) => s.scope) as [string, ...string[]])
      .optional()
      .describe(scopes.map((s) => `${s.scope} = ${s.id}`).join(', '));
    const resolve = (scope: unknown) => byScope.get(scope as 'family' | 'project') ?? only;
    const list = scopes.map((s) => `${s.id} (${s.scope})`).join(' and ');
    tools.push(
      {
        name: 'channel_read',
        description: `Read new messages on your coordination channel(s): ${list}. Only what you haven't seen; you never get the same message twice.`,
        input: { scope: scopeArg },
        handler: async ({ scope }) => formatMessages(channels.readSince(resolve(scope), username)),
      },
      {
        name: 'channel_post',
        description: `Post a short message (max ~2 lines) to a channel you are in: ${list}. Your name is stamped automatically.`,
        input: { message: z.string().min(1).max(500), scope: scopeArg },
        handler: async ({ message, scope }) => {
          const channel = resolve(scope);
          channels.post(channel, username, 'agent', String(message));
          return `posted to ${channel}`;
        },
      },
    );
  }
  const co = opts.coordinator;
  if (co) {
    tools.push(
      {
        name: 'family_status',
        description: 'The live state of every sub-issue in this family.',
        input: {},
        handler: async () => co.status(),
      },
      {
        name: 'family_message',
        description: "Send a sub-issue's agent an instruction. A running agent reads it at its next turn; an idle one is woken to read it.",
        input: { identifier: z.string().min(1), text: z.string().min(1).max(2000) },
        handler: async ({ identifier, text }) => co.message(String(identifier), String(text)),
      },
      {
        name: 'family_cancel',
        description: "Stop a sub-issue's agent. The operator can resume it later; say why.",
        input: { identifier: z.string().min(1), reason: z.string().min(1).max(500) },
        handler: async ({ identifier, reason }) => co.cancel(String(identifier), String(reason)),
      },
      {
        name: 'family_propose',
        description:
          'Propose new sub-issues. This does NOT create them — the operator reviews and approves. Tell them what you proposed and that it is waiting on them.',
        input: {
          subtasks: z
            .array(
              z.object({
                title: z.string().min(1),
                description: z.string().min(1),
                repo: z.string().optional(),
                blockedBy: z.array(z.number()).optional(),
              }),
            )
            .min(1)
            .max(10),
        },
        handler: async ({ subtasks }) => co.propose(subtasks as PlannedSubtask[]),
      },
    );
  }
  return tools;
}

/** The specs without their handlers, for a runner on the other side of a pipe or a socket. */
export function toWire(specs: ToolSpec[]): WireTool[] {
  return specs.map(({ name, description, input }) => ({
    name,
    description,
    inputSchema: z.toJSONSchema(z.object(input)) as Record<string, unknown>,
  }));
}

/**
 * Tools rebuilt on the far side: the same names, descriptions and argument
 * rules, with every call handed to `call` — which sends it back to the daemon,
 * where the real handler runs.
 */
export function fromWire(wire: WireTool[], call: (name: string, args: Record<string, unknown>) => Promise<string>): ToolSpec[] {
  return wire.map(({ name, description, inputSchema }) => {
    const schema = z.fromJSONSchema(inputSchema);
    const input = schema instanceof z.ZodObject ? (schema.shape as z.ZodRawShape) : {};
    return { name, description, input, handler: (args) => call(name, args) };
  });
}
