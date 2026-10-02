/* OPIc 노트 service worker
 * - Page shell (HTML, manifest, icons): served from cache first, refreshed in the background.
 *   When a newer page is found, open pages get a 'page-updated' message and show a reload prompt.
 * - Audio (audio/*.mp3): nothing is downloaded up front. A clip is fetched the first time it is
 *   played (or by the in-page "받기" buttons) and kept in its own cache for offline use.
 *   Range requests from <audio> are answered from the cached file with 206 responses.
 * - Google Fonts: cached the first time they are used, so the page keeps its typefaces offline.
 * No persistent-storage request: if the browser clears the cache, clips are fetched again on play.
 */
const SHELL = 'opic-notes-shell-v1';
const AUDIO = 'opic-notes-audio';      // unversioned on purpose: survives app updates
const FONTS = 'opic-notes-fonts-v1';
const KEEP = [SHELL, AUDIO, FONTS];
const PAGE = new URL('opic-study-notes.html', self.registration.scope).href;
const UPDATED_MARK = new URL('__page-updated-at', self.registration.scope).href;
const SHELL_FILES = [
  './',
  'index.html',
  'opic-study-notes.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('opic-notes-') && !KEEP.includes(n))
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (!url.href.startsWith(self.registration.scope)) return;
    if (url.pathname.endsWith('/sw.js')) return; // let the browser handle worker updates itself
    if (/\/audio\/[^/]+\.mp3$/.test(url.pathname)) {
      event.respondWith(audioResponse(req));
      return;
    }
    event.respondWith(shellResponse(event));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fontResponse(req));
  }
});

/* ---------- page shell: stale-while-revalidate ---------- */
async function shellResponse(event) {
  const req = event.request;
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });

  const refresh = (async () => {
    try {
      const fresh = await fetch(req.url.split('#')[0], { cache: 'no-cache' });
      if (!fresh.ok) return null;
      const changed = cached && versionOf(cached) !== versionOf(fresh);
      await cache.put(stripSearch(req.url), fresh.clone());
      if (changed && stripSearch(req.url) === PAGE) {
        // remember when a newer page arrived; the page compares this with its own load time
        await cache.put(UPDATED_MARK, new Response(String(Date.now())));
        notify({ type: 'page-updated' });
      }
      return fresh;
    } catch (e) {
      return null;
    }
  })();

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const fresh = await refresh;
  if (fresh) return fresh;
  if (req.mode === 'navigate') {
    const page = await cache.match(PAGE);
    if (page) return page;
  }
  return Response.error();
}

function versionOf(res) {
  return res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length') || '';
}

function stripSearch(href) {
  const u = new URL(href);
  u.search = '';
  u.hash = '';
  return u.href;
}

async function notify(msg) {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach((c) => c.postMessage(msg));
}

/* ---------- audio: cache on first play, answer ranges from the cache ---------- */
async function audioResponse(req) {
  const key = stripSearch(req.url);
  const cache = await caches.open(AUDIO);
  let res = await cache.match(key);
  if (!res) {
    let net;
    try {
      net = await fetch(key); // full file, no Range header
    } catch (e) {
      return Response.error(); // offline and not saved yet
    }
    if (!net.ok) return net;
    try { await cache.put(key, net.clone()); } catch (e) { /* storage full: still play it */ }
    res = net;
  }
  const range = req.headers.get('range');
  return range ? sliceResponse(res, range) : res;
}

async function sliceResponse(res, range) {
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - parseInt(m[2], 10));
    } else {
      start = parseInt(m[1] || '0', 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
    }
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': res.headers.get('content-type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

/* ---------- Google Fonts: cache first ---------- */
async function fontResponse(req) {
  const cache = await caches.open(FONTS);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  try {
    // fetch as CORS so the cached copy is a normal (non-opaque) response
    const net = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (net.ok) {
      try { await cache.put(req.url, net.clone()); } catch (e) { /* ignore */ }
    }
    return net;
  } catch (e) {
    return Response.error(); // offline: the page falls back to system fonts
  }
}
