/**
 * build-concentrate-report.js
 * -------------------------------------------------------------------------
 * Concentrate sibling of build-report.js / build-preroll-report.js. Turns a
 * raw concentrate scrape (concentrate-scraped.json, written by
 * concentrate-value-finder.js) plus any hand-entered JARS concentrates
 * (concentrates-manual.json) into three deliverables:
 *   - concentrate-best-value.csv   (spreadsheet-friendly)
 *   - concentrate-best-value.xlsx  (formatted, 2 sheets)
 *   - concentrate-best-value.html  (mobile phone page)
 *
 * Run after a scrape, or via `npm run concentrate` which does both.
 *   node build-concentrate-report.js
 */
'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const cv = require('./concentrate-value-finder.js');

const SCRAPE = 'concentrate-scraped.json';
if (!fs.existsSync(SCRAPE)) {
  console.error(`No ${SCRAPE} found. Run the scraper first:`);
  console.error('  node concentrate-value-finder.js --headless --json concentrate-scraped.json');
  console.error('  (or just: npm run concentrate)');
  process.exit(1);
}

const base = JSON.parse(fs.readFileSync(SCRAPE, 'utf8'));
const opts = base.opts || { minThc: 0 };
const scraped = (base.results || []).filter((r) => !r.manual);

let manual = [];
try { manual = JSON.parse(fs.readFileSync('concentrates-manual.json', 'utf8')); } catch (_) { /* optional */ }

const manualRecs = [];
for (const it of manual) {
  const r = cv.toConcentrateRecord(it);
  if (it.manualNote) r.notes.push(it.manualNote);
  r.manual = true;
  manualRecs.push(r);
}
const keptManual = cv.applyConcentrateFilters(manualRecs, opts).kept;
for (const d of manualRecs.filter((r) => !keptManual.includes(r))) {
  console.log(`   (manual item skipped: ${d.name} — THC ${d.thc})`);
}

const ranked = cv.rankConcentrates(scraped.concat(keptManual));
const generatedAt = base.generatedAt || new Date().toISOString();

// --- merged JSON (reference) ---
fs.writeFileSync('concentrate-best-value.json', JSON.stringify({ opts, generatedAt, count: ranked.length, results: ranked, jarsManualAdded: keptManual.length }, null, 2));

