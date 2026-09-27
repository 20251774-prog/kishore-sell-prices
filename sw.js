/* Kishore Sell Prices v2 — cache-first service worker. Bump CACHE to force old installs to update. */
const CACHE = 'kishore-sell-v2-2026-09-27e';
const ASSETS = [
  './', './index.html', './styles.css', './core.js', './ocr.js', './app.js', './manifest.webmanifest',
  './data/fccc-basic.json', './data/fccc-produce.json', './data/fccc-auth.json',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './vendor/tesseract/tesseract.min.js', './vendor/tesseract/worker.min.js',
  './vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js', './vendor/tesseract-core/tesseract-core-lstm.wasm.js',
  './vendor/lang/eng.traineddata.gz',
  './fccc-pdf.js', './fccc-update.js', './vendor/pdfjs/pdf.min.js', './vendor/pdfjs/pdf.worker.min.js', './data/fccc-csv-template.csv',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
