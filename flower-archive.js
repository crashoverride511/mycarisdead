/**
 * flower-archive.js — append the day's flower board to a growing history so we
 * can later analyze which days/stores drop the best deals. Runs as the last step
 * of run-flower-daily.js (after the board is built).
 *
 * Writes:
 *   history/YYYY-MM-DD.json   compact snapshot of that day's ranked qualifiers
 *   deal-history.csv          one row per day (best pick + board stats), keyed
 *                             by date and UPSERTed so re-runs update, not dup.
 *
 * Date is America/Phoenix (MST, no DST = UTC-7) to match the artifact timestamp.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const HIST = path.join(DIR, 'history');
const CSV = path.join(DIR, 'deal-history.csv');

const mstDate = (d = new Date()) => new Date(d.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 10);

const COLS = ['date', 'storesWithPicks', 'totalPicks', 'bestPPG', 'bestOZ', 'bestTHC', 'bestMenu', 'bestStore', 'bestProduct', 'under88', 'jarsET', 'jarsGV', 'source'];
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function upsertCsv(row) {
  let lines = [];
  if (fs.existsSync(CSV)) lines = fs.readFileSync(CSV, 'utf8').split('\n').filter(Boolean);
  const header = COLS.join(',');
  const body = lines.slice(1).filter((l) => {
    const d = (l.match(/^"([^"]*)"/) || [])[1];
    return d && d !== row.date; // drop any existing row for this date
  });
  body.push(COLS.map((c) => esc(row[c])).join(','));
  // sort by date ascending
  body.sort((a, b) => ((a.match(/^"([^"]*)"/) || [])[1] > (b.match(/^"([^"]*)"/) || [])[1] ? 1 : -1));
  fs.writeFileSync(CSV, [header, ...body].join('\n') + '\n');
}

function rowFrom(results, date, source) {
  const q = results.filter((r) => r.pricePerGram != null);
  const best = q.reduce((a, r) => (r.pricePerGram < a.pricePerGram ? r : a), q[0]);
  const stores = new Set(q.map((r) => r.dispensary));
  const bestOZ = +(best.pricePerGram * 28).toFixed(2);
  return {
    date,
    storesWithPicks: stores.size,
    totalPicks: q.length,
    bestPPG: best.pricePerGram.toFixed(2),
    bestOZ,
    bestTHC: best.thc,
    bestMenu: /·\s*rec/i.test(best.dispensary) ? 'rec' : 'med',
    bestStore: best.dispensary,
    bestProduct: best.name,
    under88: bestOZ < 88 ? 'yes' : 'no',
    jarsET: q.filter((r) => /east tucson/i.test(r.dispensary)).length,
    jarsGV: q.filter((r) => /green valley/i.test(r.dispensary)).length,
    source,
  };
}

function main() {
  if (!fs.existsSync(HIST)) fs.mkdirSync(HIST);
  const merged = JSON.parse(fs.readFileSync(path.join(DIR, 'weed-results-merged.json'), 'utf8'));
  const date = mstDate();
  const results = merged.results || [];

  // compact daily snapshot
  const snap = results.map((r) => ({ ppg: +r.pricePerGram?.toFixed(2), oz: +(r.pricePerGram * 28).toFixed(0), thc: r.thc, name: r.name, dispensary: r.dispensary, jars: !!r.jars, deal: r.dealReal === true ? r.discountPct : null, url: r.url || '' }));
  fs.writeFileSync(path.join(HIST, `${date}.json`), JSON.stringify({ date, generatedAt: new Date().toISOString(), count: snap.length, results: snap }, null, 0));

  const row = rowFrom(results, date, 'live');
  upsertCsv(row);
  console.log(`archived ${date}: ${row.totalPicks} picks, best $${row.bestPPG}/g ($${row.bestOZ}/oz) ${row.bestProduct} @ ${row.bestStore}`);

  // one-time backfill of reconstructed historical bests (from run-logs/alerts),
  // only if not already present. Clearly marked source=reconstructed.
  if (process.env.BACKFILL === '1') {
    const seeds = [
      { date: '2026-08-19', storesWithPicks: '', totalPicks: '', bestPPG: '3.14', bestOZ: 88, bestTHC: 28.9, bestMenu: 'rec', bestStore: 'Sol Flower (South Tucson) · rec', bestProduct: 'Cali Orange X Gorilla Biscuit Most Wanted Flower', under88: 'no', jarsET: '', jarsGV: '', source: 'reconstructed' },
      { date: '2026-08-23', storesWithPicks: '', totalPicks: '', bestPPG: '2.86', bestOZ: 80, bestTHC: 36.06, bestMenu: 'med', bestStore: 'JARS - East Tucson', bestProduct: 'Fleur 1/2 Supercharged Trainwreck (stock unconfirmed)', under88: 'yes', jarsET: '', jarsGV: '', source: 'reconstructed' },
    ];
    for (const s of seeds) upsertCsv(s);
    console.log('backfilled reconstructed rows: 2026-08-19, 2026-08-23');
  }
}
main();
