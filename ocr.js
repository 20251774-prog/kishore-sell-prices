/* Kishore Sell Prices v2 — on-device OCR (Tesseract.js 5, all assets local in vendor/). */
(function () {
  'use strict';
  const CACHE_PATH = 'kishore-v2';
  let workerP = null;
  let tessLoaded = null;
  const isFile = location.protocol === 'file:';
  const abs = (rel) => new URL(rel, location.href).href;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  function loadTess() {
    if (!tessLoaded) tessLoaded = window.Tesseract ? Promise.resolve() : loadScript('vendor/tesseract/tesseract.min.js');
    return tessLoaded;
  }

  // On file:// the worker cannot fetch() eng.traineddata, so we inject it into the same IndexedDB cache Tesseract reads.
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('keyval-store');
      r.onupgradeneeded = () => r.result.createObjectStore('keyval');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('keyval').objectStore('keyval').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
  async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('keyval', 'readwrite'); tx.objectStore('keyval').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }
  async function ensureLangForFileMode(progress) {
    const key = CACHE_PATH + '/eng.traineddata';
    const have = await idbGet(key).catch(() => null);
    if (have) return;
    progress && progress('Loading English reader data (file mode)…', 0.05);
    await loadScript('vendor/lang/eng.traineddata.gz.js');
    const b64 = window.KISHORE_ENG_TRAINEDDATA_GZ_B64;
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    await idbSet(key, u8);
    window.KISHORE_ENG_TRAINEDDATA_GZ_B64 = null;
  }

  let progressCb = null;
  async function getWorker(progress) {
    progressCb = progress;
    if (workerP) return workerP;
    workerP = (async () => {
      await loadTess();
      if (isFile) await ensureLangForFileMode(progress);
      const w = await Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract-core/'),
        langPath: abs('vendor/lang'),
        cachePath: CACHE_PATH,
        gzip: true,
        workerBlobURL: true,
        logger: (m) => { if (progressCb && m && m.status) progressCb(m.status, m.progress || 0); },
        errorHandler: (e) => console.warn('tesseract', e),
      });
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
    return workerP;
  }

  async function fileToBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fall through */ }
    }
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file); const img = new Image();
      img.onload = () => { res(img); URL.revokeObjectURL(url); }; img.onerror = rej; img.src = url;
    });
  }

  /** Downscale to max ~2000px long side, grayscale, contrast stretch, optional adaptive threshold. */
  function preprocess(bmp, opts = {}) {
    const W0 = bmp.width, H0 = bmp.height, long = Math.max(W0, H0);
    let scale = Math.min(1, 2000 / long);
    if (long < 1400) scale = 1400 / long;
    const w0 = Math.round(W0 * scale), h0 = Math.round(H0 * scale);
    const rot = ((+opts.rotate || 0) % 360 + 360) % 360;
    const side = rot === 90 || rot === 270;
    const W = side ? h0 : w0, H = side ? w0 : h0;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(bmp, -w0 / 2, -h0 / 2, w0, h0); ctx.restore();
    const img = ctx.getImageData(0, 0, W, H); const d = img.data; const n = W * H;
    const g = new Uint8ClampedArray(n); const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000; g[i] = v; hist[g[i]]++; }
    // contrast stretch between 1st and 99th percentile
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.01) { lo = v; break; } }
    acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.01) { hi = v; break; } }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) g[i] = ((g[i] - lo) * 255) / span;
    if (opts.bw) {
      // Bradley adaptive threshold (integral image) — robust to shadows
      const S = Math.max(15, Math.round(W / 24)), T = 0.15, half = S >> 1;
      const I = new Float64Array((W + 1) * (H + 1));
      for (let y = 1; y <= H; y++) { let row = 0; for (let x = 1; x <= W; x++) { row += g[(y - 1) * W + x - 1]; I[y * (W + 1) + x] = I[(y - 1) * (W + 1) + x] + row; } }
      const out = new Uint8ClampedArray(n);
      for (let y = 0; y < H; y++) {
        const y1 = Math.max(0, y - half), y2 = Math.min(H - 1, y + half);
        for (let x = 0; x < W; x++) {
          const x1 = Math.max(0, x - half), x2 = Math.min(W - 1, x + half);
          const cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum = I[(y2 + 1) * (W + 1) + x2 + 1] - I[y1 * (W + 1) + x2 + 1] - I[(y2 + 1) * (W + 1) + x1] + I[y1 * (W + 1) + x1];
          out[y * W + x] = g[y * W + x] * cnt <= sum * (1 - T) ? 0 : 255;
        }
      }
      for (let i = 0; i < n; i++) g[i] = out[i];
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = g[i]; d[j + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Small colour JPEG for history/thumbnail */
  function thumbnail(bmp, maxSide = 1400, q = 0.72) {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }

  async function recognizeFile(file, opts = {}, progress) {
    const t0 = performance.now();
    progress && progress('Preparing photo…', 0.02);
    const bmp = opts.bitmap || await fileToBitmap(file);
    const photo = opts.photo || thumbnail(bmp);
    const canvas = preprocess(bmp, opts);
    const w = await getWorker(progress);
    progress && progress('recognizing text', 0);
    const r = await w.recognize(canvas);
    const ms = Math.round(performance.now() - t0);
    return { text: r.data.text, confidence: r.data.confidence, photo, bitmap: bmp, ms, width: canvas.width, height: canvas.height, rotate: opts.rotate || 0 };
  }

  window.KOCR = { getWorker, recognizeFile, preprocess, fileToBitmap, isFile };
})();
