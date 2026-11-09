// Finds the start positions for endgame training off the main thread: every book position
// reached after 39 or 40 moves by following book moves from the start, with one line reaching it.
// In: the book file as an ArrayBuffer.
// Out: { progress } messages, then { moves: Uint8Array, lens: Uint8Array, scores: Int8Array }:
// line i is lens[i] square numbers (a1 = 0) in `moves`, after the lines before it; scores[i] is the
// book's best score of line i's final position for the side to move there.
import { Book } from './book.js';
import { flipsFor, initialBoard } from './reversi.js';

const NAMES = [];
for (let s = 0; s < 64; s++) NAMES.push('abcdefgh'[s & 7] + ((s >> 3) + 1));
const FIRST = 39, LAST = 40;

self.onmessage = (e) => {
  try {
    const book = new Book(e.data);
    const seen = new Uint8Array(book.n);
    const lines = [], scores = [];
    const root = book.find(initialBoard(), 1);
    // Stack entries: { b: board, p: side to move, hit: {index, symmetry}, line }
    const stack = root ? [{ b: initialBoard(), p: 1, hit: root, line: '' }] : [];
    let visited = 0, t = performance.now();
    while (stack.length) {
      const { b, p, hit, line } = stack.pop();
      if (seen[hit.index]) continue;
      seen[hit.index] = 1;
      if ((++visited & 4095) === 0 && performance.now() - t > 250) {
        t = performance.now();
        self.postMessage({ progress: visited / book.n });
      }
      const info = book.decode(hit.index, hit.symmetry);
      const ply = line.length / 2;
      if (ply >= FIRST && info.moves.length) {
        lines.push(line);
        scores.push(Math.max(...info.moves.map((m) => m.score)));
      }
      if (ply >= LAST) continue;
      const q = 3 - p;
      for (const m of info.moves) {
        if (!m.inBook || m.sq >= 64) continue;
        const flips = flipsFor(b, m.sq, p);
        if (!flips.length) continue;
        const c = b.slice();
        c[m.sq] = p;
        for (const f of flips) c[f] = p;
        let h = book.find(c, q), next = q;
        if (!h) { h = book.find(c, p); next = p; } // the other side has to pass
        if (!h || seen[h.index]) continue;
        stack.push({ b: c, p: next, hit: h, line: line + NAMES[m.sq] });
      }
    }
    // Packed for storage: moves of all lines one after another (square numbers), each line's length.
    let total = 0;
    for (const l of lines) total += l.length / 2;
    const moves = new Uint8Array(total), lens = new Uint8Array(lines.length);
    let k = 0;
    lines.forEach((l, i) => {
      lens[i] = l.length / 2;
      for (let j = 0; j < l.length; j += 2) moves[k++] = (l.charCodeAt(j + 1) - 49) * 8 + (l.charCodeAt(j) - 97);
    });
    const s = Int8Array.from(scores);
    self.postMessage({ moves, lens, scores: s }, [moves.buffer, lens.buffer, s.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
