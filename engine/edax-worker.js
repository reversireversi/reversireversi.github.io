// Runs Edax (WebAssembly) in a background thread so the board never freezes.
// Load as new Worker('engine/edax-worker.js')          -> release build
//      or new Worker('engine/edax-worker.js?debug')    -> debug build, verbose Edax output
//      ?hash=18 (18..24): smaller or larger search memory, 2^bits entries (default 20)
// Messages in:  { id, board, level, n }   (board: 64 chars a1..h8 + ' X' or ' O')
// Messages out: { type: 'ready' } | { type: 'log', text } | { type: 'error', error } | { id, result } | { id, error }
const DEBUG = self.location.search.includes('debug');
const HASH_BITS = Math.min(24, Math.max(18, Number(new URLSearchParams(self.location.search).get('hash')) || 20));
importScripts(DEBUG ? 'build/edax-debug.js' : 'build/edax.js');

const log = (text) => postMessage({ type: 'log', text });
let analyze = null;

(async () => {
  const evalBytes = new Uint8Array(await (await fetch('build/eval.dat')).arrayBuffer());
  const Module = await createEdax({
    locateFile: (f) => 'build/' + f,
    print: DEBUG ? log : () => {},
    printErr: log,
  });
  Module.FS.mkdir('/data');
  Module.FS.writeFile('/data/eval.dat', evalBytes);
  Module.FS.chdir('/');
  Module.ccall('edax_init', 'number', ['number'], [HASH_BITS]);
  if (DEBUG) Module.ccall('edax_set_verbosity', null, ['number'], [2]);
  analyze = Module.cwrap('edax_analyze', 'string', ['string', 'number', 'number']);
  postMessage({ type: 'ready' });
})().catch((e) => postMessage({ type: 'error', error: String(e && e.stack || e) }));

onmessage = (e) => {
  const { id, board, level, n } = e.data;
  if (!analyze) { postMessage({ id, error: 'engine not ready' }); return; }
  try {
    postMessage({ id, result: JSON.parse(analyze(board, level, n)) });
  } catch (err) {
    postMessage({ id, error: String(err && err.stack || err) });
  }
};
