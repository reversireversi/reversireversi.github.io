// Training helpers: spaced repetition store and opponent move choice.

const MIN = 60e3, DAY = 864e5;
// Leitner boxes: a miss goes to box 0 (back in about a minute); each correct review moves up one box.
export const INTERVALS = [1 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 21 * DAY, 60 * DAY];

export class Repetition {
  constructor(storageKey = 'ot.srs') {
    this.storageKey = storageKey;
    this.items = {};
    try { this.items = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { this.items = {}; }
  }

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.items)); } catch { /* storage full or blocked */ }
  }

  // key: book position id; line: transcript reaching it; color: side the user plays there (1/2).
  record(key, line, color, correct, now = Date.now()) {
    const it = this.items[key];
    if (!correct) {
      this.items[key] = { line, color, box: 0, due: now + INTERVALS[0], misses: (it ? it.misses : 0) + 1, last: now };
      this.save();
      return;
    }
    if (it && it.due <= now) {
      it.box = Math.min(it.box + 1, INTERVALS.length - 1);
      it.due = now + INTERVALS[it.box];
      it.last = now;
      this.save();
    }
  }

  // colors: array of allowed colors, e.g. [1] or [1, 2]
  due(colors, now = Date.now()) {
    return Object.entries(this.items)
      .filter(([, it]) => it.due <= now && colors.includes(it.color))
      .sort((a, b) => a[1].due - b[1].due)
      .map(([key, it]) => ({ key, ...it }));
  }

  count(colors) {
    const all = Object.values(this.items).filter((it) => colors.includes(it.color));
    return { total: all.length, due: all.filter((it) => it.due <= Date.now()).length };
  }

  // Raw item access, used to undo a record (e.g. when a move is accepted after all).
  get(key) { return this.items[key] ? { ...this.items[key] } : undefined; }
  put(key, item) {
    if (item) this.items[key] = { ...item }; else delete this.items[key];
    this.save();
  }

  clear() { this.items = {}; this.save(); }
}

// Moves within `margin` discs of the best move and, if `floor` is set, scoring at least `floor`
// (for the side to move). If no move passes both, the best moves. moves: [{ sq, score }].
export function withinMargin(moves, margin, floor = null) {
  if (!moves.length) return [];
  const best = Math.max(...moves.map((m) => m.score));
  const ok = moves.filter((m) => m.score >= best - margin && (floor === null || m.score >= floor));
  return ok.length ? ok : moves.filter((m) => m.score === best);
}

// Book moves (not the leaf) for the trainer to choose from: see withinMargin.
export function opponentCandidates(info, margin, floor = null) {
  return withinMargin(info.moves.filter((m) => m.inBook && m.sq < 64), margin, floor);
}

export const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
