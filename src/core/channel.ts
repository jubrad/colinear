import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, log } from './log.js';

export interface ChannelMessage {
  ts: number;
  from: string;
  kind: 'agent' | 'operator';
  text: string;
}

/**
 * Storage seam: today a local jsonl dir; a remote-executor future serves the
 * same tool surface over HTTP with a different store behind it.
 */
export interface ChannelStore {
  append(channel: string, msg: ChannelMessage): void;
  read(channel: string): ChannelMessage[];
  channels(): string[];
}

const CHANNELS_DIR = join(STATE_DIR, 'channels');
const CURSORS_FILE = join(CHANNELS_DIR, 'cursors.json');
/** a brand-new reader backfills at most this many messages */
const BACKFILL = 10;

function safeName(channel: string): string {
  return channel.replace(/[^A-Za-z0-9_-]/g, '');
}

class JsonlChannelStore implements ChannelStore {
  append(channel: string, msg: ChannelMessage): void {
    mkdirSync(CHANNELS_DIR, { recursive: true });
    appendFileSync(join(CHANNELS_DIR, `${safeName(channel)}.jsonl`), `${JSON.stringify(msg)}\n`);
  }

  read(channel: string): ChannelMessage[] {
    try {
      return readFileSync(join(CHANNELS_DIR, `${safeName(channel)}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ChannelMessage);
    } catch {
      return [];
    }
  }

  channels(): string[] {
    try {
      return readdirSync(CHANNELS_DIR)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.replace(/\.jsonl$/, ''));
    } catch {
      return [];
    }
  }
}

type Listener = () => void;

class ChannelManager {
  private store: ChannelStore = new JsonlChannelStore();
  private cursors: Record<string, number> | undefined;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private loadCursors(): Record<string, number> {
    if (!this.cursors) {
      try {
        this.cursors = JSON.parse(readFileSync(CURSORS_FILE, 'utf8')) as Record<string, number>;
      } catch {
        this.cursors = {};
      }
    }
    return this.cursors;
  }

  private saveCursors() {
    try {
      mkdirSync(CHANNELS_DIR, { recursive: true });
      writeFileSync(CURSORS_FILE, JSON.stringify(this.loadCursors()));
    } catch (err) {
      log(`channel cursor save failed: ${err}`);
    }
  }

  channels(): string[] {
    return this.store.channels();
  }

  history(channel: string): ChannelMessage[] {
    return this.store.read(channel);
  }

  post(channel: string, from: string, kind: ChannelMessage['kind'], text: string): void {
    this.store.append(channel, { ts: Date.now(), from, kind, text: text.trim() });
    this.emit();
  }

  /**
   * Messages since this reader's cursor (server-side — agents can't
   * double-pull). New readers backfill a capped tail, not full history.
   */
  readSince(channel: string, reader: string): ChannelMessage[] {
    const all = this.store.read(channel);
    const cursors = this.loadCursors();
    const key = `${safeName(channel)}:${reader}`;
    const from = cursors[key] ?? Math.max(0, all.length - BACKFILL);
    cursors[key] = all.length;
    this.saveCursors();
    // own messages are excluded: an agent already knows what it said
    return all.slice(from).filter((m) => m.from !== reader);
  }
}

export const channels = new ChannelManager();

export function formatMessages(msgs: ChannelMessage[]): string {
  if (!msgs.length) return '(no new messages)';
  return msgs
    .map((m) => `[${new Date(m.ts).toLocaleTimeString()}] ${m.kind === 'operator' ? 'OPERATOR' : m.from}: ${m.text}`)
    .join('\n');
}
