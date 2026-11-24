import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskChat, AskStore, type AskConversation } from './ask.js';
import type { Config } from './types.js';

/**
 * The @ chat's history: conversations kept on disk, listed newest first,
 * opened again with their session, and the newest one current after a
 * restart. No agent runs here — what is pinned is what is kept.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = join(mkdtempSync(join(tmpdir(), 'colinear-ask-')), 'conversations');
const store = new AskStore(dir);
const conv = (id: string, at: number, first: string, sessionId?: string): AskConversation => ({
  id, startedAt: at, updatedAt: at, sessionId,
  messages: [{ from: 'you', text: first, at }, { from: 'colinear', text: 'done', at: at + 1 }],
});

check('nothing yet is an empty history', store.list().length === 0);
store.save({ id: 'blank', startedAt: 1, updatedAt: 1, messages: [] });
check('a conversation nothing was said in is not kept', store.list().length === 0);
store.save(conv('a', 1000, 'find the stack under o/r#1', 'sess-a'));
store.save(conv('b', 3000, 'review o/r#9'));
store.save(conv('c', 2000, 'list my  tasks\n please'));
const list = store.list();
check('newest first', list.map((h) => h.id).join() === 'b,c,a', list.map((h) => h.id).join());
check('titled by the first thing asked, on one line', list.find((h) => h.id === 'c')?.title === 'list my tasks please');
check('with how long it is', list[0].count === 2);
check('a saved conversation keeps its session', store.load('a')?.sessionId === 'sess-a');

const cfg = {} as Config;
const chat = new AskChat(cfg, () => {}, dir);
check('a restart opens the newest conversation', chat.get().id === 'b' && chat.get().messages.length === 2);
check('opening a past one brings its messages back', chat.open('a') && chat.get().id === 'a' && chat.get().messages[0].text.startsWith('find the stack'));
check('a conversation that is gone does not open', !chat.open('nope') && chat.get().id === 'a');
chat.reset();
check('a new conversation starts empty', chat.get().messages.length === 0 && chat.get().id !== 'a');
check('and the old ones stay in the history', chat.history().length === 3);

if (failures.length) {
  console.error(`ask history: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — @ conversations are kept, listed newest first, opened again with their session,\n     and the newest is current after a restart; an empty one is never kept');
