/**
 * preroll-value-finder.js
 * -------------------------------------------------------------------------
 * The pre-roll sibling of weed-value-finder.js. Finds the best-VALUE pre-rolls
 * across the same Tucson / Green Valley dispensaries, normalized two ways:
 *
 *   - $ / gram          (of total flower in the pack — compares packs vs singles)
 *   - $ / joint         (per individual pre-roll — how prerolls actually get bought)
 *
 * Filters (prerolls skew infused, so the THC floor is higher than flower's):
 *   - THC >= 35%            (hard cutoff; unknown THC is dropped; --min-thc to change)
 *   - Sativa or sativa-dominant hybrid ONLY  (pure sativa surfaced with ★)
 *   - ranked by REAL price per gram (what you actually pay, deal-verified)
 *
 * Why a separate tool
 * -------------------
 * Pre-rolls carry two quantities flower doesn't: a PACK COUNT (5pk / 10pk) and,
 * very often, INFUSION (kief/diamonds/hash) that pushes THC to 40–50%. Dutchie's
 * "Add <weight> to cart" label already reports the pack's TOTAL grams (a 5-pack
 * of 0.5g joints shows as "2.5g", a 10-pack as "1/8 oz"), so the flower tool's
 * gram normalizer works as-is. This tool adds pack-count parsing on top so it can
 * also rank by $/joint and show grams-per-joint.
 *
 * It REUSES the flower tool's proven engine (price/THC/lineage parsing, the live
 * Leafly sativa-lean lookup, deal verification, filtering, ranking, and the
 * Dutchie browser plumbing) by requiring ./weed-value-finder.js — so the two
 * stay in lockstep and there's one source of truth for the hard parts.
 *
 * Usage (mirrors the flower tool):
 *   node preroll-value-finder.js                      # all seeded dispos, headed
 *   node preroll-value-finder.js --headless
 *   node preroll-value-finder.js --min-thc 27
 *   node preroll-value-finder.js --max-ppg 12         # cap $/gram
 *   node preroll-value-finder.js --include-hybrid     # also coarse hybrids
 *   node preroll-value-finder.js --infused-only       # only infused prerolls
 *   node preroll-value-finder.js --no-infused         # exclude infused prerolls
 *   node preroll-value-finder.js --sort perjoint      # rank by $/joint instead of $/g
 *   node preroll-value-finder.js --only earths-healing-south,green-halo
 *   node preroll-value-finder.js --json preroll-scraped.json
 *   node preroll-value-finder.js --selftest           # math checks, no browser
 *
 * JARS locks its menu to your IP location, same as flower, so JARS pre-rolls are
 * hand-entered via prerolls-manual.json and merged by build-preroll-report.js.
 */

'use strict';

const fs = require('fs');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* only needed for live runs */ }

// Reuse the flower tool's engine + plumbing — one source of truth for the hard parts.
const m = require('./weed-value-finder.js');

// ---------------------------------------------------------------------------
// Pre-roll specifics: pack count + infusion
// ---------------------------------------------------------------------------

// How many individual joints are in this listing. Reads "5PK", "10 PK",
// "5-PACK", "PACK OF 5", "7X0.5G", "5CT" out of the product name / weight text.
// Defaults to 1 (a single pre-roll). Deliberately does NOT treat promo copy like
// "2 For $30" as a count — only true pack tokens.
function parsePackCount(text) {
  if (!text) return 1;
  const t = String(text);
  let mm = t.match(/(\d+)\s*(?:pk|pack|packs|-\s*pack|ct|count)\b/i);
  if (mm) return Number(mm[1]);
  mm = t.match(/pack of\s*(\d+)/i);
  if (mm) return Number(mm[1]);
  mm = t.match(/\b(\d+)\s*x\s*\d/i); // "7 x 0.5g", "5x1g"
  if (mm) return Number(mm[1]);
  return 1;
}

// Is this an infused pre-roll (kief / diamonds / hash / "infused")? Infused
// prerolls run much higher THC and $/g, so it's worth flagging + filterable.
function isInfused(text) {
  return /\b(infused|infusion|diamond|kief|hash|hthc|liquid diamond|caviar|moon ?rock)\b/i.test(String(text || ''));
}

