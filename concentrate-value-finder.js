/**
 * concentrate-value-finder.js
 * -------------------------------------------------------------------------
 * The concentrate sibling of weed-value-finder.js. Finds the best-VALUE
 * concentrates (wax, shatter, rosin, live resin, diamonds, badder, sauce...)
 * across the same Tucson / Green Valley dispensaries, ranked by REAL price
 * per gram.
 *
 * Unlike the flower and pre-roll tools, this one does NOT filter by strain
 * lineage or enforce a THC floor by default — indica, hybrid, and sativa all
 * count, and --min-thc defaults to 0. Concentrate shoppers care about form
 * and price, not sativa-dominance. THC and lineage are still shown as plain
 * info columns.
 *
 * It REUSES the flower tool's proven engine (price/weight parsing, deal
 * verification, filtering primitives, ranking, and the Dutchie browser
 * plumbing) by requiring ./weed-value-finder.js — one source of truth for
 * the hard parts, same pattern as preroll-value-finder.js.
 *
 * Usage:
 *   node concentrate-value-finder.js                   # all seeded dispos, headed
 *   node concentrate-value-finder.js --headless
 *   node concentrate-value-finder.js --min-thc 70       # optional THC floor
 *   node concentrate-value-finder.js --max-ppg 20       # cap $/gram
 *   node concentrate-value-finder.js --only earths-healing-south,green-halo
 *   node concentrate-value-finder.js --json concentrate-scraped.json
 *   node concentrate-value-finder.js --selftest         # math checks, no browser
 *
 * JARS locks its menu to your IP location, same as flower/prerolls, so JARS
 * concentrates (if any) are hand-entered via concentrates-manual.json and
 * merged by build-concentrate-report.js.
 */

'use strict';

const fs = require('fs');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* only needed for live runs */ }

// Reuse the flower tool's engine + plumbing — one source of truth for the hard parts.
const m = require('./weed-value-finder.js');

// ---------------------------------------------------------------------------
// Concentrate specifics: form (purely informational — never filtered on)
// ---------------------------------------------------------------------------

// Order matters: more specific terms first so "live rosin" doesn't get
// swallowed by a bare "rosin" match, etc.
const FORM_PATTERNS = [
  ['Live Rosin', /\blive\s*rosin\b/i],
  ['Rosin', /\brosin\b/i],
  ['Live Resin', /\blive\s*resin\b/i],
  ['Resin', /\bresin\b/i],
  ['Diamonds', /\bdiamonds?\b/i],
  ['Badder', /\bbadder|budder\b/i],
  ['Sauce', /\bsauce\b/i],
  ['Shatter', /\bshatter\b/i],
  ['Crumble', /\bcrumble\b/i],
  ['Sugar', /\bsugar\b/i],
  ['Wax', /\bwax\b/i],
  ['Hash', /\bhash|bubble\s*hash\b/i],
  ['Distillate', /\bdistillate\b/i],
];

// Best-effort concentrate form from product name/brand text. Returns '' when
// nothing matches — shown as-is, never used to drop a listing.
function detectForm(text) {
  const t = String(text || '');
  for (const [label, re] of FORM_PATTERNS) if (re.test(t)) return label;
  return '';
}

