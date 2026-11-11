import {
  BLACK, WHITE, EMPTY, sqName, legalMoves, countDiscs,
  initialState, playMove, parseTranscript,
} from './reversi.js';
import { Engine, toEdaxBoard } from './engine.js';
import { Book, toStored, fromStored } from './book.js';
import { Repetition, PositionStats, INTERVALS, opponentCandidates, withinMargin, pickRandom } from './train.js';
import { dbGet, dbPut, dbDelete, askPersist } from './device-store.js';

// Offline support and "Add to Home Screen" app (see sw.js).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
}

// ---------- Settings (per browser) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ot.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ot.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- Game state ----------
let states = [initialState()];
let cursor = 0;
const cur = () => states[cursor];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const cells = [];
const discEls = new Array(64).fill(null);
const shown = new Array(64).fill(EMPTY);

for (let s = 0; s < 64; s++) {
  const c = document.createElement('div');
  c.className = 'cell';
  c.dataset.sq = s;
  c.setAttribute('role', 'gridcell');
  c.setAttribute('aria-label', sqName(s));
  c.addEventListener('click', () => onCell(s));
  boardEl.appendChild(c);
  cells.push(c);
}

// The four marker dots sit on grid intersections b2/c3, f2/g3, b6/c7, f6/g7.
for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
  const d = document.createElement('div');
  d.className = 'dot';
  d.style.left = `calc(${x} * (100% - var(--g)) / 8 + var(--g) / 2)`;
  d.style.top = `calc(${y} * (100% - var(--g)) / 8 + var(--g) / 2)`;
  boardEl.appendChild(d);
}

function makeDisc(color, drop) {
  const holder = document.createElement('div');
  holder.className = 'holder' + (drop ? ' drop' : '');
  setSpot(holder);
  const disc = document.createElement('div');
  disc.className = 'disc' + (color === WHITE ? ' is-white' : '');
  disc.innerHTML = '<div class="face black"></div><div class="face white"></div>';
  holder.appendChild(disc);
  return holder;
}

// Random off-centre spot of a disc (used when Disc placement is not Centred): --jx/--jy in the
// unit circle, uniformly at random. Set when a disc is placed, flipped, or a new game starts.
function setSpot(holder) {
  const a = Math.random() * 2 * Math.PI, r = Math.sqrt(Math.random());
  holder.style.setProperty('--jx', (r * Math.cos(a)).toFixed(3));
  holder.style.setProperty('--jy', (r * Math.sin(a)).toFixed(3));
}

// ---------- Rendering ----------
let spotGame = null; // first state of the game the disc spots belong to
function renderBoard(animate) {
  const st = cur();
  const b = st.board;
  const mr = st.move >> 3, mc = st.move & 7;
  if (states[0] !== spotGame) { // a new game or line: new spots for the discs that stay on the board
    spotGame = states[0];
    for (const h of discEls) if (h) { h.style.transition = 'none'; setSpot(h); }
  }

  for (let s = 0; s < 64; s++) {
    const v = b[s];
    if (v === EMPTY) {
      if (discEls[s]) { discEls[s].remove(); discEls[s] = null; }
    } else if (!discEls[s]) {
      discEls[s] = makeDisc(v, animate && s === st.move);
      cells[s].appendChild(discEls[s]);
    } else if (shown[s] !== v) {
      const disc = discEls[s].firstChild;
      // Ripple the flips outward from the played square.
      const dist = animate && st.move >= 0 ? Math.max(Math.abs((s >> 3) - mr), Math.abs((s & 7) - mc)) : 0;
      disc.style.transitionDelay = animate ? `${60 + dist * 55}ms` : '0ms';
      disc.classList.toggle('is-white', v === WHITE);
      // A flipped disc lands on a new random spot, sliding there while it turns.
      discEls[s].style.transition = animate ? `translate .42s ease ${60 + dist * 55}ms` : 'none';
      setSpot(discEls[s]);
    }
    shown[s] = v;
    cells[s].classList.remove('legal', 'w', 'last');
  }

  if (st.move >= 0) cells[st.move].classList.add('last');
  if (!st.over) {
    for (const m of legalMoves(b, st.toMove)) {
      cells[m].classList.add('legal');
      if (st.toMove === WHITE) cells[m].classList.add('w');
    }
  }
}

function renderStatus() {
  const st = cur();
  const { black, white } = countDiscs(st.board);
  $('count-black').textContent = black;
  $('count-white').textContent = white;
  $('side-black').classList.toggle('active', !st.over && st.toMove === BLACK);
  $('side-white').classList.toggle('active', !st.over && st.toMove === WHITE);

  const name = (p) => (p === BLACK ? 'Black' : 'White');
  let text;
  if (st.over) {
    text = black === white ? `Game over: draw ${black}–${white}`
      : `Game over: ${black > white ? 'Black' : 'White'} wins ${Math.max(black, white)}–${Math.min(black, white)}`;
  } else if (st.passed) {
    text = `${name(3 - st.toMove)} passes. ${name(st.toMove)} to move`;
  } else {
    text = `${name(st.toMove)} to move`;
  }
  $('status').textContent = text;

  $('btn-first').disabled = $('btn-back').disabled = cursor === 0;
  $('btn-fwd').disabled = $('btn-last').disabled = cursor === states.length - 1;
}

function renderMoves() {
  const el = $('moves');
  el.innerHTML = '';
  for (let i = 1; i < states.length; i++) {
    const st = states[i];
    const d = document.createElement('div');
    d.className = 'mv' + (i === cursor ? ' current' : '') + (i > cursor ? ' future' : '');
    d.innerHTML = `<span class="n">${i}</span><span class="c ${st.mover === BLACK ? 'b' : 'w'}"></span>${sqName(st.move)}`;
    d.addEventListener('click', () => goTo(i));
    el.appendChild(d);
  }
  // Keep the current move visible inside the list only. (scrollIntoView would also scroll
  // the page, which on a phone jumps away from the board after every move.)
  const currentEl = el.querySelector('.current');
  if (currentEl) {
    const t = currentEl.offsetTop, b = t + currentEl.offsetHeight;
    if (t < el.scrollTop) el.scrollTop = t;
    else if (b > el.scrollTop + el.clientHeight) el.scrollTop = b - el.clientHeight;
  }
}

const transcript = () => states.slice(1).map((s) => sqName(s.move)).join('');

function render(animate = false) {
  renderBoard(animate);
  renderStatus();
  renderMoves();
  renderExplore();
  const ta = $('transcript');
  if (document.activeElement !== ta) ta.value = transcript();
  requestAnalysis();
}

// ---------- Edax analysis ----------
let engine = null;
let engineState = 'off';
let analysisOn = store.get('edax', false);
let level = store.get('level', 18);
let anaToken = 0;
const cache = new Map(); // "board|level" -> { moves, ms }

const QUICK_LEVEL = 8;

