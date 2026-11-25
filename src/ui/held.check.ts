import { follow, followPos } from './held.js';

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

// the board: a card keeps the cursor as the board re-sorts and cards change column
const board = [['a', 'parent'], ['child', 'x']];
const resorted = [['parent', 'a'], ['x'], ['child']];
const moved = followPos(board, { col: 1, row: 0 }, resorted, id);
check('a card that moves column keeps the cursor', moved.col === 2 && moved.row === 0, JSON.stringify(moved));
check('a card re-sorted within its column keeps it too', JSON.stringify(followPos(board, { col: 0, row: 1 }, resorted, id)) === JSON.stringify({ col: 0, row: 0 }));
check('a card that is gone leaves the cursor where it was', JSON.stringify(followPos(board, { col: 1, row: 1 }, [['a']], id)) === JSON.stringify({ col: 1, row: 1 }));

if (failures.length) {
  console.error(`held: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a list or a board re-sorted under the cursor keeps it on the same item');
