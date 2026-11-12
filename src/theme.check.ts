import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme, palette, STATUS_COLORS, theme, THEMES } from './theme.js';

/**
 * Themes are only as good as their coverage: one colour written straight into
 * a view stays the same in every theme and looks wrong in most. What a
 * typecheck cannot see: a colour literal outside theme.ts, and a map built at
 * import that would freeze the theme it saw.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const root = fileURLToPath(new URL('.', import.meta.url));
const files: string[] = [];
const walk = (dir: string) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f) && !f.endsWith('.check.ts') && f !== 'theme.ts') files.push(p);
  }
};
walk(root);

const NAMED = 'black|red|green|yellow|blue|magenta|cyan|white|gray|grey';
const literal = new RegExp(`(color|Color)=["'](${NAMED}|#[0-9a-fA-F]{3,6})["']|color: ["'](${NAMED}|#[0-9a-fA-F]{3,6})["']|["']#[0-9a-fA-F]{6}["']`);
for (const f of files) {
  readFileSync(f, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (literal.test(line)) check('a colour outside theme.ts', false, `${f.slice(root.length)}:${i + 1}: ${line.trim()}`);
    });
}

const map = palette(() => ({ ok: theme.ok }));
applyTheme('colinear');
const before = map.ok;
applyTheme('nord');
check('a palette() map follows a theme switch', map.ok === THEMES.nord.tokens.ok && map.ok !== before);
check('status colours follow a theme switch', STATUS_COLORS.done === THEMES.nord.tokens.ok);
applyTheme('no-such-theme');
check('an unknown theme falls back to the default', theme.key === THEMES.colinear.tokens.key);

if (failures.length) {
  console.error(`theme: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok — every colour in ${files.length} files comes from the theme, and a switch reaches the maps built from it`);
