import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IssueFilterSpec } from './linear.js';
import { log } from './log.js';

export interface CustomViewSpec {
  name: string;
  aliases?: string[];
  kind?: 'issues';
  describe?: string;
  filter?: IssueFilterSpec;
  columns?: string[];
  sort?: string;
}

export const VIEWS_DIR = join(homedir(), '.config', 'foreman', 'views');

export function loadCustomViews(): CustomViewSpec[] {
  let files: string[];
  try {
    files = readdirSync(VIEWS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const specs: CustomViewSpec[] = [];
  for (const file of files) {
    try {
      const spec = JSON.parse(readFileSync(join(VIEWS_DIR, file), 'utf8')) as CustomViewSpec;
      if (!spec.name) throw new Error('missing "name"');
      specs.push(spec);
    } catch (err) {
      log(`custom view ${file} skipped: ${err}`);
    }
  }
  return specs;
}
