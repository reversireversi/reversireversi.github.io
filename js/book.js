// Reader for Edax opening books (book.dat), entirely in the browser.
//
// File layout (little endian), from Edax book.c:
//   header (42 bytes): u32 'EDAX', u32 'BOOK', u8 version, u8 release,
//     date {i16 year, i8 month, day, hour, minute, second, pad},
//     options {i32 level, n_empties, midgame_error, endcut_error, verbosity}, i32 n_nodes
//   position records, one after another:
//     u64 player, u64 opponent            (player = side to move; bit i = square i, a1 = 0)
//     u32 wins, draws, losses, lines
//     i16 value, lower, upper             (score of the position for the side to move)
//     u8 n_link, u8 level
//     n_link x {i8 score, u8 move}        (book moves, score for the side to move)
//     {i8 score, u8 move}                 (leaf: best move not in the book; move 65 = none)
// Each position is stored once, in one of its 8 symmetric orientations.

import { flipsFor } from './reversi.js';

const MAGIC_EDAX = 0x45444158;
const MAGIC_BOOK = 0x424f4f4b;
const HEADER_SIZE = 42;
export const NOMOVE = 65;
export const PASS = 64;

// symmetry(x, s) exactly as Edax: bit 1 mirror columns, bit 2 mirror rows, bit 4 transpose.
const SYM = [];
for (let s = 0; s < 8; s++) {
  const t = new Uint8Array(64);
  for (let x = 0; x < 64; x++) {
    let y = x;
    if (s & 1) y ^= 7;
    if (s & 2) y ^= 56;
    if (s & 4) y = (y >> 3) | ((y & 7) << 3);
    t[x] = y;
  }
  SYM.push(t);
}
const symMove = (m, s) => (m < 64 ? SYM[s][m] : m);
const SYM_INV = SYM.map((t) => { const inv = new Uint8Array(64); for (let x = 0; x < 64; x++) inv[t[x]] = x; return inv; });
// Square conversions between the stored orientation of a record and the board it was found
// on with symmetry s (from find/probe).
export const toStored = (sq, s) => (sq < 64 ? SYM_INV[s][sq] : sq);
export const fromStored = (sq, s) => symMove(sq, s);

// Byte lookup tables for turning a current bitboard (two u32 words) into the stored
// orientation of symmetry s: stored bit x is current bit SYM[s][x].
// STAB[((s * 8 + byte) * 256 + value) * 2 + word]
const STAB = new Uint32Array(8 * 8 * 256 * 2);
for (let s = 0; s < 8; s++) {
  const inv = new Uint8Array(64);
  for (let x = 0; x < 64; x++) inv[SYM[s][x]] = x;
  for (let j = 0; j < 8; j++) {
    for (let v = 0; v < 256; v++) {
      let lo = 0, hi = 0;
      for (let k = 0; k < 8; k++) {
        if (!(v & (1 << k))) continue;
        const x = inv[j * 8 + k];
        if (x < 32) lo |= 1 << x; else hi |= 1 << (x - 32);
      }
      const t = ((s * 8 + j) * 256 + v) * 2;
      STAB[t] = lo >>> 0; STAB[t + 1] = hi >>> 0;
    }
  }
}
let W0 = 0, W1 = 0; // result of symWords
function symWords(w0, w1, s) {
  let lo = 0, hi = 0;
  const base = s * 8 * 256 * 2;
  for (let j = 0; j < 4; j++) {
    const a = base + (j * 256 + ((w0 >>> (8 * j)) & 255)) * 2;
    const b = base + ((j + 4) * 256 + ((w1 >>> (8 * j)) & 255)) * 2;
    lo |= STAB[a] | STAB[b];
    hi |= STAB[a + 1] | STAB[b + 1];
  }
  W0 = lo >>> 0; W1 = hi >>> 0;
}

