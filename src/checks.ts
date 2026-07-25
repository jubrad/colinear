import { spawn } from 'node:child_process';
import type { CheckConfig, CheckResult } from './types.js';

const CHECK_TIMEOUT_MS = 15 * 60 * 1000;

export async function runChecks(checks: CheckConfig[], cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, cwd));
  }
  return results;
}

function runCheck(check: CheckConfig, cwd: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', check.cmd], { cwd, timeout: CHECK_TIMEOUT_MS });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 20_000) output = output.slice(-20_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => resolve({ name: check.name, ok: false, output: String(err) }));
    child.on('close', (code) => resolve({ name: check.name, ok: code === 0, output: output.slice(-4_000) }));
  });
}
