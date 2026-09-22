import type { SessionSpend } from './types.js';

/** What one row cost, and what is unknown about it. */
export interface RowSpend {
  /**
   * Undefined when nothing on the row carried a price, which is not the same
   * as zero. A runtime that reports no price has not established that the run
   * was free, and a total that treats it as free understates spend while
   * reading as authoritative.
   */
  costUsd?: number;
  /** sessions whose runtime priced nothing */
  unpriced: number;
  /** the models that actually ran it, in the order they first ran */
  models: string[];
}

/**
 * Read a row's cost out of its session ledger.
 *
 * `stored` is the row's own running total, which is the answer in two cases:
 * a row written before the ledger existed, and a row whose sessions all
 * reported a price. The ledger only changes the arithmetic where a session
 * reported none — but it is also the only thing that can say which models ran,
 * now that a single task can span several.
 */
export function rowSpend(spend: SessionSpend[] | undefined, stored: number): RowSpend {
  if (!spend?.length) return { costUsd: stored, unpriced: 0, models: [] };
  const priced = spend.filter((s) => s.costUsd !== undefined);
  // Attribute by what actually answered where the runtime said so, and by what
  // was asked for where it did not. Reporting the request as though it were the
  // answer is the thing this whole ledger exists to stop.
  const models: string[] = [];
  for (const s of spend) {
    for (const name of s.ran?.length ? s.ran : [s.model ?? 'default']) {
      if (!models.includes(name)) models.push(name);
    }
  }
  return {
    costUsd: priced.length ? priced.reduce((n, s) => n + (s.costUsd ?? 0), 0) : undefined,
    unpriced: spend.length - priced.length,
    models,
  };
}

/** The figure at the top of a list of rows, and how much of it is missing. */
export function totalSpend(rows: RowSpend[]): { costUsd: number; unpriced: number } {
  return {
    costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    unpriced: rows.reduce((n, r) => n + r.unpriced, 0),
  };
}
