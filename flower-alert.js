/**
 * flower-alert.js — after the daily merge, check the cheapest qualifying pick
 * against the $/oz alert threshold and flag NEW better-than-threshold deals.
 *
 * Threshold: ALERT_MAX_PER_OZ (default $88/oz — set 2026-08-19 to beat the
 * then-current Sol Flower leader at exactly $88.00/oz). "Better" = strictly less.
 *
 * Writes flower-alert.json {alert, isNew, oz, ppg, thc, name, dispensary, url}
 * for flower-daily.ps1 to raise a Windows toast on `isNew`. Also appends an
 * ALERT line to flower-daily.log and drops FLOWER-DEAL-ALERT.txt on isNew.
 * State in flower-alert-state.json prevents re-alerting the same deal daily.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const ALERT_MAX_PER_OZ = Number(process.env.ALERT_MAX_PER_OZ || 88);

const results = JSON.parse(fs.readFileSync(path.join(DIR, 'weed-results-merged.json'), 'utf8')).results || [];
if (!results.length) { console.log('flower-alert: no results'); process.exit(0); }

const best = results.reduce((a, r) => (r.pricePerGram < a.pricePerGram ? r : a));
const oz = +(best.pricePerGram * 28).toFixed(2);
const alert = oz < ALERT_MAX_PER_OZ; // strictly better than the threshold
const sig = `${best.name}|${best.dispensary}|${best.pricePerGram.toFixed(4)}`;

const STATE = path.join(DIR, 'flower-alert-state.json');
let state = {}; try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
const isNew = alert && state.lastSig !== sig; // new/changed deal under the bar

const out = {
  alert, isNew, threshold: ALERT_MAX_PER_OZ, oz,
  ppg: +best.pricePerGram.toFixed(2), thc: best.thc,
  name: best.name, dispensary: best.dispensary, url: best.url || '',
  checkedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(DIR, 'flower-alert.json'), JSON.stringify(out, null, 2));

if (isNew) {
  const line = `[${new Date().toISOString()}] 🔥 ALERT — new deal under $${ALERT_MAX_PER_OZ}/oz: $${oz}/oz ($${out.ppg}/g, ${best.thc}%) ${best.name} @ ${best.dispensary}`;
  fs.appendFileSync(path.join(DIR, 'flower-daily.log'), '\n' + line + '\n');
  fs.writeFileSync(path.join(DIR, 'FLOWER-DEAL-ALERT.txt'),
    `BETTER-THAN-$${ALERT_MAX_PER_OZ}/OZ DEAL\n\n$${oz}/oz  ($${out.ppg}/g)  ${best.thc}% THC\n${best.name}\n${best.dispensary}\n${best.url || ''}\n\nfound ${new Date().toLocaleString()}\n`);
  fs.writeFileSync(STATE, JSON.stringify({ lastSig: sig, lastOz: oz, at: out.checkedAt }, null, 2));
  console.log(line);
} else {
  console.log(`flower-alert: best $${oz}/oz — ${alert ? 'under bar but already alerted' : 'not under $' + ALERT_MAX_PER_OZ + '/oz'} (no new alert)`);
}
