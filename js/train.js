// Training helpers: spaced repetition store and opponent move choice.

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Leitner boxes: a miss goes to box 0 (back in 10 minutes); each correct review moves up one box.
// Short steps, for the weeks before a tournament.
export const INTERVALS = [10 * MIN, 1 * HOUR, 1 * DAY, 2 * DAY, 4 * DAY];
const VERSION = '2'; // stored items re-timed to the current INTERVALS

export class Repetition {
  constructor(storageKey = 'ot.srs') {
    this.storageKey = storageKey;
    this.items = {};
    this.deadline = null; // ms; positions last seen before it are due by then at the latest
    try { this.items = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { this.items = {}; }
    this.migrate();
  }

  // Positions saved with the older, longer steps keep their box and get a due time from the
  // current steps, counted from when they were last answered.
  migrate() {
    let v = null;
    try { v = localStorage.getItem(this.storageKey + '.v'); } catch { /* ignore */ }
    if (v === VERSION) return;
    const top = INTERVALS.length - 1;
    for (const it of Object.values(this.items)) {
      it.box = Math.min(it.box || 0, top);
      it.due = (it.last || Date.now()) + INTERVALS[it.box];
    }
    this.save();
    try { localStorage.setItem(this.storageKey + '.v', VERSION); } catch { /* ignore */ }
  }

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.items)); } catch { /* storage full or blocked */ }
  }

  // When the item is due, with the deadline applied.
  dueAt(it) {
    const d = this.deadline;
    return d && (it.last || 0) < d && it.due > d ? d : it.due;
  }

  // key: book position id; line: transcript reaching it; color: side the user plays there (1/2).
  record(key, line, color, correct, now = Date.now()) {
    const it = this.items[key];
    if (!correct) {
      this.items[key] = { line, color, box: 0, due: now + INTERVALS[0], misses: (it ? it.misses : 0) + 1, last: now };
      this.save();
      return;
    }
    if (!it) return;
    if (this.dueAt(it) <= now) {
      it.box = Math.min(it.box + 1, INTERVALS.length - 1);
      it.due = now + INTERVALS[it.box];
      it.last = now;
    }
    it.seen = now; // answered (also when not due), for "Reviews only"
    this.save();
  }

  // colors: array of allowed colors, e.g. [1] or [1, 2]
  due(colors, now = Date.now()) {
    return Object.entries(this.items)
      .filter(([, it]) => this.dueAt(it) <= now && colors.includes(it.color))
      .sort((a, b) => this.dueAt(a[1]) - this.dueAt(b[1]))
      .map(([key, it]) => ({ key, ...it }));
  }

  // All saved positions, the longest unseen first (for "Reviews only" when none are due).
  saved(colors) {
    const seen = (it) => Math.max(it.seen || 0, it.last || 0);
    return Object.entries(this.items)
      .filter(([, it]) => colors.includes(it.color))
      .sort((a, b) => seen(a[1]) - seen(b[1]))
      .map(([key, it]) => ({ key, ...it }));
  }

  count(colors) {
    const all = Object.values(this.items).filter((it) => colors.includes(it.color));
    const now = Date.now();
    return { total: all.length, due: all.filter((it) => this.dueAt(it) <= now).length };
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
