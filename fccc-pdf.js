/* Kishore Sell Prices — FCCC PDF list parser (runs in the browser with pdf.js, and in Node for tests).
   Port of the pdfplumber parsers used to build data/fccc-basic.json and data/fccc-produce.json:
   words are rebuilt from pdf.js text items (x/y positions), rows grouped by y, columns by fixed x ranges,
   item blocks split by the table's horizontal grid lines (Basic list). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KFcccPdf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NUM_B = /^\d{1,4}\.\d{1,2}$/;
  const NUM_P = /^\d{1,4}\.\d{2}$/;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // ------------------------------------------------------------------ page extraction
  function mul(m, n) { return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  /** Words (like pdfplumber extract_words, x_tolerance≈1.5) with top/bottom measured from the page top. */
  function wordsFromText(tc, H) {
    const words = []; let prev = null; // prev = {word, itemEndX, baseline}
    for (const it of tc.items) {
      const str = it.str || '';
      if (!str.length) { prev = null; continue; }
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      const x = it.transform[4], base = it.transform[5];
      if (!str.trim()) { prev = null; continue; }
      const cw = it.width / str.length;
      const re = /\S+/g; let m; let first = true;
      while ((m = re.exec(str))) {
        const x0 = x + m.index * cw, x1 = x0 + m[0].length * cw;
        const top = H - base - 0.79 * size, bottom = H - base + 0.21 * size;
        if (first && m.index === 0 && prev && Math.abs(prev.base - base) < 0.6 && x0 - prev.w.x1 <= 1.5 && x0 - prev.w.x1 > -2) {
          prev.w.text += m[0]; prev.w.x1 = x1;
        } else {
          words.push({ text: m[0], x0, x1, top, bottom });
        }
        first = false;
        prev = { w: words[words.length - 1], base };
      }
      if (/\s$/.test(str)) prev = null;
    }
    return words;
  }

  /** Horizontal edges (from rectangles and horizontal line segments), pdfplumber-style 'top'. */
  function hEdgesFromOps(ops, OPS, H) {
    const edges = []; let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, a);
      else if (fn === OPS.constructPath) {
        const sub = a[0], args = a[1]; let k = 0; let cur = null;
        for (const op of sub) {
          if (op === OPS.rectangle) {
            const x = args[k], y = args[k + 1], w = args[k + 2], h = args[k + 3]; k += 4;
            const p1 = apply(ctm, x, y), p2 = apply(ctm, x + w, y + h);
            const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]);
            edges.push({ top: H - p1[1], x0, x1 }); edges.push({ top: H - p2[1], x0, x1 });
          } else if (op === OPS.moveTo) { cur = apply(ctm, args[k], args[k + 1]); k += 2; }
          else if (op === OPS.lineTo) {
            const p = apply(ctm, args[k], args[k + 1]); k += 2;
            if (cur && Math.abs(p[1] - cur[1]) < 0.01) edges.push({ top: H - p[1], x0: Math.min(p[0], cur[0]), x1: Math.max(p[0], cur[0]) });
            cur = p;
          } else if (op === OPS.curveTo) k += 6;
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
        }
      }
    }
    return edges;
  }

  async function extractPages(pdf, OPS, opts = {}) {
    const pages = []; let headText = '';
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const H = page.view[3] - page.view[1];
      const tc = await page.getTextContent();
      const words = wordsFromText(tc, H);
      let edges = [];
      if (opts.edges) edges = hEdgesFromOps(await page.getOperatorList(), OPS, H);
      if (n <= 2) headText += ' ' + words.filter((w) => w.top < 118).map((w) => w.text).join(' ');
      pages.push({ n, words, edges });
      page.cleanup && page.cleanup();
      opts.progress && opts.progress(n, pdf.numPages);
    }
    return { pages, headText };
  }

  // ------------------------------------------------------------------ helpers
  function groupLines(words, tol = 2) {
    const lines = new Map();
    const keys = [];
    for (const w of words) {
      const k = Math.round(w.top);
      let mk = keys.find((m) => Math.abs(m - k) <= tol);
      if (mk === undefined) { mk = k; keys.push(k); lines.set(k, []); }
      lines.get(mk).push(w);
    }
    return lines;
  }
  function detectType(text) {
    const t = (text || '').toLowerCase();
    if (/produce/.test(t) && /(onion|potato|garlic|produce summary|produce master)/.test(t)) return 'produce';
    if (/basic food|food item prices|prices of basic food/.test(t)) return 'basic';
    if (/produce/.test(t)) return 'produce';
    return null;
  }
  function readAsAt(text) {
    const m = String(text || '').match(/as\s+(?:at|of)\s+(?:[A-Za-z]+day\s*,?\s*)?(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\s*,?\s+(\d{4})/i)
      || String(text || '').match(/as\s+(?:at|of)\s+(\d{1,2})[./-](\d{1,2})[./-](\d{4})/i);
    if (!m) return null;
    const mo = isNaN(+m[2]) ? MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()] : +m[2];
    if (!mo) return null;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
  }
  const num = (t) => parseFloat(t.replace(/,/g, ''));

  // ------------------------------------------------------------------ Basic Food list
  const WS_COLS = [318, 363, 408, 453, 495, 537];
  const RT_COLS = [583, 628, 673, 718, 763, 813];
  function colidx(xc, cols) { for (let i = 0; i < 5; i++) if (cols[i] <= xc && xc < cols[i + 1]) return i; return null; }

  function parseBasicPages(pages) {
    const items = []; let cur = null; let category = null; let vat = null; let carry = null;
    // pass 1: blocks (item cells) per page, split by the horizontal grid lines of the description column
    const pageBlocks = pages.map((pg) => {
      const body = pg.words.filter((w) => w.top > 118 && w.top < 550);
      const hs = [...new Set(pg.edges.filter((e) => e.x0 <= 20 && e.x1 >= 250).map((e) => Math.round(e.top)))].sort((a, b) => a - b);
      const boundaries = hs.filter((b) => b > 115);
      const blockOf = (y) => boundaries.filter((b) => b < y).length;
      const merged = groupLines(body, 2);
      const blocks = new Map(); const blockcat = new Map();
      for (const k of [...merged.keys()].sort((a, b) => a - b)) {
        const ws = merged.get(k).slice().sort((a, b) => a.x0 - b.x0);
        const prices = ws.filter((w) => NUM_B.test(w.text.replace(/,/g, '')));
        if (!prices.length) {
          const vw = ws.filter((w) => w.x0 >= 755).map((w) => w.text).join(' ');
          const cw = ws.filter((w) => w.x0 < 755);
          const m = vw.match(/([\d.]+)\s*%/);
          if (m) vat = parseFloat(m[1]);
          if (cw.length && cw.every((w) => w.x0 >= 320 && w.x1 <= 560) && /[A-Za-z]/.test(cw.map((w) => w.text).join(' '))) {
            category = cw.map((w) => w.text).join(' ').trim(); continue;
          }
          if (!cw.length) continue;
        }
        const b = blockOf(k);
        if (!blocks.has(b)) { blocks.set(b, []); blockcat.set(b, [category, vat]); }
        blocks.get(b).push([k, ws]);
      }
      return [...blocks.keys()].sort((a, b) => a - b).map((bi) => {
        const lines = blocks.get(bi);
        const descY = lines.filter(([, ws]) => ws.some((w) => w.x1 < 256)).map(([k]) => k);
        const rowY = lines.filter(([, ws]) => ws.some((w) => w.x0 >= 318 && NUM_B.test(w.text.replace(/,/g, '')))).map(([k]) => k);
        const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
        return { lines, hasDesc: descY.length > 0, descC: avg(descY), rowC: avg(rowY), cat: blockcat.get(bi) };
      });
    });
    const packsOfLines = (lines) => lines.map(([, ws]) => ({
      rt: ws.filter((w) => w.x0 >= 537 && w.x0 < 585 && !NUM_B.test(w.text)).map((w) => w.text).join('').toLowerCase(),
      ws: ws.filter((w) => w.x0 >= 256 && w.x1 <= 320 && !NUM_B.test(w.text)).map((w) => w.text).join('').toLowerCase(),
    }));
    const dupPacks = (target, lines) => {
      if (!target) return false;
      const tr = target.rows.map((r) => String(r.rt_pack || '').toLowerCase().replace(/\s+/g, '')).filter(Boolean);
      const tw = target.rows.map((r) => String(r.ws_pack || '').toLowerCase().replace(/\s+/g, '')).filter(Boolean);
      return packsOfLines(lines).some((p) => (p.rt ? tr.includes(p.rt.replace(/\s+/g, '')) : !!(p.ws && tw.includes(p.ws.replace(/\s+/g, '')))));
    };
    const newItem = (pg, blk, extra) => Object.assign({ desc: [], rows: [], frags: [], page: pg.n, category: blk.cat[0], vat: blk.cat[1] }, extra || {});
    // pass 2: assemble items; rows at the bottom of a page may belong to the item described at the top of the next page
    pages.forEach((pg, pi) => {
      const order = pageBlocks[pi];
      order.forEach((blk, oi) => {
        const lines = blk.lines;
        let it;
        if (!blk.hasDesc) {
          const target = carry || cur;
          const last = oi === order.length - 1 && oi > 0;
          const nextFirst = pageBlocks[pi + 1] && pageBlocks[pi + 1][0];
          // split cell: next page starts with a description whose text sits ABOVE the centre of its rows
          const split = last && nextFirst && nextFirst.hasDesc && nextFirst.rowC != null && nextFirst.descC < nextFirst.rowC - 3;
          const dup = dupPacks(target, lines);
          // top of page: more packs of the item from the previous page. Bottom of page: grid lines only cross the
          // description column at item boundaries, so rows alone at the bottom belong to the item described on the next page.
          if (oi === 0 && target) it = target;
          else if (last && (split || dup || nextFirst)) { if (carry) items.push(carry); it = newItem(pg, blk, { carried: true }); carry = it; }
          else if (target && !dup) it = target;
          else { if (carry) { items.push(carry); carry = null; } it = newItem(pg, blk); items.push(it); cur = it; }
        } else if (carry && oi === 0) { it = carry; carry = null; items.push(it); cur = it; }
        else { if (carry) { items.push(carry); carry = null; } it = newItem(pg, blk); items.push(it); cur = it; }
        for (const [k, ws] of lines) {
          const d = ws.filter((w) => w.x1 < 256).map((w) => w.text);
          if (d.length) it.desc.push(d.join(' '));
          const wq = ws.filter((w) => w.x0 >= 256 && w.x1 <= 320 && !NUM_B.test(w.text)).map((w) => w.text).join(' ');
          const rq = ws.filter((w) => w.x0 >= 537 && w.x0 < 585 && !NUM_B.test(w.text)).map((w) => w.text).join(' ');
          const wp = [null, null, null, null, null], rp = [null, null, null, null, null];
          for (const w of ws) {
            const t = w.text.replace(/,/g, '');
            if (!NUM_B.test(t)) continue;
            const xc = (w.x0 + w.x1) / 2;
            if (w.x0 >= 318 && w.x1 <= 540) { const i = colidx(xc, WS_COLS); if (i !== null) wp[i] = parseFloat(t); }
            else if (w.x0 >= 583) { const i = colidx(xc, RT_COLS); if (i !== null) rp[i] = parseFloat(t); }
          }
          const anyW = wp.some((v) => v !== null), anyR = rp.some((v) => v !== null);
          if ((wq || rq) && !anyW && !anyR) { it.frags.push([k, wq, rq]); continue; }
          if (wq || anyW || rq || anyR) it.rows.push({ y: k + (it.carried && it.page !== pg.n ? 1000 : 0), ws_pack: wq || null, ws: anyW ? wp : null, rt_pack: rq || null, rt: anyR ? rp : null });
        }
      });
    });
    if (carry) items.push(carry);
    // wrapped pack fragments -> nearest row within 18pt
    for (const it of items) {
      for (const [k, wq, rq] of it.frags) {
        for (const [key, txt] of [['ws_pack', wq], ['rt_pack', rq]]) {
          if (!txt) continue;
          const cand = it.rows.filter((r) => (key === 'ws_pack' ? r.ws : r.rt) && Math.abs(r.y - k) <= 18);
          if (!cand.length) continue;
          const r = cand.reduce((a, b) => (Math.abs(b.y - k) < Math.abs(a.y - k) ? b : a));
          if (!r[key + '_parts']) r[key + '_parts'] = r[key] ? [[r.y, r[key]]] : [];
          r[key + '_parts'].push([k, txt]); r[key + '_parts'].sort((a, b) => a[0] - b[0]);
          r[key] = r[key + '_parts'].map((p) => p[1]).join(' ');
        }
      }
    }
    const out = []; let base = '';
    for (const it of items) {
      let name = it.desc.join(' ').replace(/\s+/g, ' ').trim();
      if (/^[(\-–]*\s*if\b/i.test(name) && base) name = base + ' ' + name;
      else if (name) base = name;
      const rows = it.rows.map((r) => [r.ws ? r.ws_pack : null, r.ws ? r.ws[0] : null, r.ws ? r.ws[4] : null, r.rt ? r.rt_pack : null, r.rt ? r.rt[0] : null, r.rt ? r.rt[4] : null]);
      if (!rows.some((r) => r[1] != null || r[2] != null || r[4] != null || r[5] != null)) continue;
      out.push({ n: name, c: it.category, v: it.vat, p: it.page, r: rows });
    }
    return out;
  }

  // ------------------------------------------------------------------ Produce list
  const PWS = [300, 350, 398, 446, 494, 545], PRT = [585, 636, 684, 732, 780, 830];
  function parseProducePages(pages) {
    const out = []; let category = null; let lastTrader = null;
    for (const pg of pages) {
      const words = pg.words.filter((w) => w.top > 118 && w.top < 550);
      const lines = groupLines(words, 2);
      const names = [], rows = [];
      for (const k of [...lines.keys()].sort((a, b) => a - b)) {
        const ws = lines.get(k).slice().sort((a, b) => a.x0 - b.x0);
        if (!ws.some((w) => NUM_P.test(w.text)) && ws.every((w) => w.x0 > 300 && w.x1 < 560)) { category = ws.map((w) => w.text).join(' '); continue; }
        const nm = ws.filter((w) => w.x1 < 215).map((w) => w.text).join(' ');
        if (nm) names.push([k, k, nm]);
        const oo = ws.filter((w) => w.x0 >= 215 && w.x0 < 260).map((w) => w.text).join(' ');
        const wq = ws.filter((w) => w.x0 >= 260 && w.x0 < 305 && !NUM_P.test(w.text)).map((w) => w.text).join(' ');
        const rq = ws.filter((w) => w.x0 >= 545 && w.x0 < 590 && !NUM_P.test(w.text)).map((w) => w.text).join(' ');
        const wp = [null, null, null, null, null], rp = [null, null, null, null, null];
        for (const w of ws) {
          if (!NUM_P.test(w.text)) continue;
          const xc = (w.x0 + w.x1) / 2;
          if (xc < 545) { const i = colidx(xc, PWS); if (i !== null) wp[i] = parseFloat(w.text); }
          else { const i = colidx(xc, PRT); if (i !== null) rp[i] = parseFloat(w.text); }
        }
        if (oo || wq || rq) rows.push({ y: k, oo, wq, rq, wp, rp, cat: category });
      }
      const g = [];
      for (const nmr of names) {
        const last = g[g.length - 1];
        if (last && nmr[0] - last[1] <= 13 && !rows.some((r) => last[1] < r.y && r.y < nmr[0] && r.oo)) { last[1] = nmr[0]; last[2] += ' ' + nmr[2]; }
        else g.push(nmr.slice());
      }
      const mr = [];
      for (const r of rows) {
        const last = mr[mr.length - 1];
        if (last && !r.oo && last.oo && !last.wq && r.y - last.y <= 4) { for (const k of Object.keys(r)) if (k !== 'oo' && k !== 'y') last[k] = r[k]; continue; }
        mr.push(Object.assign({}, r));
      }
      // An Own + Others pair always shares one trader; if the trader name wraps onto both rows, join the pieces.
      const pairName = {};
      for (let i = 0; i + 1 < mr.length; i++) {
        const a = mr[i], b = mr[i + 1];
        if (/^Own/.test(a.oo || '') && /^Other/.test(b.oo || '') && b.y - a.y <= 20) {
          const inside = g.filter((x) => { const c = (x[0] + x[1]) / 2; return c >= a.y - 3 && c <= b.y + 3; });
          if (inside.length >= 2) pairName[i] = pairName[i + 1] = inside.map((x) => x[2]).join(' ');
        }
      }
      for (let ri = 0; ri < mr.length; ri++) {
        const r = mr[ri];
        if (!r.wq && !r.rq) continue;
        let trader;
        if (pairName[ri] != null) trader = pairName[ri];
        else {
          let best = null;
          for (const [a, b, nm] of g) { const d = Math.abs((a + b) / 2 - r.y); if (d <= 20 && (!best || d < best[0])) best = [d, nm]; }
          trader = best ? best[1] : lastTrader;
        }
        lastTrader = trader;
        out.push({ category: r.cat, trader, oo: r.oo || null, wq: r.wq, vlws: r.wp[0], oiws: r.wp[4], rq: r.rq, vlrt: r.rp[0], oirt: r.rp[4], page: pg.n });
      }
    }
    return out.map((o) => ({
      n: `${o.category} – ${o.trader} (${o.oo})`, c: String(o.category || '').toUpperCase(), v: 0, p: o.page, trader: o.trader, oo: o.oo,
      r: [[o.wq, o.vlws, o.oiws, o.rq, o.vlrt, o.oirt]],
    }));
  }

  // ------------------------------------------------------------------ public
  /** Parse a PDF ArrayBuffer. pdfjsLib = window.pdfjsLib (or require('pdfjs-dist/legacy/build/pdf.js')). type: 'basic'|'produce'|'auto' */
  async function parsePdf(pdfjsLib, data, type = 'auto', opts = {}) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(data), isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
    // peek at page 1 header to detect type/date
    const p1 = await pdf.getPage(1); const H1 = p1.view[3] - p1.view[1];
    const head = wordsFromText(await p1.getTextContent(), H1).map((w) => w.text).join(' ');
    const detected = detectType(head);
    const t = type === 'auto' ? detected : type;
    if (!t) throw new Error('Could not tell if this is the Basic Food or Produce list. Choose the list type and try again.');
    const { pages } = await extractPages(pdf, pdfjsLib.OPS, { edges: t === 'basic', progress: opts.progress });
    const asAt = readAsAt(head);
    const items = t === 'basic' ? parseBasicPages(pages) : parseProducePages(pages);
    const title = t === 'basic' ? 'FCCC Basic Food Items Master Price List' : 'FCCC Produce Master Price List';
    const ds = {
      kind: t, as_at: asAt, detected, pages: pdf.numPages, count: items.length, items,
      source: `${title}${asAt ? ' as at ' + asAt : ''}${opts.fileName ? ' (' + opts.fileName + ')' : ''} — uploaded, parsed on phone`,
      columns: 'rows = [wholesale pack, VL urban max wholesale, OI max wholesale, retail pack, VL urban max retail, OI max retail]',
      header: head.slice(0, 300),
    };
    pdf.destroy && pdf.destroy();
    return ds;
  }

  /** Stats + problems for a dataset */
  function stats(ds) {
    const items = ds.items || [];
    let wsRows = 0, rtRows = 0, both = 0, noPrice = 0, noName = 0;
    const problems = [];
    for (const it of items) {
      const w = it.r.filter((r) => r[1] != null).length, o = it.r.filter((r) => r[5] != null).length;
      wsRows += w; rtRows += o; if (w && o) both++;
      if (!it.n) noName++;
      if (!o) noPrice++;
    }
    if (noName) problems.push(`${noName} item(s) without a name`);
    if (noPrice) problems.push(`${noPrice} item(s) have no Outer Island retail price`);
    return { items: items.length, wsRows, rtRows, both, noPrice, noName, problems };
  }

  // ------------------------------------------------------------------ CSV fallback
  const CSV_COLS = ['item', 'pack_wholesale', 'vl_urban_wholesale', 'pack_retail', 'oi_retail', 'category'];
  function splitCsvLine(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out.map((s) => s.trim());
  }
  function parseCsv(text, opts = {}) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new Error('CSV is empty');
    const head = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const idx = {}; CSV_COLS.forEach((c) => { idx[c] = head.indexOf(c); });
    if (idx.item < 0 || idx.oi_retail < 0) throw new Error('CSV header must include at least: item, oi_retail (template: ' + CSV_COLS.join(',') + ')');
    const items = []; const byName = new Map(); const bad = [];
    lines.slice(1).forEach((l, i) => {
      const c = splitCsvLine(l); const g = (k) => (idx[k] >= 0 ? c[idx[k]] || '' : '');
      const name = g('item'); if (!name) return;
      const vlw = g('vl_urban_wholesale') ? num(g('vl_urban_wholesale')) : null;
      const oir = g('oi_retail') ? num(g('oi_retail')) : null;
      if ((vlw != null && isNaN(vlw)) || (oir != null && isNaN(oir))) { bad.push(i + 2); return; }
      const row = [g('pack_wholesale') || null, vlw, null, g('pack_retail') || null, null, oir];
      let it = byName.get(name);
      if (!it) { it = { n: name, c: (g('category') || 'CSV').toUpperCase(), v: /12\.5/.test(g('category')) ? 12.5 : 0, p: null, r: [] }; byName.set(name, it); items.push(it); }
      it.r.push(row);
    });
    return {
      kind: opts.kind || 'basic', as_at: opts.asAt || null, count: items.length, items, csvBadLines: bad,
      source: `CSV upload${opts.fileName ? ' (' + opts.fileName + ')' : ''}`,
      columns: 'rows = [wholesale pack, VL urban max wholesale, OI max wholesale, retail pack, VL urban max retail, OI max retail]',
    };
  }
  const CSV_TEMPLATE = CSV_COLS.join(',') + '\n'
    + '"FMF Blue Premium Soyabean Oil (If FMF Foods Limited wholesale to others)",12x1L,49.96,1L,4.98,EDIBLE OIL\n'
    + '"FMF Blue Premium Soyabean Oil (If FMF Foods Limited wholesale to others)",4x5L,75.81,5L,22.70,EDIBLE OIL\n';

  return { parsePdf, parseBasicPages, parseProducePages, extractPages, wordsFromText, hEdgesFromOps, detectType, readAsAt, stats, parseCsv, CSV_TEMPLATE, CSV_COLS };
});
