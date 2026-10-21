// Offline support for the app shell.
//
// Network first: when online, every file is revalidated with the server (a
// cheap 304 when unchanged), so a refresh always shows the latest version.
// The cache is only a fallback for when there's no connection or the network
// is too slow. Downloads bypass the browser's HTTP cache, because GitHub Pages
// tells browsers to reuse files for 10 minutes, which would otherwise let a
// new version be built from stale files.
const VERSION = 'glasswild-v6';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/main.js', 'js/world.js', 'js/fauna.js', 'js/flora.js', 'js/scenery.js', 'js/clock.js',
  'js/art.js', 'js/skyfx.js', 'js/when.js', 'js/tasks.js', 'js/ui.js', 'js/audio.js', 'js/particles.js', 'js/palette.js', 'js/species.js', 'js/util.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
const TIMEOUT_MS = 4000;

const fresh = (url) => new Request(url, { cache: 'no-cache', credentials: 'same-origin' });

// GitHub Pages marks files reusable for 10 minutes, which lets the browser's
// in-memory cache hand out old scripts without asking us. Responses we pass
// on are re-labelled so the browser always checks back first.
function revalidating(res) {
  if (!res || !res.ok || res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'no-cache');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.all(SHELL.map((u) => fetch(fresh(u)).then((res) => { if (res.ok) return c.put(u, revalidating(res)); }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const net = fetch(fresh(req.url)).then((raw) => {
      const res = revalidating(raw);
      if (res.ok) cache.put(req.url.split('?')[0], res.clone());
      return res;
    });
    // a slow connection falls back to the saved copy rather than hanging
    const slow = new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS));
    try {
      const res = await Promise.race([net, slow]);
      if (res) return res;
    } catch { /* offline: use the saved copy */ }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return net.catch(() => Response.error());
  })());
});
