import { follow } from './held.js';

/**
 * A list re-sorted under the cursor keeps the cursor on the same item — the
 * reviews list re-orders on every poll, and an index alone switched the open
 * PR with no key pressed.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const id = (s: string) => s;

check('a re-sort keeps the cursor on its item', follow(['a', 'b', 'c'], 1, ['c', 'a', 'b'], id) === 2);
check('a row arriving above pushes the cursor down with its item', follow(['a', 'b'], 0, ['new', 'a', 'b'], id) === 1);
check('the item leaving hands the cursor to whatever took its place', follow(['a', 'b', 'c'], 1, ['a', 'c'], id) === 1);
check('a cursor past the end follows the last item', follow(['a', 'b'], 5, ['b', 'a'], id) === 0);
check('an empty list leaves the cursor alone', follow([], 3, ['a'], id) === 3);

if (failures.length) {
  console.error(`held: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a list re-sorted under the cursor keeps it on the same item');
