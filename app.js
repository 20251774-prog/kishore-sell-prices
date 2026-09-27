/* Kishore Sell Prices v2 — UI (Scan / Price / FCCC / History / Help). Uses KCore (core.js) and KOCR (ocr.js). */
(function () {
  'use strict';
  const K = window.KCore;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NON_FCCC_CATS = new Set(['spice', 'noodles', 'coke', 'jasmine', 'meat', 'lamb_sausage', 'eggs', 'fruit']);
  let uid = 1;

  const S = { options: [], matcher: null, datasets: [], scan: null, manual: null, pickerCtx: null };

  // ------------------------------------------------------------ utils
  function toast(msg, ms = 1800) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms); }
  function switchTab(name) {
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    window.scrollTo(0, 0);
    if (name === 'history') renderHistory();
  }
  function newLine(p = {}) {
    return Object.assign({ id: uid++, item: '', pack: '', qty: '', foc: '', unitCost: '', discPct: '', vat: 'G', cat: 'standard', perUnit: 1, freightUnits: '', totalKg: '', cartons: '', markupOverride: '', fcccStatus: 'none', fccc: null, fcccConf: null, userFccc: false, perUnitUser: false, conf: 'ok' }, p);
  }
  function newInvoice(kind) { return { id: kind + '-' + Date.now(), kind, header: { company: '', inv: '', date: '' }, lines: [], photos: [], ocrText: '', results: null, savedAt: null }; }

  // ------------------------------------------------------------ IndexedDB history
  const DB = {
    open() { return this._p || (this._p = new Promise((res, rej) => { const r = indexedDB.open('kishore-sell-v2', 1); r.onupgradeneeded = () => r.result.createObjectStore('invoices', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
    async put(v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('invoices', 'readwrite'); tx.objectStore('invoices').put(v); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
    async all() { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('invoices').objectStore('invoices').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); },
    async del(id) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('invoices', 'readwrite'); tx.objectStore('invoices').delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  };
  function serialise(inv) {
    const lines = inv.lines.map((l) => { const c = Object.assign({}, l); delete c.cands; return c; });
    return { id: inv.id, kind: inv.kind, header: inv.header, lines, photos: inv.photos, ocrText: inv.ocrText, savedAt: new Date().toISOString(), sellText: inv.sellText || '' };
  }
  async function saveInvoice(inv, quiet) {
    try { inv.savedAt = new Date().toISOString(); await DB.put(serialise(inv)); if (!quiet) toast('Saved to History'); }
    catch (e) { try { localStorage.setItem('kishore-v2-' + inv.id, JSON.stringify(serialise(Object.assign({}, inv, { photos: [] })))); } catch (_) { /* ignore */ } toast('Saved (photo not stored: ' + e.message + ')'); }
  }

  // ------------------------------------------------------------ FCCC matching per line
  function applyMatch(line, opt, conf, byUser) {
    line.fccc = opt; line.fcccConf = conf; line.fcccStatus = 'applied'; line.userFccc = !!byUser;
    if (!line.perUnitUser) {
      const n = suggestUnitsForOpt(line, opt);
      if (n) { line.perUnit = n.n; line.perUnitNote = n.note; }
    }
    if (!line.vatUser && opt.vatPct != null) line.vat = opt.vatPct > 0 ? 'G' : 'B';
  }
  function suggestUnitsForOpt(line, opt) {
    const rp = K.parsePack(opt.rtPack);
    const ip = K.parsePack(line.pack || line.item);
    const sellSize = line.cat === 'garlic' ? 400 : rp && rp.size;
    if (ip && ip.size && sellSize && rp && ip.dim === rp.dim) {
      const n = (ip.count * ip.size) / sellSize;
      if (n >= 1 && Math.abs(n - Math.round(n)) < 0.02) return { n: Math.round(n), note: `from invoice pack ${line.pack || ''}` };
    }
    if (ip && !ip.size && ip.count > 1) return { n: ip.count, note: 'from invoice pack count' };
    const cost = K.num(line.unitCost);
    if (cost && opt.vlWs && opt.ratio && cost > opt.vlWs * 0.55 && cost < opt.vlWs * 1.3) return { n: Math.round(opt.ratio * 1000) / 1000, note: `invoice cost looks like the FCCC wholesale pack (${opt.wsPack})` };
    return null;
  }
  function runMatch(line, header) {
    if (!S.matcher || line.userFccc || line.fcccStatus === 'not') return;
    line.cands = null;
    if (NON_FCCC_CATS.has(line.cat) || !line.item || line.item.length < 3) { line.fcccStatus = 'none'; line.fccc = null; return; }
    const cands = S.matcher.match(line.item, line.pack, header.company, 8);
    line.cands = cands;
    const top = cands[0], second = cands[1];
    if (!top) { line.fcccStatus = 'none'; line.fccc = null; line.fcccConf = null; return; }
    const clear = !second || top.confidence - second.confidence >= 8 ||
      (second.opt.rtPack === top.opt.rtPack && Math.abs((second.opt.markup || 0) - (top.opt.markup || 0)) < 0.005);
    if (top.confidence >= K.CONF_HIGH && clear) applyMatch(line, top.opt, top.confidence, false);
    else if (top.confidence >= 40) { line.fcccStatus = 'suggest'; line.fccc = top.opt; line.fcccConf = top.confidence; line.fcccWhy = clear ? 'low confidence' : 'two close matches'; }
    else { line.fcccStatus = 'none'; line.fccc = null; line.fcccConf = top.confidence; }
  }

  // ------------------------------------------------------------ editor (review table + results)
  function Editor(host, getInv, opts) {
    this.host = host; this.getInv = getInv; this.opts = opts || {};
    this.bindOnce();
  }
  Editor.prototype.render = function () {
    const inv = this.getInv(); const h = inv.header; const self = this;
    const photo = inv.photos && inv.photos.length ? inv.photos[inv.photos.length - 1] : null;
    this.host.innerHTML = `
      <div class="card">
        <h2>${this.opts.title || 'Invoice'}</h2>
        ${photo ? `<div class="photo-strip">${inv.photos.map((p, i) => `<img class="thumb" data-i="${i}" src="${p}" alt="Invoice page ${i + 1}" />`).join('')}<span class="meta">Tap photo to zoom</span></div>` : ''}
        <div class="grid3">
          <label class="field">Supplier<input data-h="company" list="suppliers" value="${esc(h.company)}" placeholder="e.g. FMF Foods" /></label>
          <label class="field">Invoice no<input data-h="inv" value="${esc(h.inv)}" /></label>
          <label class="field">Date<input data-h="date" value="${esc(h.date)}" placeholder="dd/mm/yyyy" /></label>
        </div>
        <p class="meta freight-note">${K.supplierSkipsFreight(h.company) ? '🚚 No freight for this supplier (Coke / FMF group).' : '🚚 $5 freight per carton/bag applies (non-FCCC lines).'}</p>
        ${inv.ocrText ? `<details class="ocr-raw"><summary>What the reader saw (OCR text)</summary><pre>${esc(inv.ocrText)}</pre></details>` : ''}
      </div>
      <div class="card review">
        <div class="review-head">${photo ? `<img class="thumb mini" data-i="${inv.photos.length - 1}" src="${photo}" alt="Invoice photo — tap to zoom" title="Tap to zoom" />` : ''}<div class="rh-txt"><h2>Review lines (${inv.lines.length})</h2><span class="meta">Compare with the photo${photo ? ' (tap it to zoom)' : ''}, fix anything wrong, then Price all</span></div></div>
        <div class="table-wrap"><table class="rt">
          <thead><tr><th class="sticky">Item</th><th>Qty</th><th>Unit cost VEP</th><th>Disc %</th><th>FOC qty</th><th>Pack</th><th>VAT</th><th>Category</th><th>Sell units / inv unit</th><th>Meat total kg</th><th>Meat ctns</th><th>FCCC match</th><th></th></tr></thead>
          <tbody>${inv.lines.map((l, i) => this.rowHtml(l, i)).join('')}</tbody>
        </table></div>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary" data-act="add">+ Add line</button>
          <button type="button" class="btn btn-ghost" data-act="clear">Clear all</button>
        </div>
        <button type="button" class="btn btn-primary btn-xl btn-block" data-act="price">💲 Price all</button>
      </div>
      <div class="results-host"></div>
      <datalist id="suppliers">${K.SUPPLIERS.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>`;
    this.bind();
    if (inv.results) this.renderResults();
  };
  Editor.prototype.rowHtml = function (l, i) {
    const catOpts = Object.keys(K.CATEGORIES).map((k) => `<option value="${k}" ${l.cat === k ? 'selected' : ''}>${esc(K.CATEGORIES[k].label)}</option>`).join('');
    const meat = K.CATEGORIES[l.cat] && K.CATEGORIES[l.cat].meat;
    const flag = l.conf === 'check' ? ' flag' : '';
    return `<tr data-id="${l.id}" class="${flag}">
      <td class="sticky"><textarea data-f="item" rows="2" aria-label="Item line ${i + 1}">${esc(l.item)}</textarea></td>
      <td><input data-f="qty" value="${esc(l.qty)}" inputmode="decimal" class="w4" /></td>
      <td><input data-f="unitCost" value="${esc(l.unitCost)}" inputmode="decimal" class="w6" /></td>
      <td><input data-f="discPct" value="${esc(l.discPct)}" inputmode="decimal" class="w4" placeholder="0" /></td>
      <td><input data-f="foc" value="${esc(l.foc)}" inputmode="decimal" class="w4" placeholder="0" /></td>
      <td><input data-f="pack" value="${esc(l.pack)}" class="w6" placeholder="12x1L" /></td>
      <td><select data-f="vat" class="${l.vatGuessed ? 'guess' : ''}"><option ${l.vat === 'G' ? 'selected' : ''}>G</option><option ${l.vat === 'B' ? 'selected' : ''}>B</option></select></td>
      <td><select data-f="cat">${catOpts}</select></td>
      <td><input data-f="perUnit" value="${esc(l.perUnit)}" inputmode="decimal" class="w4" title="${esc(l.perUnitNote || 'How many selling units in one invoice unit (e.g. 12 bottles per carton)')}" /></td>
      <td><input data-f="totalKg" value="${esc(l.totalKg)}" inputmode="decimal" class="w5 ${meat ? '' : 'dim'}" /></td>
      <td><input data-f="cartons" value="${esc(l.cartons)}" inputmode="decimal" class="w4 ${meat ? '' : 'dim'}" /></td>
      <td>${this.fcccCell(l)}</td>
      <td><button type="button" class="btn-icon" data-act="del" aria-label="Delete line">🗑️</button></td>
    </tr>`;
  };
  Editor.prototype.fcccCell = function (l) {
    if (l.fcccStatus === 'applied' && l.fccc) return `<button type="button" class="match ok" data-act="pick">✓ ${l.userFccc ? 'chosen' : l.fcccConf + '%'}<small>${esc(short(l.fccc.name))} · ${esc(l.fccc.rtPack)} · ${K.pct(l.fccc.markup)}</small></button>`;
    if (l.fcccStatus === 'suggest' && l.fccc) return `<button type="button" class="match warn" data-act="pick">⚠ check ${l.fcccConf}% (${esc(l.fcccWhy || '')})<small>${esc(short(l.fccc.name))} · ${esc(l.fccc.rtPack)}</small></button>`;
    if (l.fcccStatus === 'not') return `<button type="button" class="match no" data-act="pick">Not FCCC<small>tap to change</small></button>`;
    return `<button type="button" class="match no" data-act="pick">— not FCCC<small>tap to search</small></button>`;
  };
  function short(s) { s = String(s || ''); return s.length > 48 ? s.slice(0, 46) + '…' : s; }

  Editor.prototype.bind = function () {
    const self = this; const inv = this.getInv();
    $$('[data-h]', this.host).forEach((inp) => inp.addEventListener('input', () => {
      inv.header[inp.dataset.h] = inp.value;
      if (inp.dataset.h === 'company') { $('.freight-note', self.host).textContent = K.supplierSkipsFreight(inp.value) ? '🚚 No freight for this supplier (Coke / FMF group).' : '🚚 $5 freight per carton/bag applies (non-FCCC lines).'; clearTimeout(self._rm); self._rm = setTimeout(() => { inv.lines.forEach((l) => runMatch(l, inv.header)); self.refreshRows(); }, 500); }
    }));
    $$('.thumb', this.host).forEach((img) => img.addEventListener('click', () => openZoom(img.src)));
  };
  Editor.prototype.bindOnce = function () {
    const self = this;
    const lineOf = (el) => { const inv = self.getInv(); const tr = el.closest('tr[data-id]'); return { inv, tr, l: tr && inv ? inv.lines.find((x) => String(x.id) === tr.dataset.id) : null }; };
    this.host.addEventListener('input', (e) => {
      const f = e.target.dataset.f; if (!f) return;
      const { inv, tr, l } = lineOf(e.target); if (!l) return;
      l[f] = e.target.value;
      if (f === 'perUnit') l.perUnitUser = true;
      if (f === 'vat') { l.vatUser = true; e.target.classList.remove('guess'); }
      if (f === 'item' || f === 'pack') { clearTimeout(l._t); l._t = setTimeout(() => { if (!l.userFccc) { runMatch(l, inv.header); self.refreshCell(tr, l); } }, 600); }
    });
    this.host.addEventListener('change', (e) => {
      const f = e.target.dataset.f; if (f !== 'cat' && f !== 'vat') return;
      const { inv, tr, l } = lineOf(e.target); if (!l) return;
      if (f === 'vat') { l.vat = e.target.value; l.vatUser = true; e.target.classList.remove('guess'); return; }
      l.cat = e.target.value;
      if (!l.perUnitUser) l.perUnit = K.suggestPerUnit(l.item, l.pack, l.cat) || 1;
      if (K.CATEGORIES[l.cat].meat && !l.totalKg) l.totalKg = l.qty;
      if (!l.userFccc) runMatch(l, inv.header);
      const nt = document.createElement('tbody'); nt.innerHTML = self.rowHtml(l, inv.lines.indexOf(l)); tr.replaceWith(nt.firstElementChild);
    });
    this.host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act; const { inv, tr, l } = lineOf(b);
      if (!inv) return;
      if (act === 'add') { inv.lines.push(newLine({ vat: 'G' })); self.render(); const rows = $$('tbody tr', self.host); if (rows.length) $('textarea', rows[rows.length - 1]).focus(); }
      else if (act === 'del' && l) { inv.lines = inv.lines.filter((x) => x !== l); tr.remove(); $('.review-head h2', self.host).textContent = `Review lines (${inv.lines.length})`; }
      else if (act === 'clear') { if (confirm('Clear all lines?')) { inv.lines = []; inv.results = null; self.render(); } }
      else if (act === 'pick' && l) openPicker(l, inv, () => self.refreshCell(tr, l));
      else if (act === 'price') self.priceAll();
      else if (act === 'copy') copyText(inv.sellText);
      else if (act === 'share') shareText(inv.sellText, inv.header);
      else if (act === 'save') saveInvoice(inv);
    });
  };
  Editor.prototype.refreshCell = function (tr, l) { const td = tr.children[11]; if (td) td.innerHTML = this.fcccCell(l); const vs = $('select[data-f="vat"]', tr); if (vs) vs.value = l.vat; const pu = $('input[data-f="perUnit"]', tr); if (pu && document.activeElement !== pu) pu.value = l.perUnit; };
  Editor.prototype.refreshRows = function () { const inv = this.getInv(); $$('tbody tr', this.host).forEach((tr) => { const l = inv.lines.find((x) => String(x.id) === tr.dataset.id); if (l) this.refreshCell(tr, l); }); };

  Editor.prototype.priceAll = function () {
    const inv = this.getInv();
    const pend = inv.lines.filter((l) => l.fcccStatus === 'suggest');
    inv.results = inv.lines.map((l) => K.priceLine(l, inv.header));
    inv.sellText = K.sellListText(inv.header, inv.lines, inv.results);
    this.renderResults(pend.length);
    const rh = $('.results-host', this.host); rh.scrollIntoView({ behavior: 'smooth', block: 'start' });
    saveInvoice(inv, true);
  };
  Editor.prototype.renderResults = function (pending) {
    const inv = this.getInv(); const rh = $('.results-host', this.host);
    const cards = inv.lines.map((l, i) => {
      const r = inv.results[i];
      if (!r || !r.ok) return `<div class="res-card bad"><b>${esc(l.item || 'Line ' + (i + 1))}</b><div class="meta">${esc((r && r.error) || 'Not priced')}</div></div>`;
      const q = r.quotes.map((x) => `<div class="qrow ${x.primary ? 'primary' : ''}"><span>${esc(x.label)}</span><span class="${x.value != null ? 'red' : ''}">${x.value != null ? K.money(x.value) + (x.primary ? '/' + esc(r.unitLabel) : '') : esc(x.text)}</span></div>`).join('');
      const warn = (r.warnings || []).map((w) => `<div class="warnline">⚠ ${esc(w)}</div>`).join('') + (l.fcccStatus === 'suggest' ? `<div class="warnline">⚠ FCCC match not confirmed (${l.fcccConf}%) — priced with normal markup. Tap the FCCC cell to confirm.</div>` : '');
      return `<div class="res-card"><div class="res-head"><b>${esc(l.item)}</b><span class="sell">${K.money(r.primary)}<small>/${esc(r.unitLabel)}</small></span></div>
        <div class="meta">qty ${esc(r.qty)}${r.foc ? ' + ' + esc(r.foc) + ' FOC' : ''}${r.disc ? ' · disc ' + esc(r.disc) + '%' : ''} · VAT ${r.vat} · cost ${K.money(r.costSell)}/${esc(r.unitLabel)}${r.kgCtn ? ' · ' + r.kgCtn.toFixed(2) + ' kg/ctn' : ''} · ${r.mode === 'fccc' ? 'OI markup ' + K.pct(r.markup) : 'markup ' + K.pct(r.markup)}</div>
        ${q}${warn}<details><summary>Working</summary><pre>${esc(r.working)}</pre></details></div>`;
    }).join('');
    rh.innerHTML = `<div class="card"><h2>Sell prices</h2>${pending ? `<p class="warnline">⚠ ${pending} line(s) have an unconfirmed FCCC match.</p>` : ''}${cards}</div>
      <div class="card"><h2>Sell list for Viber</h2><textarea class="sell-out" readonly rows="10">${esc(inv.sellText)}</textarea>
      <div class="btn-row"><button type="button" class="btn btn-primary" data-act="copy">📋 Copy</button><button type="button" class="btn btn-primary" data-act="share">📤 Share</button><button type="button" class="btn btn-secondary" data-act="save">💾 Save</button></div></div>`;
  };

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); toast('Copied — paste into Viber'); }
    catch (_) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Copied'); }
  }
  async function shareText(t, h) {
    if (navigator.share) { try { await navigator.share({ title: 'Sell list ' + (h.company || ''), text: t }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    copyText(t); toast('Share not available here — copied instead');
  }

  // ------------------------------------------------------------ zoom + picker
  function openZoom(src) { $('#zoom-img').src = src; $('#zoom-img').classList.remove('big'); $('#zoom').classList.remove('hidden'); }
  function openPicker(line, inv, done) {
    S.pickerCtx = { line, inv, done };
    $('#picker-line').textContent = `Line: ${line.item} ${line.pack || ''}`;
    $('#picker-search').value = '';
    renderPicker(line.cands || (S.matcher ? S.matcher.match(line.item, line.pack, inv.header.company, 8) : []), true);
    $('#picker').classList.remove('hidden');
  }
  function renderPicker(list, isMatch) {
    const host = $('#picker-results'); const ctx = S.pickerCtx;
    host.innerHTML = (isMatch ? '<p class="meta">Best matches (confidence):</p>' : '') + (list.length ? list.map((c, i) => {
      const o = c.opt || c; const conf = c.confidence != null ? `<span class="conf ${c.confidence >= K.CONF_HIGH ? 'hi' : c.confidence >= 55 ? 'mid' : 'lo'}">${c.confidence}%</span>` : '';
      return `<button type="button" class="opt" data-i="${i}">${conf}<b>${esc(o.name)}</b><span class="meta">${esc(o.srcLabel)} · retail ${esc(o.rtPack)} · OI RP <span class="red">${K.money(o.oiRetail)}</span> · VL WS ${esc(o.wsPack || '—')} ${K.money(o.vlWs)} · OI markup <b>${K.pct(o.markup)}</b>${c.reasons && c.reasons.length ? ' · ' + esc(c.reasons.join(', ')) : ''}</span></button>`;
    }).join('') : '<p class="meta">No match. Search by brand/item words, or mark Not FCCC.</p>');
    $$('.opt', host).forEach((b) => b.addEventListener('click', () => {
      const c = list[+b.dataset.i]; const o = c.opt || c;
      applyMatch(ctx.line, o, c.confidence != null ? c.confidence : null, true);
      closePicker(); ctx.done && ctx.done();
    }));
  }
  function closePicker() { $('#picker').classList.add('hidden'); }

  // ------------------------------------------------------------ FCCC search
  function searchOptions(q, src, limit = 60) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const o of S.options) {
      if (src && o.src !== src) continue;
      const blob = (o.name + ' ' + o.cat + ' ' + o.rtPack + ' ' + (o.wsPack || '')).toLowerCase();
      if (terms.every((t) => blob.includes(t))) { out.push(o); if (out.length >= limit) break; }
    }
    return out;
  }
  function renderFccc() {
    const q = $('#fccc-search').value; const src = ($('#fccc-filter .chip.active') || {}).dataset.src || '';
    const host = $('#fccc-results');
    if (!q.trim()) { host.innerHTML = '<div class="card meta">Type an item, brand or trader. Each result shows OI max retail (cap), VL urban wholesale converted to the retail pack, and the OI markup with working.</div>'; return; }
    const res = searchOptions(q, src);
    host.innerHTML = res.length ? res.map((o) => `<div class="card fopt"><div class="res-head"><b>${esc(o.name)}</b><span class="sell">${K.money(o.oiRetail)}<small>/${esc(o.rtPack)}</small></span></div>
      <div class="meta">${esc(o.srcLabel)} · ${esc(o.cat)}${o.page ? ' · p' + o.page : ''} · VAT ${o.vatPct}%</div>
      <div class="qrow"><span>VL urban max wholesale</span><span>${K.money(o.vlWs)} / ${esc(o.wsPack || '—')}</span></div>
      <div class="qrow"><span>OI max retail (cap)${o.retailVip ? ' VIP' : ''}</span><span class="red">${K.money(o.oiRetail)}</span></div>
      <div class="qrow primary"><span>OI markup</span><span>${K.pct(o.markup)}</span></div>
      ${o.warn ? `<div class="warnline">⚠ ${esc(o.warn)}</div>` : ''}
      <details><summary>Working</summary><pre>${esc(o.working)}${o.note ? '\n' + esc(o.note) : ''}</pre></details></div>`).join('') + (res.length >= 60 ? '<p class="meta">Showing first 60 — add more words.</p>' : '')
      : '<div class="card meta">No match.</div>';
  }

  // ------------------------------------------------------------ history
  async function renderHistory() {
    const host = $('#history-list');
    let all = [];
    try { all = await DB.all(); } catch (e) { host.innerHTML = `<div class="card warnline">History unavailable: ${esc(e.message)}</div>`; return; }
    all.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    host.innerHTML = all.length ? all.map((v) => `<div class="card hist" data-id="${esc(v.id)}">
      ${v.photos && v.photos[0] ? `<img class="hthumb" src="${v.photos[0]}" alt="" />` : '<div class="hthumb none">✏️</div>'}
      <div class="hinfo"><b>${esc(v.header.company || 'Unknown supplier')}</b><div class="meta">inv ${esc(v.header.inv || '—')} · ${esc(v.header.date || '')}</div><div class="meta">${v.lines.length} lines · saved ${new Date(v.savedAt).toLocaleString()}</div></div>
      <div class="hbtns"><button type="button" class="btn btn-primary" data-act="open">Open</button><button type="button" class="btn-icon" data-act="hdel" aria-label="Delete">🗑️</button></div></div>`).join('')
      : '<div class="card meta">No saved invoices yet. Scan or price an invoice and press Price all — it saves automatically.</div>';
    $$('.hist', host).forEach((card) => card.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const v = all.find((x) => x.id === card.dataset.id);
      if (b.dataset.act === 'hdel') { if (confirm('Delete this saved invoice?')) { await DB.del(v.id); renderHistory(); } return; }
      const inv = Object.assign(newInvoice(v.kind || 'scan'), v, { results: null });
      inv.lines = v.lines.map((l) => newLine(Object.assign({}, l, { id: uid++ })));
      if (inv.kind === 'manual') { S.manual = inv; priceEditor.render(); switchTab('price'); }
      else { S.scan = inv; $('#scan-editor').classList.remove('hidden'); scanEditor.render(); switchTab('scan'); }
      const ed = inv.kind === 'manual' ? priceEditor : scanEditor; ed.priceAll();
    }));
  }
  async function exportAll() {
    const all = await DB.all();
    const blob = new Blob([JSON.stringify({ app: 'kishore-sell-v2', exported: new Date().toISOString(), invoices: all })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kishore-invoices-backup.json'; a.click();
  }

  // ------------------------------------------------------------ scan flow
  async function onPhoto(file) {
    if (!file) return;
    const append = $('#opt-append').checked && S.scan && S.scan.lines.length;
    const bw = $('#opt-bw').checked;
    const pr = $('#ocr-progress'); pr.classList.remove('hidden');
    const bar = $('#ocr-bar'), msg = $('#ocr-msg');
    const setP = (status, p) => {
      const map = { 'loading tesseract core': 'Loading reader engine', 'initializing tesseract': 'Starting reader', 'loading language traineddata': 'Loading English data', 'initializing api': 'Starting reader', 'recognizing text': 'Reading invoice text' };
      const base = status === 'recognizing text' ? 0.3 + 0.7 * p : Math.min(0.3, 0.3 * p);
      bar.style.width = Math.round(base * 100) + '%';
      msg.textContent = `${map[status] || status}… ${status === 'recognizing text' ? Math.round(p * 100) + '%' : ''}`;
    };
    try {
      const rotSel = $('#opt-rot').value;
      const t0 = performance.now();
      let r = await KOCR.recognizeFile(file, { bw, rotate: rotSel === 'auto' ? 0 : +rotSel }, setP);
      let parsed = K.parseInvoiceText(r.text);
      const score = (rr, pp) => pp.lines.length * 12 + rr.confidence;
      if (rotSel === 'auto' && (parsed.lines.length < 2 || r.confidence < 50)) {
        // photo may be sideways: try turning it and keep the best reading
        for (const rot of [90, 270]) {
          msg.textContent = `Photo may be sideways — trying ${rot}°…`;
          const r2 = await KOCR.recognizeFile(file, { bw, rotate: rot, bitmap: r.bitmap, photo: r.photo }, setP);
          const p2 = K.parseInvoiceText(r2.text);
          if (score(r2, p2) > score(r, parsed) + 8) { r = r2; parsed = p2; }
        }
      }
      r.ms = performance.now() - t0;
      bar.style.width = '100%'; msg.textContent = `Done in ${(r.ms / 1000).toFixed(1)} s · reader confidence ${Math.round(r.confidence)}%${r.rotate ? ` · turned ${r.rotate}°` : ''}`;
      $('#ocr-status').textContent = 'OCR: ready (offline)'; $('#ocr-status').className = 'pill ok';
      if (!append) {
        S.scan = newInvoice('scan');
        S.scan.header = parsed.header;
      } else {
        ['company', 'inv', 'date'].forEach((k) => { if (!S.scan.header[k]) S.scan.header[k] = parsed.header[k]; });
      }
      S.scan.photos.push(r.photo);
      S.scan.ocrText = (S.scan.ocrText ? S.scan.ocrText + '\n\n--- next page ---\n' : '') + r.text;
      const lines = parsed.lines.map((p) => newLine(p));
      lines.forEach((l) => runMatch(l, S.scan.header));
      S.scan.lines = S.scan.lines.concat(lines);
      if (!S.scan.lines.length) S.scan.lines.push(newLine());
      S.scan.results = null;
      $('#scan-editor').classList.remove('hidden');
      scanEditor.render();
      toast(`${lines.length} line(s) read — please check them`, 2600);
      $('#scan-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
      saveInvoice(S.scan, true);
    } catch (e) {
      console.error(e);
      msg.textContent = 'Could not read photo: ' + (e && (e.message || e)) + '. You can still type the lines below.';
      if (!S.scan) { S.scan = newInvoice('scan'); S.scan.lines.push(newLine()); }
      $('#scan-editor').classList.remove('hidden'); scanEditor.render();
    }
  }

  // ------------------------------------------------------------ data load
  async function loadJson(path) {
    try { const r = await fetch(path); if (!r.ok) throw new Error(r.status); return await r.json(); }
    catch (e) {
      // file:// fallback: XHR usually allowed in some browsers; otherwise use embedded copy
      return new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', path); x.onload = () => { try { res(JSON.parse(x.responseText)); } catch (err) { rej(err); } }; x.onerror = () => rej(e); x.send(); });
    }
  }
  async function loadEmbedded() {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'data/fccc-embedded.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    return window.KISHORE_FCCC_DATA;
  }
  async function loadData() {
    let b, p, a;
    try {
      if (location.protocol === 'file:') throw new Error('file mode: use embedded data');
      [b, p, a] = await Promise.all(['data/fccc-basic.json', 'data/fccc-produce.json', 'data/fccc-auth.json'].map(loadJson));
    } catch (e) {
      const E = await loadEmbedded(); b = E.basic; p = E.produce; a = E.auth;
    }
    b.as_at = b.as_at || '2026-09-22'; p.as_at = p.as_at || '2026-09-24';
    a.srcKey = 'auth'; a.srcLabel = a.listLabel = 'FCCC authorisation (biscuits 29 Oct 2025 / wheat 28 Feb 2025)';
    a.items.forEach((it) => { it.srcLabel = it.listLabel = /BISCUIT/i.test(it.c) ? 'FCCC biscuit auth 29 Oct 2025 (Levuka)' : 'FCCC wheat auth 28 Feb 2025 (Levuka)'; });
    S.auth = a;
    KFcccStore.setBuiltins(b, p);
    await reloadFccc();
  }
  /** (Re)build options + matcher from the ACTIVE basic/produce lists (built-in or uploaded) + built-in authorisations. */
  async function reloadFccc() {
    const act = await KFcccStore.resolveActive();
    const b = act.basic, p = act.produce, a = S.auth;
    S.active = act;
    S.datasets = [b, p, a];
    S.options = K.buildFcccOptions(S.datasets);
    S.matcher = K.makeMatcher(S.options);
    const withM = S.options.filter((o) => o.markup != null).length;
    $('#data-status').textContent = `FCCC: ${KFcccUI.fmtDate(b.as_at)}`; $('#data-status').className = 'pill ok';
    $('#data-status').title = `${S.options.length} packs`;
    $('#fccc-meta').textContent = `${b.count} basic food items (${b.listLabel}) · ${p.count} produce rows (${p.listLabel}) · ${a.count} authorisation rows → ${S.options.length} retail packs (${withM} with OI markup).`;
    $('#help-data').innerHTML = [b, p, a].map((d) => `<li>${esc(d.listLabel || '')}: ${esc(d.source)} — ${d.count} rows${d.builtin === false ? ' (uploaded)' : ''}</li>`).join('');
    // keep Paul's own picks but move them onto the new list's prices (same item + retail pack)
    [S.scan, S.manual].forEach((inv) => inv && inv.lines.forEach((l) => {
      if (l.userFccc && l.fccc) {
        const n = S.options.find((o) => o.src === l.fccc.src && o.name === l.fccc.name && o.rtPack === l.fccc.rtPack);
        if (n) l.fccc = n; else { l.userFccc = false; l.fcccStatus = 'none'; l.fccc = null; }
      }
      runMatch(l, inv.header);
    }));
    [scanEditor, priceEditor].forEach((ed) => { try { if (ed && ed.getInv() && ed.getInv().lines.length && !ed.host.classList.contains('hidden')) ed.refreshRows(); } catch (_) { /* ignore */ } });
    KFcccUI.renderActive();
    renderFccc();
  }

  // ------------------------------------------------------------ init
  let scanEditor, priceEditor;
  function init() {
    S.manual = newInvoice('manual'); S.manual.lines.push(newLine());
    scanEditor = new Editor($('#scan-editor'), () => S.scan, { title: 'Scanned invoice' });
    priceEditor = new Editor($('#price-editor'), () => S.manual, { title: 'Manual invoice (type lines)' });
    priceEditor.render();
    $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('#cam-input').addEventListener('change', (e) => { onPhoto(e.target.files[0]); e.target.value = ''; });
    $('#gal-input').addEventListener('change', (e) => { onPhoto(e.target.files[0]); e.target.value = ''; });
    $('#zoom-close').addEventListener('click', () => $('#zoom').classList.add('hidden'));
    $('#zoom-img').addEventListener('click', () => $('#zoom-img').classList.toggle('big'));
    $('#picker-close').addEventListener('click', closePicker);
    $('#picker-not').addEventListener('click', () => { const c = S.pickerCtx; c.line.fcccStatus = 'not'; c.line.fccc = null; c.line.userFccc = false; closePicker(); c.done && c.done(); });
    $('#picker-search').addEventListener('input', (e) => { const q = e.target.value; if (!q.trim()) renderPicker(S.pickerCtx.line.cands || [], true); else renderPicker(searchOptions(q, '', 40), false); });
    $('#fccc-search').addEventListener('input', renderFccc);
    $$('#fccc-filter .chip').forEach((c) => c.addEventListener('click', () => { $$('#fccc-filter .chip').forEach((x) => x.classList.toggle('active', x === c)); renderFccc(); }));
    $('#btn-export').addEventListener('click', exportAll);
    renderFccc();
    KFcccUI.init({ K, toast, reload: reloadFccc, current: () => S.active || {}, showTab: switchTab });
    loadData().catch((e) => { console.error(e); $('#data-status').textContent = 'FCCC data failed: ' + e.message; });

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        const ready = () => { $('#sw-status').textContent = 'Offline ready'; $('#sw-status').className = 'pill ok'; };
        if (navigator.serviceWorker.controller) ready();
        navigator.serviceWorker.ready.then(ready);
        reg.addEventListener('updatefound', () => { $('#sw-status').textContent = 'Updating offline copy…'; });
      }).catch((e) => { $('#sw-status').textContent = 'Offline cache off: ' + e.message; });
    } else {
      $('#sw-status').textContent = location.protocol === 'file:' ? 'Opened as file (no install)' : 'No offline cache';
    }
    if (KOCR.isFile) $('#ocr-status').textContent = 'OCR: file mode';
  }

  window.KishoreApp = { S, runMatch, applyMatch, newLine, newInvoice, get scanEditor() { return scanEditor; }, get priceEditor() { return priceEditor; }, onPhoto, loadData, reloadFccc };
  document.addEventListener('DOMContentLoaded', init);
})();
