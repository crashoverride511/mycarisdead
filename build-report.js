/**
 * build-report.js
 * -------------------------------------------------------------------------
 * Turns a raw scrape (weed-scraped.json, written by weed-value-finder.js) plus
 * any hand-entered JARS items (jars-manual.json) into the three deliverables:
 *   - weed-best-value.csv   (spreadsheet-friendly)
 *   - weed-best-value.xlsx  (formatted, 2 sheets)
 *   - weed-best-value.html  (mobile phone page)
 *
 * Why a separate step: JARS locks its menu to your IP's location, so it can't be
 * auto-scraped from a non-Arizona connection. You paste JARS flower items into
 * jars-manual.json and this merges them into the ranking with the same math.
 *
 * Run it directly after a scrape, or via `npm run weed` which does both.
 *   node build-report.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const m = require('./weed-value-finder.js');

const SCRAPE = 'weed-scraped.json';
if (!fs.existsSync(SCRAPE)) {
  console.error(`No ${SCRAPE} found. Run the scraper first:`);
  console.error('  node weed-value-finder.js --headless --json weed-scraped.json');
  console.error('  (or just: npm run weed)');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(SCRAPE, 'utf8'));
const opts = base.opts || { minThc: 27, includeHybrid: false };

// Raw scraped results never carry manual:true, so starting from the raw scrape
// means re-running this never double-counts the hand-entered JARS items.
const scraped = (base.results || []).filter((r) => !r.manual);

let manual = [];
try { manual = JSON.parse(fs.readFileSync('jars-manual.json', 'utf8')); } catch (_) { /* optional */ }

const manualRecs = [];
for (const it of manual) {
  const r = m.normalizeListing(it);
  m.applyLeanInference(r);
  if (it.manualNote) r.notes.push(it.manualNote);
  r.manual = true;
  manualRecs.push(r);
}
const keptManual = m.applyFilters(manualRecs, opts).kept;
for (const d of manualRecs.filter((r) => !keptManual.includes(r))) {
  console.log(`   (manual item skipped: ${d.name} — THC ${d.thc}, ${d.strainLabel})`);
}

const ranked = m.rankListings(scraped.concat(keptManual), Boolean(opts.preferSativa));
const generatedAt = base.generatedAt || new Date().toISOString();

// --- weed-best-value.json (final merged, for reference / the HTML/xlsx read from memory) ---
fs.writeFileSync('weed-best-value.json', JSON.stringify({ opts, generatedAt, count: ranked.length, results: ranked, jarsManualAdded: keptManual.length }, null, 2));

