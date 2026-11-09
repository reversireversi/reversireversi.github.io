// Service worker: lets the trainer open and run without a network connection.
// Network first (so new versions arrive as soon as they are published), with a copy of
// every file kept in a cache for offline use. The book itself is not handled here; it is
// kept by the page in IndexedDB and never fetched over the network.

const CACHE = 'reversi-trainer-v2';
const NETWORK_TIMEOUT_MS = 4000; // on a poor connection, fall back to the saved copy

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/main.js',
  'js/reversi.js',
  'js/engine.js',
  'js/book.js',
  'js/train.js',
  'js/device-store.js',
  'js/umigame-worker.js',
  'js/endgame-worker.js',
  'engine/edax-worker.js',
  'engine/build/edax.js',
  'engine/build/edax.wasm',
  'engine/build/eval.dat',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event));
});

async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const key = new URL(req.url);
  key.search = ''; // "?v=…" cache busters share one entry
  const saved = async () => (await cache.match(key.href)) || (req.mode === 'navigate' ? cache.match('index.html') : undefined);

  const net = fetch(req).then((res) => {
    if (res.ok) event.waitUntil(store(cache, key.href, res.clone())); // save in the background
    return res;
  });
  net.catch(() => {}); // handled below
  try {
    return await withTimeout(net, NETWORK_TIMEOUT_MS);
  } catch {
    // Slow or offline: use the saved copy if there is one, else keep waiting for the network.
    const hit = await saved();
    if (hit) return hit;
    try { return await net; } catch {
      return new Response('Offline and not saved yet', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  }
}

// Save a response unless the same version is already saved (avoids rewriting the 14 MB
// evaluation file on every start).
async function store(cache, url, res) {
  const old = await cache.match(url);
  const tag = (r) => r && (r.headers.get('etag') || r.headers.get('last-modified'));
  if (old && tag(old) && tag(old) === tag(res)) return;
  await cache.put(url, res);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