function hash4(a, b, c, d) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ c, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ d, 0x165667b1);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Book {
  constructor(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < HEADER_SIZE || dv.getUint32(0, true) !== MAGIC_EDAX || dv.getUint32(4, true) !== MAGIC_BOOK) {
      throw new Error('Not an Edax opening book');
    }
    this.version = dv.getUint8(8);
    this.release = dv.getUint8(9);
    if (this.version !== 4) throw new Error(`Unsupported book version ${this.version}.${this.release}`);
    const pad = (n) => String(n).padStart(2, '0');
    this.date = `${dv.getInt16(10, true)}-${pad(dv.getInt8(12))}-${pad(dv.getInt8(13))} ${pad(dv.getInt8(14))}:${pad(dv.getInt8(15))}`;
    this.level = dv.getInt32(18, true);
    this.nEmpties = dv.getInt32(22, true);
    this.midgameError = dv.getInt32(26, true);
    this.endcutError = dv.getInt32(30, true);
    this.declaredNodes = dv.getInt32(38, true);

    // Index every record.
    const offsets = [];
    let off = HEADER_SIZE;
    const end = buffer.byteLength;
    while (off + 42 <= end) {
      const nLink = dv.getUint8(off + 38);
      const size = 40 + 2 * nLink + 2;
      if (off + size > end) break;
      offsets.push(off);
      off += size;
    }
    this.trailingBytes = end - off;
    this.offsets = Uint32Array.from(offsets);
    this.n = this.offsets.length;

    // Open-addressing hash table: board -> record index.
    let cap = 1;
    while (cap < this.n * 2) cap <<= 1;
    this.mask = cap - 1;
    this.table = new Int32Array(cap).fill(-1);
    for (let i = 0; i < this.n; i++) {
      const o = this.offsets[i];
      let h = hash4(dv.getUint32(o, true), dv.getUint32(o + 4, true), dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)) & this.mask;
      while (this.table[h] !== -1) h = (h + 1) & this.mask;
      this.table[h] = i;
    }
    this.dv = dv;
  }

  static async fromFile(file) {
    return new Book(await file.arrayBuffer());
  }

  findWords(p0, p1, o0, o1) {
    const dv = this.dv;
    let h = hash4(p0, p1, o0, o1) & this.mask;
    for (;;) {
      const i = this.table[h];
      if (i === -1) return -1;
      const o = this.offsets[i];
      if (dv.getUint32(o, true) === p0 && dv.getUint32(o + 4, true) === p1 &&
          dv.getUint32(o + 8, true) === o0 && dv.getUint32(o + 12, true) === o1) return i;
      h = (h + 1) & this.mask;
    }
  }

  // board: 64-array (0 empty, 1 black, 2 white); toMove: 1 or 2.
  // Returns null if the position is not in the book, otherwise
  // { value, lower, upper, level, wins, draws, losses, lines, moves: [{ sq, score, inBook }], leaf }
  // Scores are from the side to move. moves are sorted best first; the leaf (best
  // non-book move) is included with inBook = false.
  probe(board, toMove) {
    const hit = this.find(board, toMove);
    return hit ? this.decode(hit.index, hit.symmetry) : null;
  }

  // Record index and symmetry of a position, or null if it is not in the book.
  find(board, toMove) {
    let p0 = 0, p1 = 0, o0 = 0, o1 = 0;
    for (let y = 0; y < 64; y++) {
      const v = board[y];
      if (!v) continue;
      if (v === toMove) { if (y < 32) p0 |= 1 << y; else p1 |= 1 << (y - 32); }
      else { if (y < 32) o0 |= 1 << y; else o1 |= 1 << (y - 32); }
    }
    for (let s = 0; s < 8; s++) {
      // Stored board B satisfies symmetry(B, s) == current; STAB maps current bits to B's bits.
      symWords(p0, p1, s); const q0 = W0, q1 = W1;
      symWords(o0, o1, s);
      const i = this.findWords(q0, q1, W0, W1);
      if (i >= 0) return { index: i, symmetry: s };
    }
    return null;
  }

  // ---------- Umigame numbers ----------
  // For each position: how many lines each side must memorise to always play a best move,
  // when the other side may play any of its best moves.
  //   no book moves (or not in the book): 1 and 1
  //   otherwise, over the moves with the best score (book moves, plus the stored best non-book
  //   move, which counts as 1 and 1): the mover's number is the minimum of the mover's numbers
  //   after those moves; the other side's number is the sum of theirs.
  // Stored per record as [side to move, other side]; -1 = not computed yet. Counts can get
  // large, so they are kept as doubles. Everything is computed once, in slices (umigameStep).

  umigameInit() {
    if (this.umi) return;
    this.umi = new Float64Array(this.n * 2).fill(-1);
    this.umiKids = new Map();  // record -> children list while it waits for them
    this.umiStack = [];
    this.umiNext = 0;          // next record for the background scan
    this.umiDone = 0;          // records computed
  }

  // Use numbers computed elsewhere (the worker) for this same book.
  umigameSet(umi) {
    this.umi = umi;
    this.umiKids = new Map();
    this.umiStack = [];
    this.umiNext = this.n;
    this.umiDone = this.n;
  }

  umigameReady() { return !!this.umi && this.umiDone >= this.n; }

  // [side to move, other side] for record i, or null if not computed yet.
  umigameOf(i) {
    if (!this.umi || this.umi[2 * i] < 0) return null;
    return [this.umi[2 * i], this.umi[2 * i + 1]];
  }

  // Children of record i through its best moves: [childIndex or -1, sameSideToMove].
  // As in KifuBox, the stored best non-book move (leaf) counts too when it ties for the best
  // score; its line ends there (-1 = counts as 1 and 1).
  umigameChildren(i) {
    const dv = this.dv, o = this.offsets[i], nLink = dv.getUint8(o + 38);
    const kids = [];
    if (!nLink) return kids;
    let best = -Infinity;
    for (let k = 0; k < nLink; k++) best = Math.max(best, dv.getInt8(o + 40 + 2 * k));
    const lo = o + 40 + 2 * nLink;
    if (dv.getUint8(lo + 1) !== NOMOVE) {
      const leafScore = dv.getInt8(lo);
      if (leafScore > best) return [[-1, false]]; // the leaf alone is best
      if (leafScore === best) kids.push([-1, false]);
    }
    const board = this.recordBoard(i); // side to move is 1
    for (let k = 0; k < nLink; k++) {
      if (dv.getInt8(o + 40 + 2 * k) !== best) continue;
      const move = dv.getUint8(o + 40 + 2 * k + 1);
      const b = board.slice();
      if (move < 64) {
        for (const f of flipsFor(b, move, 1)) b[f] = 1;
        b[move] = 1;
      }
      let hit = this.find(b, 2);             // normally the other side is to move
      if (hit) { kids.push([hit.index, false]); continue; }
      hit = this.find(b, 1);                 // some pass positions are stored with the passer to move
      kids.push(hit ? [hit.index, true] : [-1, false]);
    }
    return kids;
  }

  // Work through the stack until it is empty or the deadline passes. Returns true when empty.
  umigameRun(stack, deadline) {
    const U = this.umi, kidsOf = this.umiKids;
    let n = 0;
    while (stack.length) {
      if ((++n & 255) === 0 && performance.now() > deadline) return false;
      const i = stack[stack.length - 1];
      if (U[2 * i] >= 0) { stack.pop(); continue; }
      let kids = kidsOf.get(i);
      if (!kids) { kids = this.umigameChildren(i); kidsOf.set(i, kids); }
      let pending = false;
      for (const [c] of kids) if (c >= 0 && U[2 * c] < 0) { stack.push(c); pending = true; }
      if (pending) continue;
      let mine = 1, theirs = 1;
      if (kids.length) {
        mine = Infinity; theirs = 0;
        for (const [c, same] of kids) {
          const a = c < 0 ? 1 : same ? U[2 * c] : U[2 * c + 1];     // mover's number after the move
          const b = c < 0 ? 1 : same ? U[2 * c + 1] : U[2 * c];     // other side's number
          mine = Math.min(mine, a);
          theirs += b;
        }
      }
      U[2 * i] = mine; U[2 * i + 1] = theirs;
      kidsOf.delete(i);
      this.umiDone++;
      stack.pop();
    }
    return true;
  }

  // Compute for up to `ms` milliseconds. Returns the fraction of records done (1 = finished).
  umigameStep(ms) {
    this.umigameInit();
    const deadline = performance.now() + ms;
    for (;;) {
      if (!this.umiStack.length) {
        while (this.umiNext < this.n && this.umi[2 * this.umiNext] >= 0) this.umiNext++;
        if (this.umiNext >= this.n) return 1;
        this.umiStack.push(this.umiNext);
      }
      if (!this.umigameRun(this.umiStack, deadline)) return this.umiDone / this.n;
    }
  }

  // Synchronous: [side to move, other side] for record i (computes what is missing).
  umigame(i) {
    this.umigameInit();
    if (this.umi[2 * i] < 0) this.umigameRun([i], Infinity);
    return [this.umi[2 * i], this.umi[2 * i + 1]];
  }

  decode(i, s = 0) {
    const dv = this.dv, o = this.offsets[i];
    const nLink = dv.getUint8(o + 38);
    const moves = [];
    for (let k = 0; k < nLink; k++) {
      moves.push({ sq: symMove(dv.getUint8(o + 40 + 2 * k + 1), s), score: dv.getInt8(o + 40 + 2 * k), inBook: true });
    }
    const lo = o + 40 + 2 * nLink;
    const leafMove = dv.getUint8(lo + 1);
    const leaf = leafMove === NOMOVE ? null : { sq: symMove(leafMove, s), score: dv.getInt8(lo), inBook: false };
    if (leaf) moves.push(leaf);
    moves.sort((a, b) => b.score - a.score || (b.inBook - a.inBook));
    return {
      index: i,
      symmetry: s,
      wins: dv.getUint32(o + 16, true),
      draws: dv.getUint32(o + 20, true),
      losses: dv.getUint32(o + 24, true),
      lines: dv.getUint32(o + 28, true),
      value: dv.getInt16(o + 32, true),
      lower: dv.getInt16(o + 34, true),
      upper: dv.getInt16(o + 36, true),
      level: dv.getUint8(o + 39),
      nLink,
      moves,
      leaf,
    };
  }

  // Stable id of a position (same for all 8 symmetric orientations): its stored board.
  recordKey(i) {
    const dv = this.dv, o = this.offsets[i];
    let k = '';
    for (let j = 0; j < 16; j += 4) k += dv.getUint32(o + j, true).toString(16).padStart(8, '0');
    return k;
  }

  // Board of record i in stored orientation, as a 64-array with the side to move as black (1).
  recordBoard(i) {
    const dv = this.dv, o = this.offsets[i];
    const p = [dv.getUint32(o, true), dv.getUint32(o + 4, true)];
    const q = [dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)];
    const b = new Array(64).fill(0);
    for (let x = 0; x < 64; x++) {
      const w = x >> 5, bit = 1 << (x & 31);
      if (p[w] & bit) b[x] = 1; else if (q[w] & bit) b[x] = 2;
    }
    return b;
  }
}