// Turn one raw Dutchie card into a normalized pre-roll record. Delegates ALL the
// hard normalization (prices, THC, grams, lineage bucket, deal verification) to
// the flower engine, then layers on pack count + per-joint math + infusion.
function toPrerollRecord(raw) {
  const rec = m.normalizeListing(raw); // grams here = the pack's TOTAL grams
  const nameBlob = `${raw.name || ''} ${raw.weightText || ''} ${raw.blob || ''}`;
  rec.count = parsePackCount(nameBlob);
  rec.infused = isInfused(nameBlob);
  rec.perJointGrams = rec.grams != null && rec.count ? rec.grams / rec.count : null;
  rec.pricePerJoint = rec.charged != null && rec.count ? rec.charged / rec.count : null;
  return rec;
}

// ---------------------------------------------------------------------------
// Arg parsing (superset of the flower flags, plus preroll-specific ones)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  const has = (name) => args.includes(`--${name}`);
  return {
    minThc: Number(get('min-thc', 35)), // prerolls skew infused (40–50%); higher floor than flower
    maxPpg: get('max-ppg') != null ? Number(get('max-ppg')) : null,
    includeHybrid: has('include-hybrid'),
    strictLineage: has('strict-lineage'),
    noStrainLookup: has('no-strain-lookup'),
    infusedOnly: has('infused-only'),
    noInfused: has('no-infused'),
    sort: (get('sort') || 'ppg').toLowerCase(), // 'ppg' | 'perjoint'
    includeVerify: has('include-unverified-slugs') || Boolean(get('only')),
    preferSativa: has('prefer-sativa'),
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
// Pre-roll-aware filter + rank (wraps the flower engine's filter/rank)
// ---------------------------------------------------------------------------

function applyPrerollFilters(records, opts) {
  // Infusion gate first (preroll-specific), then hand off to the shared engine.
  let pool = records;
  const dropped = [];
  if (opts.infusedOnly) {
    pool = pool.filter((r) => r.infused || dropped.push({ r, reason: 'not infused' }) && false);
  } else if (opts.noInfused) {
    pool = pool.filter((r) => !r.infused || dropped.push({ r, reason: 'infused (excluded)' }) && false);
  }
  const res = m.applyFilters(pool, opts);
  return { kept: res.kept, dropped: dropped.concat(res.dropped) };
}

// Rank by $/gram (default) or $/joint. Reuse the engine's rank for $/g so
// prefer-sativa + THC tiebreak behavior stays identical; do $/joint locally.
function rankPrerolls(list, opts) {
  if (opts.sort === 'perjoint') {
    return [...list].sort((a, b) => {
      if (opts.preferSativa && m.BUCKET_RANK[a.strainBucket] !== m.BUCKET_RANK[b.strainBucket]) {
        return m.BUCKET_RANK[a.strainBucket] - m.BUCKET_RANK[b.strainBucket];
      }
      const av = a.pricePerJoint ?? Infinity, bv = b.pricePerJoint ?? Infinity;
      if (av !== bv) return av - bv;
      return (b.thc ?? 0) - (a.thc ?? 0);
    });
  }
  return m.rankListings(list, opts.preferSativa);
}

// ---------------------------------------------------------------------------
// Dutchie pre-roll scrape (reuses the flower tool's browser plumbing + harvester)
// ---------------------------------------------------------------------------

async function scrapePrerolls(context, disp, opts) {
  const menuType = disp.menuType || 'rec';
  const url = `https://dutchie.com/embedded-menu/${disp.slug}/products/pre-rolls?menuType=${menuType}`;
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
      console.log(`   no pre-roll cards found${bad ? ' (menu says not-found — slug likely wrong)' : ''} — skipping`);
      await page.close();
      return [];
    }
    const cards = await page.evaluate(m.DUTCHIE_HARVEST);
    console.log(`   harvested ${cards.length} card(s)`);
    await page.close();
    return cards.slice(0, opts.maxPerStore).map((c) =>
      toPrerollRecord({ dispensary: disp.name, dispensaryId: disp.id, ...c })
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

const money = (n) => (n == null ? '   —  ' : `$${n.toFixed(2)}`);

function printTable(ranked, dropped, opts) {
  console.log(`\n${'='.repeat(104)}`);
  console.log(
    `BEST VALUE PRE-ROLLS — THC ≥ ${opts.minThc}%, sativa${opts.includeHybrid ? ' / sativa-hybrid / hybrid' : ' & sativa-dominant hybrid'} only` +
    `${opts.infusedOnly ? '  ·  INFUSED only' : opts.noInfused ? '  ·  no infused' : ''}`
  );
  console.log(`ranked by REAL ${opts.sort === 'perjoint' ? 'price per joint' : 'price per gram'}`);
  console.log('='.repeat(104));

  if (!ranked.length) {
    console.log('\nNothing qualified. Loosen with --min-thc, --max-ppg, or --include-hybrid.');
  } else {
    console.log(
      `\n${'$/g'.padEnd(7)}${'$/jt'.padEnd(8)}${'PACK'.padEnd(6)}${'PRICE'.padEnd(9)}${'WT'.padEnd(8)}${'THC'.padEnd(8)}${'INF'.padEnd(5)}${'LINEAGE'.padEnd(15)}${'DEAL'.padEnd(12)}${'DISPENSARY'.padEnd(18)}PRODUCT`
    );
    console.log('-'.repeat(104));
    for (const r of ranked) {
      const deal =
        r.dealReal === true ? `✓ ${r.discountPct}% off` :
        r.dealReal === false ? '⚠ unverified' :
        r.discountPct != null ? `${r.discountPct}% off` : '';
      const mark = r.inferred ? '≈' : (r.strainBucket === 'sativa' ? '★' : ' ');
      const pack = r.count > 1 ? `${r.count}pk` : '1';
      console.log(
        `${mark}${('$' + (r.pricePerGram ?? 0).toFixed(2)).padEnd(6)}` +
          `${money(r.pricePerJoint).padEnd(8)}${pack.padEnd(6)}${money(r.charged).padEnd(9)}${(r.weightLabel || '?').padEnd(8)}` +
          `${(r.thc != null ? r.thc + '%' : '?').padEnd(8)}${(r.infused ? 'inf' : '').padEnd(5)}${(r.strainLabel || '').slice(0, 14).padEnd(15)}${deal.padEnd(12)}` +
          `${(r.dispensary || '').slice(0, 17).padEnd(18)}${r.brand ? r.brand + ' — ' : ''}${r.name}`
      );
    }

    const best = ranked[0];
    const bestSativa = ranked.find((r) => r.strainBucket === 'sativa');
    console.log(`\n${'─'.repeat(104)}`);
    console.log(`BEST VALUE:  $${best.pricePerGram.toFixed(2)}/g · ${money(best.pricePerJoint)}/joint — ${best.name} @ ${best.dispensary}`);
    console.log(`             ${money(best.charged)} / ${best.count > 1 ? best.count + ' joints · ' : ''}${best.weightLabel} · ${best.thc}% · ${best.strainLabel}${best.infused ? ' · infused' : ''}`);
    if (best.url) console.log(`             ${best.url}`);
    if (bestSativa && bestSativa !== best) {
      console.log(`BEST SATIVA: $${bestSativa.pricePerGram.toFixed(2)}/g · ${money(bestSativa.pricePerJoint)}/joint — ${bestSativa.name} @ ${bestSativa.dispensary}`);
      if (bestSativa.url) console.log(`             ${bestSativa.url}`);
    }
    console.log(`\n★ = pure sativa   ≈ = lineage inferred   ✓ = deal verified vs struck MSRP   ⚠ = could NOT verify   inf = infused`);
  }

  const notable = dropped.filter((d) => /THC .* <|not sativa|infused/.test(d.reason)).slice(0, 8);
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
  const cols = ['pricePerGram', 'pricePerJoint', 'count', 'perJointGrams', 'infused', 'charged', 'original', 'discountPct', 'dealReal', 'grams', 'weightLabel', 'thc', 'strainLabel', 'dispensary', 'brand', 'name', 'url'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(p, [cols.join(',')].concat(ranked.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n'));
  console.log(`Wrote CSV  -> ${p}`);
}

// ---------------------------------------------------------------------------
// Self-test (no browser): pack math + infusion + reuse of the flower engine
// ---------------------------------------------------------------------------

function selftest() {
  const approx = (a, b, t = 0.01) => Math.abs(a - b) <= t;
  let pass = 0, total = 0;
  const check = (name, cond, got) => { total++; console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `   got: ${got}`}`); if (cond) pass++; };

  // pack count parsing
  check('5PK -> 5', parsePackCount('ANTHEM PRE-ROLLS ROCKET GLARE 5PK') === 5);
  check('10PK -> 10', parsePackCount('SATIVA BLEND 10PK') === 10);
  check('single -> 1', parsePackCount('ANTHEM STRAWBERRY COUGH PREROLL') === 1);
  check('"Pack of 3" -> 3', parsePackCount('Sunny Days Pack of 3') === 3);
  check('"7 x 0.5g" -> 7', parsePackCount('Blend 7 x 0.5g') === 7);
  check('"2 For $30" is NOT a count', parsePackCount('Anthem Infused 1G 2 For $30') === 1);
  check('5-pack hyphen -> 5', parsePackCount('Baby Jeeter 5-pack') === 5);

  // infusion detection
  check('infused flagged', isInfused('ANTHEM INFUSED BERRY GELATO PREROLL') === true);
  check('diamond flagged', isInfused('Baby Jeeter Liquid Diamond Caviar') === true);
  check('plain not infused', isInfused('Timeless Blue Dream Preroll') === false);

  // 5-pack infused: Dutchie gives TOTAL grams in the add-to-cart weight (2.5g)
  const p5 = toPrerollRecord({
    dispensary: 'T', brand: 'Anthem', name: 'ANTHEM INFUSED PRE-ROLLS ROCKET GLARE 5PK',
    weightText: '2.5g', priceText: '$35.28 | $58.80', strainText: 'Sativa', thcText: 'THC: 41.96%',
    blob: 'ANTHEM INFUSED PRE-ROLLS ROCKET GLARE 5PK | Anthem | Sativa | THC: 41.96% | 2.5g | $35.28 | $58.80 | 40% off',
  });
  check('5pk count', p5.count === 5, p5.count);
  check('5pk total grams 2.5', p5.grams === 2.5, p5.grams);
  check('5pk per-joint grams 0.5', approx(p5.perJointGrams, 0.5), p5.perJointGrams);
  check('5pk $/g = 35.28/2.5', approx(p5.pricePerGram, 35.28 / 2.5), p5.pricePerGram);
  check('5pk $/joint = 35.28/5', approx(p5.pricePerJoint, 35.28 / 5), p5.pricePerJoint);
  check('5pk infused', p5.infused === true);
  check('5pk deal verified 40%', p5.dealReal === true && p5.discountPct === 40, `${p5.dealReal}/${p5.discountPct}`);

  // 10-pack blend priced as 1/8 oz total (=3.5g), THC 22% -> dropped by THC floor
  const p10 = toPrerollRecord({
    dispensary: 'T', brand: 'Anthem', name: 'ANTHEM PRE-ROLLS SATIVA BLEND 10PK',
    weightText: '1/8 oz', priceText: '$25.20 | $42.00', strainText: 'Sativa', thcText: 'THC: 22.58%',
    blob: 'ANTHEM PRE-ROLLS SATIVA BLEND 10PK | Anthem | Sativa | THC: 22.58% | 1/8 oz | $25.20 | $42.00 | 40% off',
  });
  check('10pk total grams 3.5', p10.grams === 3.5, p10.grams);
  check('10pk per-joint grams 0.35', approx(p10.perJointGrams, 0.35), p10.perJointGrams);
  const f10 = applyPrerollFilters([p10], { minThc: 27, includeHybrid: false });
  check('10pk dropped by THC floor', f10.kept.length === 0 && /THC/.test(f10.dropped[0].reason), JSON.stringify(f10.dropped.map((d) => d.reason)));

  // single infused sativa, passes THC, per-joint == total
  const s1 = toPrerollRecord({
    dispensary: 'T', brand: 'Anthem', name: 'ANTHEM INFUSED STRAWBERRY COUGH PREROLL',
    weightText: '1g', priceText: '$17.64 | $29.40', strainText: 'Sativa', thcText: 'THC: 43%',
    blob: 'ANTHEM INFUSED STRAWBERRY COUGH PREROLL | Anthem | Sativa | THC: 43% | 1g | $17.64 | $29.40 | 40% off',
  });
  check('single count 1', s1.count === 1);
  check('single $/joint == $/g', approx(s1.pricePerJoint, s1.pricePerGram), `${s1.pricePerJoint}/${s1.pricePerGram}`);
  const kept = applyPrerollFilters([s1], { minThc: 27, includeHybrid: false }).kept;
  check('single infused sativa passes filter', kept.length === 1);

  // infused-only / no-infused gates
  const mix = [s1, toPrerollRecord({ dispensary: 'T', name: 'Plain Sativa PR', weightText: '1g', priceText: '$10', strainText: 'Sativa', thcText: 'THC: 30%', blob: 'Plain Sativa PR | Sativa | THC: 30% | 1g | $10' })];
  check('--infused-only keeps only infused', applyPrerollFilters(mix, { minThc: 27, infusedOnly: true }).kept.length === 1);
  check('--no-infused drops infused', applyPrerollFilters(mix, { minThc: 27, noInfused: true }).kept.every((r) => !r.infused));

  // ranking by $/joint vs $/g can differ (big pack cheap per joint, higher per g)
  const rk = rankPrerolls(mix, { sort: 'perjoint' });
  check('perjoint sort orders by $/joint', rk[0].pricePerJoint <= rk[1].pricePerJoint);

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadDispensaries(opts) {
  // Reuse the flower tool's dispensary list; only the Dutchie stores carry a
  // pre-roll category. JARS is geo-locked (hand-entered via prerolls-manual.json).
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
    console.error('(You can still run the math checks with:  node preroll-value-finder.js --selftest)');
    process.exit(1);
  }

  const dispensaries = loadDispensaries(opts);
  if (!dispensaries.length) { console.error('No dispensaries selected.'); process.exit(1); }

  console.log(`Pre-roll value finder — THC ≥ ${opts.minThc}%, ${opts.includeHybrid ? 'sativa + coarse hybrids' : 'sativa & sativa-dominant hybrids'}${opts.infusedOnly ? ', infused only' : opts.noInfused ? ', no infused' : ''}`);
  console.log(`Dispensaries (${dispensaries.length}): ${dispensaries.map((d) => d.name).join(', ')}`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await m.makeContext(browser);

  let all = [];
  for (const disp of dispensaries) {
    const rows = await scrapePrerolls(context, disp, opts);
    all = all.concat(rows);
    await new Promise((res) => setTimeout(res, 900 + Math.random() * 1200));
  }
  await browser.close();

  console.log(`\nParsed ${all.length} total pre-roll listing(s) across ${dispensaries.length} store(s).`);
  if (!opts.strictLineage) {
    if (!opts.noStrainLookup) await m.resolveLeanViaLeafly(all, { log: (msg) => console.log(msg) });
    all.forEach(m.applyLeanInference);
    const n = all.filter((r) => r.inferred).length;
    console.log(`Total sativa-leaning listings rescued from hybrid/unknown: ${n} (≈). Use --strict-lineage for menu labels only.`);
  }
  const { kept, dropped } = applyPrerollFilters(all, opts);
  const ranked = rankPrerolls(kept, opts);

  printTable(ranked, dropped, opts);
  if (opts.jsonOut) writeJson(opts.jsonOut, ranked, dropped, opts);
  if (opts.csvOut) writeCsv(opts.csvOut, ranked);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parsePackCount, isInfused, toPrerollRecord, applyPrerollFilters, rankPrerolls };
