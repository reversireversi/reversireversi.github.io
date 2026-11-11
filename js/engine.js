// Client for the Edax Web Worker.
// Only the latest request matters: older ones resolve as { stale: true }.
// If a long search is still running when a new request arrives, the worker is
// restarted (cheaper than waiting for a deep search to finish).

const KILL_AFTER_MS = 250;

export class Engine {
  // url: the worker script, e.g. 'engine/edax-worker.js?hash=18' for less search memory.
  constructor(onStatus = () => {}, url = 'engine/edax-worker.js') {
    this.onStatus = onStatus;
    this.url = url;
    this.seq = 0;
    this.spawn();
  }

  spawn() {
    this.ready = false;
    this.current = null;
    this.worker = new Worker(this.url);
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.onStatus('error', e.message || 'worker error');
    this.onStatus('loading');
  }

  onMessage(d) {
    if (d.type === 'log') return;
    if (d.type === 'ready') { this.ready = true; this.onStatus('ready'); this.pump(); return; }
    if (d.type === 'error') { this.onStatus('error', d.error); return; }
    const job = this.current;
    this.current = null;
    clearTimeout(this.killTimer);
    if (job && job.id === d.id) job.resolve(d.error ? { error: d.error } : d.result);
    this.pump();
  }

  // board: 64 chars a1..h8 ('X','O','-') + ' X' or ' O'
  analyze(board, level, n = 60) {
    return new Promise((resolve) => {
      if (this.pending) this.pending.resolve({ stale: true });
      this.pending = { id: ++this.seq, board, level, n, resolve };
      if (this.current) {
        clearTimeout(this.killTimer);
        const running = this.current;
        const wait = Math.max(0, KILL_AFTER_MS - (performance.now() - running.started));
        this.killTimer = setTimeout(() => {
          if (this.current !== running) return;
          running.resolve({ stale: true });
          this.worker.terminate();
          this.spawn();
        }, wait);
      } else {
        this.pump();
      }
    });
  }

  cancel() {
    if (this.pending) { this.pending.resolve({ stale: true }); this.pending = null; }
  }

  // Id of the request made by the latest analyze() call.
  lastId() { return this.seq; }

  // Stop request `id` now (time cap): drop it if queued, or restart the worker if it is running.
  abort(id) {
    if (this.pending && this.pending.id === id) { this.pending.resolve({ stale: true }); this.pending = null; return; }
    if (this.current && this.current.id === id) {
      clearTimeout(this.killTimer);
      this.current.resolve({ stale: true });
      this.worker.terminate();
      this.spawn();
    }
  }

  pump() {
    if (!this.ready || this.current || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    job.started = performance.now();
    this.current = job;
    this.worker.postMessage({ id: job.id, board: job.board, level: job.level, n: job.n });
  }
}

// Board array (0 empty, 1 black, 2 white) + side to move -> Edax board string.
export function toEdaxBoard(board, toMove) {
  let s = '';
  for (const v of board) s += v === 1 ? 'X' : v === 2 ? 'O' : '-';
  return s + (toMove === 1 ? ' X' : ' O');
}
