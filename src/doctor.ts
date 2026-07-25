import { loadConfig } from './core/config.js';
import { fetchIssues } from './core/linear.js';

const cfg = loadConfig();
const issues = await fetchIssues(cfg, cfg.team);
console.log(`Linear OK — ${issues.length} issues${cfg.team ? ` in ${cfg.team}` : ' assigned to me'}:`);
for (const i of issues) {
  console.log(`  ${i.identifier}  [${i.stateName}]  ${i.title}`);
}
