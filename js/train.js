// Training helpers: spaced repetition store and opponent move choice.

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
// Leitner boxes: a miss goes to box 0 (back in 10 minutes); each correct review moves up one box.
// Short steps, for the weeks before a tournament.
export const INTERVALS = [10 * MIN, 1 * HOUR, 1 * DAY, 2 * DAY, 4 * DAY];
const VERSION = '2'; // stored items re-timed to the current INTERVALS
const HISTORY_MAX = 200; // answers logged per position (Train history in Analyse)
export const FLAG_SAVED = 1, FLAG_FIXED = 2, FLAG_REMOVED = 4;

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

  // "Save for review" after a correct answer: into Box 0 (also when already saved), as after a
  // mistake, but without counting a miss.
  add(key, line, color, now = Date.now()) {
    const it = this.items[key];
    this.items[key] = { ...(it || {}), line, color, box: 0, due: now + INTERVALS[0], misses: it ? it.misses || 0 : 0, last: now };
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

  // "Remove from review": out of the review list (answer history and counts stay).
  remove(key) {
    if (!this.items[key]) return;
    delete this.items[key];
    this.save();
  }
  has(key) { return !!this.items[key]; }

  // Raw item access, used to undo a record (e.g. when a move is accepted after all).
  get(key) { return this.items[key] ? { ...this.items[key] } : undefined; }
  put(key, item) {
    if (item) this.items[key] = { ...item }; else delete this.items[key];
    this.save();
  }

  clear() { this.items = {}; this.save(); }
}

// Answer history per position (Train), keyed like the review list (book position id):
//   items[key] = { line, color, c, w, x, mv: { square: count }, h: [answer log], old: { c, w, x } }
// c: correct answers, w: correct with an Umigame warning (not included in c), x: wrong answers,
// mv: moves played there, as squares of the book's stored orientation so that all symmetric
// lines to the position share them.
export class PositionStats {
  constructor(storageKey = 'ot.posStats') {
    this.storageKey = storageKey;
    this.items = {};
    try { this.items = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { this.items = {}; }
  }

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.items)); } catch { /* storage full or blocked */ }
  }

  // Once: mistakes counted by the review list before this history existed.
  importMisses(srs) {
    const flag = this.storageKey + '.imported';
    try { if (localStorage.getItem(flag)) return; } catch { return; }
    for (const [key, it] of Object.entries(srs.items)) {
      if (!it.misses || this.items[key]) continue;
      this.items[key] = { line: it.line, color: it.color, c: 0, w: 0, x: it.misses, mv: {} };
    }
    this.save();
    try { localStorage.setItem(flag, '1'); } catch { /* ignore */ }
  }

  // outcome: 'c' correct, 'w' correct with warning, 'x' wrong. sq: stored-orientation square.
  // Each answer is also logged in it.h as [time, sq, outcome, savedByButton?], newest last, at
  // most HISTORY_MAX per position; it.old counts the answers not in the log (from before the log
  // existed, or dropped as the oldest).
  record(key, line, color, outcome, sq, now = Date.now()) {
    const it = this.items[key] || (this.items[key] = { line, color, c: 0, w: 0, x: 0, mv: {} });
    it[outcome]++;
    it.mv[sq] = (it.mv[sq] || 0) + 1;
    if (!it.h) { it.h = []; it.old = { c: it.c, w: it.w, x: it.x }; it.old[outcome]--; }
    it.h.push([now, sq, outcome]);
    while (it.h.length > HISTORY_MAX) {
      const o = it.h.shift()[2];
      it.old[o === 'a' ? 'c' : o]++;
    }
    this.save();
  }

  // A wrong answer accepted as correct after all ('a' in the log).
  accept(key) {
    const it = this.items[key];
    if (!it || !it.x) return;
    it.x--; it.c++;
    const last = it.h && it.h[it.h.length - 1];
    if (last && last[2] === 'x') last[2] = 'a';
    this.save();
  }

  // Flags on the latest answer (it.h entry [3], bits): FLAG_SAVED "Save for review" pressed,
  // FLAG_FIXED the answer moved the position up from Box 0, FLAG_REMOVED "Remove from review"
  // pressed. Older entries hold 1 for saved, which is the same bit.
  flag(key, bit, on = true) {
    const it = this.items[key];
    const last = it && it.h && it.h[it.h.length - 1];
    if (!last) return;
    last[3] = on ? (last[3] || 0) | bit : (last[3] || 0) & ~bit;
    this.save();
  }
  markSaved(key) { this.flag(key, FLAG_SAVED); }

  // Answers not in the log: { c, w, x }.
  undated(it) {
    if (!it) return { c: 0, w: 0, x: 0 };
    return it.old ? it.old : { c: it.c, w: it.w, x: it.x };
  }

  get(key) { return this.items[key] || null; }

  // The n positions with the most wrong answers (ties: lower share correct first).
  worst(colors, n = 10) {
    const share = (it) => (it.c + it.w) / (it.c + it.w + it.x);
    return Object.entries(this.items)
      .filter(([, it]) => it.x > 0 && colors.includes(it.color))
      .sort((a, b) => b[1].x - a[1].x || share(a[1]) - share(b[1]))
      .slice(0, n)
      .map(([key, it]) => ({ key, ...it }));
  }
}

// Training history, day by day, rebuilt from the answer logs of PositionStats (Train only).
// colors: sides to include. fixedSince: time from which answers carry FLAG_FIXED; before it,
// "fixed" is estimated as a correct answer at least 10 minutes after a wrong (or saved) one.
// Returns [{ day: 'YYYY-MM-DD', answers, positions, c, w, x, a, trained, fixed, newPos,
// newWrong, saved, removed }], newest day first. Answers from before the log have no date
// and are left out.
export function dailyHistory(stats, colors, fixedSince) {
  const days = new Map();
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const get = (day) => {
    let d = days.get(day);
    if (!d) {
      d = { day, answers: 0, pos: new Set(), c: 0, w: 0, x: 0, a: 0, trained: 0, fixed: 0, newPos: 0, newWrong: 0, saved: 0, removed: 0 };
      days.set(day, d);
    }
    return d;
  };
  for (const [key, it] of Object.entries(stats.items)) {
    if (!it.h || !colors.includes(it.color)) continue;
    const old = it.old || { c: 0, w: 0, x: 0 };
    let hadWrong = old.x > 0;
    let prev = null;
    it.h.forEach(([t, , o, f = 0], i) => {
      const d = get(dayOf(t));
      d.answers++;
      d.pos.add(key);
      if (o in d) d[o]++;
      if (hadWrong) d.trained++;
      const right = o === 'c' || o === 'w' || o === 'a';
      if (t >= fixedSince) { if (f & FLAG_FIXED) d.fixed++; }
      else if (right && prev && (prev[2] === 'x' || (prev[3] & FLAG_SAVED)) && t - prev[0] >= INTERVALS[0]) d.fixed++;
      if (i === 0 && old.c + old.w + old.x === 0) {
        d.newPos++;
        if (o === 'x') d.newWrong++;
      }
      if (f & FLAG_SAVED) d.saved++;
      if (f & FLAG_REMOVED) d.removed++;
      if (o === 'x') hadWrong = true;
      prev = [t, 0, o, f];
    });
  }
  return [...days.values()]
    .map(({ pos, ...d }) => ({ ...d, positions: pos.size }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
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
