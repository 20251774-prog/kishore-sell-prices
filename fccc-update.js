/* Kishore Sell Prices — FCCC list versions (built-in + uploaded PDFs/CSVs in IndexedDB), upload preview + diff. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const KIND_NAME = { basic: 'Basic Food list', produce: 'Produce list' };
  const ACTIVE_KEY = 'kishore-fccc-active';

  function fmtDate(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : 'date unknown'; }
  function listLabel(kind, asAt) { return kind === 'produce' ? `FCCC produce list ${fmtDate(asAt)}` : `FCCC list ${fmtDate(asAt)}`; }

  // ------------------------------------------------------------ storage
  const ListDB = {
    open() { return this._p || (this._p = new Promise((res, rej) => { const r = indexedDB.open('kishore-fccc-lists', 1); r.onupgradeneeded = () => r.result.createObjectStore('lists', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })); },
    async tx(mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('lists', mode); const st = t.objectStore('lists'); const out = fn(st); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage full?')); }); },
    put(rec) { return this.tx('readwrite', (st) => st.put(rec)); },
    get(id) { return this.tx('readonly', (st) => st.get(id)); },
    del(id) { return this.tx('readwrite', (st) => st.delete(id)); },
    async meta() { const all = await this.tx('readonly', (st) => st.getAll()); return (all || []).map((r) => ({ id: r.id, kind: r.kind, as_at: r.as_at, fileName: r.fileName, uploadedAt: r.uploadedAt, stats: r.stats, via: r.via })); },
  };
  const Active = {
    get() { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '{}'); } catch (_) { return {}; } },
    set(kind, id) { const a = this.get(); a[kind] = id; localStorage.setItem(ACTIVE_KEY, JSON.stringify(a)); },
  };

  const Store = {
    builtins: {},
    setBuiltins(basic, produce) {
      basic.listId = 'builtin-basic'; basic.kind = 'basic'; basic.builtin = true;
      produce.listId = 'builtin-produce'; produce.kind = 'produce'; produce.builtin = true;
      this.builtins = { basic, produce };
    },
    decorate(ds, kind) { ds.kind = kind; ds.srcKey = kind; ds.listLabel = ds.srcLabel = listLabel(kind, ds.as_at); return ds; },
    /** Active datasets {basic, produce}; falls back to built-in if an upload is missing. */
    async resolveActive() {
      const act = Active.get(); const out = {};
      for (const kind of ['basic', 'produce']) {
        let ds = this.builtins[kind];
        if (act[kind] && !String(act[kind]).startsWith('builtin')) {
          try { const rec = await ListDB.get(act[kind]); if (rec && rec.ds) { ds = rec.ds; ds.listId = rec.id; ds.uploadedAt = rec.uploadedAt; ds.builtin = false; } } catch (e) { console.warn(e); }
        }
        out[kind] = this.decorate(ds, kind);
      }
      return out;
    },
  };

  // ------------------------------------------------------------ pdf.js loader (local, offline)
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'vendor/pdfjs/pdf.min.js';
      s.onload = () => { const L = window.pdfjsLib; if (!L) return rej(new Error('PDF reader did not load')); L.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href; res(L); };
      s.onerror = () => rej(new Error('PDF reader files missing (vendor/pdfjs)'));
      document.head.appendChild(s);
    });
  }

  // ------------------------------------------------------------ diff
  function normK(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  /** Map options by item+retail pack; repeated identical keys get #2, #3… so duplicates don't hide each other. */
  function keyed(opts) {
    const m = new Map(); const seen = {};
    for (const o of opts) { const k0 = normK(o.name) + ' | ' + normK(o.rtPack).replace(/\s/g, ''); seen[k0] = (seen[k0] || 0) + 1; m.set(seen[k0] > 1 ? k0 + ' #' + seen[k0] : k0, o); }
    return m;
  }
  function diffLists(K, oldDs, newDs) {
    const oOpts = K.buildFcccOptions([Object.assign({}, oldDs, { srcKey: oldDs.kind })]);
    const nOpts = K.buildFcccOptions([Object.assign({}, newDs, { srcKey: newDs.kind })]);
    const om = keyed(oOpts), nm = keyed(nOpts);
    const oNames = new Set(oldDs.items.map((i) => normK(i.n))); const nNames = new Set(newDs.items.map((i) => normK(i.n)));
    const addedPacks = [...nm.entries()].filter(([k]) => !om.has(k)).map(([, o]) => o);
    const removedPacks = [...om.entries()].filter(([k]) => !nm.has(k)).map(([, o]) => o);
    const newNames = new Set(newDs.items.filter((i) => !oNames.has(normK(i.n))).map((i) => normK(i.n)));
    const goneNames = new Set(oldDs.items.filter((i) => !nNames.has(normK(i.n))).map((i) => normK(i.n)));
    const changes = [];
    for (const [k, n] of nm) {
      const o = om.get(k); if (!o) continue;
      const wsO = o.wsPerRetailUnit, wsN = n.wsPerRetailUnit;
      const dW = (wsO == null) !== (wsN == null) || (wsO != null && Math.abs(wsO - wsN) > 0.00051);
      const dR = Math.abs((n.oiRetail || 0) - (o.oiRetail || 0)) > 0.0001;
      if (dW || dR) changes.push({ name: n.name, pack: n.rtPack, oldWsPack: o.wsPack, newWsPack: n.wsPack, oldWs: o.vlWs, newWs: n.vlWs, oldRt: o.oiRetail, newRt: n.oiRetail, oldM: o.markup, newM: n.markup });
    }
    changes.sort((a, b) => Math.abs((b.newRt - b.oldRt) / (b.oldRt || 1)) - Math.abs((a.newRt - a.oldRt) / (a.oldRt || 1)) || Math.abs((b.newM || 0) - (b.oldM || 0)) - Math.abs((a.newM || 0) - (a.oldM || 0)));
    return { addedPacks, removedPacks, newNames, goneNames, changes, oOpts: oOpts.length, nOpts: nOpts.length };
  }

  // ------------------------------------------------------------ UI
  let ctx = null; let pending = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));

  function setProgress(p, msg) { const pr = $('#upd-progress'); pr.classList.remove('hidden'); $('#upd-bar').style.width = Math.round(p * 100) + '%'; $('#upd-msg').textContent = msg; }

  async function onPdf(file) {
    if (!file) return;
    const type = $('#upd-type').value;
    $('#upd-preview').innerHTML = '';
    try {
      setProgress(0.02, 'Loading PDF reader…');
      const L = await loadPdfJs();
      const buf = await file.arrayBuffer();
      setProgress(0.05, 'Reading PDF…');
      const t0 = performance.now();
      const ds = await window.KFcccPdf.parsePdf(L, buf, type, { fileName: file.name, progress: (n, N) => setProgress(0.05 + 0.9 * (n / N), `Reading page ${n} of ${N}…`) });
      ds.fileName = file.name; ds.via = 'pdf';
      setProgress(1, `Read ${ds.pages} pages in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      const warn = [];
      if (type !== 'auto' && ds.detected && ds.detected !== type) warn.push(`You chose ${KIND_NAME[type]}, but the PDF header looks like the ${KIND_NAME[ds.detected]}. Check the type.`);
      showPreview(ds, warn);
    } catch (e) {
      console.error(e);
      setProgress(1, 'Could not read this PDF: ' + (e.message || e) + ' — try the CSV upload below.');
    } finally { $('#upd-pdf').value = ''; }
  }

  async function onCsv(file) {
    if (!file) return;
    try {
      const kind = $('#upd-type').value === 'produce' ? 'produce' : 'basic';
      const asAt = $('#csv-date').value || null;
      const ds = window.KFcccPdf.parseCsv(await file.text(), { kind, asAt, fileName: file.name });
      ds.fileName = file.name; ds.via = 'csv';
      const warn = [];
      if (!asAt) warn.push('No list date entered — set "List date" before uploading so the version is labelled correctly.');
      if (ds.csvBadLines && ds.csvBadLines.length) warn.push(`CSV lines with bad numbers were skipped: ${ds.csvBadLines.slice(0, 12).join(', ')}${ds.csvBadLines.length > 12 ? '…' : ''}`);
      if ($('#upd-type').value === 'auto') warn.push('List type "Auto" cannot be detected from a CSV — treated as Basic Food list.');
      $('#upd-progress').classList.add('hidden');
      showPreview(ds, warn);
    } catch (e) { toast('CSV problem: ' + (e.message || e), 4000); }
    finally { $('#upd-csv').value = ''; }
  }

  function showPreview(ds, warn) {
    const K = ctx.K; const P = window.KFcccPdf;
    const cur = ctx.current()[ds.kind];
    const st = P.stats(ds), cs = P.stats(cur);
    const d = diffLists(K, cur, ds);
    const problems = warn.slice();
    if (!ds.as_at) problems.push('Could not read the "as at" date from the PDF header.');
    else if (cur.as_at && ds.as_at <= cur.as_at) problems.push(`This list (${fmtDate(ds.as_at)}) is not newer than the one in use (${fmtDate(cur.as_at)}).`);
    st.problems.forEach((p) => problems.push(p));
    const drop = cs.items ? (cs.items - st.items) / cs.items : 0;
    const dropR = cs.rtRows ? (cs.rtRows - st.rtRows) / cs.rtRows : 0;
    const bigDrop = drop > 0.2 || dropR > 0.2;
    if (bigDrop) problems.unshift(`⛔ Row count dropped a lot compared with the list in use (items ${cs.items} → ${st.items}, OI retail rows ${cs.rtRows} → ${st.rtRows}). The PDF layout may have changed — check carefully or use CSV.`);
    if (!st.items) problems.unshift('⛔ No price rows were found in this file.');
    const noRt = ds.items.filter((i) => !i.r.some((r) => r[5] != null)).slice(0, 8).map((i) => i.n);
    pending = { ds, st, bigDrop, empty: !st.items };
    const row = (lab, a, b) => `<tr><td>${lab}</td><td><b>${a}</b></td><td>${b}</td><td class="${a - b < 0 ? 'neg' : ''}">${a - b > 0 ? '+' : ''}${a - b}</td></tr>`;
    const chg = (c) => `<tr class="nm"><td colspan="3"><b>${esc(c.name)}</b> <span class="meta">· retail ${esc(c.pack)}</span></td></tr><tr><td>${money(c.oldWs)}${c.oldWsPack ? ' <small>/' + esc(c.oldWsPack) + '</small>' : ''} →<br><b>${money(c.newWs)}</b>${c.newWsPack ? ' <small>/' + esc(c.newWsPack) + '</small>' : ''}</td><td>${money(c.oldRt)} →<br><b class="red">${money(c.newRt)}</b></td><td>${K.pct(c.oldM)} →<br><b>${K.pct(c.newM)}</b></td></tr>`;
    $('#upd-preview').innerHTML = `
      <div class="preview">
        <h3>${esc(KIND_NAME[ds.kind])} · as at <b>${esc(fmtDate(ds.as_at))}</b></h3>
        <p class="meta">${esc(ds.fileName || '')}${ds.pages ? ' · ' + ds.pages + ' pages' : ''} · ${ds.via === 'csv' ? 'from CSV' : 'read from PDF on this phone'}</p>
        ${problems.length ? `<div class="problems">${problems.map((p) => `<div class="warnline">⚠ ${esc(p)}</div>`).join('')}${noRt.length && st.noPrice ? `<div class="meta">No OI retail: ${noRt.map(esc).join(' · ')}</div>` : ''}</div>` : '<div class="okline">✓ No parse problems found</div>'}
        <table class="cmp"><thead><tr><th></th><th>This file</th><th>In use (${esc(fmtDate(cur.as_at))})</th><th>Change</th></tr></thead><tbody>
          ${row('Items', st.items, cs.items)}${row('Wholesale rows (VL urban)', st.wsRows, cs.wsRows)}${row('OI retail rows', st.rtRows, cs.rtRows)}${row('Items with both', st.both, cs.both)}
        </tbody></table>
        <h3>Changes vs list in use</h3>
        <div class="chips static"><span class="chip">${d.changes.length} price change${d.changes.length === 1 ? "" : "s"}</span><span class="chip">${d.addedPacks.length} new packs (${d.newNames.size} new item names)</span><span class="chip">${d.removedPacks.length} removed packs (${d.goneNames.size} names gone)</span></div>
        <input id="upd-q" class="search" type="search" placeholder="Search this upload (e.g. soya 1L)" autocomplete="off" />
        <div id="upd-diff"></div>
        <div class="btn-row sticky-actions">
          <button type="button" class="btn btn-primary" id="upd-activate" ${!st.items ? 'disabled' : ''}>✅ Use this list</button>
          <button type="button" class="btn btn-ghost" id="upd-cancel">Cancel</button>
        </div>
      </div>`;
    const renderDiff = () => {
      const q = ($('#upd-q').value || '').toLowerCase().trim();
      const words = q.split(/\s+/).filter(Boolean);
      const hit = (s) => !words.length || words.every((w) => s.toLowerCase().includes(w));
      const ch = d.changes.filter((c) => hit(c.name + ' ' + c.pack));
      const ad = d.addedPacks.filter((o) => hit(o.name + ' ' + o.rtPack)); const rm = d.removedPacks.filter((o) => hit(o.name + ' ' + o.rtPack));
      const packRow = (o, isNew) => `<div class="srow"><b>${esc(o.name)}</b>${isNew && d.newNames.has(normK(o.name)) ? ' <span class="pill ok">new item</span>' : ''}<div class="meta">retail ${esc(o.rtPack)} · OI <span class="red">${money(o.oiRetail)}</span>${o.wsPack ? ' · VL urban WS ' + esc(o.wsPack) + ' ' + money(o.vlWs) : ''} · OI markup ${K.pct(o.markup)}</div></div>`;
      const sample = words.length ? ds.items.filter((i) => hit(i.n + ' ' + i.r.map((r) => r[0] + ' ' + r[3]).join(' '))).slice(0, 15) : ds.items.slice(0, 6);
      const itemRows = (i) => `<div class="srow"><b>${esc(i.n)}</b><div class="meta">${esc(i.c || '')}${i.p ? ' · p' + i.p : ''}</div>${i.r.map((r) => `<div class="meta">${r[0] ? 'WS ' + esc(r[0]) + ' VL urban ' + money(r[1]) : ''}${r[0] && r[3] ? ' · ' : ''}${r[3] ? 'Retail ' + esc(r[3]) + ' OI <span class="red">' + money(r[5]) + '</span>' : ''}</div>`).join('')}</div>`;
      $('#upd-diff').innerHTML = `
        <details ${ch.length ? 'open' : ''}><summary>Price changes (${ch.length})</summary>
          ${ch.length ? `<div class="table-wrap"><table class="cmp diff"><thead><tr><th>VL urban wholesale</th><th>OI retail</th><th>OI markup</th></tr></thead><tbody>${ch.slice(0, 80).map(chg).join('')}</tbody></table></div>${ch.length > 80 ? `<p class="meta">…${ch.length - 80} more — search to narrow</p>` : ''}` : '<p class="meta">None</p>'}
        </details>
        <details ${ad.length && ad.length <= 12 ? 'open' : ''}><summary>New packs / items (${ad.length})</summary>${ad.slice(0, 60).map((o) => packRow(o, true)).join('') || '<p class="meta">None</p>'}</details>
        <details ${rm.length && rm.length <= 12 ? 'open' : ''}><summary>Removed packs / items (${rm.length})</summary>${rm.slice(0, 60).map((o) => packRow(o, false)).join('') || '<p class="meta">None</p>'}</details>
        <details ${words.length ? 'open' : ''}><summary>${words.length ? 'Matching rows in this upload' : 'Sample rows'} (${sample.length})</summary>${sample.map(itemRows).join('') || '<p class="meta">No match</p>'}</details>`;
    };
    $('#upd-q').addEventListener('input', renderDiff); renderDiff();
    $('#upd-cancel').addEventListener('click', () => { pending = null; $('#upd-preview').innerHTML = ''; $('#upd-progress').classList.add('hidden'); });
    $('#upd-activate').addEventListener('click', activatePending);
    $('#upd-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function activatePending() {
    if (!pending) return;
    const { ds, st, bigDrop } = pending;
    if (bigDrop && !window.confirm(`WARNING: this upload has far fewer rows than the list in use (more than 20% drop). Prices may be missing.\n\nUse it anyway?`)) return;
    if (!window.confirm(`Use ${KIND_NAME[ds.kind]} as at ${fmtDate(ds.as_at)} (${st.items} items) for all FCCC pricing from now on?\n\nYou can switch back any time under "Saved FCCC lists".`)) return;
    const id = `up-${ds.kind}-${ds.as_at || 'nodate'}-${Date.now()}`;
    const rec = { id, kind: ds.kind, as_at: ds.as_at, fileName: ds.fileName, via: ds.via, uploadedAt: new Date().toISOString(), stats: { items: st.items, wsRows: st.wsRows, rtRows: st.rtRows, both: st.both }, ds };
    try { await ListDB.put(rec); } catch (e) { toast('Could not save list: ' + (e.message || e), 4000); return; }
    Active.set(ds.kind, id);
    pending = null; $('#upd-preview').innerHTML = ''; $('#upd-progress').classList.add('hidden');
    await ctx.reload();
    toast(`Now using ${listLabel(ds.kind, ds.as_at)}`, 3000);
    renderVersions();
  }

  async function renderVersions() {
    const host = $('#versions-list'); if (!host) return;
    let ups = []; try { ups = await ListDB.meta(); } catch (e) { console.warn(e); }
    const act = Active.get(); const cur = ctx.current();
    const html = ['basic', 'produce'].map((kind) => {
      const b = Store.builtins[kind]; if (!b) return '';
      const P = window.KFcccPdf; const bs = P.stats(b);
      const list = [{ id: 'builtin-' + kind, kind, as_at: b.as_at, builtin: true, stats: bs }].concat(ups.filter((u) => u.kind === kind).sort((x, y) => String(y.as_at).localeCompare(String(x.as_at)) || String(y.uploadedAt).localeCompare(String(x.uploadedAt))));
      const inUse = cur[kind] && cur[kind].listId;
      return `<h3>${KIND_NAME[kind]}</h3>` + list.map((v) => {
        const on = v.id === inUse;
        return `<div class="ver ${on ? 'on' : ''}">
          <div class="vinfo"><b>${esc(listLabel(kind, v.as_at))}</b> ${on ? '<span class="pill ok">In use</span>' : ''}
            <div class="meta">${v.builtin ? 'Built into the app' : `Uploaded ${esc(fmtDate((v.uploadedAt || '').slice(0, 10)))} · ${esc(v.fileName || '')} (${v.via === 'csv' ? 'CSV' : 'PDF'})`} · ${v.stats ? v.stats.items + ' items, ' + v.stats.rtRows + ' OI retail rows' : ''}</div></div>
          <div class="vbtns">${on ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-use="${esc(v.id)}" data-kind="${kind}">Use this</button>`}${v.builtin ? '' : `<button type="button" class="btn-icon" data-del="${esc(v.id)}" data-kind="${kind}" aria-label="Delete">🗑️</button>`}</div>
        </div>`;
      }).join('');
    }).join('') + `<h3>Biscuits + flour</h3><div class="ver on"><div class="vinfo"><b>FCCC authorisations</b> <span class="pill ok">In use</span><div class="meta">Built in: Biscuit Authorisation 29 Oct 2025 (Sch 1 + Sch 4 Levuka) · Wheat Authorisation 28 Feb 2025 (Sch 1 + Sch 4 Levuka). Not uploadable.</div></div></div>`;
    host.innerHTML = html;
    host.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', async () => {
      Active.set(b.dataset.kind, b.dataset.use); await ctx.reload(); renderVersions(); toast('FCCC list switched', 2000);
    }));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!window.confirm('Delete this uploaded FCCC list from the phone?')) return;
      await ListDB.del(b.dataset.del);
      if (Active.get()[b.dataset.kind] === b.dataset.del) Active.set(b.dataset.kind, 'builtin-' + b.dataset.kind);
      await ctx.reload(); renderVersions(); toast('Deleted', 1500);
    }));
  }

  function renderActive() {
    const host = $('#fccc-active'); if (!host) return; const cur = ctx.current();
    host.innerHTML = ['basic', 'produce'].map((k) => cur[k] ? `<div class="act"><span>${KIND_NAME[k]}</span><b class="big">${esc(listLabel(k, cur[k].as_at))}</b><span class="meta">${cur[k].builtin ? 'built-in' : 'uploaded ' + esc(fmtDate((cur[k].uploadedAt || '').slice(0, 10)))}</span></div>` : '').join('')
      + '<div class="act"><span>Biscuits + flour</span><b>Auth 29 Oct 2025 / 28 Feb 2025</b><span class="meta">built-in</span></div>';
  }

  function toast(m, ms) { (ctx && ctx.toast ? ctx.toast : (x) => alert(x))(m, ms); }

  function open(which) {
    ctx.showTab && ctx.showTab('fccc');
    const el = $(which === 'versions' ? '#fccc-versions' : '#fccc-update');
    el.classList.remove('hidden'); if (which === 'versions') renderVersions();
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  function init(c) {
    ctx = c;
    $('#upd-pdf').addEventListener('change', (e) => onPdf(e.target.files[0]));
    $('#upd-csv').addEventListener('change', (e) => onCsv(e.target.files[0]));
    $('#btn-upd-open').addEventListener('click', () => open('update'));
    $('#btn-versions').addEventListener('click', () => open('versions'));
    $('#csv-template').addEventListener('click', () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([window.KFcccPdf.CSV_TEMPLATE], { type: 'text/csv' })); a.download = 'fccc-list-template.csv'; a.click();
    });
    document.querySelectorAll('[data-open-fccc]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); open(a.dataset.openFccc); }));
    const d = new Date(); $('#csv-date').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  window.KFcccStore = Store;
  window.KFcccUI = { init, renderActive, renderVersions, open, diffLists, fmtDate, listLabel, ListDB, Active, loadPdfJs, _preview: showPreview, get pending() { return pending; } };
})();
