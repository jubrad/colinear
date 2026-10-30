import type { Readable, Writable } from 'node:stream';
import { createDecoder } from '../protocol.js';

/**
 * One end of a connection to a runner, whatever carries it: stdio pipes to a
 * child, a socket into a container, a WebSocket to a pod. Frames are JSON
 * objects, one per line (design/multi-user/runner.md, "The protocol").
 */
export interface Link<In, Out> {
  send(frame: Out): void;
  onFrame(fn: (frame: In) => void): void;
  /** the far end went away; `reason` says why when anything does */
  onClose(fn: (reason?: string) => void): void;
  close(): void;
}

export function streamLink<In, Out>(input: Readable, output: Writable, close: () => void = () => output.end()): Link<In, Out> {
  const frameFns: Array<(frame: In) => void> = [];
  const closeFns: Array<(reason?: string) => void> = [];
  let closed = false;
  const finish = (reason?: string) => {
    if (closed) return;
    closed = true;
    for (const fn of closeFns) fn(reason);
  };
  const decode = createDecoder<In>((frame) => {
    for (const fn of frameFns) fn(frame);
  });
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    try {
      decode(chunk);
    } catch (err) {
      finish(`unreadable frame: ${String(err).slice(0, 120)}`);
    }
  });
  input.on('end', () => finish());
  input.on('close', () => finish());
  input.on('error', (err) => finish(String(err)));
  output.on('error', (err) => finish(String(err)));
  return {
    send: (frame) => {
      if (!closed) output.write(`${JSON.stringify(frame)}\n`);
    },
    onFrame: (fn) => void frameFns.push(fn),
    onClose: (fn) => void closeFns.push(fn),
    close: () => {
      close();
      finish();
    },
  };
}
