/**
 * merge-strainpicker.js — build weed-results-merged.json (what the cards, the
 * alert and the archive read) from the finder's weed-results.json.
 *
 * JARS now arrives INSIDE weed-results.json: the finder reads each JARS store
 * from the storefront's API (jars-api.js). So normally this step just passes the
 * board through.
 *
 * It only merges anything when the API failed for a JARS store and
 * run-flower-daily.js fell back to the Playwright scrape (jars-pull-cdp.js →
 * jars-<store>-lists.json). Two rules for that fallback:
 *   - a store the finder already covered is never merged again (no duplicates);
 *   - a lists file is merged only if it was harvested recently (JARS_MAX_AGE_H,
 *     default 3 h). A stale file is refused, loudly — an old JARS menu must
 *     never be passed off as today's.
 */
'use strict';
const fs = require('fs');
const m = require('./weed-value-finder.js');

const MAX_AGE_H = Number(process.env.JARS_MAX_AGE_H || 3);
const FALLBACK = [
  { id: 'jars-east-tucson', file: 'jars-east-tucson-lists.json', label: 'JARS - East Tucson' },
  { id: 'jars-green-valley', file: 'jars-green-valley-lists.json', label: 'JARS - Green Valley' },
];

(async () => {
  const base = JSON.parse(fs.readFileSync('weed-results.json', 'utf8'));
  const opts = base.opts;
  const coverage = Array.isArray(base.coverage) ? base.coverage.map((c) => ({ ...c })) : [];
  let added = [];

  for (const { id, file, label } of FALLBACK) {
    const cov = coverage.find((c) => c.id === id);
    if (cov && cov.ok) continue; // read live via the API this run — nothing to merge
    let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { console.log(`${label}: not covered by the API and no ${file} to fall back on — NOT on the board`); continue; }
    const ageH = (Date.now() - Date.parse(d.harvestedAt || 0)) / 36e5;
    if (!(ageH <= MAX_AGE_H)) {
      console.log(`⚠ ${label}: ${file} is ${Number.isFinite(ageH) ? ageH.toFixed(1) + ' h' : 'of unknown age'} old (limit ${MAX_AGE_H} h) — REFUSING to merge stale JARS data. ${label} is NOT on the board.`);
      continue;
    }
    const nameFromUrl = (u) => { const s = (u || '').split('/product/')[1] || ''; return s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim(); };
    const junkName = (n) => !n || /^\d+\+?$/.test(String(n).trim()) || String(n).trim().length < 4;
    const recs = (d.flower || []).map((r) => ({ ...r, dispensary: label, dispensaryId: id, jars: true, name: (junkName(r.name) && r.url) ? nameFromUrl(r.url) : r.name }));
    if (recs.length) { try { await m.resolveLeanViaLeafly(recs, { log: () => {} }); } catch (_) { /* dictionary fallback below */ } }
    recs.forEach(m.applyLeanInference);
    const kept = m.applyFilters(recs, opts).kept;
    console.log(`${label}: merged from the Playwright fallback (${ageH.toFixed(1)} h old) — ${recs.length} flower -> ${kept.length} qualify`);
    added = added.concat(kept);
    const entry = { id, name: label, platform: 'jars', ok: recs.length > 0, menu: 'med', source: 'playwright', listings: recs.length, qualified: kept.length, error: recs.length ? null : 'fallback scrape returned nothing' };
    if (cov) Object.assign(cov, entry); else coverage.push(entry);
  }

  const ranked = m.rankListings(base.results.concat(added), false);
  fs.writeFileSync('weed-results-merged.json', JSON.stringify({ ...base, count: ranked.length, coverage, results: ranked, jarsAdded: added.length }, null, 2));

  const jarsRows = ranked.filter((r) => r.jars || /jars/i.test(r.dispensary || '')).length;
  console.log(`\nBoard: ${ranked.length} picks (${jarsRows} from JARS${added.length ? `, ${added.length} via fallback` : ''})`);
  const notRead = coverage.filter((c) => !c.ok);
  if (notRead.length) console.log(`⚠ NOT read this run: ${notRead.map((c) => c.name).join(', ')}`);
  ranked.slice(0, 6).forEach((r, i) => console.log('  #' + (i + 1) + '  $' + r.pricePerGram.toFixed(2) + '/g  ' + r.thc + '%  ' + r.dispensary.split('(')[0].trim() + ' — ' + r.name));
})().catch((e) => { console.error('merge ERR', e.message); process.exit(1); });