// --- CSV ---
const cols = ['pricePerGram', 'charged', 'original', 'discountPct', 'dealReal', 'grams', 'weightLabel', 'thc', 'strainLabel', 'dispensary', 'brand', 'name', 'url'];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync('weed-best-value.csv', [cols.join(',')].concat(ranked.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n'));

// --- HTML (phone page) ---
fs.writeFileSync('weed-best-value.html', buildHtml(ranked, generatedAt));

// --- XLSX (async, last) ---
buildXlsx(ranked).then(() => {
  const jrank = ranked.findIndex((r) => r.manual);
  console.log(`Report built: ${ranked.length} picks (${keptManual.length} hand-entered JARS).`);
  if (jrank >= 0) {
    const j = ranked[jrank];
    console.log(`  JARS "${j.name}" ranks #${jrank + 1} at $${j.pricePerGram.toFixed(2)}/g ($${Math.round(j.pricePerGram * 28)}/oz).`);
  }
  console.log('  -> weed-best-value.csv / .xlsx / .html');
});

// ===========================================================================
// HTML
// ===========================================================================
function buildHtml(rows0, generatedAtISO) {
  const genStr = new Date(generatedAtISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' }) + ' MST';
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const shortDisp = (s) => s.replace(' Dispensary', '').replace(' (Tucson)', '').replace('Trulieve / Harvest of Tucson', 'Trulieve/Harvest');
  const rows = rows0.map((x, i) => ({
    rank: i + 1, ppg: +x.pricePerGram.toFixed(2), oz: Math.round(x.pricePerGram * 28), price: x.charged,
    wt: x.weightLabel || '?', thc: x.thc, bucket: x.strainBucket, inf: !!x.inferred, manual: !!x.manual,
    deal: x.dealReal, disc: x.discountPct, disp: x.dispensary, brand: x.brand || '', name: x.name, url: x.url || '',
    note: (x.notes || []).find((n) => /BOGO|effective/i.test(n)) || '',
  }));
  const card = (r) => {
    const mark = r.manual ? { t: 'J', cls: 'jars' } : r.bucket === 'sativa' ? { t: '★', cls: 'sativa' } : r.inf ? { t: '≈', cls: 'inf' } : { t: '', cls: '' };
    const lineage = r.bucket === 'sativa' ? 'Pure sativa' : 'Sativa-lean';
    const lineageNote = r.manual ? 'JARS · by hand' : r.inf ? 'inferred' : 'menu-labeled';
    const dealChip = r.deal === true ? `<span class="chip deal">✓ ${r.disc}% off</span>` : r.deal === false ? `<span class="chip warn">⚠ unverified</span>` : '';
    const bogo = r.note ? `<span class="chip bogo">BOGO ≈$1.43/g</span>` : '';
    return `<article class="card${r.manual ? ' is-jars' : ''}" data-ppg="${r.ppg}" data-thc="${r.thc}" data-pure="${r.bucket === 'sativa' ? 1 : 0}" data-deal="${r.deal === true ? 1 : 0}">
  <div class="rank"><span class="mk ${mark.cls}">${mark.t}</span><span class="num">${r.rank}</span></div>
  <div class="body">
    <div class="prod">${escape(r.brand ? r.brand + ' · ' : '')}${escape(r.name)}</div>
    <div class="line2"><span class="thc">${r.thc}%</span><span class="lin ${mark.cls}">${lineage}<small>${lineageNote}</small></span><span class="disp">${escape(shortDisp(r.disp))}</span></div>
    <div class="chips">${dealChip}${bogo}<span class="chip qty">${escape(r.wt)} · $${r.price}</span></div>
  </div>
  <div class="price"><div class="ppg"><span class="cur">$</span>${r.ppg.toFixed(2)}<span class="per">/g</span></div><div class="oz">$${r.oz}/oz</div>${r.url ? `<a class="go" href="${escape(r.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
</article>`;
  };
  return `<title>Tucson Flower · Best $/g</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{--bg:#f3f5ee;--surface:#fff;--surface2:#f7f9f2;--line:#e0e5d8;--ink:#1b2216;--muted:#5c6851;--faint:#8a9680;--accent:#2f8f4e;--accent-ink:#1f7a40;--gold:#b8892a;--teal:#2a9d8a;--amber:#d1701f;--warn:#b07a1e;--shadow:0 1px 2px rgba(30,40,20,.06),0 4px 16px rgba(30,40,20,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#10140d;--surface:#191f13;--surface2:#20271a;--line:#2c3423;--ink:#e9efe1;--muted:#9aa88d;--faint:#6f7c63;--accent:#6bcb7b;--accent-ink:#7ed88c;--gold:#e4b24c;--teal:#5cc2b0;--amber:#ef9042;--warn:#e0a94b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}}
:root[data-theme="light"]{--bg:#f3f5ee;--surface:#fff;--surface2:#f7f9f2;--line:#e0e5d8;--ink:#1b2216;--muted:#5c6851;--faint:#8a9680;--accent:#2f8f4e;--accent-ink:#1f7a40;--gold:#b8892a;--teal:#2a9d8a;--amber:#d1701f;--warn:#b07a1e;--shadow:0 1px 2px rgba(30,40,20,.06),0 4px 16px rgba(30,40,20,.05)}
:root[data-theme="dark"]{--bg:#10140d;--surface:#191f13;--surface2:#20271a;--line:#2c3423;--ink:#e9efe1;--muted:#9aa88d;--faint:#6f7c63;--accent:#6bcb7b;--accent-ink:#7ed88c;--gold:#e4b24c;--teal:#5cc2b0;--amber:#ef9042;--warn:#e0a94b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;line-height:1.4}
.wrap{max-width:600px;margin:0 auto;padding:0 14px 40px;padding-bottom:calc(40px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:linear-gradient(var(--bg) 80%,transparent);margin:0 -14px;padding:14px 14px 8px}
.h-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
h1{font-size:20px;font-weight:800;letter-spacing:-.02em;margin:0}
h1 small{display:block;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-top:3px}
.gen{font-size:11px;color:var(--faint);text-align:right;line-height:1.35}
.criteria{font-size:12px;color:var(--muted);margin:9px 0 10px}
.criteria b{color:var(--ink);font-weight:700}
.controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chipbtn{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--muted);font:inherit;font-size:12.5px;font-weight:600;padding:6px 11px;border-radius:999px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background .12s,color .12s,border-color .12s}
.chipbtn[aria-pressed="true"]{background:var(--accent);color:#08120a;border-color:var(--accent)}
.sort{margin-left:auto}
.count{font-size:12px;color:var(--faint);padding:10px 2px 8px;font-weight:600}
.list{display:flex;flex-direction:column;gap:9px}
.card{display:grid;grid-template-columns:30px 1fr auto;gap:11px;align-items:stretch;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 13px;box-shadow:var(--shadow)}
.card.is-jars{border-color:color-mix(in srgb,var(--amber) 55%,var(--line));background:linear-gradient(180deg,color-mix(in srgb,var(--amber) 9%,var(--surface)),var(--surface))}
.rank{display:flex;flex-direction:column;align-items:center;gap:3px;padding-top:1px}
.mk{font-size:15px;line-height:1;height:16px}
.mk.sativa{color:var(--gold)}.mk.inf{color:var(--teal)}.mk.jars{color:var(--amber);font-weight:800;font-size:13px}
.rank .num{font-size:12px;font-weight:700;color:var(--faint)}
.body{min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center}
.prod{font-size:14.5px;font-weight:700;letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.line2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.thc{font-weight:800;color:var(--accent-ink)}
.lin{color:var(--muted);font-weight:600}
.lin small{color:var(--faint);font-weight:500;margin-left:4px;font-size:11px}
.lin.sativa{color:var(--gold)}.lin.jars{color:var(--amber)}
.disp{color:var(--faint);margin-left:auto;font-size:11.5px;text-align:right}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:1px}
.chip{font-size:11px;font-weight:700;padding:2.5px 7px;border-radius:6px;white-space:nowrap}
.chip.deal{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent-ink)}
.chip.bogo{background:color-mix(in srgb,var(--gold) 20%,transparent);color:var(--gold)}
.chip.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.chip.qty{background:var(--surface2);color:var(--muted);font-weight:600}
.price{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:1px;text-align:right}
.ppg{font-size:22px;font-weight:800;letter-spacing:-.03em;line-height:1;white-space:nowrap}
.ppg .cur{font-size:14px;font-weight:700;vertical-align:top;margin-right:-1px}
.ppg .per{font-size:12px;font-weight:600;color:var(--faint)}
.oz{font-size:11.5px;color:var(--faint);font-weight:600;margin-top:2px}
.go{margin-top:5px;font-size:11.5px;font-weight:700;color:var(--accent-ink);text-decoration:none;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));padding:3px 9px;border-radius:7px}
.go:active{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.note{font-size:11.5px;color:var(--faint);margin-top:18px;line-height:1.55}
.note b{color:var(--muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:12px}
.legend b{font-weight:800}
.empty{text-align:center;color:var(--faint);padding:30px;font-size:13px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
<div class="wrap">
<header>
  <div class="h-top"><h1>Tucson Flower<small>best value · $ / gram</small></h1><span class="gen">updated<br>${genStr}</span></div>
  <p class="criteria">Sativa &amp; sativa-leaning · THC <b>≥27%</b> · ranked by what you actually pay. <b>10 dispensaries.</b></p>
  <div class="controls">
    <button class="chipbtn" data-filter="all" aria-pressed="true">All</button>
    <button class="chipbtn" data-filter="pure">★ Pure sativa</button>
    <button class="chipbtn" data-filter="under6">≤ $6/g</button>
    <button class="chipbtn" data-filter="deal">On deal</button>
    <button class="chipbtn sort" data-sort="ppg" aria-pressed="true">Sort: $/g</button>
  </div>
</header>
<div class="count" id="count"></div>
<div class="list" id="list">
${rows.map(card).join('\n')}
</div>
<div class="empty" id="empty" hidden>Nothing matches that filter.</div>
<div class="legend"><span><b style="color:var(--gold)">★</b> menu pure sativa</span><span><b style="color:var(--teal)">≈</b> lineage inferred</span><span><b style="color:var(--amber)">J</b> JARS (by hand)</span></div>
<p class="note"><b>Reading it:</b> $/g is the price you pay (sale ÷ grams); $/oz is the 28g equivalent so sizes compare fairly. Deals are recomputed against the struck price — ✓ verified, ⚠ couldn't verify. JARS locks its menu to your location so it can't be auto-pulled here; JARS picks were entered by hand. Snapshot from the update time — reconfirm in-store.</p>
</div>
<script>
(function(){
  var list=document.getElementById('list'),cards=[].slice.call(list.children);
  var count=document.getElementById('count'),empty=document.getElementById('empty');
  var filter='all',sort='ppg';
  function apply(){
    var vis=cards.filter(function(c){
      if(filter==='pure')return c.dataset.pure==='1';
      if(filter==='under6')return parseFloat(c.dataset.ppg)<=6;
      if(filter==='deal')return c.dataset.deal==='1';
      return true;
    });
    vis.sort(function(a,b){
      if(sort==='thc')return parseFloat(b.dataset.thc)-parseFloat(a.dataset.thc);
      return parseFloat(a.dataset.ppg)-parseFloat(b.dataset.ppg);
    });
    cards.forEach(function(c){c.style.display='none';});
    vis.forEach(function(c){c.style.display='';list.appendChild(c);});
    count.textContent=vis.length+' of '+cards.length+' picks · '+(sort==='thc'?'highest THC first':'cheapest first');
    empty.hidden=vis.length>0;
  }
  document.querySelectorAll('[data-filter]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed','false');});b.setAttribute('aria-pressed','true');filter=b.dataset.filter;apply();});});
  var sb=document.querySelector('[data-sort]');
  sb.addEventListener('click',function(){sort=sort==='ppg'?'thc':'ppg';sb.textContent='Sort: '+(sort==='ppg'?'$/g':'THC');apply();});
  apply();
})();
</script>`;
}

// ===========================================================================
// XLSX
// ===========================================================================
async function buildXlsx(ranked) {
  const A = 'Arial';
  const wb = new ExcelJS.Workbook();
  const box = () => { const s = { style: 'thin', color: { argb: 'FFCFD8D5' } }; return { top: s, left: s, right: s, bottom: s }; };
  const ws = wb.addWorksheet('Best Value Flower', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.mergeCells('A1:N1');
  ws.getCell('A1').value = 'Tucson Best-Value Flower  —  Sativa & Sativa-Leaning, THC ≥ 27%';
  ws.getCell('A1').font = { name: A, size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
  ws.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;
  ws.mergeCells('A2:N2');
  ws.getCell('A2').value = '★ menu pure sativa   ≈ inferred sativa-lean   ✓ verified deal   ⚠ unverifiable   J = JARS (by hand)   |   $/oz = 28g equivalent';
  ws.getCell('A2').font = { name: A, size: 9, italic: true, color: { argb: 'FF555555' } };
  ws.getCell('A2').alignment = { vertical: 'middle', indent: 1 };
  const HDR = 4;
  const cols2 = ['Rank', '$/g', '$/oz (eq)', 'Price', 'Weight', 'THC', 'Lineage', 'Source', 'Deal', 'Dispensary', 'Brand', 'Product', 'Note', 'Link'];
  const widths = [6, 9, 11, 10, 9, 8, 24, 26, 14, 24, 16, 40, 20, 10];
  cols2.forEach((n, i) => {
    const c = ws.getRow(HDR).getCell(i + 1); c.value = n;
    c.font = { name: A, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E5D50' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = box();
    ws.getColumn(i + 1).width = widths[i];
  });
  ws.getRow(HDR).height = 26;
  const lineage = (r) => (r.strainBucket === 'sativa' ? 'Sativa (pure)' : 'Sativa-dominant hybrid');
  const source = (r) => !r.inferred ? 'Menu label' : (r.inferredFrom || '').startsWith('leafly:') ? 'Inferred ≈ Leafly (' + r.inferredFrom.slice(7) + ')' : (r.inferredFrom || '').startsWith('name:') ? 'Inferred ≈ name (' + r.inferredFrom.slice(5) + ')' : 'Inferred ≈';
  const deal = (r) => r.dealReal === true ? `✓ ${r.discountPct}% off` : r.dealReal === false ? '⚠ unverified' : '';
  ranked.forEach((r, i) => {
    const rr = HDR + 1 + i, row = ws.getRow(rr);
    const mark = r.manual ? 'J' : r.strainBucket === 'sativa' ? '★' : r.inferred ? '≈' : '';
    const note = (r.notes || []).find((n) => /BOGO|effective|\$/.test(n)) || '';
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.pricePerGram; row.getCell(2).numFmt = '$#,##0.00';
    row.getCell(3).value = { formula: `B${rr}*28` }; row.getCell(3).numFmt = '$#,##0';
    row.getCell(4).value = r.charged; row.getCell(4).numFmt = '$#,##0.00';
    row.getCell(5).value = r.weightLabel;
    row.getCell(6).value = r.thc; row.getCell(6).numFmt = '0.0"%"';
    row.getCell(7).value = (mark + ' ' + lineage(r)).trim();
    row.getCell(8).value = source(r);
    row.getCell(9).value = deal(r);
    row.getCell(10).value = r.dispensary;
    row.getCell(11).value = r.brand;
    row.getCell(12).value = r.name;
    row.getCell(13).value = note;
    if (r.url) { row.getCell(14).value = { text: 'open', hyperlink: r.url }; row.getCell(14).font = { name: A, size: 10, color: { argb: 'FF1155CC' }, underline: true }; }
    for (let c = 1; c <= 14; c++) {
      const cell = row.getCell(c);
      if (c !== 14 || !r.url) cell.font = { name: A, size: 10, bold: i === 0 || r.manual };
      cell.border = box();
      cell.alignment = { vertical: 'middle', horizontal: c <= 6 ? 'center' : 'left', indent: c <= 6 ? 0 : 1 };
    }
    const fill = r.manual ? 'FFFFE8C2' : r.strainBucket === 'sativa' ? 'FFFFF6D6' : i % 2 ? 'FFEAF2EF' : null;
    if (fill) for (let c = 1; c <= 14; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    row.height = 15;
  });
  ws.autoFilter = { from: { row: HDR, column: 1 }, to: { row: HDR, column: 14 } };

  // Sheet 2: cheapest per dispensary
  const ws2 = wb.addWorksheet('By Dispensary', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws2.mergeCells('A1:E1');
  ws2.getCell('A1').value = 'Cheapest qualifying $/g at each dispensary';
  ws2.getCell('A1').font = { name: A, size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
  ws2.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  ws2.getRow(1).height = 24;
  ['Dispensary', 'Best $/g', '$/oz (eq)', 'Product', 'THC'].forEach((n, i) => {
    const c = ws2.getRow(3).getCell(i + 1); c.value = n;
    c.font = { name: A, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E5D50' } };
    c.alignment = { horizontal: 'center' }; c.border = box();
  });
  const best = {};
  for (const r of ranked) if (!best[r.dispensary] || r.pricePerGram < best[r.dispensary].pricePerGram) best[r.dispensary] = r;
  const order = Object.values(best).sort((a, b) => a.pricePerGram - b.pricePerGram);
  [26, 10, 12, 46, 8].forEach((w, i) => (ws2.getColumn(i + 1).width = w));
  order.forEach((r, i) => {
    const rr = 4 + i, row = ws2.getRow(rr);
    row.getCell(1).value = r.dispensary;
    row.getCell(2).value = r.pricePerGram; row.getCell(2).numFmt = '$#,##0.00';
    row.getCell(3).value = { formula: `B${rr}*28` }; row.getCell(3).numFmt = '$#,##0';
    row.getCell(4).value = `${r.brand} — ${r.name}`;
    row.getCell(5).value = r.thc; row.getCell(5).numFmt = '0.0"%"';
    for (let c = 1; c <= 5; c++) { const cell = row.getCell(c); cell.font = { name: A, size: 10 }; cell.border = box(); cell.alignment = { vertical: 'middle', horizontal: c === 1 || c === 4 ? 'left' : 'center', indent: c === 1 || c === 4 ? 1 : 0 }; }
  });

  await wb.xlsx.writeFile('weed-best-value.xlsx');
}
