import type { CheckConfig, CheckResult } from './types.js';
import type { Workspace } from './workspace.js';

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

export async function runChecks(checks: CheckConfig[], workspace: Workspace, signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (signal?.aborted) {
      results.push({ name: check.name, ok: false, output: 'cancelled' });
      continue;
    }
    // signal: task cancellation must kill the shell, not wait out the timeout
    const run = await workspace.exec(['bash', '-lc', check.cmd], { timeoutMs: CHECK_TIMEOUT_MS, signal, maxOutput: 20_000 });
    results.push({ name: check.name, ok: run.code === 0, output: run.output.slice(-4_000) });
  }
  return results;
}