// ---------------------------------------------------------------------------
// Arg parsing (subset of the flower flags — no sativa/hybrid gating here)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  const has = (name) => args.includes(`--${name}`);
  return {
    minThc: Number(get('min-thc', 0)), // concentrates run 60-90%+; no floor by default
    maxPpg: get('max-ppg') != null ? Number(get('max-ppg')) : null,
    includeVerify: has('include-unverified-slugs') || Boolean(get('only')),
    only: (get('only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxPerStore: Number(get('max', 400)),
    headed: !has('headless'),
    configPath: get('config'),
    jsonOut: get('json'),
    csvOut: get('csv'),
    selftest: has('selftest'),
  };
}

// ---------------------------------------------------------------------------
// Filter + rank — lineage-agnostic (no strain/THC gating unless asked for)
// ---------------------------------------------------------------------------

// Deliberately NOT m.applyFilters: that always excludes indica/indica-hybrid
// regardless of flags, which is wrong here — concentrate shoppers don't care
// about sativa-dominance. Only drop a listing for having no comparable price,
// or for failing an EXPLICITLY requested THC/price cap.
function applyConcentrateFilters(records, opts) {
  const kept = [];
  const dropped = [];
  for (const r of records) {
    if (r.pricePerGram == null) { dropped.push({ r, reason: 'no comparable $/g' }); continue; }
    if (opts.minThc > 0 && (r.thc == null || r.thc < opts.minThc)) {
      dropped.push({ r, reason: r.thc == null ? 'no THC listed' : `THC ${r.thc}% < ${opts.minThc}%` });
      continue;
    }
    if (opts.maxPpg != null && r.pricePerGram > opts.maxPpg) {
      dropped.push({ r, reason: `$${r.pricePerGram.toFixed(2)}/g > $${opts.maxPpg}/g cap` });
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}

// Pure $/g value sort (THC as a tiebreak only) — reuses the flower engine's
// ranker with preferSativa always off, since lineage isn't a ranking input here.
function rankConcentrates(list) {
  return m.rankListings(list, false);
}

function toConcentrateRecord(raw) {
  const rec = m.normalizeListing(raw);
  rec.form = detectForm(`${raw.name || ''} ${raw.brand || ''} ${raw.blob || ''}`);
  return rec;
}

// ---------------------------------------------------------------------------
// Dutchie concentrate scrape (reuses the flower tool's browser plumbing + harvester)
// ---------------------------------------------------------------------------

async function scrapeConcentrates(context, disp, opts) {
  const menuType = disp.menuType || 'rec';
  const url = `https://dutchie.com/embedded-menu/${disp.slug}/products/concentrates?menuType=${menuType}`;
  const page = await context.newPage();
  console.log(`\n▶ ${disp.name} (dutchie:${disp.slug})`);
  try {
    await m.gotoAndSettle(page, url);
    const bad = await page.evaluate(() =>
      /can't find|not found|404|no products/i.test(document.body?.innerText || '')
    ).catch(() => false);
    await page.waitForTimeout(1200);
    const count = await m.autoScroll(
      page,
      () => Array.from(document.querySelectorAll('button')).filter((b) => /add .* to cart|^add\b/i.test((b.textContent || '').trim())).length
    );
    if (!count) {
      console.log(`   no concentrate cards found${bad ? ' (menu says not-found — slug likely wrong)' : ''} — skipping`);
      await page.close();
      return [];
    }
    const cards = await page.evaluate(m.DUTCHIE_HARVEST);
    console.log(`   harvested ${cards.length} card(s)`);
    await page.close();
    return cards.slice(0, opts.maxPerStore).map((c) =>
      toConcentrateRecord({ dispensary: disp.name, dispensaryId: disp.id, ...c })
    );
  } catch (e) {
    console.log(`   error: ${e.message} — skipping`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printTable(ranked, dropped, opts) {
  console.log(`\n${'='.repeat(104)}`);
  console.log(`BEST VALUE CONCENTRATES${opts.minThc > 0 ? ` — THC ≥ ${opts.minThc}%` : ' — all forms, any THC'}`);
  console.log('ranked by REAL price per gram');
  console.log('='.repeat(104));

  if (!ranked.length) {
    console.log('\nNothing qualified. Loosen with --min-thc or --max-ppg.');
  } else {
    console.log(
      `\n${'$/g'.padEnd(7)}${'/oz eq'.padEnd(8)}${'PRICE'.padEnd(9)}${'WT'.padEnd(8)}${'THC'.padEnd(7)}${'FORM'.padEnd(13)}${'LINEAGE'.padEnd(10)}${'DEAL'.padEnd(12)}${'DISPENSARY'.padEnd(20)}PRODUCT`
    );
    console.log('-'.repeat(104));
    for (const r of ranked) {
      const deal =
        r.dealReal === true ? `✓ ${r.discountPct}% off` :
        r.dealReal === false ? '⚠ unverified' :
        r.discountPct != null ? `${r.discountPct}% off` : '';
      console.log(
        `$${(r.pricePerGram ?? 0).toFixed(2).padEnd(6)}` +
          `$${Math.round((r.pricePerGram ?? 0) * 28).toString().padEnd(7)}` +
          `$${(r.charged ?? 0).toFixed(2).padEnd(8)}${(r.weightLabel || '?').padEnd(8)}` +
          `${(r.thc != null ? r.thc + '%' : '?').padEnd(7)}${(r.form || '').padEnd(13)}${(r.strainLabel || '').padEnd(10)}${deal.padEnd(12)}` +
          `${(r.dispensary || '').slice(0, 19).padEnd(20)}${r.brand ? r.brand + ' — ' : ''}${r.name}`
      );
    }

    const best = ranked[0];
    console.log(`\n${'─'.repeat(104)}`);
    console.log(`BEST VALUE:  $${best.pricePerGram.toFixed(2)}/g — ${best.name} @ ${best.dispensary}`);
    console.log(`             $${(best.charged ?? 0).toFixed(2)} / ${best.weightLabel} · ${best.thc != null ? best.thc + '%' : '? THC'} · ${best.form || best.strainLabel}`);
    if (best.url) console.log(`             ${best.url}`);
    console.log(`\n✓ = deal verified vs struck MSRP   ⚠ = advertised deal we could NOT verify`);
  }

  const notable = dropped.filter((d) => /\$/.test(d.reason)).slice(0, 8);
  if (notable.length) {
    console.log(`\nDropped by filter (sample):`);
    for (const d of notable) console.log(`   ✗ ${d.r.name || '(unnamed)'} @ ${d.r.dispensary} — ${d.reason}`);
  }
}

function writeJson(p, ranked, dropped, opts) {
  fs.writeFileSync(p, JSON.stringify({ opts, generatedAt: new Date().toISOString(), count: ranked.length, results: ranked, droppedCount: dropped.length }, null, 2));
  console.log(`\nWrote JSON -> ${p}`);
}

function writeCsv(p, ranked) {
  const cols = ['pricePerGram', 'charged', 'original', 'discountPct', 'dealReal', 'grams', 'weightLabel', 'thc', 'form', 'strainLabel', 'dispensary', 'brand', 'name', 'url'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(p, [cols.join(',')].concat(ranked.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n'));
  console.log(`Wrote CSV  -> ${p}`);
}

// ---------------------------------------------------------------------------
// Self-test (no browser): form detection + lineage-agnostic filtering
// ---------------------------------------------------------------------------

function selftest() {
  let pass = 0, total = 0;
  const check = (name, cond, got) => { total++; console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `   got: ${got}`}`); if (cond) pass++; };

  check('live rosin beats bare rosin match', detectForm('Timeless Live Rosin Jar 1g') === 'Live Rosin');
  check('live resin beats bare resin match', detectForm('Connected Live Resin Sauce 1g') === 'Live Resin');
  check('diamonds', detectForm('Alien Labs Diamonds 1g') === 'Diamonds');
  check('badder/budder', detectForm('Raw Garden Budder 1g') === 'Badder');
  check('shatter', detectForm('Error Shatter 1g') === 'Shatter');
  check('unknown form -> empty string, never guessed', detectForm('Mystery Extract 1g') === '');

  // Indica concentrate must NOT be dropped (unlike the flower/preroll tools,
  // which hard-exclude indica/indica-hybrid regardless of flags).
  const indica = toConcentrateRecord({
    dispensary: 'T', brand: 'Raw Garden', name: 'Raw Garden Live Resin Badder - Gelato', weightText: '1g',
    priceText: '$30.00', strainText: 'Indica', thcText: 'THC: 82%', blob: 'Raw Garden Live Resin Badder - Gelato | Indica | THC: 82% | 1g | $30.00',
  });
  check('indica concentrate passes with no THC floor', applyConcentrateFilters([indica], { minThc: 0 }).kept.length === 1);
  check('indica concentrate form detected', indica.form === 'Live Resin', indica.form);

  // Default minThc=0 means "no THC listed" doesn't drop a listing either.
  const noThc = toConcentrateRecord({ dispensary: 'T', brand: 'X', name: 'Mystery Wax', weightText: '1g', priceText: '$25.00', blob: 'Mystery Wax | 1g | $25.00' });
  check('no THC listed still kept when minThc=0', applyConcentrateFilters([noThc], { minThc: 0 }).kept.length === 1);

  // An explicit --min-thc DOES gate, same as flower/preroll.
  const lowThc = toConcentrateRecord({ dispensary: 'T', brand: 'X', name: 'Low Potency Rosin', weightText: '1g', priceText: '$20.00', strainText: 'Hybrid', thcText: 'THC: 40%', blob: 'Low Potency Rosin | Hybrid | THC: 40% | 1g | $20.00' });
  check('--min-thc 70 drops a 40% item', applyConcentrateFilters([lowThc], { minThc: 70 }).kept.length === 0);
  check('--min-thc 70 keeps an 82% item', applyConcentrateFilters([indica], { minThc: 70 }).kept.length === 1);

  // Ranking is pure $/g regardless of lineage.
  const cheapIndica = toConcentrateRecord({ dispensary: 'T', name: 'Cheap Indica Wax', weightText: '1g', priceText: '$15.00', strainText: 'Indica', thcText: 'THC: 75%', blob: 'Cheap Indica Wax | Indica | THC: 75% | 1g | $15.00' });
  const pricierSativa = toConcentrateRecord({ dispensary: 'T', name: 'Pricier Sativa Diamonds', weightText: '1g', priceText: '$40.00', strainText: 'Sativa', thcText: 'THC: 88%', blob: 'Pricier Sativa Diamonds | Sativa | THC: 88% | 1g | $40.00' });
  const ranked = rankConcentrates([pricierSativa, cheapIndica]);
  check('ranking ignores lineage: cheaper indica ranks above pricier sativa', ranked[0] === cheapIndica);

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadDispensaries(opts) {
  // Reuse the flower tool's dispensary list; only the Dutchie stores carry a
  // concentrates category. JARS is geo-locked (hand-entered via concentrates-manual.json).
  let list = m.DISPENSARIES.filter((d) => d.platform === 'dutchie');
  if (opts.configPath) {
    const raw = JSON.parse(fs.readFileSync(opts.configPath, 'utf8'));
    list = Array.isArray(raw) ? raw : raw.dispensaries || [];
  }
  if (opts.only.length) list = m.DISPENSARIES.filter((d) => opts.only.includes(d.id) || opts.only.includes(d.slug));
  return list;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.selftest) return selftest();

  if (!chromium) {
    console.error('playwright is not installed. Run:  npm install playwright && npx playwright install chromium');
    console.error('(You can still run the math checks with:  node concentrate-value-finder.js --selftest)');
    process.exit(1);
  }

  const dispensaries = loadDispensaries(opts);
  if (!dispensaries.length) { console.error('No dispensaries selected.'); process.exit(1); }

  console.log(`Concentrate value finder${opts.minThc > 0 ? ` — THC ≥ ${opts.minThc}%` : ' — all forms, any THC, any lineage'}`);
  console.log(`Dispensaries (${dispensaries.length}): ${dispensaries.map((d) => d.name).join(', ')}`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await m.makeContext(browser);

  let all = [];
  for (const disp of dispensaries) {
    const rows = await scrapeConcentrates(context, disp, opts);
    all = all.concat(rows);
    await new Promise((res) => setTimeout(res, 900 + Math.random() * 1200));
  }
  await browser.close();

  console.log(`\nParsed ${all.length} total concentrate listing(s) across ${dispensaries.length} store(s).`);
  const { kept, dropped } = applyConcentrateFilters(all, opts);
  const ranked = rankConcentrates(kept);

  printTable(ranked, dropped, opts);
  if (opts.jsonOut) writeJson(opts.jsonOut, ranked, dropped, opts);
  if (opts.csvOut) writeCsv(opts.csvOut, ranked);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { detectForm, toConcentrateRecord, applyConcentrateFilters, rankConcentrates };
