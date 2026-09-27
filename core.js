/* Kishore Sell Prices v2 — core logic (pricing rules, FCCC OI markup, fuzzy matching, invoice text parser).
 * Pure functions, no DOM. Works in the browser (window.KCore) and in Node (module.exports) for unit tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VAT_RATE = 0.125;
  const FREIGHT_PER_CTN = 5;

  // ---------------------------------------------------------------- helpers
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : '$' + round2(n).toFixed(2));
  const pct = (m) => (m == null || !Number.isFinite(m) ? '—' : (m * 100).toFixed(2) + '%');
  const num = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const f4 = (n) => (Math.round(n * 10000) / 10000).toString();

  // ---------------------------------------------------------------- suppliers
  const SUPPLIERS = [
    { name: 'FMF Foods', re: /fmf\s*foods|f\.?m\.?f\.?\s*food/i, fmf: true },
    { name: 'FMF Snax', re: /fmf\s*snax|snax\s*pte/i, fmf: true },
    { name: 'Biscuit Company', re: /biscuit\s*company|iscuit\s*compan/i, fmf: true },
    { name: 'The Rice Company', re: /rice\s*company/i, fmf: true },
    { name: 'Pea Industries', re: /pea\s*industr/i, fmf: true },
    { name: 'Coca-Cola Europacific', re: /coca.?cola|europac[il]|europag/i, coke: true },
    { name: 'Punjas', re: /punja'?s?\s*(&|and)?\s*sons|punjas\s*(pte|ltd|limited)|\bpunja\b/i },
    { name: 'Motibhai', re: /moti\s*bhai|tibhai|motibha/i },
    { name: 'Ashabhai', re: /ashabhai|asha\s*bhai/i },
    { name: 'Goodman Fielder', re: /goodman|fielder\s*int/i },
    { name: 'Hardip Narayan', re: /hardip/i },
    { name: 'Turners & Growers', re: /turners\s*(&|and)?\s*growers|turners/i },
    { name: 'Unique Warehouse', re: /unique\s*!?\s*ware|unique\s+w/i },
    { name: 'Tappoo', re: /tappoo/i },
    { name: 'CJ Patel', re: /c\.?\s*j\.?\s*patel/i },
    { name: 'Hari Dayal', re: /hari\s*dayal/i },
  ];
  const NO_FREIGHT_RE = /coca.?cola|coke|europacific|fmf|biscuit\s*company|rice\s*company|pea\s*industr/i;
  function supplierSkipsFreight(name) { return NO_FREIGHT_RE.test(name || ''); }
  function isFmfGroup(name) { return /fmf|biscuit\s*company|rice\s*company|pea\s*industr/i.test(name || ''); }

  // ---------------------------------------------------------------- categories (locked markups)
  const CATEGORIES = {
    standard: { label: 'Standard 30%', markup: 0.30, freight: true },
    spice: { label: 'Spice 100%', markup: 1.00, freight: true },
    noodles: { label: 'Chow/Maggi noodles 15%', markup: 0.15, freight: true },
    coke: { label: 'Coke soft drink 25% (no freight)', markup: 0.25, freight: false },
    jasmine: { label: 'Jasmine rice 12% (no freight)', markup: 0.12, freight: false },
    meat: { label: 'Meat/lamb 20% per kg', markup: 0.20, freight: true, meat: true },
    lamb_sausage: { label: 'Lamb sausage 30% per kg', markup: 0.30, freight: true, meat: true },
    eggs: { label: 'Eggs 30% (5 trays/ctn +$5)', markup: 0.30, freight: true, freightUnits: 5 },
    garlic: { label: 'Garlic per 400g', markup: 0.30, freight: true, sellSizeG: 400 },
    fruit: { label: 'Apples/oranges/pears per piece', markup: 0.30, freight: true },
    fmf_rice: { label: 'FMF rice (FMF RRP 7%)', markup: 0.30, freight: false, fmf: 0.07 },
    fmf_flour: { label: 'FMF flour (FMF RRP 8%)', markup: 0.30, freight: false, fmf: 0.08 },
    coarse_besan: { label: 'Coarse besan (FMF RRP 10%)', markup: 0.30, freight: false, fmf: 0.10 },
    pea_besan: { label: 'Pea besan (FMF RRP 10%)', markup: 0.30, freight: false, fmf: 0.10 },
  };

  // Guess category from description + supplier
  function guessCategory(desc, supplier) {
    const d = (desc || '').toLowerCase();
    const s = (supplier || '').toLowerCase();
    if (/sausage/.test(d) && /lamb|mutton/.test(d)) return 'lamb_sausage';
    if (/\b(lamb|mutton|hogget|fores?|flaps?|chops?|shanks?|loin|brisket|leg\s*chop|neck|t-?bone|beef|chicken|drumstick|sausages?)\b/.test(d)
        && !/(twisties|chips|snack|noodle|soup|flavou?r|burger|stock|cube|maggi|chow|crisps|seasoning|masala|powder)/.test(d)) return 'meat';
    if (/eggs?\b|\beggs?/.test(d) && !/(eggplant|noodle|custard|powder)/.test(d)) return 'eggs';
    if (/garlic/.test(d)) return 'garlic';
    if (/coca.?cola|europac/.test(s)) return 'coke';
    if (/\b(apples?|oranges?|pears?|mandarin)\b/.test(d)) return 'fruit';
    if (/jasmin/.test(d)) return 'jasmine';
    if (/coarse\s*besan|besan\s*coarse/.test(d)) return 'coarse_besan';
    if (/besan/.test(d)) return 'pea_besan';
    if (/(chow|maggi)/.test(d) && /(80\s*g|5\s*x\s*80|noodle)/.test(d)) return 'noodles';
    if (/coca.?cola|europac/.test(s) || /\b(coke|coca|fanta|sprite|lift|schweppes|powerade|pump)\b/.test(d)) return 'coke';
    if (/(masala|turmeric|haldi|jeera|cumin|curry\s*powder|chilli\s*powder|chili\s*powder|garam|dhania|coriander\s*powder|methi|fenugreek|spice|cardamom|cinnamon|clove|mustard\s*seed|black\s*pepper|pepper\s*(ground|powder)|fennel|saunf|kalonji|ajwain|hing|asafoetida|paprika)/.test(d)) return 'spice';
    const fmfish = isFmfGroup(s) || /\bfmf\b|sungrown|sunwhite|sunrice|rice\s*co/.test(d);
    if (fmfish && /\b(rice|sungrown|sunwhite|sunrice|calrose)\b/.test(d)) return 'fmf_rice';
    if (fmfish && /flour/.test(d)) return 'fmf_flour';
    return 'standard';
  }

  // Default VAT guess: basic zero-rated foods -> B
  function guessVat(desc) {
    const d = (desc || '').toLowerCase();
    if (/\b(rice|flour|sugar|salt|soya|soyabean|canola|oil|tea|milk|tuna|mackerel|sardines?|peas|dhal|dal|onions?|potato(es)?|garlic|kerosene|sharps|atta)\b/.test(d)
        && !/(masala|chips|snack|biscuit|cookie|cracker|juice|drink|noodle|sauce\s*mix|chocolate)/.test(d)) return 'B';
    return 'G';
  }

  // ---------------------------------------------------------------- pack parsing
  function normPack(s) {
    return String(s || '').toLowerCase()
      .replace(/×|\*/g, 'x')
      .replace(/(\d)\s*(litres?|liters?|ltrs?|lts?)\b/g, '$1l')
      .replace(/(\d)\s*(gms?|grams?)\b/g, '$1g')
      .replace(/(\d)\s*kgs?\b/g, '$1kg')
      .replace(/(\d)\s*mls?\b/g, '$1ml');
  }
  const UNIT_MULT = { kg: 1000, g: 1, l: 1000, ml: 1 };
  const UNIT_DIM = { kg: 'g', g: 'g', l: 'ml', ml: 'ml' };
  /** Parse a pack string -> {count, size, dim} size in g or ml; count = inner units */
  function parsePack(s) {
    const t = normPack(s);
    if (!t.trim()) return null;
    let m = t.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
    if (m) return { count: +m[1], size: +m[2] * UNIT_MULT[m[3]], dim: UNIT_DIM[m[3]] };
    m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\s*x\s*(\d+)\b/);
    if (m) return { count: +m[3], size: +m[1] * UNIT_MULT[m[2]], dim: UNIT_DIM[m[2]] };
    if (/\bper\s*kg\b|^\s*kg\s*$/.test(t)) return { count: 1, size: 1000, dim: 'g' };
    m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
    if (m) return { count: 1, size: +m[1] * UNIT_MULT[m[2]], dim: UNIT_DIM[m[2]] };
    m = t.match(/(\d+)\s*(bottles?|btls?|cans?|packets?|pkts?|tins?|tubs?|pouch(es)?|sachets?|pcs|pieces|units?|jars?|packs?|each|ea|trays?|rolls?|s\b)/);
    if (m) return { count: +m[1], size: null, dim: null };
    m = t.match(/(\d+)\s*'s\b/);
    if (m) return { count: +m[1], size: null, dim: null };
    m = t.match(/^\s*(\d+)\s*$/);
    if (m) return { count: +m[1], size: null, dim: null };
    return null;
  }
  const packTotal = (p) => (p && p.size ? p.count * p.size : null);

  /** How many retail units are in one wholesale pack (for price conversion) */
  function retailUnitsPerWholesale(wsPack, rtPack) {
    const w = parsePack(wsPack), r = parsePack(rtPack);
    if (!w || !r) return null;
    if (w.size && r.size && w.dim === r.dim) return packTotal(w) / packTotal(r);
    if (!w.size && w.count) return w.count / (r.count && !r.size ? r.count : 1);
    return null;
  }

  // ---------------------------------------------------------------- FCCC options
  /** Flatten FCCC datasets into options (one per retail pack row) with OI markup working. */
  function buildFcccOptions(datasets) {
    const opts = [];
    let id = 0;
    for (const ds of datasets) {
      if (!ds || !ds.items) continue;
      for (const it of ds.items) {
        const rows = it.r || [];
        rows.forEach((row, ri) => {
          const [, , , rtPack, rtVL, rtOI] = row;
          if (rtOI == null || !rtPack) return;
          // choose wholesale row: same row first, else matching inner size, else any convertible
          let ws = null, ratio = null, how = '';
          const tryRow = (r2, label) => {
            if (ws || !r2 || r2[0] == null || (r2[1] == null && r2[2] == null)) return;
            const q = retailUnitsPerWholesale(r2[0], rtPack);
            if (q && q > 0) { ws = r2; ratio = q; how = label; }
          };
          tryRow(row, 'same row');
          if (!ws) {
            const rp = parsePack(rtPack);
            rows.forEach((r2) => { const wp = parsePack(r2[0]); if (!ws && wp && rp && wp.size && wp.size === rp.size) tryRow(r2, 'same unit size'); });
          }
          if (!ws) rows.forEach((r2) => tryRow(r2, 'converted by weight/volume'));
          const o = {
            id: 'F' + (id++), src: ds.srcKey, srcLabel: it.srcLabel || ds.srcLabel, listLabel: it.listLabel || ds.listLabel || it.srcLabel || ds.srcLabel, listId: ds.listId || null, name: it.n, cat: it.c, vatPct: it.v,
            page: it.p, rtPack, oiRetail: rtOI, vlRetail: rtVL, retailVip: !!it.retail_vip, note: it.note || '',
            wsPack: ws ? ws[0] : null, vlWs: ws ? ws[1] : null, oiWs: ws ? ws[2] : null, ratio, how,
          };
          computeOiMarkup(o);
          opts.push(o);
        });
      }
    }
    return opts;
  }

  function computeOiMarkup(o) {
    o.markup = null; o.working = ''; o.warn = '';
    if (!o.wsPack || !o.ratio) { o.working = `No convertible wholesale pack for retail ${o.rtPack}`; o.warn = 'no wholesale'; return o; }
    let wsPrice = o.vlWs, wsLabel = 'VL urban max wholesale';
    if (wsPrice == null) { wsPrice = o.oiWs; wsLabel = 'OI max wholesale (VL urban not listed!)'; o.warn = 'VL urban wholesale not listed — used OI wholesale'; }
    const perUnit = wsPrice / o.ratio;
    let retail = o.oiRetail, rLabel = 'OI max retail';
    let s = `${wsLabel} ${money(wsPrice)} per ${o.wsPack}`;
    if (o.ratio !== 1) s += ` ÷ ${f4(o.ratio)} (${o.rtPack} units per ${o.wsPack}) = ${f4(perUnit)} per ${o.rtPack}`;
    if (o.retailVip) { retail = o.oiRetail / (1 + VAT_RATE); rLabel = 'Levuka retail VIP ÷ 1.125'; s += `; ${rLabel}: ${money(o.oiRetail)} ÷ 1.125 = ${f4(retail)}`; }
    o.markup = retail / perUnit - 1;
    o.wsPerRetailUnit = perUnit;
    o.working = `${s}; OI markup = ${o.retailVip ? f4(retail) : money(retail)} ÷ ${f4(perUnit)} − 1 = ${pct(o.markup)}`;
    if ((o.markup < -0.02 || o.markup > 0.8) && o.vlRetail && wsPrice) {
      // FCCC list pack text looks wrong (e.g. '10kg' printed for a multi-bag bale): infer units from VL wholesale vs VL retail
      const k = Math.round((wsPrice / o.vlRetail) * 1.07);
      const m2 = k >= 1 ? retail / (wsPrice / k) - 1 : null;
      if (m2 != null && m2 >= 0 && m2 <= 0.6) {
        o.working += ` ⚠ implausible; FCCC pack text '${o.wsPack}' looks wrong → assumed ${k} retail units per wholesale pack (from VL retail ${money(o.vlRetail)}): ${money(wsPrice)} ÷ ${k} = ${f4(wsPrice / k)}; OI markup = ${pct(m2)}`;
        o.markup = m2; o.ratio = k; o.wsPerRetailUnit = wsPrice / k; o.warn = `FCCC wholesale pack '${o.wsPack}' unclear — assumed ${k} units; check`;
      } else { o.warn = 'Implausible OI markup — check FCCC row'; }
    }
    return o;
  }

  // ---------------------------------------------------------------- fuzzy matching
  const STOP = new Set('the of and in if to its own on with for a an by pte ltd limited co company another party others other retails retail wholesale wholesales price delivery exclusive inclusive brand pack ctn ct carton cartons bag bags pkt pkts x per new'.split(' '));
  const SYN = { soya: 'soyabean', soy: 'soyabean', soybean: 'soyabean', ltr: 'l', litre: 'l', tom: 'tomato', 't/sauce': 'tomato', mack: 'mackerel', mackeral: 'mackerel', sardine: 'sardines', crkrs: 'crackers', cracker: 'crackers', bfast: 'breakfast', bkfst: 'breakfast', marg: 'margarine', onion: 'onions', potato: 'potatoes', veg: 'vegetable', dhal: 'peas', dal: 'peas', calrose: 'calrose', tealeaves: 'tea', leaves: 'tea', ceylon: 'tea', whitesugar: 'sugar', ghee: 'ghee' };
  const NOUNS = ['oil', 'rice', 'sugar', 'salt', 'flour', 'sharps', 'peas', 'tea', 'milk', 'tuna', 'mackerel', 'sardines', 'margarine', 'butter', 'corned', 'crackers', 'onions', 'potatoes', 'garlic', 'spread', 'fish'];
  const BRANDS = ['fmf', 'punjas', 'golden', 'alba', 'ace', 'ananda', 'cocotop', 'sunbeam', 'sofali', 'rewa', 'anchor', 'meadow', 'fielders', 'crest', 'americana', 'brunswick', 'sunwhite', 'sungrown', 'sunrice', 'bushells', 'lipton', 'farmers', 'oxford', 'palm', 'hellaby', 'tasty', 'pams', 'bakersfresh', 'motibhai', 'ashabhai', 'westgold', 'choice', 'flora', 'nature', 'island', 'hope', 'king', 'blue', 'dyanas', 'colonial', 'salisbury', 'richmond', 'canterbury', 'country'];
  const TYPE_GROUPS = [['soyabean', 'canola', 'sunflower', 'palm', 'mustard', 'olive', 'vegetable', 'coconut', 'ghee'], ['longgrain', 'calrose', 'basmati', 'jasmine', 'brown', 'parboiled'], ['mackerel', 'tuna', 'sardines'], ['tomato', 'natural', 'chilli', 'brine', 'water'], ['salted', 'unsalted'], ['normal', 'sharps', 'wholemeal', 'atta']];
  function tokens(s) {
    return normPack(s).replace(/soya\s*bean/g, 'soyabean').replace(/long\s*grain/g, 'longgrain').replace(/\(if[^)]*\)?/g, ' ').replace(/[^a-z0-9./ ]+/g, ' ').split(/\s+/)
      .map((t) => t.replace(/^[./]+|[./]+$/g, '')).filter((t) => t && t.length > 1 && !STOP.has(t) && !/^\d+(\.\d+)?(kg|g|l|ml)?$/.test(t) && !/^\d+x(\d|$)/.test(t) && !/^x\d/.test(t))
      .map((t) => SYN[t] || t).map((t) => (t.endsWith('s') && !NOUNS.includes(t) && !BRANDS.includes(t) && t.length > 4 ? t.slice(0, -1) : t));
  }
  function traderClause(name) { const m = String(name).match(/\(\s*if([^)]*)\)?/i) || String(name).match(/\bif\b(.*)$/i); return m ? m[1].toLowerCase() : ''; }

  function makeMatcher(options) {
    const df = new Map();
    const prepared = options.map((o) => {
      const tk = [...new Set(tokens(o.name + ' ' + (o.cat || '')))];
      tk.forEach((t) => df.set(t, (df.get(t) || 0) + 1));
      return { o, tk: new Set(tk), core: new Set(tokens(o.name)), trader: traderClause(o.name), rp: parsePack(o.rtPack) };
    });
    const N = prepared.length || 1;
    const idf = (t) => (df.get(t) ? Math.log(1 + N / (df.get(t) + 1)) : 0.35 * Math.log(1 + N)); // unknown words (OCR noise, codes) weigh less

    function match(desc, pack, supplier, limit = 8) {
      const it = [...new Set(tokens(desc))];
      if (!it.length) return [];
      const ip = parsePack(pack || desc);
      const invNouns = NOUNS.filter((n) => it.includes(n) || (n === 'oil' && /oil/.test(desc.toLowerCase())));
      const sup = (supplier || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
      const invBrand = BRANDS.find((b) => it.includes(b));
      const wInv = it.reduce((a, t) => a + idf(t), 0);
      const out = [];
      for (const p of prepared) {
        let hit = 0; for (const t of it) if (p.tk.has(t)) hit += idf(t);
        if (hit === 0) continue;
        let coreW = 0, coreHit = 0; for (const t of p.core) { coreW += idf(t); if (it.includes(t)) coreHit += idf(t); }
        let score = 0.8 * (0.75 * (hit / wInv) + 0.25 * (coreW ? coreHit / coreW : 0));
        const reasons = [];
        const sharedNoun = invNouns.some((n) => p.tk.has(n));
        if (!sharedNoun) { score *= 0.35; reasons.push('no shared product word'); }
        for (const g of TYPE_GROUPS) {
          const a = g.filter((t) => it.includes(t)), b = g.filter((t) => p.core.has(t) && !it.includes(t));
          if (a.length && b.length && !a.some((t) => p.core.has(t))) { score -= 0.3; reasons.push('type ≠ (' + b[0] + ')'); break; }
        }
        const invBrands = BRANDS.filter((b) => it.includes(b));
        const optBrands = BRANDS.filter((b) => p.core.has(b));
        if (invBrands.length && optBrands.length) {
          if (invBrands.some((b) => p.core.has(b))) { score += 0.10; reasons.push('brand ✓'); }
          else { score -= 0.2; reasons.push('brand ≠'); }
        }
        if (ip && ip.size && p.rp && p.rp.size && ip.dim === p.rp.dim) {
          if (Math.abs(ip.size - p.rp.size) < 1e-6) { score += 0.15; reasons.push('size ✓'); }
          else if (p.o.src !== 'produce') { score -= 0.3; reasons.push('size ≠'); }
        }
        if (p.o.src === 'produce') {
          // produce rows: name is 'Garlic – Trader (Own/Others)'; score on product word + supplier as trader
          const noun = NOUNS.find((n) => p.tk.has(n) && invNouns.includes(n));
          if (!noun) continue;
          const tr = (p.o.name || '').toLowerCase();
          score = 0.55;
          if (sup.length && sup.some((w) => tr.includes(w))) { score += /\(others\)/.test(tr) ? 0.30 : 0.12; reasons.push(/\(others\)/.test(tr) ? 'supplier = trader (Others) ✓' : 'supplier = trader (Own)'); }
          else reasons.push('pick trader');
        } else if (p.trader && sup.length) {
          const named = sup.some((w) => p.trader.includes(w));
          if (named && /wholesal/.test(p.trader)) { score += 0.08; reasons.push('supplier wholesales ✓'); }
          else if (named) { score -= 0.03; reasons.push('supplier retail-own row'); }
        }
        if (p.o.markup == null) score -= 0.1;
        if (p.o.warn) score -= 0.05;
        if (score < 0.2) continue;
        out.push({ opt: p.o, score: Math.max(0, Math.min(1, score)), reasons });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, limit).map((r) => ({ ...r, confidence: Math.round(r.score * 100) }));
    }
    return { match };
  }
  const CONF_HIGH = 75; // >= auto-applied (shown); below = flagged, never applied silently

  // ---------------------------------------------------------------- pricing
  /**
   * Price one invoice line.
   * line: { item, pack, qty, foc, unitCost (VEP per invoice unit, before disc), discPct, vat 'G'|'B', cat,
   *         perUnit (sell units per invoice unit), freightUnits (sell units per $5 freight carton), freightOn,
   *         totalKg, cartons, fccc: option|null, fcccStatus, sellLabel }
   * header: { company }
   */
  function priceLine(line, header) {
    const company = (header && header.company) || '';
    const cat = CATEGORIES[line.cat] ? line.cat : 'standard';
    const C = CATEGORIES[cat];
    const W = [];
    const res = { ok: false, quotes: [], warnings: [], working: '', cat };
    const unit = num(line.unitCost);
    if (unit == null) { res.error = 'Enter unit cost VEP'; return res; }
    const qty = num(line.qty) || 0;
    const foc = num(line.foc) || 0;
    const disc = num(line.discPct) || 0;
    const vat = String(line.vat || 'G').toUpperCase() === 'B' ? 'B' : 'G';
    const vatF = (n) => (vat === 'G' ? n * (1 + VAT_RATE) : n);
    const vatTxt = vat === 'G' ? ' × 1.125 VAT (G, last)' : ' (B, no VAT)';

    // 1 net after discount
    let cost = unit;
    if (disc) { cost = unit * (1 - disc / 100); W.push(`Net VEP: ${money(unit)} × (1 − ${disc}%) = ${f4(cost)}`); }
    else W.push(`Cost VEP: ${money(unit)} per invoice unit`);
    // 2 FOC blend
    if (foc > 0 && qty > 0) {
      const b = (cost * qty) / (qty + foc);
      W.push(`FOC blend: ${f4(cost)} × ${qty} ÷ (${qty} + ${foc} FOC) = ${f4(b)}`);
      cost = b;
    }
    // freight
    let freightOn = line.freightOn !== false && C.freight;
    if (supplierSkipsFreight(company)) { if (freightOn) W.push('No freight: Coke / FMF group supplier'); freightOn = false; }
    else if (!C.freight) W.push(`No freight: ${C.label}`);

    res.qty = qty; res.foc = foc; res.disc = disc; res.vat = vat; res.company = company;

    // ---- meat per kg
    if (C.meat) {
      const kg = num(line.totalKg), ct = num(line.cartons);
      let kgCtn = null;
      if (kg && ct) { kgCtn = kg / ct; W.push(`kg/ctn = ${kg} kg ÷ ${ct} ctn = ${kgCtn.toFixed(2)} kg/ctn`); }
      else res.warnings.push('Enter total kg and cartons for meat (kg/ctn)');
      let c = cost;
      if (freightOn && kgCtn) { c = cost + FREIGHT_PER_CTN / kgCtn; W.push(`Cost/kg ${f4(cost)} + ($5 ÷ ${kgCtn.toFixed(2)}) = ${f4(c)}`); }
      const m = line.markupOverride != null && line.markupOverride !== '' ? num(line.markupOverride) / 100 : C.markup;
      const sell = round2(vatF(c * (1 + m)));
      W.push(`${f4(c)} × ${(1 + m).toFixed(2)}${vatTxt} = ${money(sell)}/kg`);
      Object.assign(res, { ok: true, primary: sell, unitLabel: 'kg', costSell: cost, markup: m, kgCtn, mode: 'meat' });
      res.quotes.push({ label: 'Sell /kg', value: sell, primary: true });
      res.working = W.join('\n');
      return res;
    }

    // ---- sell units per invoice unit
    let per = num(line.perUnit) || 1;
    const sellLabel = line.sellLabel || (cat === 'garlic' ? '400g' : cat === 'fruit' ? 'each' : cat === 'eggs' ? 'tray' : '') || 'unit';
    const costSell = cost / per;
    if (per !== 1) W.push(`Per ${sellLabel}: ${f4(cost)} ÷ ${per} = ${f4(costSell)}`);
    res.costSell = costSell; res.unitLabel = sellLabel; res.perUnit = per;

    // ---- FCCC dual quote
    const o = line.fcccStatus === 'applied' ? line.fccc : null;
    if (o && o.markup != null) {
      const m = o.markup;
      const rp = parsePack(o.rtPack);
      let capFactor = 1;
      if (cat === 'garlic' && rp && rp.size) capFactor = 400 / rp.size;
      const cap = o.oiRetail * capFactor;
      const rrp = round2(vatF(costSell * (1 + m)));
      W.push(`FCCC [${o.srcLabel}] ${o.name} · retail ${o.rtPack}`);
      W.push(`  ${o.working}`);
      W.push(`Retail RRP = ${f4(costSell)} × (1 + ${pct(m)})${vatTxt} = ${money(rrp)} (no freight in FCCC cost)`);
      if (capFactor !== 1) W.push(`FCCC OI RP per 400g = ${money(o.oiRetail)}/kg × 0.4 = ${money(cap)}`);
      Object.assign(res, { ok: true, primary: rrp, markup: m, mode: 'fccc', cap: round2(cap), fcccOpt: o });
      res.quotes.push({ label: 'Retail RRP', value: rrp, primary: true });
      res.quotes.push({ label: 'FCCC OI RP (cap)', value: round2(cap) });
      res.quotes.push({ label: 'OI markup', text: pct(m) });
      res.fcccList = o.listLabel || o.srcLabel || '';
      if (res.fcccList) res.quotes.push({ label: 'Reference', text: res.fcccList });
      if (rrp > cap + 0.004) res.warnings.push(`RRP ${money(rrp)} is ABOVE FCCC cap ${money(cap)} — sell at or below the cap`);
      if (o.warn) res.warnings.push(o.warn);
    } else {
      // ---- non-FCCC markup
      let c = costSell;
      const fu = num(line.freightUnits) || C.freightUnits || per;
      if (freightOn) {
        const add = FREIGHT_PER_CTN / fu;
        c = costSell + add;
        W.push(fu === 1 ? `Freight +$5 per ctn/bag → ${f4(c)}` : `Freight $5 ÷ ${fu} per ctn = +${f4(add)} → ${f4(c)}`);
      }
      const m = line.markupOverride != null && line.markupOverride !== '' ? num(line.markupOverride) / 100 : C.markup;
      const sell = round2(vatF(c * (1 + m)));
      W.push(`${C.label}: ${f4(c)} × (1 + ${pct(m)})${vatTxt} = ${money(sell)}/${sellLabel}`);
      Object.assign(res, { ok: true, primary: sell, markup: m, mode: 'markup', freightOn });
      res.quotes.push({ label: 'Sell', value: sell, primary: true });
    }

    // ---- FMF RRP always added
    if (C.fmf) {
      const fr = round2(vatF(costSell * (1 + C.fmf)));
      W.push(`FMF RRP ${pct(C.fmf)}: ${f4(costSell)} × ${(1 + C.fmf).toFixed(2)}${vatTxt} = ${money(fr)}`);
      res.quotes.push({ label: `FMF RRP ${Math.round(C.fmf * 100)}%`, value: fr, fmfRrp: true });
      res.fmfRrp = fr;
      if (res.mode !== 'fccc') { res.primary = fr; res.markup = C.fmf; res.mode = 'fmf'; res.quotes = res.quotes.filter((q) => !q.primary); res.quotes.forEach((q) => { if (q.fmfRrp) q.primary = true; }); }
    }
    res.working = W.join('\n');
    return res;
  }

  // ---------------------------------------------------------------- sell list text
  function sellLine(line, r) {
    if (!r || !r.ok) return null;
    const bits = [];
    const name = (line.item || 'Item').trim() + (line.pack && !String(line.item || '').toLowerCase().includes(String(line.pack).toLowerCase()) ? ' ' + line.pack : '');
    let q = `qty ${r.qty} came`;
    if (r.foc > 0) q += ` + ${r.foc} FOC`;
    bits.push(q);
    if (r.disc) bits.push(`disc ${r.disc}%`);
    if (r.mode === 'meat') {
      bits.push(`cost ${money(r.costSell)}/kg`);
      if (r.kgCtn) bits.push(`${r.kgCtn.toFixed(2)} kg/ctn`);
      bits.push(`markup ${pct(r.markup)}`);
      bits.push(`sell 🔴 ${money(r.primary)}/kg`);
    } else {
      bits.push(`cost ${money(r.costSell)}/${r.unitLabel}`);
      if (r.cat === 'coke' || r.cat === 'fruit' || r.cat === 'eggs') { if (r.perUnit && r.perUnit !== 1) bits.push(`${r.perUnit} per ctn`); }
      if (r.mode === 'fccc') {
        bits.push(`FCCC OI markup ${pct(r.markup)}`);
        bits.push(`Retail RRP 🔴 ${money(r.primary)}/${r.unitLabel}`);
        bits.push(`FCCC OI RP ${money(r.cap)}`);
        if (r.fcccList) bits.push(r.fcccList);
        if (r.fmfRrp != null) bits.push(`FMF RRP 🔴 ${money(r.fmfRrp)}`);
      } else if (r.mode === 'fmf') {
        bits.push(`FMF RRP ${pct(r.markup)}`);
        bits.push(`sell 🔴 ${money(r.primary)}/${r.unitLabel}`);
      } else {
        bits.push(`markup ${pct(r.markup)}`);
        bits.push(`sell 🔴 ${money(r.primary)}/${r.unitLabel}`);
      }
    }
    if (r.warnings && r.warnings.some((w) => /ABOVE FCCC cap/.test(w))) bits.push('⚠ above FCCC cap');
    return `${name} — ${bits.join(' · ')}`;
  }
  function sellListText(header, lines, results) {
    const out = [];
    const h = [header.company, header.inv ? 'inv ' + header.inv : '', header.date].filter(Boolean).join(' · ');
    if (h) out.push(h);
    lines.forEach((L, i) => { const s = sellLine(L, results[i]); if (s) { if (out.length) out.push(''); out.push(s); } });
    return out.join('\n');
  }

  // ---------------------------------------------------------------- OCR invoice text parser
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function detectSupplier(lines) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/kishore/i.test(l) && !/fmf|coca|punja|motibhai|ashabhai|goodman|hardip|turners|unique|tappoo|patel|dayal/i.test(l)) continue;
      for (const s of SUPPLIERS) if (s.re.test(l)) return { name: s.name, line: i };
    }
    return null;
  }
  function detectDate(text) {
    const cands = [];
    const re1 = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/g; let m;
    while ((m = re1.exec(text))) { let y = +m[3]; if (y < 100) y += 2000; cands.push({ d: +m[1], mo: +m[2], y, i: m.index }); }
    const re2 = /\b(\d{1,2})[\s\-]*(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[\s\-,]*(\d{2,4})\b/gi;
    while ((m = re2.exec(text))) { let y = +m[3]; if (y < 100) y += 2000; cands.push({ d: +m[1], mo: MON[m[2].toLowerCase()], y, i: m.index }); }
    const re3 = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
    while ((m = re3.exec(text))) cands.push({ d: +m[3], mo: +m[2], y: +m[1], i: m.index });
    const ok = cands.filter((c) => c.d >= 1 && c.d <= 31 && c.mo >= 1 && c.mo <= 12 && c.y >= 2024 && c.y <= 2027);
    ok.forEach((c) => { const ls = text.lastIndexOf('\n', c.i) + 1; const le = text.indexOf('\n', c.i); const line = text.slice(ls, le < 0 ? undefined : le); const pre = line.slice(0, c.i - ls + 1); c.due = /due|expir/i.test(pre) ? 2 : /print/i.test(pre) ? 1 : 0; });
    ok.sort((a, b) => a.due - b.due || (b.y === 2026) - (a.y === 2026) || a.i - b.i);
    const c = ok[0];
    return c ? `${String(c.d).padStart(2, '0')}/${String(c.mo).padStart(2, '0')}/${c.y}` : '';
  }
  function detectInvoiceNo(lines) {
    const re = /(?:tax\s*invoice|invoice|inv)\s*(?:no|number|num|#)?\.?\s*[:#.\-]*\s*([A-Z]{0,4}[\- ]?\d{4,12})/i;
    const reG = new RegExp(re.source, 'gi');
    for (const l of lines) {
      let m; reG.lastIndex = 0;
      while ((m = reG.exec(l))) {
        const pre = l.slice(Math.max(0, m.index - 8), m.index);
        if (/sdc|tin/i.test(pre) || /per\s*tin/i.test(m[0]) || /counter/i.test(l.slice(m.index, m.index + 20))) continue;
        return m[1].replace(/\s/g, '');
      }
    }
    for (const l of lines.slice(0, 30)) {
      if (/tel|fax|phone|tin|box|p\.?o\.?|vat\s*reg|mob/i.test(l)) continue;
      const m = l.match(/\b([A-Z]{0,3}\d{6,12})\b/); if (m) return m[1];
    }
    return '';
  }

  const SKIP_LINE = /(gross|\bwe?i?ght\b|\bwet\b|volume|label\s*name|rounding|sub\s*-?\s*total|grand\s*total|total\s*(vat|tax|amount|due|payable|purchase)|net\s*amount|amount\s*payable|balance|vat\s*reg|tin\s*no|invoice\s*(no|date)|due\s*date|page\s*\d|signature|received|terms|bank|account|phone|fax|email|p\.?o\.?\s*box|customer|ship\s*to|bill\s*to|deliver|dispatch|cashier|payment|thank)/i;

  function numTokens(str) {
    // returns array of {raw, vals:[candidates], idx, pctFlag}
    const out = [];
    const re = /\$?\d[\d,]*(?:\.\d+)?%?/g; let m;
    while ((m = re.exec(str))) {
      const raw = m[0];
      const isPct = raw.endsWith('%');
      let t = raw.replace(/[$%]/g, '');
      if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
      else if (/^\d+,\d{2}$/.test(t)) t = t.replace(',', '.');
      else t = t.replace(/,/g, '');
      const v = Number(t);
      if (!Number.isFinite(v)) continue;
      const vals = [v];
      if (!t.includes('.') && t.length >= 3 && !isPct) vals.push(v / 100); // OCR dropped decimal point
      out.push({ raw, vals, idx: m.index, end: m.index + raw.length, pct: isPct, hasDot: t.includes('.') });
    }
    return out;
  }

  function parseItemLine(raw) {
    let s = raw.replace(/[|\[\]{}]/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/(\d\s*x\s*)S(\s*(ltr|lt|l|kg|g)\b)/gi, '$15$2').replace(/(\d\s*x\s*)S(?=\d)/gi, '$15').replace(/(\d)S(?=\d\s*(ml|g|gm|kg|l)\b)/gi, '$15').replace(/(\d)[oO](?=\d|\s*(kg|g|ml|l)\b)/g, '$10');
    if (s.length < 6 || SKIP_LINE.test(s)) return null;
    // VAT code evidence
    let vat = null;
    if (/\(\s*[B8]\s*\)|\bB\b(?=\s*[\d.]*\s*$)|\s0(\.0+)?%/.test(s)) vat = 'B';
    if (/\(\s*G\s*\)|\bG\b(?=\s*[\d.]*\s*$)|12\.5\s*%?|\b12\.50\b/.test(s)) vat = 'G';
    // strip leading item code
    s = s.replace(/^\(?[A-Z]{0,3}\d{4,}[A-Z]?\)?\s*(\(\s*[BG8]\s*\))?\s*/i, '');
    // qty written first, e.g. "10-05085-0002 5.00 ctn HALDI POWDER" or "20 bag Garlic 10kg"
    let qtyFirst = null;
    const QF = /(?:^|\s)(\d{1,4}(?:\.\d{1,3})?)\s*[,;!()]?\s*(ctns?|otn|etn|cin|bags?|pkts?|each|ea|trays?|box|doz|pcs?|cs|units?|tins?|btls?)\b\s+(?=[A-Za-z])/i;
    const qm = s.match(QF);
    if (qm && qm.index < s.length * 0.45) {
      const before = s.slice(0, qm.index);
      if (!/[a-z]{3,}/i.test(before.replace(/\b(ctn|ea)\b/gi, ''))) { qtyFirst = +qm[1]; s = s.slice(qm.index + qm[0].length); }
    }
    const nums = numTokens(s);
    if (nums.length < (qtyFirst ? 1 : 2)) return null;
    // description = text before first number that is followed only by numbers/short tokens
    const words = s.split(' ');
    // find cut: last position of an alphabetic word (>=3 letters) that isn't a unit/code word
    const UNITW = /^(ct|ctn|ctns|cs|ea|each|bag|bags|pkt|pkts|kg|kgs|g|pc|pcs|tray|trays|try|doz|box|bx|unit|units|b|g|v|nos|no|bdl|rl|roll|lt|ltr|l|btl|x\d*|car|wh0?1|who1|whot|whdy|wh|uom)$/i;
    let cut = 0, pos = 0;
    words.forEach((w) => {
      const start = s.indexOf(w, pos); pos = start + w.length;
      const letters = w.replace(/[^a-z]/gi, '');
      if (letters.length >= 3 && !UNITW.test(w.replace(/[^a-z0-9]/gi, ''))) cut = pos;
    });
    const desc = s.slice(0, cut).replace(/[\s:;,.\-]+$/, '')
      .replace(/^((\d+|[\dA-Z]*\d[\d\-]{4,}\S*|[$§]?\d{3,}\S*)\s+)+(?=\S*[A-Za-z]{2})/, '')
      .replace(/\s+(WH0?1|WHO[1!]|WHOT|WHDY|CAR)(?=\s|$).*$/i, '')
      .replace(/^\d\.\d{8,}\s+/, '')
      .replace(/\s+\d+\.\d{2}\s+\d[\d,]*\.\d{2}\b.*$/, '').trim();
    if (desc.replace(/[^a-z]/gi, '').length < 3) return null;
    const tail = nums.filter((n) => n.idx >= cut);
    if (qtyFirst) {
      const q = qtyFirst; const pl = nums.filter((n) => !n.pct && !/x$/i.test(s.slice(n.end, n.end + 1)) && !/^\s*(kg|g|gm|ml|l|ltr)\b/i.test(s.slice(n.end, n.end + 4)) && !/x\s*$/i.test(s.slice(Math.max(0, n.idx - 1), n.idx)));
      for (let i = 0; i + 1 < pl.length; i++) {
        for (const u of pl[i].vals) for (const g of pl[i + 1].vals) {
          if (u > 0 && Math.abs(q * u - g) <= Math.max(0.03, 0.006 * g)) {
            let dp = '';
            const dv = pl[i + 2] && pl[i + 2].vals[0];
            if (dv && dv > 0 && dv < g * 0.6) { const pc = Math.round((dv / g) * 10000) / 100; if (Math.abs(pc * 2 - Math.round(pc * 2)) < 0.03) dp = pc; }
            const isFoc0 = /\b(foc|f\.o\.c|free|bonus)\b/i.test(raw);
            return { item: desc, qty: q, unitCost: round2(u * 100) / 100, total: g, discPct: dp, vat, foc: '', isFoc: isFoc0, conf: 'ok', raw };
          }
        }
      }
      const money = pl.filter((n) => n.hasDot && n.vals[0] > 0);
      if (money.length) {
        const tot = money[money.length - 1].vals[0];
        const unitGuess = money.length >= 2 ? money[0].vals[0] : Math.round((tot / q) * 100) / 100;
        return { item: desc, qty: q, unitCost: unitGuess, total: tot, discPct: '', vat, foc: '', isFoc: false, conf: 'check', raw };
      }
      return { item: desc, qty: q, unitCost: '', total: '', discPct: '', vat, foc: '', isFoc: false, conf: 'check', raw };
    }
    if (tail.length < 2) return null;
    if (!tail.some((n) => n.hasDot || n.raw.includes('$'))) return null; // needs at least one money amount
    // discount %
    let disc = null;
    tail.filter((n) => n.pct).forEach((n) => { const v = n.vals[0]; if (v > 0 && v < 60 && Math.abs(v - 12.5) > 1e-6) disc = v; });
    const plain = tail.filter((n) => !n.pct);
    // search qty × unit × (1 - d) ≈ total
    let best = null;
    const discC = [0]; if (disc) discC.push(disc);
    plain.forEach((n) => { const v = n.vals[0]; if (n.hasDot && v > 0 && v <= 50 && v <= 30 && Math.abs(v * 2 - Math.round(v * 2)) < 1e-6 && Math.abs(v - 12.5) > 1e-6 && !discC.includes(v)) discC.push(v); });
    const vatF = [1, 1.125]; const vatEvid = vat === 'G' || /12\.5|12 50/.test(s);
    const dotted = plain.some((n) => n.hasDot && n.vals[0] >= 1);
    const rawPen = (n, v) => (dotted && !n.hasDot && v === n.vals[0] && v >= 100 ? 0.45 : 0);
    for (let ti = plain.length - 1; ti >= 1; ti--) {
      for (const tv of plain[ti].vals) {
        if (tv <= 0) continue;
        for (let ui = ti - 1; ui >= 0; ui--) {
          for (const uv of plain[ui].vals) {
            if (uv <= 0 || uv > tv * 1.0001 + 0.01) continue;
            for (let qi = ui - 1; qi >= -1; qi--) {
              const qvals = qi >= 0 ? plain[qi].vals : [null];
              for (const qv0 of qvals) {
                for (const d of discC) for (const vf of vatF) {
                  let qv = qv0;
                  if (qv == null) { qv = Math.round((tv / (uv * vf * (1 - d / 100))) * 100) / 100; if (Math.abs(qv - Math.round(qv)) > 0.02 || qv < 1 || qv > 5000) continue; qv = Math.round(qv); }
                  if (qv <= 0 || qv > 20000) continue;
                  const calc = qv * uv * vf * (1 - d / 100);
                  const err = Math.abs(calc - tv) / tv;
                  if (err < 0.012 || Math.abs(calc - tv) < 0.03) {
                    const penalty = (qv === 1 && Math.abs(uv - tv) < 0.01 ? 0.6 : 0) + rawPen(plain[ui], uv) + rawPen(plain[ti], tv) + (qi < 0 ? 0.3 : 0) + (d ? 0.25 : 0) + (vf !== 1 ? (vatEvid ? 0.12 : 0.35) : 0) + (uv !== plain[ui].vals[0] ? 0.15 : 0) + (tv !== plain[ti].vals[0] ? 0.15 : 0) + (qi >= 0 && qv0 !== plain[qi].vals[0] ? 0.2 : 0) + (plain.length - 1 - ti) * 0.05 + err;
                    if (!best || penalty < best.penalty) best = { qty: qv, unit: uv, total: tv, disc: d || null, penalty, inferredQty: qi < 0 };
                  }
                }
              }
            }
          }
        }
      }
    }
    let conf = 'ok';
    if (!best) {
      // fallback: first two money-ish numbers
      const money2 = plain.filter((n) => n.hasDot);
      if (money2.length >= 2) {
        const unitv = money2[0].vals[0], tot = money2[money2.length - 1].vals[0];
        const q = unitv ? tot / unitv : null;
        best = { qty: q && Math.abs(q - Math.round(q)) < 0.05 ? Math.round(q) : '', unit: unitv, total: tot, disc: disc, penalty: 9 };
        conf = 'check';
      } else return null;
    }
    const isFoc = /\b(foc|f\.o\.c|free|bonus)\b/i.test(raw) || best.unit === 0;
    return { item: desc, qty: best.qty, unitCost: round2(best.unit * 100) / 100, total: best.total, discPct: best.disc || '', vat, foc: '', isFoc, conf: best.inferredQty ? 'check' : conf, raw };
  }

  function parseFocLine(raw) {
    if (!/\b(foc|f\.o\.c|free\s*(of\s*charge|goods)?|bonus)\b/i.test(raw)) return null;
    const s = raw.replace(/[|\[\]{}]/g, ' ');
    const m = s.match(/(.*?)(\d+)\s*(ctn|ctns|pkt|ea|bag|tray|x)?\s*(foc|free|bonus)/i) || s.match(/(foc|free|bonus)\D*(\d+)/i);
    let qty = null;
    if (m) qty = Number(m[2]);
    const desc = s.replace(/\b(foc|f\.o\.c|free|bonus)\b/ig, ' ').replace(/[\d.,$]+/g, ' ').replace(/\s+/g, ' ').trim();
    return qty ? { item: desc, foc: qty } : null;
  }

  function similarity(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let i = 0; A.forEach((t) => { if (B.has(t)) i++; });
    return i / Math.min(A.size, B.size);
  }

  function parsePackFromDesc(desc) {
    const t = normPack(desc);
    let m = t.match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
    if (m) return `${m[1]}x${m[2]}x${m[3]}${m[4]}`;
    m = t.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
    if (m) return `${m[1]}x${m[2]}${m[3]}`;
    m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\s*x\s*(\d+)/);
    if (m) return `${m[3]}x${m[1]}${m[2]}`;
    m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|ml)\b/);
    if (m) return `${m[1]}${m[2]}`;
    return '';
  }

  /** Suggest sell units per invoice unit from desc/pack/category */
  function suggestPerUnit(desc, pack, cat) {
    const d = normPack(desc + ' ' + (pack || ''));
    if (cat === 'fruit') { const m = d.match(/\b(\d{2,3})\b(?!\s*(kg|g|l|ml))/g); if (m) { const c = m.map(Number).find((n) => n >= 40 && n <= 300); if (c) return c; } return ''; }
    if (cat === 'garlic') { const p = parsePack(d); if (p && p.size && p.dim === 'g') return Math.round(packTotal(p) / 400); return 25; }
    if (cat === 'eggs') return 1;
    let m = d.match(/(\d+)\s*x\s*(\d+)\s*x\s*\d/);
    if (m) return +m[1] * +m[2];
    m = d.match(/(\d+)\s*x\s*\d/);
    if (m && +m[1] > 1) return +m[1];
    m = d.match(/\d\s*(kg|g|l|ml)\s*x\s*(\d+)/);
    if (m) return +m[2];
    m = d.match(/(?:^|\s|pet|can|btl)x\s*(\d{1,3})\b/);
    if (m && +m[1] > 1) return +m[1];
    return 1;
  }

  function parseInvoiceText(text, opts = {}) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sup = detectSupplier(lines);
    const header = { company: sup ? sup.name : '', inv: detectInvoiceNo(lines), date: detectDate(text) };
    const items = [];
    let lastWasItem = false;
    for (const l of lines) {
      const it = parseItemLine(l);
      if (!it && lastWasItem && items.length) {
        // wrapped description, e.g. "CREAM & CHIVES" / "16X250G" under the item line
        const c = l.replace(/[|\[\]{}~_—]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[^A-Za-z0-9)%]+$/, '');
        const money = (c.match(/\d+\.\d{2}\b/g) || []).length;
        if (c.length >= 3 && c.length <= 32 && !money && c.split(' ').length <= 5 && (/[A-Za-z]{2}/.test(c) || /\d+\s*x\s*\d+/i.test(c)) && !SKIP_LINE.test(c) && !/total|vat|net|price|discount/i.test(c)) {
          const prev = items[items.length - 1];
          if (!prev.contAdded || prev.contAdded < 2) { prev.item = (prev.item + ' ' + c).trim(); prev.contAdded = (prev.contAdded || 0) + 1; continue; }
        }
      }
      lastWasItem = !!it;
      if (it) {
        if (it.isFoc && items.length) {
          const prev = items.slice().reverse().find((p) => similarity(p.item, it.item) >= 0.6);
          if (prev) { prev.foc = (num(prev.foc) || 0) + (num(it.qty) || 0); continue; }
        }
        items.push(it);
        continue;
      }
      const f = parseFocLine(l);
      if (f && items.length) {
        const prev = items.slice().reverse().find((p) => similarity(p.item, f.item) >= 0.5) || null;
        if (prev) prev.foc = (num(prev.foc) || 0) + f.foc;
      }
    }
    const out = items.map((it) => {
      const cat = guessCategory(it.item, header.company);
      const pack = parsePackFromDesc(it.item);
      return {
        item: it.item, pack, qty: it.qty, foc: it.foc || '', unitCost: it.unitCost, discPct: it.discPct,
        vat: it.vat || guessVat(it.item), vatGuessed: !it.vat, cat, perUnit: suggestPerUnit(it.item, pack, cat),
        totalKg: cat === 'meat' || cat === 'lamb_sausage' ? it.qty : '', cartons: '', total: it.total, conf: it.conf, raw: it.raw,
      };
    });
    return { header, lines: out, supplierLine: sup ? sup.line : null };
  }

  return {
    VAT_RATE, FREIGHT_PER_CTN, CATEGORIES, SUPPLIERS, CONF_HIGH,
    round2, money, pct, num, parsePack, retailUnitsPerWholesale, buildFcccOptions, computeOiMarkup, makeMatcher,
    priceLine, sellLine, sellListText, parseInvoiceText, parseItemLine, guessCategory, guessVat, supplierSkipsFreight,
    isFmfGroup, suggestPerUnit, parsePackFromDesc, detectSupplier, detectDate, detectInvoiceNo, tokens,
  };
});