// ---------- Time-capped analysis (Train) ----------
// Edax runs at rising levels up to `target`; when `capMs` runs out, the deepest finished level
// is used. The first level always finishes. onStep(step) is called after each level.
// Returns { res, level, capped } | { stale: true } | { error }.
const CAP_STEPS = [8, 12, 16, 20, 24, 28];
const capCache = new Map(); // "board|level|n" -> result
async function cappedAnalyze(board, target, n, capMs, onStep) {
  const levels = [...CAP_STEPS.filter((l) => l < target), target];
  let best = null, timer = 0, capHit = false;
  const cap = capMs ? new Promise((r) => { timer = setTimeout(() => { capHit = true; r('cap'); }, capMs); }) : null;
  try {
    for (const lv of levels) {
      const key = `${board}|${lv}|${n}`;
      let res = capCache.get(key);
      if (!res) {
        const p = engine.analyze(board, lv, n);
        const id = engine.lastId();
        res = best && cap ? await Promise.race([p, cap]) : await p;
        if (res === 'cap') { engine.abort(id); break; }
        if (res.stale) return { stale: true };
        if (res.error) return { error: res.error };
        capCache.set(key, res);
      }
      best = { res, level: lv };
      if (onStep) onStep({ ...best, capped: lv < target });
      if (capHit) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return { ...best, capped: best.level < target };
}

function setEngineStatus(text, isErr = false) {
  const el = $('engine-status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function ensureEngine() {
  if (engine) return;
  engine = new Engine((state, err) => {
    engineState = state;
    if (state === 'loading') setEngineStatus('Loading Edax…');
    else if (state === 'error') setEngineStatus('Engine error: ' + err, true);
    else if (state === 'ready') requestAnalysis();
  });
}

const fmtScore = (v) => (v > 0 ? '+' + v : String(v));
const fmtPv = (pv) => (pv.match(/.{2}/g) || []).map((m) => (m === 'ps' ? 'pass' : m)).slice(0, 12).join(' ');
const moveSq = (name) => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

// ---------- Scores drawn on the board: book first, Edax otherwise ----------
let edaxView = null; // { res, partial } for the current position

function clearBoardScores() {
  for (const c of cells) {
    c.classList.remove('scored', 'peek');
    const s = c.querySelector('.score');
    if (s) s.remove();
    const p = c.querySelector('.pct');
    if (p) p.remove();
  }
}

// list: [{ sq, score, leaf }]
function paintScores(list, partial) {
  clearBoardScores();
  const shown = list.filter((m) => m.sq < 64);
  if (!shown.length) return;
  const best = Math.max(...shown.map((m) => m.score));
  for (const m of shown) {
    const el = document.createElement('div');
    el.className = 'score' + (m.score === best ? ' best' : best - m.score >= 6 ? ' bad' : '')
      + (m.leaf ? ' leaf' : '') + (partial ? ' partial' : '');
    el.textContent = fmtScore(m.score);
    if (m.umi) {
      // Umigame numbers of the position after this move: Black's (dark) and White's (light),
      // the side to move first.
      const ub = `<span class="ub">${fmtCount(m.umi.b)}</span>`, uw = `<span class="uw">${fmtCount(m.umi.w)}</span>`;
      el.innerHTML = `<span class="v">${fmtScore(m.score)}</span>`
        + `<span class="umi">${cur().toMove === WHITE ? uw + ub : ub + uw}</span>`;
      el.title = `Umigame: Black ${m.umi.b}, White ${m.umi.w}`;
    }
    cells[m.sq].appendChild(el);
    cells[m.sq].classList.add('scored');
  }
}

const fmtCount = (n) => (n < 10000 ? String(n) : n < 1e6 ? Math.round(n / 1000) + 'k' : (n / 1e6).toPrecision(2) + 'M');

// Umigame numbers { b, w } of a position, or of the position after `sq` is played.
// null while the numbers are still being computed in the background.
function umiOf(st) {
  if (!book || st.over) return { b: 1, w: 1 };
  let hit = book.find(st.board, st.toMove), mover = st.toMove;
  if (!hit) { mover = 3 - st.toMove; hit = book.find(st.board, mover); } // pass positions
  if (!hit) return { b: 1, w: 1 };
  const u = book.umigameOf(hit.index);
  if (!u) return null;
  const [m, t] = u;
  return mover === BLACK ? { b: m, w: t } : { b: t, w: m };
}

// Compute all Umigame numbers after the book loads (in a worker; in slices here if that
// fails), then repaint.
let umiWorker = null;
function computeUmigame(b) {
  if (umiWorker) { umiWorker.terminate(); umiWorker = null; }
  const progress = (done) => {
    $('book-meta').dataset.umi = `Umigame numbers: computing… ${Math.floor(done * 100)}%`;
    renderBookMeta();
  };
  const tick = () => { // fallback on the main thread
    if (book !== b) return; // another book was opened
    const done = b.umigameStep(30);
    if (done < 1) { progress(done); setTimeout(tick, 0); return; }
    umigameReady(b);
  };
  try {
    const w = new Worker(new URL('./umigame-worker.js', import.meta.url), { type: 'module' });
    umiWorker = w;
    w.onmessage = (e) => {
      if (book !== b) { w.terminate(); return; }
      const d = e.data;
      if (d.umi) { b.umigameSet(d.umi); w.terminate(); umiWorker = null; umigameReady(b); }
      else if (d.error) { w.terminate(); umiWorker = null; setTimeout(tick, 0); }
      else progress(d.progress);
    };
    w.onerror = () => { w.terminate(); umiWorker = null; setTimeout(tick, 0); };
    w.postMessage(b.dv.buffer.slice(0));
  } catch {
    setTimeout(tick, 0);
  }
}
function umigameReady(b) {
  if (book !== b) return;
  if (!b.umiSaved && bookRemembered) { // keep the numbers for next time
    b.umiSaved = true;
    dbPut('umi', { id: b.id, data: b.umi.buffer });
  }
  delete $('book-meta').dataset.umi;
  renderBookMeta();
  if (mode === 'train' && T.phase === 'wrong' && T.anchor && T.anchor.marks) { // add the numbers to the mistake view
    const st = T.anchor.states[T.anchor.cursor], old = T.anchor.marks.list;
    const fresh = bookList(st, probe(st));
    for (const e of old) if (!fresh.find((f) => f.sq === e.sq)) fresh.push(e); // the wrong move's Edax score
    T.anchor.marks.list = fresh;
  }
  if (mode === 'analyse' || exploring()) requestAnalysis();
}
function renderBookMeta() {
  const el = $('book-meta');
  el.textContent = `${bookName} · ${book.n.toLocaleString()} positions · level ${book.level} · ${book.date}`
    + (el.dataset.umi ? ` · ${el.dataset.umi}` : '');
}
function umiAfter(st, sq) {
  const child = playMove(st, sq);
  return child ? umiOf(child) : null;
}

// Umigame numbers after book move m; the stored best non-book move always ends its line (1 and 1).
function umiMove(st, m) {
  if (!m.inBook) return book && book.umigameReady() ? { b: 1, w: 1 } : null; // shown once computed
  return umiAfter(st, m.sq);
}

// Book moves of `info` (position `st`) for painting, with their Umigame numbers.
function bookList(st, info) {
  return info.moves.filter((m) => m.sq < 64)
    .map((m) => ({ sq: m.sq, score: m.score, leaf: !m.inBook, umi: umiMove(st, m) }));
}

function paintBoard() {
  if (isTrain()) {
    if (!exploring()) return;
    for (const c of cells) c.classList.remove('wrong', 'right');
    if (T.phase === 'wrong' && atAnchor()) { paintAnchorMarks(); return; }
  }
  if (bookOn && bookInfo) paintScores(bookList(cur(), bookInfo), false);
  else if (edaxView) paintScores(edaxView.res.moves.map((m) => ({ sq: moveSq(m.move), score: m.score })), edaxView.partial);
  else clearBoardScores();
  paintPct();
}

function showAnalysis(res, partial, ms) {
  $('engine-lines').innerHTML = '';
  const moves = (res.moves || []).slice().sort((a, b) => b.score - a.score);
  edaxView = moves.length ? { res: { ...res, moves }, partial } : null;
  paintBoard();
  if (!moves.length) return;
  const best = moves[0].score;

  const lines = $('engine-lines');
  for (const m of moves) {
    const sq = moveSq(m.move);
    const row = document.createElement('div');
    row.className = 'eline' + (m.score === best ? ' best' : '');
    row.innerHTML = `<span class="m">${m.move}</span><span class="s">${fmtScore(m.score)}</span><span class="pv">${fmtPv(m.pv)}</span>`;
    row.title = fmtPv(m.pv);
    row.onmouseenter = () => cells[sq].classList.add('peek');
    row.onmouseleave = () => cells[sq].classList.remove('peek');
    row.onclick = () => onCell(sq);
    lines.appendChild(row);
  }

  const d = moves[0];
  const depthText = d.selectivity < 100 ? `depth ${d.depth}@${d.selectivity}%` : `depth ${d.depth}`;
  const exact = d.depth >= res.empties && d.selectivity === 100;
  setEngineStatus(partial ? `Thinking… (quick ${depthText})`
    : `Level ${level} · ${exact ? 'exact' : depthText}${ms != null ? ` · ${(ms / 1000).toFixed(1)}s` : ''}`);
}

// ---------- Opening book ----------
let book = null;
let bookName = '';
let bookOn = store.get('bookOn', true);
let bookInfo = null;

function setBookStatus(text, isErr = false) {
  const el = $('book-status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function updateBook() {
  const st = cur();
  const lines = $('book-lines');
  lines.innerHTML = '';
  // Endgame training does not use the book after the start position.
  bookInfo = book && bookOn && !st.over && mode !== 'endgame' ? book.probe(st.board, st.toMove) : null;
  if (!book) { setBookStatus('No book loaded. Your book is read in this browser only and never uploaded.'); return; }
  if (!bookOn) { setBookStatus('Book scores hidden'); return; }
  if (st.over) { setBookStatus('Game over'); return; }
  if (!bookInfo) { setBookStatus('Out of book' + (analysisOn ? ' (Edax scores shown)' : '')); return; }

  const i = bookInfo;
  const u = umiOf(st);
  setBookStatus(`In book · value ${fmtScore(i.value)} · ${i.nLink} book move${i.nLink === 1 ? '' : 's'}`
    + (u ? ` · Umigame Black ${u.b}, White ${u.w}` : ''));
  const best = i.moves.length ? i.moves[0].score : 0;
  for (const m of i.moves) {
    const row = document.createElement('div');
    row.className = 'eline' + (m.score === best ? ' best' : '');
    const name = m.sq === 64 ? 'pass' : sqName(m.sq);
    const mu = m.sq < 64 ? umiMove(st, m) : null;
    row.innerHTML = `<span class="m">${name}</span><span class="s">${fmtScore(m.score)}</span>`
      + `<span class="pv">${m.inBook ? 'book' : 'best non-book move'}${mu ? ` · Umigame ${mu.b} / ${mu.w}` : ''}</span>`;
    if (m.sq < 64) {
      row.onmouseenter = () => cells[m.sq].classList.add('peek');
      row.onmouseleave = () => cells[m.sq].classList.remove('peek');
      row.onclick = () => onCell(m.sq);
    }
    lines.appendChild(row);
  }
}

$('opt-book').checked = bookOn;
$('opt-book').onchange = (e) => { bookOn = e.target.checked; store.set('bookOn', bookOn); updateBook(); paintBoard(); };
$('btn-book').onclick = () => $('book-file').click();
// ---------- Book kept on this device ----------
// The opened book is saved in this browser's own storage (IndexedDB) so it opens by itself
// next time, together with its Umigame numbers. It never leaves the device.
let bookRemembered = false;
const bookId = (b, name) => `${name}|${b.dv.byteLength}|${b.date}|${b.n}`;

function renderRemember() {
  $('btn-book-forget').hidden = !bookRemembered;
  $('book-note').textContent = bookRemembered ? 'Remembered on this device; opens by itself next time.' : '';
}

// Use `buffer` (the book file) as the current book. fromDevice: it came from storage.
async function openBook(buffer, name, fromDevice = false) {
  const t = performance.now();
  const b = new Book(buffer);
  book = b;
  bookName = name;
  b.id = bookId(b, name);
  $('btn-book').textContent = 'Change…';
  $('book-meta').dataset.umi = 'Umigame numbers: computing…';
  renderBookMeta();
  console.log(`Book loaded in ${Math.round(performance.now() - t)} ms`);
  updateBook();
  paintBoard();
  if (isTrain() && T.phase === 'idle') { setFeedback('Book loaded. Press <b>Start</b>.'); renderTrainStats(); }
  endPos = null;
  endNext = null; prepToken++;
  loadEndPositions(b);

  const saved = await dbGet('umi');
  if (book !== b) return;
  if (saved && saved.id === b.id && saved.data && saved.data.byteLength === b.n * 16) {
    b.umigameSet(new Float64Array(saved.data));
    b.umiSaved = true; // already stored
    umigameReady(b);
  } else {
    computeUmigame(b);
  }

  if (!fromDevice) {
    bookRemembered = false;
    renderRemember();
    if (saved && saved.id !== b.id) await dbDelete('umi');
    bookRemembered = await dbPut('book', { name, data: buffer, savedAt: Date.now() });
    if (book !== b) return;
    renderRemember();
    if (bookRemembered && b.umigameReady() && !b.umiSaved) { // numbers finished before the book was saved
      b.umiSaved = true;
      dbPut('umi', { id: b.id, data: b.umi.buffer });
    }
    if (bookRemembered && endPos && endPos.scores && !b.endSaved) { // start positions found before that
      b.endSaved = true;
      dbPut('endpos', { id: b.id, moves: endPos.moves, lens: endPos.lens, scores: endPos.scores });
    }
    askPersist();
  }
}

$('book-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setBookStatus(`Reading ${file.name}…`);
  try {
    await openBook(await file.arrayBuffer(), file.name);
  } catch (err) {
    book = null;
    setBookStatus('Could not read book: ' + err.message, true);
  } finally {
    e.target.value = '';
  }
};

$('btn-book-forget').onclick = async () => {
  await dbDelete('book');
  await dbDelete('umi');
  await dbDelete('endpos');
  bookRemembered = false;
  renderRemember();
  $('book-note').textContent = 'Removed from this device. The book stays open until you reload.';
};

// On start: reopen the book saved on this device, if any.
(async () => {
  const saved = await dbGet('book');
  if (!saved || !saved.data || book) return;
  setBookStatus(`Opening ${saved.name} from this device…`);
  try {
    bookRemembered = true;
    renderRemember();
    await openBook(saved.data, saved.name, true);
  } catch (err) {
    bookRemembered = false;
    renderRemember();
    setBookStatus('Could not open the saved book: ' + err.message, true);
  }
})();

async function requestAnalysis() {
  const token = ++anaToken;
  if (isTrain() && !exploring()) { edaxView = null; return; } // training draws its own feedback
  edaxView = null;
  $('engine-lines').innerHTML = '';
  updateBook();
  paintBoard();
  // Playing on in Train: book scores if in book, otherwise Edax (always on there).
  if (isTrain() && (bookInfo || (T.phase === 'wrong' && atAnchor()))) return;
  if (!analysisOn && !isTrain()) { if (engine) engine.cancel(); setEngineStatus('Off'); return; }
  ensureEngine();

  const st = cur();
  if (st.over) { engine.cancel(); setEngineStatus('Game over'); return; }
  if (mode === 'endgame') { // playing on in an endgame: exact scores
    const r = await solve(st);
    if (token !== anaToken || !r.moves) return;
    showAnalysis(r.res, false);
    return;
  }
  const board = toEdaxBoard(st.board, st.toMove);
  if (mode === 'train') { // playing on: rising levels within the time cap
    const r = await cappedAnalyze(board, level, 60, T.cap * 1000, (step) => {
      if (token === anaToken) showAnalysis(step.res, step.level < level);
    });
    if (token !== anaToken || r.stale) return;
    if (r.error) { setEngineStatus('Engine error: ' + r.error, true); return; }
    showAnalysis(r.res, false);
    return;
  }
  const key = board + '|' + level;
  if (cache.has(key)) { const c = cache.get(key); showAnalysis(c, false, c.ms); return; }
  if (engineState !== 'ready') { setEngineStatus('Loading Edax…'); }
  else setEngineStatus('Thinking…');

  if (level > QUICK_LEVEL) {
    const quick = await engine.analyze(board, QUICK_LEVEL, 60);
    if (token !== anaToken || quick.stale) return;
    if (quick.error) { setEngineStatus('Engine error: ' + quick.error, true); return; }
    showAnalysis(quick, true);
  }
  const t = performance.now();
  const res = await engine.analyze(board, level, 60);
  if (token !== anaToken || res.stale) return;
  if (res.error) { setEngineStatus('Engine error: ' + res.error, true); return; }
  res.ms = performance.now() - t;
  cache.set(key, res);
  showAnalysis(res, false, res.ms);
}

$('opt-edax').checked = analysisOn;
$('opt-level').value = String(level);
$('opt-edax').onchange = (e) => { analysisOn = e.target.checked; store.set('edax', analysisOn); requestAnalysis(); };
$('opt-level').onchange = (e) => { level = Number(e.target.value); store.set('level', level); requestAnalysis(); };

// ---------- Training ----------
let mode = 'analyse';            // analyse | train | endgame
const isTrain = () => mode === 'train' || mode === 'endgame';
// Separate review lists: book positions (Train) and endgame positions (Train Endgame).
const srsBook = new Repetition();
const srsEnd = new Repetition('ot.srsEnd');
const posStats = new PositionStats(); // Train: answers per position (top 10 mistakes)
posStats.importMisses(srsBook);
const srsNow = () => (mode === 'endgame' ? srsEnd : srsBook);
const END_SCORES = [-6, -4, -2, 0, 2, 4, 6, 8];
const T = {
  phase: 'idle',          // idle | user | checking | trainer | wrong | end
  colorPref: store.get('trainColor', 1), // 1 black, 2 white, 3 both
  margin: store.get('trainMargin', 2),
  floor: store.get('trainFloor', null),   // trainer never plays a book move below this (null = no limit)
  endMargin: store.get('endMargin', 2),   // Train Endgame: trainer within this many discs of perfect
  endScores: store.get('endScores', END_SCORES.slice()), // ticked start scores
  endFrom: store.get('endFrom', 39),      // games start after a move in endFrom..endTo
  endTo: store.get('endTo', 40),
  endNoReviews: store.get('endNoReviews', false), // Endgame: only new positions
  endEqual: store.get('endEqual', true),  // Endgame: each ticked score equally likely (else by book counts)
  lineId: 0,
  reviewsOnly: store.get('reviewsOnly', false),
  reviewPly: 0,           // move number of the reviewed position (cursor there)
  cap: store.get('trainCap', 3),          // seconds for Edax checks and play-on scores; 0 = none
  lineColor: BLACK,
  retrying: false,
  review: null,           // review item being replayed, if any
  line: { correct: 0, total: 0 },
  session: { correct: 0, total: 0 },
  endSession: { correct: 0, total: 0 },
  timer: 0,
  anchor: null,           // trained position saved at a mistake or line end: { states, cursor, marks }
};
const colorName = (p) => (p === BLACK ? 'Black' : 'White');
const prefColors = () => (T.colorPref === 3 ? [BLACK, WHITE] : [T.colorPref]);

function setFeedback(html, kind = '') {
  const el = $('train-feedback');
  el.innerHTML = html;
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

function showButtons(...ids) {
  for (const id of ['btn-train-start', 'btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy']) $(id).hidden = !ids.includes(id);
}

function renderTrainStats() {
  const end = mode === 'endgame';
  const c = srsNow().count(end ? [BLACK, WHITE] : prefColors());
  const s = end ? T.endSession : T.session;
  let text = `Session: ${s.correct}/${s.total} correct · Reviews due: ${c.due} · Saved positions: ${c.total}`;
  if (end && endPos && endPos.byKey) text += ` · Book positions to start from: ${endCount().toLocaleString()}`;
  $('train-stats').textContent = text;
  renderMoveChart();
  if (!end) { renderWorst(); renderBoxes(); }
}

// ---------- Most mistakes and review boxes (Train, under the chart) ----------
const fmtWait = (ms) => (ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : ms < 864e5 ? `${Math.round(ms / 3600e3)} hour${ms < 7200e3 ? '' : 's'}`
  : `${Math.round(ms / 864e5)} day${ms < 1728e5 ? '' : 's'}`);
function renderWorst() {
  const list = $('worst-list');
  list.innerHTML = '';
  posStats.worst(prefColors(), 10).forEach((it, i) => {
    const moves = (it.line.match(/.{2}/g) || []);
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'worst-row';
    btn.title = `${it.line} (${colorName(it.color)} to play)`;
    btn.innerHTML = `<span class="rk">${i + 1}.</span>`
      + `<span class="ln">Move ${moves.length + 1}, ${colorName(it.color)}<small>…${moves.slice(-4).join(' ')}</small></span>`
      + `<span class="cnt"><span class="ok" title="correct">${it.c}</span><span class="wa" title="correct with Umigame warning">${it.w}</span>`
      + `<span class="no" title="wrong">${it.x}</span></span>`;
    btn.onclick = () => openWorst(it.key);
    li.appendChild(btn);
    list.appendChild(li);
  });
}
function renderBoxes() {
  const n = new Array(INTERVALS.length).fill(0);
  for (const it of Object.values(srsBook.items)) if (prefColors().includes(it.color)) n[Math.min(it.box || 0, n.length - 1)]++;
  $('box-counts').innerHTML = n.map((k, b) => `<div title="Due again ${fmtWait(INTERVALS[b])} after an answer">Box ${b}<b>${k}</b>${fmtWait(INTERVALS[b])}</div>`).join('');
}

// A position from "Most mistakes" opened in Analyse: your answers there are shown per move.
let pctKey = null;
// line: transcript to use when the position has no history yet.
function openWorst(key, line = '') {
  const it = posStats.get(key);
  if (!it && !line) return;
  const { states: parsed } = parseTranscript(it ? it.line : line);
  setMode('analyse');
  pctKey = key;
  states = parsed;
  cursor = states.length - 1;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
// Called after the board is painted in Analyse.
function paintPct() {
  for (const el of boardEl.querySelectorAll('.pct')) el.remove();
  const note = $('pos-history');
  note.hidden = true;
  if (mode !== 'analyse' || !pctKey || !book) return;
  const st = cur();
  const hit = book.find(st.board, st.toMove);
  if (!hit || book.recordKey(hit.index) !== pctKey) return;
  const it = posStats.get(pctKey) || { c: 0, w: 0, x: 0, mv: {} };
  const total = Object.values(it.mv).reduce((a, b) => a + b, 0);
  note.hidden = false;
  note.textContent = `Your answers here: ${it.c} correct, ${it.w} with Umigame warning, ${it.x} wrong.`
    + (total ? ` Moves you played: ${Object.entries(it.mv).sort((a, b) => b[1] - a[1])
      .map(([sq, k]) => `${sqName(fromStored(Number(sq), hit.symmetry))} ${Math.round((100 * k) / total)}%`).join(', ')}.`
      : ' (Which moves you played is counted from now on.)');
  for (const [sq, k] of Object.entries(it.mv)) {
    const el = document.createElement('span');
    el.className = 'pct';
    el.textContent = `${Math.round((100 * k) / total)}%`;
    cells[fromStored(Number(sq), hit.symmetry)].appendChild(el);
  }
}

// ---------- Answers by move number (chart under the board) ----------
// Train: moves 1-40; Train Endgame: moves 40-60.
const mcRange = () => (mode === 'endgame' ? [40, 60] : [1, 40]);
// c: correct (including correct with an Umigame warning), w: correct with warning, t: answers.
const emptyStats = () => ({ c: new Array(61).fill(0), w: new Array(61).fill(0), t: new Array(61).fill(0) });
const moveStats = {
  train: { session: emptyStats(), all: store.get('moveStats', null) || emptyStats(), key: 'moveStats' },
  endgame: { session: emptyStats(), all: store.get('moveStatsEnd', null) || emptyStats(), key: 'moveStatsEnd' },
};
if (!moveStats.train.all.w) moveStats.train.all.w = new Array(61).fill(0); // saved before warnings were counted
const statsNow = () => moveStats[mode === 'endgame' ? 'endgame' : 'train'];
let mcView = store.get('mcView', 'session');

// ply: move number of the user's answer (1..60).
function recordMoveStat(ply, correct, warned = false) {
  const m = statsNow();
  for (const s of [m.session, m.all]) {
    s.t[ply]++;
    if (correct) s.c[ply]++;
    if (correct && warned) s.w[ply]++;
  }
  store.set(m.key, m.all);
}
function acceptMoveStat(ply) { // a wrong answer counted as correct after all
  const m = statsNow();
  for (const s of [m.session, m.all]) if (s.c[ply] < s.t[ply]) s.c[ply]++;
  store.set(m.key, m.all);
}

function renderMoveChart() {
  const s = statsNow()[mcView];
  const [from, to] = mcRange();
  const cols = `repeat(${to - from + 1}, 1fr)`;
  $('mc-session').classList.toggle('active', mcView === 'session');
  $('mc-all').classList.toggle('active', mcView === 'all');
  let max = 1;
  for (let p = from; p <= to; p++) max = Math.max(max, s.t[p]);
  const bars = $('mc-bars');
  bars.innerHTML = '';
  bars.style.gridTemplateColumns = cols;
  const seg = (cls, n) => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.height = `${(100 * n) / max}%`;
    return el;
  };
  for (let p = from; p <= to; p++) {
    const t = s.t[p], c = s.c[p], w = s.w[p];
    const bar = document.createElement('div');
    bar.className = 'mc-bar' + (t ? '' : ' empty');
    bar.title = t
      ? `Move ${p}: ${c}/${t} correct (${Math.round((100 * c) / t)}%)` + (w ? `, ${w} with Umigame warning` : '')
      : `Move ${p}: no answers`;
    if (t) bar.append(seg('ok', c - w), seg('wa', w), seg('no', t - c)); // bottom to top
    // Tooltips need a mouse; show the numbers below the chart on tap or hover too.
    bar.onclick = bar.onmouseenter = () => { $('mc-info').textContent = bar.title; };
    bars.appendChild(bar);
  }
  const axis = $('mc-axis');
  if (axis.dataset.range !== `${from}-${to}`) {
    axis.dataset.range = `${from}-${to}`;
    axis.innerHTML = '';
    axis.style.gridTemplateColumns = cols;
    for (let p = from; p <= to; p++) {
      const l = document.createElement('span');
      l.textContent = p === from || p % 5 === 0 ? String(p) : '';
      axis.appendChild(l);
    }
    $('mc-info').textContent = 'Tap or hover a bar for its numbers.';
  }
}
$('mc-session').onclick = () => { mcView = 'session'; store.set('mcView', mcView); renderMoveChart(); };
$('mc-all').onclick = () => { mcView = 'all'; store.set('mcView', mcView); renderMoveChart(); };

function clearMarks() {
  for (const c of cells) c.classList.remove('wrong', 'right');
  clearBoardScores();
}

// Each tab keeps its own game when you switch away and back: Analyse its board, Train and
// Endgame the line in progress (so a line goes on where it was, without pressing Start).
const tabState = {};
const BUTTONS = ['btn-train-start', 'btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy'];
function saveTab() {
  const s = { states, cursor };
  if (isTrain()) {
    if (T.phase === 'idle' || T.phase === 'waiting' || T.phase === 'preparing') { tabState[mode] = s; return; }
    const fb = $('train-feedback');
    Object.assign(s, {
      phase: T.phase, fb: fb.innerHTML, fbClass: fb.className, buttons: BUTTONS.filter((id) => !$(id).hidden),
      anchor: T.anchor, last: T.last, lastWarn: T.lastWarn, line: T.line, retrying: T.retrying,
      review: T.review, reviewPly: T.reviewPly, lineColor: T.lineColor,
    });
  }
  tabState[mode] = s;
}
// Restore the line saved for the current (training) tab. Returns false if there is none.
function restoreTrainTab() {
  const s = tabState[mode];
  if (!s || !s.phase) return false;
  Object.assign(T, {
    phase: s.phase, anchor: s.anchor, last: s.last, lastWarn: s.lastWarn, line: s.line,
    retrying: s.retrying, review: s.review, reviewPly: s.reviewPly, lineColor: s.lineColor,
  });
  $('train-feedback').innerHTML = s.fb;
  $('train-feedback').className = s.fbClass;
  showButtons(...s.buttons);
  render();
  // A move that was being checked is asked again; a pending trainer move is played now.
  if (T.phase === 'checking') userTurn();
  else if (T.phase === 'trainer') trainerTurn();
  else if (T.phase === 'user' && mode === 'endgame') solve(cur());
  return true;
}

function setMode(m) {
  if (m === mode) return;
  saveTab();
  mode = m;
  if (tabState[m]) { states = tabState[m].states; cursor = tabState[m].cursor; }
  document.body.classList.toggle('training', isTrain());
  document.body.classList.toggle('endgame', m === 'endgame');
  $('tab-analyse').classList.toggle('active', m === 'analyse');
  $('tab-train').classList.toggle('active', m === 'train');
  $('tab-endgame').classList.toggle('active', m === 'endgame');
  clearTimeout(T.timer);
  T.lineId++;
  T.phase = 'idle';
  T.anchor = null;
  T.last = null;
  clearMarks();
  placeNav();
  if (m === 'endgame') prepNext(); // get the next start position ready
  if (isTrain() && restoreTrainTab()) { renderTrainStats(); return; }
  if (m === 'train') {
    if (engine) engine.cancel();
    setFeedback(book ? 'Choose your colour, then press <b>Start</b>.' : 'Open your book (below), then press <b>Start</b>.');
    showButtons('btn-train-start');
    renderTrainStats();
  } else if (m === 'endgame') {
    if (engine) engine.cancel();
    setFeedback(book
      ? 'Tick the start scores you want, then press <b>Start</b>. Games start after move 39 or 40 of a book line and are played to the end with exact Edax scores.'
      : 'Open your book (below): the start positions come from it. Then press <b>Start</b>.');
    showButtons('btn-train-start');
    if (book && !endPos) findEndPositions();
    renderTrainStats();
  }
  render();
}

// On phones the ⏮ ◀ ▶ ⏭ row sits right under the training buttons (it is used when
// playing on), and in its usual place in Analyse.
const navEl = document.querySelector('.nav');
const navHome = navEl.nextElementSibling;
const phone = matchMedia('(max-width: 600px)');
function placeNav() {
  if (isTrain() && phone.matches) $('train-explore').before(navEl);
  else navHome.before(navEl);
}
phone.addEventListener('change', placeNav);

// ---------- Train Endgame: start positions and exact scores ----------
// endPos: null (not searched), { progress } while searching, { moves, lens, scores, start } when found (see endgame-worker.js).
let endPos = null;
let endWorker = null;
function findEndPositions() {
  if (!book || endPos) return;
  const b = book;
  endPos = { progress: 0 };
  if (endWorker) endWorker.terminate();
  const w = new Worker(new URL('./endgame-worker.js', import.meta.url), { type: 'module' });
  endWorker = w;
  const done = () => { w.terminate(); if (endWorker === w) endWorker = null; };
  w.onmessage = (e) => {
    if (book !== b) { done(); return; }
    const d = e.data;
    if (d.scores) {
      done();
      if (!endPos.scores) useEndPositions(d);
      if (bookRemembered) { b.endSaved = true; dbPut('endpos', { id: b.id, moves: d.moves, lens: d.lens, scores: d.scores }); } // found once per book
    } else if (d.error) {
      endPos = { error: d.error };
      done();
      if (mode === 'endgame') setFeedback('Could not read start positions from the book: ' + d.error, 'bad');
    } else {
      endPos.progress = d.progress;
      if (mode === 'endgame' && T.phase === 'waiting') showEndProgress();
    }
  };
  w.onerror = (e) => { endPos = { error: e.message || 'worker error' }; done(); };
  w.postMessage(b.dv.buffer.slice(0));
}
function useEndPositions(d) {
  const start = new Uint32Array(d.lens.length);
  for (let i = 1; i < d.lens.length; i++) start[i] = start[i - 1] + d.lens[i - 1];
  // byKey: "ply|score" -> indices of the start positions after `ply` moves with that book score
  const byKey = new Map();
  for (let i = 0; i < d.lens.length; i++) {
    const k = `${d.lens[i]}|${d.scores[i]}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }
  endPos = { moves: d.moves, lens: d.lens, scores: d.scores, start, byKey };
  endNext = null;
  if (mode === 'endgame') {
    prepNext();
    renderTrainStats();
    if (T.phase === 'waiting') startLine();
  }
}
// Start positions saved on this device for book `b`, else searched when Train Endgame opens.
async function loadEndPositions(b) {
  const saved = await dbGet('endpos');
  if (book !== b) return;
  if (saved && saved.id === b.id && saved.scores) {
    if (endWorker) { endWorker.terminate(); endWorker = null; }
    b.endSaved = true;
    if (!endPos || !endPos.scores) useEndPositions(saved);
    return;
  }
  if (saved) dbDelete('endpos'); // for another book
  if (mode === 'endgame') findEndPositions();
}
// Transcript of start position i.
function endLineText(i) {
  let s = '';
  for (let k = endPos.start[i], e = k + endPos.lens[i]; k < e; k++) s += sqName(endPos.moves[k]);
  return s;
}
function showEndProgress() {
  setFeedback(`Finding start positions in the book… ${Math.floor((endPos.progress || 0) * 100)}%`);
}
// ---------- Train Endgame: choosing and preparing start positions ----------
// A game starts after move n (T.endFrom..T.endTo). Book lines reach move 39 or 40; for a later
// start Edax plays the best move for both sides from a move-40 book position up to move n, which
// keeps the exact score. You play the side to move at the start, so when the number of moves
// played is odd, the book position needs the opposite score. Each ticked score is about equally
// likely: first a move n and a score are picked, then a position.
const endBase = (n) => (n <= 40 ? n : 40);
function endPoolFor(n, s) {
  const steps = n - endBase(n);
  return endPos.byKey.get(`${endBase(n)}|${steps % 2 ? -s : s}`) || [];
}
// [{ n, scores: [ticked scores with positions] }] for the start moves in range that have any.
function endChoices() {
  const out = [];
  for (let n = T.endFrom; n <= T.endTo; n++) {
    const scores = T.endScores.filter((s) => endPoolFor(n, s).length);
    if (scores.length) out.push({ n, scores });
  }
  return out;
}
// Number of book positions the current settings can start from (for the stats line).
function endCount() {
  const keys = new Set();
  for (const { n, scores } of endChoices()) for (const s of scores) keys.add(`${endBase(n)}|${(n - endBase(n)) % 2 ? -s : s}`);
  let k = 0;
  for (const key of keys) k += endPos.byKey.get(key).length;
  return k;
}
const endSig = () => `${T.endFrom}-${T.endTo}|${T.endScores.join(',')}|${T.endEqual}`;
// Score for start move n: each ticked score equally likely, or (endEqual off) in proportion to
// how many book positions have it.
function pickScore(n, scores) {
  if (T.endEqual) return pickRandom(scores);
  const sizes = scores.map((s) => endPoolFor(n, s).length);
  let r = Math.random() * sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < scores.length; i++) { r -= sizes[i]; if (r < 0) return scores[i]; }
  return scores[scores.length - 1];
}

// The next start position is prepared in a second Edax (less search memory) while you play,
// so Start / Next line can begin at once. endNext: { sig, promise } for the settings in `sig`.
let prepEngine = null;
let prepToken = 0;
let endNext = null;
function prepNext() {
  if (!endPos || !endPos.byKey || T.reviewsOnly) return null;
  const sig = endSig();
  if (!endNext || endNext.sig !== sig) endNext = { sig, promise: prepareStart(++prepToken) };
  return endNext.promise;
}
// Resolves to { line, n, score, board, solved } (solved: exact scores of every move there),
// { none } if the settings allow no position, or { error }.
async function prepareStart(token) {
  if (!prepEngine) prepEngine = new Engine(() => {}, 'engine/edax-worker.js?hash=18');
  const e = prepEngine;
  for (let tries = 0; tries < 6; tries++) {
    const choices = endChoices();
    if (!choices.length) return { none: true };
    const { n, scores } = pickRandom(choices);
    const s = pickScore(n, scores);
    let line = endLineText(pickRandom(endPoolFor(n, s)));
    let st = parseTranscript(line).states.at(-1);
    let ok = true;
    for (let k = endBase(n); k < n; k++) { // best move for both sides up to move n
      const r = await e.analyze(toEdaxBoard(st.board, st.toMove), 60, 1);
      if (token !== prepToken) return { stale: true };
      if (r.stale || r.error || !r.moves || !r.moves.length) return { error: r.error || 'no result' };
      st = playMove(st, moveSq(r.moves[0].move));
      line += r.moves[0].move;
      if (!st || st.over) { ok = false; break; }
    }
    if (!ok) continue;
    const board = toEdaxBoard(st.board, st.toMove);
    const res = await e.analyze(board, 60, 60);
    if (token !== prepToken) return { stale: true };
    if (res.stale || res.error || !res.moves || !res.moves.length) return { error: res.error || 'no result' };
    const solved = solvedFrom(res);
    // A pass on the way, or a book score that is not exact, can change the score: pick again.
    if (solved.moves[0].score !== s) continue;
    return { line, n, score: s, board, solved };
  }
  return { none: true };
}

// Exact scores of every move in `st` (Edax, all moves, solved to the end). The promise is
// shared so the position is only solved once. Resolves to { moves: [{ sq, score }] (best
// first), res } or { stale } / { error }.
const solveCache = new Map();
const solvedFrom = (res) => ({ moves: res.moves.map((m) => ({ sq: moveSq(m.move), score: m.score })).sort((a, b) => b.score - a.score), res });
function solve(st) {
  const board = toEdaxBoard(st.board, st.toMove);
  let p = solveCache.get(board);
  if (!p) {
    ensureEngine();
    p = engine.analyze(board, 60, 60).then((res) => {
      if (res.stale || res.error || !res.moves) { solveCache.delete(board); return res.stale ? { stale: true } : { error: res.error || 'no result' }; }
      return solvedFrom(res);
    });
    solveCache.set(board, p);
  }
  return p;
}

// Play a move during training (keeps the move list consistent).
function pushMove(sq) {
  const st = playMove(cur(), sq);
  if (!st) return false;
  states = states.slice(0, cursor + 1);
  states.push(st);
  cursor++;
  render(true);
  return true;
}

const probe = (st) => (book ? book.probe(st.board, st.toMove) : null);
const bestScore = (info) => Math.max(...info.moves.filter((m) => m.sq < 64).map((m) => m.score));
const lineSoFar = () => states.slice(1, cursor + 1).map((s) => sqName(s.move)).join('');

// After a mistake or at the end of a line the user may play on and step through the moves
// ("exploring"). The trained position is kept in T.anchor so Retry / Play best can return to it.
function exploring() { return isTrain() && (T.phase === 'wrong' || T.phase === 'end'); }
function atAnchor() { return !!T.anchor && cur() === T.anchor.states[T.anchor.cursor]; }
function setAnchor(marks = null) { T.anchor = { states: states.slice(), cursor, marks }; }
function restoreAnchor() {
  if (!T.anchor) return;
  states = T.anchor.states.slice();
  cursor = T.anchor.cursor;
  render();
}
function paintAnchorMarks() {
  const m = T.anchor.marks;
  if (!m) return;
  paintScores(m.list, false);
  cells[m.wrong].classList.add('wrong');
  for (const s of m.right) cells[s].classList.add('right');
}
function renderExplore() {
  const on = exploring() && !!T.anchor;
  document.body.classList.toggle('exploring', on);
  const el = $('train-explore');
  if (!on) { el.textContent = ''; return; }
  el.textContent = atAnchor()
    ? (matchMedia('(pointer: coarse)').matches
      ? 'Tap any move to play on from here. Use ◀ ▶ to step through the moves.'
      : 'Click any move to play on from here. Use ◀ ▶ or the arrow keys to step through the moves.')
    : 'Playing on from the trained position.'
      + (T.phase === 'wrong' ? ' Retry, Accept and Play best & continue go back to it.' : '');
}

function startLine() {
  clearTimeout(T.timer);
  T.phase = 'idle';
  T.anchor = null;
  T.last = null;
  clearMarks();
  T.lineId++;
  if (!book) { setFeedback('Open your book first.', 'bad'); return; }
  T.line = { correct: 0, total: 0 };
  T.retrying = false;
  ensureEngine();
  if (mode === 'endgame') { startEndgame(); return; }

  const rev = nextReview(srsBook, prefColors());
  if (rev) {
    const { item } = rev;
    const { states: parsed, error } = parseTranscript(item.line);
    if (!error) {
      T.review = item;
      T.lineColor = item.color;
      states = parsed;
      cursor = states.length - 1;
      T.reviewPly = cursor;
      render();
      userTurn(`${rev.label}: you play <b>${colorName(item.color)}</b>.`);
      return;
    }
  }
  T.review = null;
  if (T.reviewsOnly) { noReviews(); return; }
  T.lineColor = T.colorPref === 3 ? (Math.random() < 0.5 ? BLACK : WHITE) : T.colorPref;
  states = [initialState()];
  cursor = 0;
  render();
  if (cur().toMove === T.lineColor) userTurn(`New line: you play <b>${colorName(T.lineColor)}</b>.`);
  else trainerTurn();
}

// The position to review next: the first due one, or with "Reviews only" and none due, the
// saved position seen longest ago. null if there is none. label: text for the feedback.
function nextReview(srs, colors) {
  const due = srs.due(colors);
  if (due.length) return { item: due[0], label: `Review (${due.length} due)` };
  if (!T.reviewsOnly) return null;
  const saved = srs.saved(colors);
  return saved.length ? { item: saved[0], label: `Review (none due; saved position seen longest ago, ${saved.length} saved)` } : null;
}
function noReviews() {
  setFeedback('No saved positions to review yet. Untick <b>Reviews only</b> to train new lines.');
  showButtons('btn-train-start');
}

// Train Endgame: a due review, otherwise a random start position with a ticked score.
// You play the side to move in the start position.
async function startEndgame() {
  // intro(you, moveNo) -> text
  const play = (line, intro) => {
    const { states: parsed, error } = parseTranscript(line);
    if (error) return false;
    states = parsed;
    cursor = states.length - 1;
    T.lineColor = cur().toMove;
    render();
    userTurn(intro(`<b>${colorName(T.lineColor)}</b>`, cursor + 1));
    return true;
  };
  const rev = T.endNoReviews && !T.reviewsOnly ? null : nextReview(srsEnd, [BLACK, WHITE]);
  if (rev) {
    T.review = rev.item;
    T.reviewPly = parseTranscript(rev.item.line).states.length - 1;
    if (play(rev.item.line, (you, n) => `${rev.label}: you play ${you}, move ${n}.`)) { prepNext(); return; }
  }
  T.review = null;
  if (T.reviewsOnly) { noReviews(); return; }
  if (!endPos) findEndPositions();
  if (endPos.error) { setFeedback('Could not read start positions from the book: ' + endPos.error, 'bad'); showButtons('btn-train-start'); return; }
  if (!endPos.byKey) { T.phase = 'waiting'; showEndProgress(); showButtons(); return; }
  if (!endChoices().length) {
    setFeedback(T.endScores.length ? 'No start positions in the book with the ticked scores. Tick more scores or widen the start moves.' : 'Tick at least one start score.', 'bad');
    showButtons('btn-train-start');
    return;
  }
  // Use the prepared start position (or wait for it).
  const id = T.lineId, sig = endSig();
  const p = prepNext();
  endNext = null; // taken: the next one is prepared once this game starts
  T.phase = 'preparing';
  showButtons();
  const slow = setTimeout(() => { if (T.lineId === id) setFeedback('Preparing the start position…'); }, 150);
  const r = await p;
  clearTimeout(slow);
  if (T.lineId !== id || mode !== 'endgame') { // left meanwhile: keep it for next time
    if (r && r.line) endNext = { sig, promise: Promise.resolve(r) };
    return;
  }
  if (!r || !r.line) {
    T.phase = 'idle';
    setFeedback(r && r.error ? 'Engine error: ' + r.error
      : 'Could not find a start position with the ticked scores in that move range. Tick more scores or widen the start moves.', 'bad');
    showButtons('btn-train-start');
    return;
  }
  solveCache.set(r.board, Promise.resolve(r.solved)); // already solved: your first move is checked at once
  play(r.line, (you, n) => `New endgame from move ${n}: you play ${you}, score <b>${fmtScore(r.score)}</b>.`);
  prepNext();
}

// A book leaf (in the book, no book moves) is still quizzed on its stored best move; the line ends after it.
const OUT_OF_BOOK = 'Out of book.';

// Score of the last move on the line that has a book score, from the trained colour's side.
function lastBookScore() {
  for (let i = cursor; i >= 1; i--) {
    const prev = states[i - 1], info = probe(prev);
    const entry = info && info.moves.find((m) => m.sq === states[i].move);
    if (entry) return { score: prev.toMove === T.lineColor ? entry.score : -entry.score, ply: i, move: sqName(states[i].move) };
  }
  return null;
}

// Result of the user's previous move, kept on screen until the next answer.
function lastHtml() {
  return T.last ? `<span class="last${T.lastWarn ? ' warn' : ''}">${T.last}</span>` : '';
}

function endLine(reason) {
  T.phase = 'end';
  const l = T.line;
  const last = reason === OUT_OF_BOOK ? lastBookScore() : null;
  const lastBook = last
    ? `<br>Last book score: <b>${fmtScore(last.score)}</b> for you (${colorName(T.lineColor)}), after ${last.ply}.${last.move}.`
    : '';
  let result = '';
  if (cur().over) { // final score for the trained side
    const { black, white } = countDiscs(cur().board);
    const d = T.lineColor === BLACK ? black - white : white - black;
    result = ` You (${colorName(T.lineColor)}) ${d > 0 ? 'win' : d < 0 ? 'lose' : 'draw'} ${Math.max(black, white)}–${Math.min(black, white)}`
      + ` (<b>${fmtScore(d)}</b>).`;
  }
  setFeedback(`${lastHtml()}${reason}${result}${lastBook}<span class="sub">This line: ${l.correct}/${l.total} correct.</span>`, 'end');
  showButtons('btn-train-next', 'btn-train-copy');
  renderTrainStats();
  setAnchor();
  renderExplore();
  requestAnalysis();
}

function userTurn(intro = '') {
  const st = cur();
  if (st.over) { endLine('Game over.'); return; }
  if (st.toMove !== T.lineColor) { trainerTurn(); return; }
  if (mode === 'endgame') solve(st); // start solving while you think
  else {
    const info = probe(st);
    if (!info || !info.moves.some((m) => m.sq < 64)) { endLine(OUT_OF_BOOK); return; }
  }
  const legal = legalMoves(st.board, st.toMove);
  if (legal.length === 1) { // forced move: nothing to train
    T.phase = 'trainer';
    T.timer = setTimeout(() => { pushMove(legal[0]); T.timer = setTimeout(trainerTurn, 450); }, 350);
    return;
  }
  T.phase = 'user';
  setFeedback(lastHtml() + `${intro ? intro + '<br>' : ''}Your move as <b>${colorName(T.lineColor)}</b>: find the best move.`);
  showButtons('btn-train-next');
}

function trainerTurn() {
  const st = cur();
  if (st.over) { endLine('Game over.'); return; }
  if (st.toMove === T.lineColor) { userTurn(); return; }
  // Reviews only: the line ends once the reviewed position is answered.
  if (T.reviewsOnly && T.review && cursor > T.reviewPly) { endLine('Review done.'); return; }
  if (mode === 'endgame') { endTrainerTurn(st); return; }
  const info = probe(st);
  if (!info) { endLine(OUT_OF_BOOK); return; }
  const cands = opponentCandidates(info, T.margin, T.floor);
  if (!cands.length) { endLine(OUT_OF_BOOK); return; }
  T.phase = 'trainer';
  T.timer = setTimeout(() => {
    pushMove(pickRandom(cands).sq);
    T.timer = setTimeout(() => (cur().toMove === T.lineColor ? userTurn() : trainerTurn()), 450);
  }, 350);
}

// Train Endgame: the trainer plays a move within T.endMargin discs of the exact best.
async function endTrainerTurn(st) {
  const id = T.lineId;
  T.phase = 'trainer';
  const t0 = performance.now();
  let r;
  for (let tries = 0; tries < 3; tries++) { // a superseded solve comes back stale: ask again
    const slow = setTimeout(() => { if (T.lineId === id && cur() === st) setFeedback(lastHtml() + 'Trainer is thinking…'); }, 600);
    r = await solve(st);
    clearTimeout(slow);
    if (T.lineId !== id || cur() !== st || mode !== 'endgame') return;
    if (!r.stale) break;
  }
  if (!r.moves || !r.moves.length) { setFeedback('Engine error: ' + (r.error || 'no result'), 'bad'); showButtons('btn-train-next'); return; }
  const pick = pickRandom(withinMargin(r.moves, T.endMargin));
  T.timer = setTimeout(() => {
    if (T.lineId !== id) return;
    pushMove(pick.sq);
    T.timer = setTimeout(() => (cur().toMove === T.lineColor ? userTurn() : trainerTurn()), 450);
  }, Math.max(0, 350 - (performance.now() - t0)));
}

// Score of `sq` for the side to move in `st`: book first, Edax if the move is not in the book.
async function moveScore(st, info, sq) {
  const entry = info.moves.find((m) => m.sq === sq);
  if (entry) return { score: entry.score, source: entry.inBook ? 'book' : 'book (best non-book move)' };
  const child = playMove(st, sq);
  if (child.over) {
    const { black, white } = countDiscs(child.board);
    const diff = st.toMove === BLACK ? black - white : white - black;
    return { score: diff, source: 'final score' };
  }
  const r = await cappedAnalyze(toEdaxBoard(child.board, child.toMove), level, 1, T.cap * 1000, (step) => {
    if (T.phase === 'checking' && step.level < level) setFeedback(`Checking… (Edax level ${step.level} done)`);
  });
  const res = r.res;
  if (r.stale || r.error || !res || !res.moves || !res.moves.length) return null;
  const s = res.moves[0].score;
  return {
    score: child.toMove === st.toMove ? s : -s,
    source: `Edax level ${r.level}` + (r.capped ? ` (time cap ${T.cap} s; level ${level} not reached)` : ''),
  };
}

// After a correct move `sq` in position `st`: text naming the other best moves that need fewer
// lines to memorise (lower Umigame number for the mover, or equal and higher for the opponent),
// or '' if there are none or the numbers are not computed yet.
function umigameWarning(st, info, sq, best) {
  if (!book || !book.umigameReady()) return '';
  const mineOf = (u) => (st.toMove === BLACK ? u.b : u.w);
  const theirsOf = (u) => (st.toMove === BLACK ? u.w : u.b);
  const entry = info.moves.find((m) => m.sq === sq);
  const own = entry ? umiMove(st, entry) : { b: 1, w: 1 }; // a move outside the book ends its line
  if (!own) return '';
  const better = info.moves
    .filter((m) => m.sq < 64 && m.sq !== sq && m.score === best)
    .map((m) => ({ m, u: umiMove(st, m) }))
    .filter(({ u }) => u && (mineOf(u) < mineOf(own) || (mineOf(u) === mineOf(own) && theirsOf(u) > theirsOf(own))))
    .sort((a, b) => mineOf(a.u) - mineOf(b.u) || theirsOf(b.u) - theirsOf(a.u));
  if (!better.length) return '';
  const fmt = (u) => `${fmtCount(mineOf(u))} · ${fmtCount(theirsOf(u))}`;
  return `Umigame ${fmt(own)}; better Umigame: ${better.map(({ m, u }) => `<b>${sqName(m.sq)}</b> ${fmt(u)}`).join(', ')}.`;
}

async function trainClick(sq) {
  if (T.phase !== 'user') return;
  const st = cur();
  if (!playMove(st, sq)) return;
  if (mode === 'endgame') { endClick(st, sq); return; }
  const info = probe(st);
  T.phase = 'checking';
  setFeedback('Checking…');
  const r = await moveScore(st, info, sq);
  if (mode !== 'train' || cur() !== st) return;
  if (!r) { T.phase = 'user'; setFeedback('Could not score that move. Try again.', 'bad'); return; }

  const best = bestScore(info);
  // A move the book does not list is never correct: only book moves and the stored best
  // non-book move (* move) are in info.moves. In a position with no book moves, that means
  // only the * move is correct (Edax scores at a lower level are not comparable to it).
  const offBook = !info.moves.some((m) => m.sq === sq);
  const correct = !offBook && r.score >= best;
  const warn = correct ? umigameWarning(st, info, sq, best) : '';
  const key = book.recordKey(info.index);
  const undo = T.retrying ? null : { key, prev: srsBook.get(key) }; // lets Accept revert this record
  if (!T.retrying) {
    srsBook.record(key, lineSoFar(), T.lineColor, correct);
    posStats.record(key, lineSoFar(), T.lineColor, !correct ? 'x' : warn ? 'w' : 'c', toStored(sq, info.symmetry));
    T.line.total++; T.session.total++;
    if (correct) { T.line.correct++; T.session.correct++; }
    recordMoveStat(cursor + 1, correct, !!warn);
  }
  renderTrainStats();

  if (correct) {
    T.retrying = false;
    const others = info.moves.filter((m) => m.sq < 64 && m.score === best && m.sq !== sq).map((m) => sqName(m.sq));
    const verdict = warn ? 'correct with warning' : 'correct';
    T.lastWarn = !!warn;
    T.last = `<b>${cursor + 1}.${sqName(sq)} ${fmtScore(r.score)}</b>: ${verdict}.`
      + (warn ? ` ${warn}` : others.length ? ` Also best: ${others.join(', ')}.` : '')
      + mistakeCount(key, true, lineSoFar());
    setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b>: ${verdict}.`
      + (warn ? `<span class="sub">${warn}</span>`
        : others.length ? `<span class="sub">Also best: ${others.join(', ')}</span>` : ''), warn ? 'warn' : 'good');
    pushMove(sq);
    T.phase = 'trainer';
    T.timer = setTimeout(trainerTurn, 650);
    return;
  }

  // Wrong: show all scores for this position, mark the chosen square.
  T.phase = 'wrong';
  T.last = null;
  const list = bookList(st, info);
  if (!list.find((m) => m.sq === sq)) list.push({ sq, score: r.score });
  paintScores(list, false);
  cells[sq].classList.add('wrong');
  const bestMoves = info.moves.filter((m) => m.sq < 64 && m.score === best);
  for (const m of bestMoves) cells[m.sq].classList.add('right');
  setAnchor({ list, wrong: sq, right: bestMoves.map((m) => m.sq) });
  T.anchor.undo = undo;
  renderExplore();
  const loss = best - r.score;
  setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b> `
    + (offBook && loss <= 0 ? 'is not a book move.' : `loses ${loss} disc${loss === 1 ? '' : 's'}${offBook ? ' (not a book move)' : ''}.`)
    + ` Best: <b>${bestMoves.map((m) => sqName(m.sq) + ' ' + fmtScore(m.score)).join(', ')}</b>`
    + `<span class="sub">Score source: ${r.source}. This position is saved for review.</span>`
    + mistakeCount(key), 'bad');
  showButtons('btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy');
}

// "Mistake made N times here", with a link that opens the position in Analyse (as from Most mistakes).
// After a correct move (inline in the result line) the count is shown also when it is 0.
function mistakeCount(key, inline = false, line = '') {
  const it = posStats.get(key);
  const x = it ? it.x : 0;
  const n = it ? it.c + it.w + it.x : 0; // answers counted for this position
  if (!x && !inline) return '';
  const times = (k) => `${k} time${k === 1 ? '' : 's'}`;
  const text = `Mistake made ${times(x)} here. Trained ${times(n)}. `
    + `<button class="link" data-open="${key}" data-line="${line}">Open in Analyse with the moves you played</button>`;
  return inline ? ` ${text}` : `<span class="sub">${text}</span>`;
}
// The link lives in the feedback HTML (which is also restored after a tab switch), so listen here.
$('train-feedback').addEventListener('click', (e) => {
  const b = e.target.closest('[data-open]');
  if (b) openWorst(b.dataset.open, b.dataset.line);
});

// Train Endgame: a move is correct only if it keeps the exact best result.
async function endClick(st, sq) {
  const id = T.lineId;
  T.phase = 'checking';
  const slow = setTimeout(() => { if (T.lineId === id && T.phase === 'checking') setFeedback('Solving…'); }, 150);
  let r;
  for (let tries = 0; tries < 3; tries++) {
    r = await solve(st);
    if (T.lineId !== id || mode !== 'endgame' || cur() !== st) { clearTimeout(slow); return; }
    if (!r.stale) break;
  }
  clearTimeout(slow);
  const mine = r.moves && r.moves.find((m) => m.sq === sq);
  if (!mine) { T.phase = 'user'; setFeedback('Could not score that move. Try again.', 'bad'); return; }
  const best = r.moves[0].score;
  const correct = mine.score === best;
  const ply = cursor + 1;
  const key = toEdaxBoard(st.board, st.toMove);
  const undo = T.retrying ? null : { key, prev: srsEnd.get(key) };
  if (!T.retrying) {
    srsEnd.record(key, lineSoFar(), T.lineColor, correct);
    T.line.total++; T.endSession.total++;
    if (correct) { T.line.correct++; T.endSession.correct++; }
    recordMoveStat(ply, correct);
  }
  renderTrainStats();
  const bestMoves = r.moves.filter((m) => m.score === best);

  if (correct) {
    T.retrying = false;
    const others = bestMoves.filter((m) => m.sq !== sq).map((m) => sqName(m.sq));
    T.lastWarn = false;
    T.last = `<b>${ply}.${sqName(sq)} ${fmtScore(mine.score)}</b>: correct.` + (others.length ? ` Also best: ${others.join(', ')}` : '');
    setFeedback(`<b>${sqName(sq)} ${fmtScore(mine.score)}</b>: correct.`
      + (others.length ? `<span class="sub">Also best: ${others.join(', ')}</span>` : ''), 'good');
    pushMove(sq);
    T.phase = 'trainer';
    T.timer = setTimeout(trainerTurn, 650);
    return;
  }

  T.phase = 'wrong';
  T.last = null;
  const list = r.moves.slice();
  paintScores(list, false);
  cells[sq].classList.add('wrong');
  for (const m of bestMoves) cells[m.sq].classList.add('right');
  setAnchor({ list, wrong: sq, right: bestMoves.map((m) => m.sq) });
  T.anchor.undo = undo;
  renderExplore();
  const loss = best - mine.score;
  setFeedback(`<b>${sqName(sq)} ${fmtScore(mine.score)}</b> loses ${loss} disc${loss === 1 ? '' : 's'}.`
    + ` Best: <b>${bestMoves.map((m) => sqName(m.sq) + ' ' + fmtScore(m.score)).join(', ')}</b>`
    + '<span class="sub">Score source: Edax exact solve. This position is saved for review.</span>', 'bad');
  showButtons('btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy');
}

$('tab-analyse').onclick = () => setMode('analyse');
$('tab-endgame').onclick = () => setMode('endgame');
$('tab-train').onclick = () => setMode('train');
$('opt-train-color').value = String(T.colorPref);
$('opt-train-margin').value = String(T.margin);
$('opt-train-color').onchange = (e) => { T.colorPref = Number(e.target.value); store.set('trainColor', T.colorPref); renderTrainStats(); };
$('opt-train-margin').onchange = (e) => { T.margin = Number(e.target.value); store.set('trainMargin', T.margin); };
$('opt-train-floor').value = T.floor === null ? 'all' : String(T.floor);
$('opt-train-floor').onchange = (e) => {
  T.floor = e.target.value === 'all' ? null : Number(e.target.value);
  store.set('trainFloor', T.floor);
};
$('opt-end-margin').value = String(T.endMargin);
$('opt-end-margin').onchange = (e) => { T.endMargin = Number(e.target.value); store.set('endMargin', T.endMargin); };
for (const v of END_SCORES) {
  const l = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = T.endScores.includes(v);
  box.onchange = () => {
    T.endScores = END_SCORES.filter((x) => (x === v ? box.checked : T.endScores.includes(x)));
    store.set('endScores', T.endScores);
    renderTrainStats();
    if (mode === 'endgame') prepNext();
  };
  l.append(box, fmtScore(v));
  $('end-scores').appendChild(l);
}
// Start move range (games start after a random move in it).
for (const id of ['opt-end-from', 'opt-end-to']) {
  for (let n = 39; n <= 56; n++) $(id).add(new Option(String(n), String(n)));
}
$('opt-end-from').value = String(T.endFrom);
$('opt-end-to').value = String(T.endTo);
const setEndRange = (from, to) => {
  T.endFrom = from; T.endTo = to;
  $('opt-end-from').value = String(from);
  $('opt-end-to').value = String(to);
  store.set('endFrom', from); store.set('endTo', to);
  renderTrainStats();
  if (mode === 'endgame') prepNext();
};
$('opt-end-from').onchange = (e) => { const v = Number(e.target.value); setEndRange(v, Math.max(v, T.endTo)); };
$('opt-end-to').onchange = (e) => { const v = Number(e.target.value); setEndRange(Math.min(v, T.endFrom), v); };
$('opt-end-equal').checked = T.endEqual;
$('opt-end-equal').onchange = (e) => {
  T.endEqual = e.target.checked;
  store.set('endEqual', T.endEqual);
  if (mode === 'endgame') prepNext();
};
// No reviews (Endgame) and Reviews only exclude each other.
$('opt-end-noreviews').checked = T.endNoReviews;
$('opt-end-noreviews').onchange = (e) => {
  T.endNoReviews = e.target.checked;
  store.set('endNoReviews', T.endNoReviews);
  if (T.endNoReviews && T.reviewsOnly) { $('opt-reviews-only').checked = false; $('opt-reviews-only').onchange({ target: $('opt-reviews-only') }); }
};
// Deadline (date, local midnight): saved positions come up again by then at the latest.
const DEFAULT_DEADLINE = '2026-11-25';
function setDeadline(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
  const ms = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
  srsBook.deadline = srsEnd.deadline = ms;
}
$('opt-deadline').value = store.get('deadline', DEFAULT_DEADLINE);
setDeadline($('opt-deadline').value);
$('opt-deadline').onchange = (e) => { store.set('deadline', e.target.value); setDeadline(e.target.value); renderTrainStats(); };
$('opt-reviews-only').checked = T.reviewsOnly;
$('opt-reviews-only').onchange = (e) => {
  T.reviewsOnly = e.target.checked;
  store.set('reviewsOnly', T.reviewsOnly);
  if (T.reviewsOnly && T.endNoReviews) { // the two exclude each other
    T.endNoReviews = false;
    $('opt-end-noreviews').checked = false;
    store.set('endNoReviews', false);
  }
  if (!T.reviewsOnly && mode === 'endgame') prepNext();
};
$('opt-train-cap').value = String(T.cap);
$('opt-train-cap').onchange = (e) => { T.cap = Number(e.target.value); store.set('trainCap', T.cap); };
$('btn-train-start').onclick = startLine;
$('btn-train-next').onclick = startLine;
$('btn-train-copy').onclick = async () => {
  const text = `${lineSoFar()} ${colorName(T.lineColor).toLowerCase()}`;
  const btn = $('btn-train-copy');
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy transcript with colour'; }, 1500);
};
$('btn-train-retry').onclick = () => {
  if (T.phase !== 'wrong') return;
  restoreAnchor();
  clearMarks();
  T.retrying = true;
  T.phase = 'user';
  renderExplore();
  setFeedback('Try again: find the best move.');
  showButtons('btn-train-next');
};
// Accept: treat the move as correct after all, undo the review entry and continue the line with it.
$('btn-train-accept').onclick = () => {
  if (T.phase !== 'wrong' || !T.anchor || !T.anchor.marks) return;
  const { wrong: sq } = T.anchor.marks;
  const undo = T.anchor.undo;
  restoreAnchor();
  clearMarks();
  if (undo) {
    // Undo the miss, then record it as a correct answer (moves a due review up a box).
    srsNow().put(undo.key, undo.prev);
    srsNow().record(undo.key, lineSoFar(), T.lineColor, true);
    if (mode === 'train') posStats.accept(undo.key);
    T.line.correct++; (mode === 'endgame' ? T.endSession : T.session).correct++;
    acceptMoveStat(cursor + 1);
  }
  renderTrainStats();
  T.retrying = false;
  T.phase = 'trainer';
  setFeedback(`<b>${sqName(sq)}</b>: accepted.<span class="sub">Not saved for review.</span>`, 'good');
  T.last = `<b>${cursor + 1}.${sqName(sq)}</b>: accepted (not saved for review).`;
  showButtons('btn-train-next');
  T.lastWarn = false;
  pushMove(sq);
  T.timer = setTimeout(trainerTurn, 650);
};
$('btn-train-best').onclick = () => {
  if (T.phase !== 'wrong') return;
  restoreAnchor();
  clearMarks();
  let pick;
  if (mode === 'endgame') { // exact scores kept with the mistake
    if (!T.anchor || !T.anchor.marks) return;
    pick = T.anchor.marks.list[0];
  } else {
    const info = probe(cur());
    if (!info) return;
    const best = bestScore(info);
    pick = info.moves.find((m) => m.sq < 64 && m.inBook && m.score === best) || info.moves.find((m) => m.sq < 64 && m.score === best);
  }
  T.retrying = false;
  T.phase = 'trainer';
  T.last = `<b>${cursor + 1}.${sqName(pick.sq)} ${fmtScore(pick.score)}</b>: best move played.`;
  T.lastWarn = false;
  showButtons('btn-train-next');
  pushMove(pick.sq);
  T.timer = setTimeout(trainerTurn, 450);
};

// ---------- Actions ----------
function onCell(s) {
  if (isTrain() && !exploring()) { trainClick(s); return; }
  const next = states[cursor + 1];
  if (next && next.move === s) { cursor++; render(true); return; }
  const st = playMove(cur(), s);
  if (!st) return;
  states = states.slice(0, cursor + 1);
  states.push(st);
  cursor++;
  render(true);
}

function goTo(i) {
  if (isTrain() && !exploring()) return;
  i = Math.max(0, Math.min(states.length - 1, i));
  if (i === cursor) return;
  const step = i === cursor + 1;
  cursor = i;
  render(step);
}

function setMsg(text, isErr = false) {
  const m = $('msg');
  m.textContent = text;
  m.classList.toggle('err', isErr);
  clearTimeout(setMsg.t);
  setMsg.t = setTimeout(() => { m.textContent = ''; }, 3500);
}

$('btn-first').onclick = () => goTo(0);
$('btn-back').onclick = () => goTo(cursor - 1);
$('btn-fwd').onclick = () => goTo(cursor + 1);
$('btn-last').onclick = () => goTo(states.length - 1);
$('btn-new').onclick = () => { states = [initialState()]; cursor = 0; render(); };

$('opt-hints').onchange = (e) => boardEl.classList.toggle('hints-off', !e.target.checked);

// Disc placement: centred, or a little off-centre in each square like a real board.
function setJitter(v) {
  boardEl.classList.toggle('jit-slight', v === 'slight');
  boardEl.classList.toggle('jit-strong', v === 'strong');
}
$('opt-jitter').value = store.get('discJitter', 'off');
setJitter($('opt-jitter').value);
$('opt-jitter').onchange = (e) => { store.set('discJitter', e.target.value); setJitter(e.target.value); };

$('btn-load').onclick = () => {
  const { states: parsed, error } = parseTranscript($('transcript').value);
  states = parsed;
  cursor = states.length - 1;
  $('transcript').blur();
  render();
  if (error) setMsg(error + '. Loaded up to there.', true);
  else setMsg(`Loaded ${states.length - 1} moves`);
};

$('btn-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(transcript()); setMsg('Copied'); }
  catch { setMsg('Copy failed', true); }
};

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') goTo(cursor - 1);
  else if (e.key === 'ArrowRight') goTo(cursor + 1);
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') goTo(states.length - 1);
  else return;
  e.preventDefault();
});

render();
setMode('train'); // the app opens on Train
