import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** One model a runtime said it can run, as it named it. */
export interface DiscoveredModel {
  /** what goes in the config or a picker — the runtime's own name for it */
  value: string;
  /** the runtime's display name, when it gave one */
  label?: string;
  description?: string;
}

/** Per runtime: what it listed last, and when. */
export type ModelCatalog = Record<string, { models: DiscoveredModel[]; at: number }>;

/** How often the daemon asks again. New models ship in weeks, not hours. */
export const CATALOG_REFRESH_MS = 24 * 60 * 60_000;

/**
 * The models each runtime reports, as last heard.
 *
 * The pickers used to offer a list compiled into colinear, which was out of
 * date the week a model shipped — a new one could be typed into the config
 * but not picked. The runtimes know better: Claude Code lists what this
 * account can run, Codex lists what its build knows. The daemon asks them
 * (on start and daily), keeps the answer on disk so a restart has it at once,
 * and sends it to every client, which merges it over the built-in names.
 *
 * Module state on purpose, like the agent registry: it is one fact per
 * process, read from wherever a picker or a router needs it.
 */
let catalog: ModelCatalog = {};
const listeners = new Set<(c: ModelCatalog) => void>();

export function getCatalog(): ModelCatalog {
  return catalog;
}

export function setCatalog(next: ModelCatalog): void {
  catalog = next;
  for (const fn of listeners) fn(catalog);
}

export function onCatalog(fn: (c: ModelCatalog) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The names a runtime listed — its own claim on them, whatever they look like. */
export function discovered(runtime: string): string[] {
  return (catalog[runtime]?.models ?? []).map((m) => m.value);
}

/**
 * Ask each runtime, keeping what it said before when it cannot answer now: a
 * runtime that is not installed, or not logged in, or slow, must not empty a
 * list that was right yesterday.
 */
export async function refreshCatalog(
  runtimes: Array<{ name: string; discover?: () => Promise<DiscoveredModel[]> }>,
  now = Date.now(),
  timeoutMs = 30_000,
): Promise<{ catalog: ModelCatalog; failed: string[] }> {
  const next: ModelCatalog = { ...catalog };
  const failed: string[] = [];
  await Promise.all(
    runtimes.map(async ({ name, discover }) => {
      if (!discover) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        const models = await Promise.race([
          discover(),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timed out')), timeoutMs))),
        ]);
        if (models.length) next[name] = { models: dedupe(models), at: now };
        else failed.push(name);
      } catch {
        failed.push(name);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  setCatalog(next);
  return { catalog: next, failed };
}

function dedupe(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  return models.filter((m) => m.value && !seen.has(m.value) && (seen.add(m.value), true));
}

export function loadCatalog(path: string): void {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ModelCatalog;
    if (raw && typeof raw === 'object') setCatalog(raw);
  } catch {
    // never asked yet, or unreadable: the built-in names stand until the first answer
  }
}

export function saveCatalog(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(catalog, null, 2));
}

/** Oldest answer in the catalog, so the daemon knows whether a restart needs to ask again. */
export function catalogAge(now = Date.now()): number {
  const ats = Object.values(catalog).map((c) => c.at);
  return ats.length ? now - Math.min(...ats) : Infinity;
}