// --- CSV ---
const cols = ['pricePerGram', 'charged', 'original', 'discountPct', 'dealReal', 'grams', 'weightLabel', 'thc', 'form', 'strainLabel', 'dispensary', 'brand', 'name', 'url'];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync('concentrate-best-value.csv', [cols.join(',')].concat(ranked.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n'));

// --- HTML ---
fs.writeFileSync('concentrate-best-value.html', buildHtml(ranked, generatedAt, opts));

// --- XLSX (async, last) ---
buildXlsx(ranked).then(() => {
  const jrank = ranked.findIndex((r) => r.manual);
  console.log(`Concentrate report built: ${ranked.length} picks (${keptManual.length} hand-entered JARS).`);
  if (jrank >= 0) {
    const j = ranked[jrank];
    console.log(`  JARS "${j.name}" ranks #${jrank + 1} at $${j.pricePerGram.toFixed(2)}/g.`);
  }
  console.log('  -> concentrate-best-value.csv / .xlsx / .html');
});

// ===========================================================================
// HTML  (phone page — shares the flower/preroll pages' theme, amber accent
// to tell it apart from flower's green and preroll's teal at a glance)
// ===========================================================================
function buildHtml(rows0, generatedAtISO, opts) {
  const genStr = new Date(generatedAtISO).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' }) + ' MST';
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const shortDisp = (s) => s.replace(' Dispensary', '').replace(' (Tucson)', '').replace('Trulieve / Harvest of Tucson', 'Trulieve/Harvest').replace(' (Halo Cannabis)', '');
  const rows = rows0.map((x, i) => ({
    rank: i + 1,
    ppg: +(x.pricePerGram ?? 0).toFixed(2),
    price: x.charged, wt: x.weightLabel || '?', thc: x.thc, form: x.form || '',
    lineage: x.strainLabel || '', manual: !!x.manual,
    deal: x.dealReal, disc: x.discountPct, disp: x.dispensary, brand: x.brand || '', name: x.name, url: x.url || '',
  }));
  const card = (r) => {
    const dealChip = r.deal === true ? `<span class="chip deal">✓ ${r.disc}% off</span>` : r.deal === false ? `<span class="chip warn">⚠ unverified</span>` : '';
    const formChip = r.form ? `<span class="chip form">${escape(r.form)}</span>` : '';
    const jarsChip = r.manual ? `<span class="chip jars">JARS · by hand</span>` : '';
    return `<article class="card${r.manual ? ' is-jars' : ''}" data-ppg="${r.ppg}" data-thc="${r.thc ?? -1}" data-deal="${r.deal === true ? 1 : 0}" data-form="${escape(r.form)}">
  <div class="rank"><span class="num">${r.rank}</span></div>
  <div class="body">
    <div class="prod">${escape(r.brand ? r.brand + ' · ' : '')}${escape(r.name)}</div>
    <div class="line2"><span class="thc">${r.thc != null ? r.thc + '%' : '? THC'}</span><span class="lin">${escape(r.lineage)}</span><span class="disp">${escape(shortDisp(r.disp))}</span></div>
    <div class="chips">${dealChip}${formChip}${jarsChip}<span class="chip qty">${escape(r.wt)} · $${r.price}</span></div>
  </div>
  <div class="price"><div class="ppg"><span class="cur">$</span>${r.ppg.toFixed(2)}<span class="per">/g</span></div>${r.url ? `<a class="go" href="${escape(r.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
</article>`;
  };
  return `<title>Tucson Concentrates · Best Value</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{--bg:#f6f2ec;--surface:#fff;--surface2:#faf6f0;--line:#e7ddd0;--ink:#241d14;--muted:#6b5f4d;--faint:#998b74;--accent:#c17a2a;--accent-ink:#a3621c;--gold:#b8892a;--purple:#7a5bbf;--warn:#b07a1e;--shadow:0 1px 2px rgba(30,20,10,.06),0 4px 16px rgba(30,20,10,.05)}
@media (prefers-color-scheme:dark){:root{--bg:#16110a;--surface:#1f1810;--surface2:#271f15;--line:#352a1c;--ink:#f1e8da;--muted:#b3a38a;--faint:#7c7058;--accent:#e2994f;--accent-ink:#efb176;--gold:#e4b24c;--purple:#b39ae6;--warn:#e0a94b;--shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.28)}}
:root[data-theme="light"]{--bg:#f6f2ec;--surface:#fff;--surface2:#faf6f0;--line:#e7ddd0;--ink:#241d14;--muted:#6b5f4d;--faint:#998b74;--accent:#c17a2a;--accent-ink:#a3621c;--gold:#b8892a;--purple:#7a5bbf;--warn:#b07a1e}
:root[data-theme="dark"]{--bg:#16110a;--surface:#1f1810;--surface2:#271f15;--line:#352a1c;--ink:#f1e8da;--muted:#b3a38a;--faint:#7c7058;--accent:#e2994f;--accent-ink:#efb176;--gold:#e4b24c;--purple:#b39ae6;--warn:#e0a94b}
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
.chipbtn[aria-pressed="true"]{background:var(--accent);color:#1a0f02;border-color:var(--accent)}
.sort{margin-left:auto}
.count{font-size:12px;color:var(--faint);padding:10px 2px 8px;font-weight:600}
.list{display:flex;flex-direction:column;gap:9px}
.card{display:grid;grid-template-columns:22px 1fr auto;gap:11px;align-items:stretch;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 13px;box-shadow:var(--shadow)}
.card.is-jars{border-color:color-mix(in srgb,var(--warn) 55%,var(--line));background:linear-gradient(180deg,color-mix(in srgb,var(--warn) 9%,var(--surface)),var(--surface))}
.rank{display:flex;align-items:flex-start;justify-content:center;padding-top:1px}
.rank .num{font-size:12px;font-weight:700;color:var(--faint)}
.body{min-width:0;display:flex;flex-direction:column;gap:5px;justify-content:center}
.prod{font-size:14.5px;font-weight:700;letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.line2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.thc{font-weight:800;color:var(--accent-ink)}
.lin{color:var(--muted);font-weight:600}
.disp{color:var(--faint);margin-left:auto;font-size:11.5px;text-align:right}
.chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:1px}
.chip{font-size:11px;font-weight:700;padding:2.5px 7px;border-radius:6px;white-space:nowrap}
.chip.deal{background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent-ink)}
.chip.form{background:color-mix(in srgb,var(--purple) 18%,transparent);color:var(--purple)}
.chip.warn{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.chip.jars{background:color-mix(in srgb,var(--warn) 22%,transparent);color:var(--warn);font-weight:800}
.chip.qty{background:var(--surface2);color:var(--muted);font-weight:600}
.price{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;gap:1px;text-align:right}
.ppg{font-size:22px;font-weight:800;letter-spacing:-.03em;line-height:1;white-space:nowrap}
.ppg .cur{font-size:14px;font-weight:700;vertical-align:top;margin-right:-1px}
.ppg .per{font-size:12px;font-weight:600;color:var(--faint)}
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
  <div class="h-top"><h1>Tucson Concentrates<small>best value · $ / gram</small></h1><span class="gen">updated<br>${genStr}</span></div>
  <p class="criteria">All forms, all lineages${opts.minThc > 0 ? ` · THC <b>≥${opts.minThc}%</b>` : ' · no THC floor'} · ranked by real price per gram.</p>
  <div class="controls">
    <button class="chipbtn" data-filter="all" aria-pressed="true">All</button>
    <button class="chipbtn" data-filter="deal">On deal</button>
    <button class="chipbtn sort" data-sort="ppg" aria-pressed="true">Sort: $/g</button>
  </div>
</header>
<div class="count" id="count"></div>
<div class="list" id="list">
${rows.map(card).join('\n')}
</div>
<div class="empty" id="empty" hidden>Nothing matches that filter.</div>
<div class="legend"><span><b style="color:var(--purple)">form</b> live resin/rosin/diamonds/etc</span><span><b style="color:var(--warn)">JARS</b> picks entered by hand</span></div>
<p class="note"><b>Reading it:</b> ranked purely by $/g — no sativa or THC filter unless you ran the scraper with one. Deals are recomputed against the struck price — ✓ verified, ⚠ couldn't verify. JARS locks its menu to your location; JARS picks entered by hand. Snapshot — reconfirm in-store.</p>
</div>
<script>
(function(){
  var list=document.getElementById('list'),cards=[].slice.call(list.children);
  var count=document.getElementById('count'),empty=document.getElementById('empty');
  var filter='all',sort='ppg';
  function apply(){
    var vis=cards.filter(function(c){
      if(filter==='deal')return c.dataset.deal==='1';
      return true;
    });
    vis.sort(function(a,b){
      if(sort==='thc')return parseFloat(b.dataset.thc)-parseFloat(a.dataset.thc);
      return parseFloat(a.dataset.ppg)-parseFloat(b.dataset.ppg);
    });
    cards.forEach(function(c){c.style.display='none';});
    vis.forEach(function(c){c.style.display='';list.appendChild(c);});
    var label=sort==='thc'?'highest THC first':'cheapest $/g first';
    count.textContent=vis.length+' of '+cards.length+' picks · '+label;
    empty.hidden=vis.length>0;
  }
  document.querySelectorAll('[data-filter]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('[data-filter]').forEach(function(x){x.setAttribute('aria-pressed','false');});b.setAttribute('aria-pressed','true');filter=b.dataset.filter;apply();});});
  var sb=document.querySelector('[data-sort]');
  var order=['ppg','thc'],names={ppg:'$/g',thc:'THC'};
  sb.addEventListener('click',function(){sort=order[(order.indexOf(sort)+1)%order.length];sb.textContent='Sort: '+names[sort];apply();});
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
  const ws = wb.addWorksheet('Best Value Concentrates', { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.mergeCells('A1:K1');
  ws.getCell('A1').value = 'Tucson Best-Value Concentrates  —  All forms, all lineages';
  ws.getCell('A1').font = { name: A, size: 15, bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7A3E12' } };
  ws.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;
  ws.mergeCells('A2:K2');
  ws.getCell('A2').value = 'J = JARS (by hand)   ✓ verified deal   ⚠ unverifiable   |   ranked purely by $/g — no strain or THC gate unless requested';
  ws.getCell('A2').font = { name: A, size: 9, italic: true, color: { argb: 'FF555555' } };
  ws.getCell('A2').alignment = { vertical: 'middle', indent: 1 };
  const HDR = 4;
  const cols2 = ['Rank', '$/g', 'Price', 'Weight', 'THC', 'Form', 'Lineage', 'Deal', 'Dispensary', 'Brand', 'Product', 'Link'];
  const widths = [6, 9, 10, 10, 8, 14, 16, 14, 22, 16, 40, 10];
  cols2.forEach((n, i) => {
    const c = ws.getRow(HDR).getCell(i + 1); c.value = n;
    c.font = { name: A, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA3621C' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }; c.border = box();
    ws.getColumn(i + 1).width = widths[i];
  });
  ws.getRow(HDR).height = 26;
  const deal = (r) => r.dealReal === true ? `✓ ${r.discountPct}% off` : r.dealReal === false ? '⚠ unverified' : '';
  ranked.forEach((r, i) => {
    const rr = HDR + 1 + i, row = ws.getRow(rr);
    const mark = r.manual ? 'J ' : '';
    row.getCell(1).value = i + 1;
    row.getCell(2).value = r.pricePerGram; row.getCell(2).numFmt = '$#,##0.00';
    row.getCell(3).value = r.charged; row.getCell(3).numFmt = '$#,##0.00';
    row.getCell(4).value = r.weightLabel;
    row.getCell(5).value = r.thc; row.getCell(5).numFmt = '0.0"%"';
    row.getCell(6).value = r.form;
    row.getCell(7).value = r.strainLabel;
    row.getCell(8).value = deal(r);
    row.getCell(9).value = r.dispensary;
    row.getCell(10).value = r.brand;
    row.getCell(11).value = mark + r.name;
    if (r.url) { row.getCell(12).value = { text: 'open', hyperlink: r.url }; row.getCell(12).font = { name: A, size: 10, color: { argb: 'FF1155CC' }, underline: true }; }
    for (let c = 1; c <= 12; c++) {
      const cell = row.getCell(c);
      if (c !== 12 || !r.url) cell.font = { name: A, size: 10, bold: i === 0 || r.manual };
      cell.border = box();
      cell.alignment = { vertical: 'middle', horizontal: c <= 8 ? 'center' : 'left', indent: c <= 8 ? 0 : 1 };
    }
    const fill = r.manual ? 'FFFFE8C2' : i % 2 ? 'FFF3E6D6' : null;
    if (fill) for (let c = 1; c <= 12; c++) row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    row.height = 15;
  });
  ws.autoFilter = { from: { row: HDR, column: 1 }, to: { row: HDR, column: 12 } };

  // Sheet 2: cheapest per dispensary
  const ws2 = wb.addWorksheet('By Dispensary', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws2.mergeCells('A1:E1');
  ws2.getCell('A1').value = 'Cheapest qualifying $/g at each dispensary';
  ws2.getCell('A1').font = { name: A, size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7A3E12' } };
  ws2.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  ws2.getRow(1).height = 24;
  ['Dispensary', 'Best $/g', 'Form', 'Product', 'THC'].forEach((n, i) => {
    const c = ws2.getRow(3).getCell(i + 1); c.value = n;
    c.font = { name: A, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA3621C' } };
    c.alignment = { horizontal: 'center' }; c.border = box();
  });
  const best = {};
  for (const r of ranked) {
    const v = r.pricePerGram ?? Infinity;
    if (!best[r.dispensary] || v < (best[r.dispensary].pricePerGram ?? Infinity)) best[r.dispensary] = r;
  }
  const order = Object.values(best).sort((a, b) => (a.pricePerGram ?? Infinity) - (b.pricePerGram ?? Infinity));
  [26, 10, 14, 46, 8].forEach((w, i) => (ws2.getColumn(i + 1).width = w));
  order.forEach((r, i) => {
    const rr = 4 + i, row = ws2.getRow(rr);
    row.getCell(1).value = r.dispensary;
    row.getCell(2).value = r.pricePerGram; row.getCell(2).numFmt = '$#,##0.00';
    row.getCell(3).value = r.form;
    row.getCell(4).value = `${r.brand} — ${r.name}`;
    row.getCell(5).value = r.thc; row.getCell(5).numFmt = '0.0"%"';
    for (let c = 1; c <= 5; c++) { const cell = row.getCell(c); cell.font = { name: A, size: 10 }; cell.border = box(); cell.alignment = { vertical: 'middle', horizontal: c === 1 || c === 4 ? 'left' : 'center', indent: c === 1 || c === 4 ? 1 : 0 }; }
  });

  await wb.xlsx.writeFile('concentrate-best-value.xlsx');
}
