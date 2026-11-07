/**
 * distance.js
 * -------------------------------------------------------------------------
 * Drive distance from HOME to each dispensary, so the report can tell a deal
 * on your normal run apart from one that's a 20-minute detour.
 *
 * Home lives in home.json (gitignored — this repo is public). Copy
 * home.example.json to home.json and set your own point:
 *   { "label": "Home", "lat": 32.1, "lng": -110.9,
 *     "nearMinutes": 15,   // stores within this drive time = your normal run
 *     "farPremium": 1.00 } // a farther store must beat your best nearby $/g
 *                          // by at least this many $/g to be "worth the drive"
 * No home.json -> the report works exactly as before (no distance features).
 *
 * Drive times come from the public OSRM router (OpenStreetMap data,
 * no traffic — real times run a bit longer) and are cached in
 * distance-cache.json. If OSRM is unreachable we fall back to straight-line
 * miles x 1.3 at ~30 mph and mark them approximate (~).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HOME_PATH = path.join(__dirname, 'home.json');
const CACHE_PATH = path.join(__dirname, 'distance-cache.json');
const OSRM = 'https://router.project-osrm.org/table/v1/driving/';
const M_PER_MI = 1609.344;

function loadHome(p = HOME_PATH) {
  let h;
  try { h = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
  if (typeof h.lat !== 'number' || typeof h.lng !== 'number') return null;
  return {
    label: h.label || 'Home',
    lat: h.lat,
    lng: h.lng,
    nearMinutes: typeof h.nearMinutes === 'number' ? h.nearMinutes : 15,
    farPremium: typeof h.farPremium === 'number' ? h.farPremium : 1.0,
  };
}

function haversineMiles(a, b) {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const cacheKey = (home, s) => `${home.lat},${home.lng}|${s.lat},${s.lng}`;

// Returns { [storeId]: { miles, minutes, approx } } for every store with coords.
async function storeDrives(home, stores, { cachePath = CACHE_PATH, fetchImpl = globalThis.fetch } = {}) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) { /* first run */ }
  const located = stores.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  const missing = located.filter((s) => !cache[cacheKey(home, s)] || cache[cacheKey(home, s)].approx);

  if (missing.length && fetchImpl) {
    const coords = [home, ...missing].map((p) => `${p.lng},${p.lat}`).join(';');
    try {
      const res = await fetchImpl(`${OSRM}${coords}?sources=0&annotations=distance,duration`, {
        headers: { 'User-Agent': 'weed-value-finder (personal script)' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      });
      const j = await res.json();
      if (j.code !== 'Ok') throw new Error(j.code || 'OSRM error');
      missing.forEach((s, i) => {
        const dist = j.distances[0][i + 1], dur = j.durations[0][i + 1];
        if (dist != null && dur != null) {
          cache[cacheKey(home, s)] = { miles: +(dist / M_PER_MI).toFixed(1), minutes: Math.round(dur / 60), approx: false };
        }
      });
      try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 1)); } catch (_) { /* best effort */ }
    } catch (e) {
      console.log(`   (drive times: router unreachable — ${e.message}; using straight-line estimates)`);
    }
  }

  const out = {};
  for (const s of located) {
    const hit = cache[cacheKey(home, s)];
    if (hit && !hit.approx) { out[s.id] = hit; continue; }
    const miles = haversineMiles(home, s) * 1.3;
    out[s.id] = { miles: +miles.toFixed(1), minutes: Math.round((miles / 30) * 60), approx: true };
  }
  return out;
}

// Tag each record with its store's drive, then decide near / far /
// worth-the-drive. `ranked` should already be sorted by $/g.
// Mutates records: miles, driveMin, driveApprox, near, worthDrive, savesPerGram.
// Returns { nearBest, worth, farHidden, nearMinutes, farPremium }.
function applyDistance(ranked, drives, home) {
  for (const r of ranked) {
    const d = drives[r.dispensaryId];
    r.miles = d ? d.miles : null;
    r.driveMin = d ? d.minutes : null;
    r.driveApprox = d ? d.approx : null;
    // Unknown location -> treat as near so it's never silently hidden.
    r.near = d ? d.minutes <= home.nearMinutes : true;
  }
  const nearBest = ranked.filter((r) => r.near && r.pricePerGram != null)
    .reduce((b, r) => (!b || r.pricePerGram < b.pricePerGram ? r : b), null);
  const worth = [], farHidden = [];
  for (const r of ranked) {
    r.worthDrive = false;
    r.savesPerGram = null;
    if (r.near) continue;
    const saves = nearBest ? nearBest.pricePerGram - r.pricePerGram : Infinity;
    if (saves >= home.farPremium) {
      r.worthDrive = true;
      r.savesPerGram = Number.isFinite(saves) ? +saves.toFixed(2) : null;
      worth.push(r);
    } else {
      farHidden.push(r);
    }
  }
  return { nearBest, worth, farHidden, nearMinutes: home.nearMinutes, farPremium: home.farPremium };
}

module.exports = { loadHome, storeDrives, applyDistance, haversineMiles, HOME_PATH };

// node distance.js --selftest   (offline; no router calls)
if (require.main === module && process.argv.includes('--selftest')) {
  let pass = 0, total = 0;
  const check = (name, cond, got) => { total++; if (cond) pass++; console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `   got: ${got}`}`); };
  const home = { label: 'H', lat: 32.2226, lng: -110.9747, nearMinutes: 15, farPremium: 1 }; // generic downtown Tucson point
  const drives = { near: { miles: 1.6, minutes: 3, approx: false }, far: { miles: 10.8, minutes: 20, approx: false } };
  const mk = (id, ppg) => ({ dispensaryId: id, pricePerGram: ppg });
  let rs = [mk('far', 1.79), mk('near', 2.23), mk('far', 5)];
  let g = applyDistance(rs, drives, home);
  check('near store flagged near', rs[1].near === true && rs[0].near === false);
  check('nearBest = cheapest nearby', g.nearBest === rs[1]);
  check('far $0.44/g cheaper is NOT worth the drive', !rs[0].worthDrive && g.worth.length === 0, rs[0].savesPerGram);
  rs = [mk('far', 1.0), mk('near', 2.23)];
  g = applyDistance(rs, drives, home);
  check('far $1.23/g cheaper IS worth the drive', rs[0].worthDrive && rs[0].savesPerGram === 1.23, rs[0].savesPerGram);
  rs = [mk('unknown-store', 3)];
  applyDistance(rs, drives, home);
  check('store with no location is never hidden', rs[0].near === true);
  const sl = haversineMiles(home, { lat: 32.2200686, lng: -110.8418342 });
  check('haversine downtown->Saints ~7.8 mi', sl > 7 && sl < 8.5, sl);
  console.log(`\n${pass}/${total} passed`);
  if (pass !== total) process.exitCode = 1;
}
