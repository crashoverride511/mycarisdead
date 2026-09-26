/**
 * weed-value-finder.js
 * -------------------------------------------------------------------------
 * A Playwright menu scraper that finds the best-VALUE flower across Tucson /
 * Green Valley dispensaries, normalized to $ per gram, and filtered to the
 * strains you actually want:
 *
 *   - THC >= 27%            (hard cutoff; anything with unknown THC is dropped)
 *   - Sativa or sativa-dominant hybrid ONLY  (pure sativa preferred / surfaced)
 *   - ranked by REAL price per gram (what you actually pay, not the % "deal")
 *
 * Why this tool exists
 * --------------------
 * Dispensary menus lie with math. A "50% OFF" sticker on an inflated MSRP can
 * be a worse $/g than a plain-priced jar next to it, and eighths vs. half-oz
 * vs. 14.17g "prepacks" are impossible to compare by sticker. So the tool:
 *   1. Normalizes every listing to $/gram using the price you're actually
 *      charged (the sale/checkout price), converting oz fractions to grams
 *      (1/8 oz = 3.5g, 1/4 = 7g, 1/2 = 14g, 1 oz = 28g).
 *   2. Ranks by that real $/g, so a genuine cheap jar beats a fake "deal".
 *   3. Verifies each advertised deal: recomputes the discount from
 *      sale-vs-original and flags listings where the "discount" has no real
 *      struck price behind it, or where the math doesn't match the sticker.
 *
 * Strain lineage
 * --------------
 * Menus disagree on granularity:
 *   - JARS exposes SATIVA / SATIVA_HYBRID / HYBRID / INDICA_HYBRID / INDICA.
 *   - Dutchie embedded menus only expose coarse Sativa / Hybrid / Indica.
 * So a plain "Hybrid" on a Dutchie menu has an UNKNOWN lean — we can't tell if
 * it's sativa-dom. By default those are excluded (you asked for at least a
 * sativa-dom hybrid). Pass --include-hybrid to also see coarse hybrids, clearly
 * flagged "(lean unknown)". Pure sativa and sativa-dominant hybrids always pass.
 *
 * Coverage — "all Tucson dispos"
 * ------------------------------
 * Most Tucson dispensaries run Dutchie embedded menus, so the generic `dutchie`
 * adapter covers them by slug. The dispensary list lives in DISPENSARIES below
 * (or an external --config JSON). JARS uses a custom storefront over Dutchie's
 * API, handled by the `jars` adapter's click-through flow. Any dispensary whose
 * menu fails to load is logged and skipped rather than killing the run.
 *
 * Setup (same toolchain as turf-searcher.js / amazon-coupon-finder.js):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Sativa-lean inference (default ON): for anything the menu labels only "Hybrid"
 * or leaves blank, the tool LOOKS THE STRAIN UP on Leafly's public API to decide
 * if it's actually sativa-leaning (e.g. Blue Dream, Pineapple Express, Trop
 * Cherry). Rescued listings are marked with ≈ (inferred) vs ★ (menu-declared
 * pure sativa). Results are cached to strain-cache.json. Disable the live lookup
 * with --no-strain-lookup (offline name dictionary only), or all inference with
 * --strict-lineage (trust menu labels exactly).
 *
 * Usage:
 *   node weed-value-finder.js                         # default: all seeded dispos
 *   node weed-value-finder.js --min-thc 27            # change THC floor
 *   node weed-value-finder.js --max-ppg 6             # cap price/gram (~$168/oz)
 *   node weed-value-finder.js --include-hybrid        # also show coarse hybrids
 *   node weed-value-finder.js --only earths-healing-south,jars-east-tucson
 *   node weed-value-finder.js --prefer-sativa         # sort pure sativa first
 *   node weed-value-finder.js --strict-lineage        # menu labels only, no inference
 *   node weed-value-finder.js --no-strain-lookup      # skip Leafly, use offline dict
 *   node weed-value-finder.js --headless              # hide the window
 *   node weed-value-finder.js --json out.json --csv out.csv
 *   node weed-value-finder.js --config dispensaries.json
 *   node weed-value-finder.js --selftest              # verify the math, no browser
 *
 * JARS (East Tucson + Green Valley): custom storefront with no public Dutchie
 * slug. Runs by default now, but JARS hides Arizona stores from non-AZ IPs — so
 * run from your Tucson connection. The adapter drives the age-gate → Arizona →
 * store flow and VERIFIES it landed on the right AZ store before trusting prices
 * (it skips rather than return an out-of-state store's menu).
 *
 * Notes / caveats:
 *  - THC % and lineage are only as good as what the store publishes. Listings
 *    with no THC number are dropped (can't confirm the 27% floor).
 *  - Slugs marked `verify:true` below are best guesses — the tool will skip any
 *    that 404. Confirm a slug by opening the store's own menu and reading the
 *    dutchie.com/embedded-menu/<slug> URL out of the iframe.
 *  - Personal price comparison only. Be polite: one page at a time, keep delays.
 */

'use strict';

const fs = require('fs');
const path = require('path');
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (_) { /* only needed for live runs */ }

// ---------------------------------------------------------------------------
// Dispensary list  (Tucson + Green Valley)
// ---------------------------------------------------------------------------
// platform: 'dutchie'  -> Dutchie embedded menu, needs `slug` (the piece in
//                         dutchie.com/embedded-menu/<slug>/...). menuType rec|med.
// platform: 'jars'     -> JARS custom storefront, needs `store` (exact store
//                         name as shown in the picker) and `mode` (rec|med).
//
// `verify:true` = slug is a best guess; confirm it or the tool will skip it.
const DISPENSARIES = [
  // --- CONFIRMED Tucson-area Dutchie menus (live-verified: slug resolves,
  //     product cards load). These run by default. ---
  { id: 'earths-healing-south', name: "Earth's Healing South", platform: 'dutchie', slug: 'earths-healing-south', menuType: 'rec' },
  { id: 'earths-healing-north', name: "Earth's Healing North", platform: 'dutchie', slug: 'earths-healing-north', menuType: 'rec' },
  { id: 'd2-eastside', name: 'D2 Dispensary (Eastside)', platform: 'dutchie', slug: 'd2-dispensary', menuType: 'rec' },
  { id: 'd2-downtown', name: 'D2 Dispensary (Downtown)', platform: 'dutchie', slug: 'the-downtown-dispensary', menuType: 'rec' },
  { id: 'botanica', name: 'Botanica', platform: 'dutchie', slug: 'botanica', menuType: 'rec' },
  { id: 'trulieve-tucson', name: 'Trulieve / Harvest of Tucson', platform: 'dutchie', slug: 'harvest-of-tucson', menuType: 'rec' },
  { id: 'nature-med', name: 'Nature Med (Tucson)', platform: 'dutchie', slug: 'nature-med-tucson', menuType: 'rec' },
  { id: 'the-flower-shop', name: 'The Flower Shop', platform: 'dutchie', slug: 'the-flower-shop', menuType: 'rec' },
  { id: 'tucson-saints', name: 'Tucson Saints', platform: 'dutchie', slug: 'tucson-saints', menuType: 'rec' },
  { id: 'green-halo', name: 'Green Halo (Halo Cannabis)', platform: 'dutchie', slug: 'the-halo-blue-palo-verde', menuType: 'rec' },

  // --- JARS (Tucson + Green Valley): custom Buddi storefront over Dutchie's
  //     API — no public Dutchie slug. The adapter drives the age-gate → state
  //     → store flow, which appears on a residential AZ IP. From a datacenter /
  //     non-AZ IP the site geo-defaults to another state and hides the AZ
  //     picker, so this is BEST-EFFORT: run it headed the first time to confirm
  //     it lands on the right store. Marked `verify` so it's opt-in.
  { id: 'jars-east-tucson', name: 'JARS - East Tucson', platform: 'jars', store: 'JARS - East Tucson (Rec/Med)', match: 'East Tucson', shopSlug: 'jars-east-tucson', mode: 'rec' },
  { id: 'jars-green-valley', name: 'JARS Green Valley', platform: 'jars', store: 'JARS Green Valley / Elevate AZ 1', match: 'Green Valley', shopSlug: 'jars-green-valley', mode: 'rec' },

  // --- Add more Tucson dispensaries here. To find a store's Dutchie slug:
  //     open its website's menu, and read the dutchie.com/embedded-menu/<slug>
  //     URL out of the menu iframe's `src`. Confirmed-not-on-public-Dutchie or
  //     unverified: Prime Leaf, Curaleaf, Desert Bloom, Debbie's, Catalina. ---
];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (name, def = null) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  const has = (name) => args.includes(`--${name}`);

  return {
    minThc: Number(get('min-thc', 27)),
    maxPpg: get('max-ppg') != null ? Number(get('max-ppg')) : null, // cap $/gram
    includeHybrid: has('include-hybrid'), // also include coarse "Hybrid" (lean unknown)
    strictLineage: has('strict-lineage'), // OFF all sativa-lean inference
    noStrainLookup: has('no-strain-lookup'), // OFF the live Leafly lookup (offline dict only)
    jarsManual: has('jars-manual'), // pause for you to pick the JARS store by hand
    includeVerify: has('include-unverified-slugs') || Boolean(get('only')), // try verify:true slugs too
    preferSativa: has('prefer-sativa'), // sort pure sativa first, then $/g
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
// Normalization engine  (the actual value of this tool)
// ---------------------------------------------------------------------------

// Pull real menu prices out of text. CRITICAL: menus are full of dollar amounts
// that are NOT the price you pay — "$10.00 off" (a discount amount) and promo
// copy like "2 For $100" or "$30 Half Ounces". Reading those as the price is how
// a scraper invents fake "89% off" deals. So we only trust a $-amount that is a
// standalone price token on its own line (nothing but the price), and we drop
// any "$N off / discount" amount outright. Returns Number[].
function parsePrices(text) {
  if (!text) return [];
  const out = [];
  for (const rawLine of String(text).replace(/,/g, '').split(/\n|\s\|\s/)) {
    const line = rawLine.trim();
    if (/\$\s*\d[\d.]*\s*(off|discount)\b/i.test(line)) continue; // "$10 off"
    const m = line.match(/^\$\s*(\d+(?:\.\d{1,2})?)$/); // ONLY a price, alone
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// Parse THC percent. Returns Number|null. Handles "THC: 29.31%", "THC : 17.3%".
function parseThc(text) {
  if (!text) return null;
  const m = text.match(/THC\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
  return m ? Number(m[1]) : null;
}

// Convert a weight token to grams. Handles "3.5g", "14.17g", "3.7grams",
// "1/8 oz", "1/2 oz", "1 oz", "1/4oz". Returns grams:Number|null + label.
const OZ_TO_G = { '1/8': 3.5, '1/4': 7, '3/8': 10.5, '1/2': 14, '1': 28 }; // industry convention
function parseWeightGrams(text) {
  if (!text) return { grams: null, label: null };
  // explicit grams first (e.g. 14.17g, 3.5g, 3.7grams, /14g)
  const g = text.match(/(\d+(?:\.\d+)?)\s*g(?:ram)?s?\b/i);
  if (g) return { grams: Number(g[1]), label: `${g[1]}g` };
  // oz fractions (1/8 oz, 1/2 oz, 1 oz)
  const oz = text.match(/(\d(?:\/\d)?)\s*oz\b/i);
  if (oz) {
    const frac = oz[1];
    const grams = OZ_TO_G[frac] ?? (frac.includes('/') ? null : Number(frac) * 28);
    return { grams, label: `${frac} oz` };
  }
  return { grams: null, label: null };
}

// Classify lineage text into a bucket. Returns one of:
// 'sativa' | 'sativa_hybrid' | 'hybrid' | 'indica_hybrid' | 'indica' | 'unknown'
function classifyStrain(text) {
  if (!text) return 'unknown';
  const t = text.toUpperCase();
  if (/SATIVA[\s_]*HYBRID|SATIVA[\s-]*DOM/.test(t)) return 'sativa_hybrid';
  if (/HYBRID[\s_]*SATIVA/.test(t)) return 'sativa_hybrid';
  if (/INDICA[\s_]*HYBRID|HYBRID[\s_]*INDICA|INDICA[\s-]*DOM/.test(t)) return 'indica_hybrid';
  if (/\bSATIVA\b/.test(t)) return 'sativa';
  if (/\bINDICA\b/.test(t)) return 'indica';
  if (/\bHYBRID\b/.test(t)) return 'hybrid';
  return 'unknown';
}

// Known sativa-dominant / sativa-LEANING strains. Used to rescue products the
// menu only labels "Hybrid" (or doesn't label at all) but that are genetically
// sativa-forward. This is a heuristic on the strain NAME — a genetics guess, not
// a lab result — so anything matched here is marked `inferred` and shown with a
// ≈ so you can tell it from a menu-declared sativa. Ordered longest-first so
// "Super Lemon Haze" wins over a bare "Haze". Word-boundary matched.
const SATIVA_LEAN_STRAINS = [
  // classic pure/near-pure sativas
  'durban poison', 'durban', 'sour diesel', 'sour d', 'green crack', 'jack herer',
  'super silver haze', 'super lemon haze', 'lemon haze', 'silver haze', 'amnesia haze',
  'ghost train haze', 'purple haze', 'strawberry cough', 'maui wowie', 'maui',
  'acapulco gold', 'panama red', 'red congolese', 'chocolope', 'kali mist',
  'lambs bread', "lamb's bread", 'lambsbread', 'malawi', 'golden goat', 'moby dick',
  'laughing buddha', 'cinderella 99', 'cindy 99', 'jack frost', 'jack the ripper',
  'candyland', 'trainwreck', 'tangie', 'clementine', 'chernobyl', 'dutch treat',
  'island sweet skunk', 'sweet skunk', 'lemon skunk', 'j1', 'harlequin', 'xj-13', 'xj13',
  'willie nelson', 'thai', 'hawaiian', 'jamaican', 'golden pineapple', 'sour tangie',
  'agent orange', 'orange crush', 'green goblin', 'ghost train', 'super silver',
  // sativa-LEANING hybrids (the "leans that way" cases you want)
  'blue dream', 'bruce banner', 'pineapple express', 'pineapple', 'pineapple punch',
  'pina punch', 'pina colada', 'pina', 'piña', 'mimosa',
  'tropicana cookies', 'tropicana', 'trop cherry', 'super boof', 'durban cookies',
  'jack', 'haze', 'sour', 'diesel', 'lemon g', 'east coast sour',
];

// Return the matched sativa-lean strain keyword in `name`, or null. Longest
// match wins to prefer specific names over generic tokens ("haze", "sour").
function inferSativaLean(name) {
  if (!name) return null;
  const t = ` ${String(name).toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const sorted = [...SATIVA_LEAN_STRAINS].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    const re = new RegExp(`(?:^|\\s)${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
    if (re.test(t)) return s;
  }
  return null;
}

// If a record's menu lineage is only "Hybrid"/unknown, try to rescue it as
// sativa-LEANING from its name using the offline dictionary. Mutates and returns
// the record. Never overrides an explicit menu label of indica/indica-hybrid/
// sativa (trust the menu there). This is the OFFLINE fallback; the live Leafly
// lookup below is preferred and more accurate.
function applyLeanInference(rec) {
  if (rec.strainBucket !== 'hybrid' && rec.strainBucket !== 'unknown') return rec;
  const hit = inferSativaLean(`${rec.name || ''} ${rec.brand || ''}`);
  if (!hit) return rec;
  rec.strainBucket = 'sativa_hybrid';
  rec.inferred = true;
  rec.inferredFrom = `name:${hit}`;
  rec.strainLabel = `Sativa-lean ≈${hit}`;
  rec.notes.push(`lineage inferred from name match "${hit}" (menu said hybrid/unknown)`);
  return rec;
}

// ---------------------------------------------------------------------------
// Live strain classifier — actually LOOK UP each strain on Leafly to decide if
// a "Hybrid"/unknown listing is a sativa-leaning hybrid, instead of guessing.
// Leafly's public JSON API gives a category (Sativa/Indica/Hybrid) plus a
// description that states "sativa-dominant" / "indica-dominant" for hybrids.
// Results are cached to disk so repeat runs don't re-hit the network.
// ---------------------------------------------------------------------------

const LEAFLY_API = 'https://consumer-api.leafly.com/api/strains/v1/';
const LEAFLY_SEARCH = 'https://consumer-api.leafly.com/api/search/v1';
const STRAIN_CACHE_PATH = path.join(__dirname, 'strain-cache.json');

// Strip brand, weights, and packaging words off a menu product name to get at
// the actual strain. "ABUNDANT ORGANICS STRAWBERRY SERENITY 14.17G" -> "strawberry serenity".
const PACKAGING_WORDS = /\b(jar|mylar|bag|can|prepack|prepacked|preroll|pre-roll|smalls?|small|flower|infused|ground|reserve|select|minis?|premium|indoor|outdoor|greenhouse|whole|half|quarter|eighth|oz|ounce|gram|grams|prepackaged|deli|shake|popcorn|mix|match|bogo)\b/gi;
function cleanStrainName(name, brand) {
  let s = ` ${(name || '').toLowerCase()} `;
  if (brand) s = s.split(brand.toLowerCase()).join(' '); // drop the brand string
  s = s
    .replace(/\d+(?:\.\d+)?\s*(?:g|grams?|oz|ounces?)\b/gi, ' ') // weights
    .replace(/\b\d\/\d\s*(?:oz|g)?\b/gi, ' ') // 1/8, 1/2
    .replace(/#\d+|\b\d+(?:\.\d+)?%?\b/g, ' ') // batch numbers, stray numbers
    .replace(PACKAGING_WORDS, ' ')
    .replace(/[^a-z0-9'\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}
const toSlug = (s) => s.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Map a Leafly strain record to our bucket. category is authoritative; for
// hybrids we read the "<x>-dominant" phrasing out of the description.
function classifyLeafly(category, description) {
  const cat = (category || '').toLowerCase();
  const dom = ((description || '').match(/(sativa|indica)[- ]dominant/i) || [])[0] || '';
  if (cat === 'sativa') return 'sativa';
  if (cat === 'indica') return 'indica';
  if (cat === 'hybrid') {
    if (/sativa/i.test(dom)) return 'sativa_hybrid';
    if (/indica/i.test(dom)) return 'indica_hybrid';
    return 'hybrid'; // balanced hybrid, no stated lean
  }
  return 'unknown';
}

function loadStrainCache() {
  try { return JSON.parse(fs.readFileSync(STRAIN_CACHE_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveStrainCache(cache) {
  try { fs.writeFileSync(STRAIN_CACHE_PATH, JSON.stringify(cache, null, 0)); } catch (_) { /* best effort */ }
}

async function leaflyFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
  if (r.status !== 200) return null;
  return r.json().catch(() => null);
}

// Look up one cleaned strain name on Leafly. Returns { bucket, slug, category,
// matchedName } or null. Tries the direct slug first, then a name-matched search
// hit. `cache` is keyed by the cleaned strain string.
async function leaflyClassifyStrain(cleaned, cache) {
  if (!cleaned || cleaned.length < 3) return null;
  if (Object.prototype.hasOwnProperty.call(cache, cleaned)) return cache[cleaned];

  let result = null;
  // 1) direct slug
  const direct = await leaflyFetchJson(LEAFLY_API + toSlug(cleaned)).catch(() => null);
  if (direct && direct.category) {
    result = { bucket: classifyLeafly(direct.category, direct.descriptionPlain || direct.shortDescriptionPlain), slug: direct.slug, category: direct.category, matchedName: direct.name };
  } else {
    // 2) search, accept a hit only if its name is a strong match (slug is a
    //    subset of, or equal to, our cleaned slug) — avoids Leafly's fuzzy
    //    top-hit returning an unrelated popular strain.
    const search = await leaflyFetchJson(`${LEAFLY_SEARCH}?query=${encodeURIComponent(cleaned)}&take=8`).catch(() => null);
    const hits = (search && search.hits && search.hits.strain) || [];
    const mySlug = toSlug(cleaned);
    const hit = hits.find((h) => h.slug && (h.slug === mySlug || mySlug.includes(h.slug) || h.slug.includes(mySlug)));
    if (hit) {
      const full = await leaflyFetchJson(LEAFLY_API + hit.slug).catch(() => null);
      const desc = (full && (full.descriptionPlain || full.shortDescriptionPlain)) || hit.shortDescriptionPlain;
      result = { bucket: classifyLeafly(hit.category, desc), slug: hit.slug, category: hit.category, matchedName: hit.name };
    }
  }
  cache[cleaned] = result; // cache misses (null) too, so we don't retry them
  return result;
}

// Resolve lineage for every hybrid/unknown listing by looking the strain up on
// Leafly. Mutates records in place. One lookup per DISTINCT strain, cached to
// disk, paced politely. Falls back to the offline dictionary on a miss.
async function resolveLeanViaLeafly(records, { concurrency = 6, log = () => {} } = {}) {
  const cache = loadStrainCache();
  const targets = records.filter((r) => r.strainBucket === 'hybrid' || r.strainBucket === 'unknown');
  // group by cleaned strain so we look each strain up once
  const byStrain = new Map();
  for (const r of targets) {
    const cleaned = cleanStrainName(r.name, r.brand);
    if (!cleaned) continue;
    if (!byStrain.has(cleaned)) byStrain.set(cleaned, []);
    byStrain.get(cleaned).push(r);
  }
  const entries = [...byStrain.entries()];
  const netBefore = entries.filter(([c]) => !Object.prototype.hasOwnProperty.call(cache, c)).length;
  log(`Looking up ${byStrain.size} distinct strain(s) on Leafly (${netBefore} new, ${byStrain.size - netBefore} cached)...`);

  // Resolve all lookups with a bounded worker pool (network-bound -> parallel is
  // a huge speedup vs. sequential). Results collected, then applied below.
  const infoByStrain = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < entries.length) {
      const [cleaned] = entries[idx++];
      let info = null;
      try { info = await leaflyClassifyStrain(cleaned, cache); } catch (_) { info = null; }
      infoByStrain.set(cleaned, info);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));

  let hits = 0, netLookups = netBefore;
  for (const [cleaned, recs] of entries) {
    const info = infoByStrain.get(cleaned);
    if (!info) continue;
    for (const r of recs) {
      r.leaflyCategory = info.category;
      r.leaflySlug = info.slug;
      // Only UPGRADE toward sativa; never downgrade a menu label we already trust.
      if (info.bucket === 'sativa' || info.bucket === 'sativa_hybrid') {
        r.strainBucket = info.bucket;
        r.inferred = true;
        r.inferredFrom = `leafly:${info.matchedName}`;
        r.strainLabel = info.bucket === 'sativa' ? `Sativa ≈Leafly` : `Sativa-lean ≈Leafly`;
        r.notes.push(`Leafly: ${info.matchedName} = ${info.category}${info.bucket === 'sativa_hybrid' ? ' (sativa-dominant)' : ''}`);
        hits++;
      } else if (info.bucket === 'indica_hybrid' || info.bucket === 'indica') {
        // Leafly says it leans indica — record it so the filter can drop it.
        r.strainBucket = info.bucket;
        r.strainLabel = BUCKET_LABEL[info.bucket] + ' ≈Leafly';
        r.notes.push(`Leafly: ${info.matchedName} = ${info.category} (not sativa)`);
      }
    }
  }
  saveStrainCache(cache);
  log(`Leafly resolved ${hits} listing(s) as sativa / sativa-leaning (${netLookups} network lookups, rest cached).`);
  return records;
}

// Is this bucket allowed given the user's "at least sativa-dom" rule?
function bucketAllowed(bucket, includeHybrid) {
  if (bucket === 'sativa' || bucket === 'sativa_hybrid') return true;
  if (bucket === 'hybrid' && includeHybrid) return true;
  return false;
}
const BUCKET_LABEL = {
  sativa: 'Sativa',
  sativa_hybrid: 'Sativa-hybrid',
  hybrid: 'Hybrid (lean unknown)',
  indica_hybrid: 'Indica-hybrid',
  indica: 'Indica',
  unknown: 'Unknown',
};
const BUCKET_RANK = { sativa: 0, sativa_hybrid: 1, hybrid: 2, indica_hybrid: 3, indica: 4, unknown: 5 };

/**
 * Turn one raw card into a normalized, comparable, deal-verified record.
 *
 * raw = { dispensary, dispensaryId, name, brand, strainText, priceText,
 *         weightText, thcText, url }  (any of these may be embedded in `blob`)
 * The parser is blob-tolerant: pass whatever text you scraped as `blob` and it
 * extracts prices/thc/weight from it; explicit fields override the blob.
 */
function normalizeListing(raw) {
  const blob = raw.blob || '';
  const prices = parsePrices(raw.priceText || blob);
  const thc = parseThc(raw.thcText || blob);
  const { grams, label: weightLabel } = parseWeightGrams(raw.weightText || blob || raw.name);
  const bucket = classifyStrain(raw.strainText || blob);

  // Charged price = the lowest listed dollar amount (sale beats MSRP).
  // Original = the highest, when there's a distinct struck price above it.
  const charged = prices.length ? Math.min(...prices) : null;
  const original = prices.length > 1 ? Math.max(...prices) : null;

  const out = {
    dispensary: raw.dispensary,
    dispensaryId: raw.dispensaryId,
    name: (raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 70),
    brand: (raw.brand || '').trim().slice(0, 30),
    strainBucket: bucket,
    strainLabel: BUCKET_LABEL[bucket],
    thc,
    grams,
    weightLabel,
    charged,
    original,
    pricePerGram: charged != null && grams ? charged / grams : null,
    // deal verification, filled below
    dealClaimed: false,
    dealReal: null, // true/false/null(no claim)
    discountPct: null,
    dealNote: null,
    url: raw.url || null,
    notes: [],
  };

  // ---- Deal verification ------------------------------------------------
  const claimsDiscount = /%\s*off|OFF\b|\bdeal\b|\bsale\b/i.test(blob) || original != null;
  out.dealClaimed = claimsDiscount;
  const claimedPctM = blob.match(/(\d{1,2})\s*%\s*off/i);
  const claimedPct = claimedPctM ? Number(claimedPctM[1]) : null;

  if (original != null && charged != null && original > charged) {
    // Real struck price exists -> recompute the discount ourselves.
    out.discountPct = Math.round((1 - charged / original) * 100);
    out.dealReal = true;
    if (claimedPct != null && Math.abs(claimedPct - out.discountPct) > 3) {
      out.dealReal = false;
      out.dealNote = `sticker says ${claimedPct}% off but sale/MSRP math = ${out.discountPct}%`;
      out.notes.push('discount math mismatch');
    }
  } else if (claimsDiscount) {
    // A "% OFF" sticker with no struck original to back it up -> unverifiable.
    out.dealReal = false;
    out.discountPct = claimedPct;
    out.dealNote = 'advertised discount has no struck MSRP to verify against';
    out.notes.push('unverified discount');
  }

  if (charged == null) out.notes.push('no price parsed');
  if (grams == null) out.notes.push('weight not parsed');
  if (thc == null) out.notes.push('no THC listed');

  return out;
}

// Apply the user's filters. Returns { kept, dropped:[{rec, reason}] }.
function applyFilters(records, opts) {
  const kept = [];
  const dropped = [];
  for (const r of records) {
    if (r.pricePerGram == null) { dropped.push({ r, reason: 'no comparable $/g' }); continue; }
    if (r.thc == null) { dropped.push({ r, reason: 'no THC listed' }); continue; }
    if (r.thc < opts.minThc) { dropped.push({ r, reason: `THC ${r.thc}% < ${opts.minThc}%` }); continue; }
    if (opts.maxPpg != null && r.pricePerGram > opts.maxPpg) {
      dropped.push({ r, reason: `$${r.pricePerGram.toFixed(2)}/g > $${opts.maxPpg}/g cap` });
      continue;
    }
    if (!bucketAllowed(r.strainBucket, opts.includeHybrid)) {
      dropped.push({ r, reason: `strain ${r.strainLabel} not sativa-dominant` });
      continue;
    }
    kept.push(r);
  }
  return { kept, dropped };
}

// Rank. Default: best real $/g first. --prefer-sativa: pure sativa bucket
// first (sativa < sativa_hybrid < hybrid), then $/g within each.
function rankListings(list, preferSativa) {
  const arr = [...list];
  arr.sort((a, b) => {
    if (preferSativa && BUCKET_RANK[a.strainBucket] !== BUCKET_RANK[b.strainBucket]) {
      return BUCKET_RANK[a.strainBucket] - BUCKET_RANK[b.strainBucket];
    }
    if (a.pricePerGram !== b.pricePerGram) return a.pricePerGram - b.pricePerGram;
    return (b.thc ?? 0) - (a.thc ?? 0); // tie: more THC per dollar wins
  });
  return arr;
}

// ---------------------------------------------------------------------------
// Browser plumbing  (reused pattern from turf-searcher.js)
// ---------------------------------------------------------------------------

async function makeContext(browser) {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1360, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
}

// Scroll to the bottom repeatedly until the number of product cards stops
// growing — Dutchie lazy-loads as you scroll. `countSelectorFn` runs in-page.
async function autoScroll(page, countInPage, { maxRounds = 40, pauseMs = 700 } = {}) {
  let last = -1;
  for (let i = 0; i < maxRounds; i++) {
    const n = await page.evaluate(countInPage).catch(() => 0);
    if (n === last) break;
    last = n;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(pauseMs);
  }
  return last;
}

// ---- Generic Dutchie embedded-menu adapter --------------------------------
// Cards are the smallest ancestor of an "Add ... to cart" button that also
// carries a price and a lineage word. A single card can offer SEVERAL weights
// (1g / 1/8 oz / 1/2 oz), each with its own price — so we emit one row PER
// weight option, pairing each weight with only the prices in its own segment.
// This avoids cross-pairing a small weight with a big-jar price (fake deals).
const DUTCHIE_HARVEST = () => {
  const isAdd = (b) => /add .* to cart|^add\b/i.test((b.textContent || '').trim());
  const btns = Array.from(document.querySelectorAll('button')).filter(isAdd);
  const cardOf = (b) => {
    let el = b;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      const t = el.innerText || '';
      if (/\$\d/.test(t) && /\b(Indica|Sativa|Hybrid)\b/i.test(t) && t.length < 800) return el;
    }
    return null;
  };
  // Collect unique card elements first (a card is reached from each of its
  // Add buttons), then parse each card once into per-weight rows.
  const cards = new Set();
  for (const b of btns) { const c = cardOf(b); if (c) cards.add(c); }

  const out = [];
  const seen = new Set();
  for (const card of cards) {
    const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const link = card.querySelector('a[href]');
    const href = link ? link.href : null;
    const name = lines[0] || '';
    const brand = lines[1] && !/\$|THC|oz|\bg\b/i.test(lines[1]) ? lines[1] : '';
    const strainLine = lines.find((l) => /^\s*(Indica|Sativa|Hybrid)/i.test(l)) || '';
    const thcLine = lines.find((l) => /THC\s*:/i.test(l)) || '';
    const header = [name, brand, strainLine, thcLine].filter(Boolean).join(' | ');

    // Split the card's lines into per-option segments at each "Add ... to cart".
    const addIdx = [];
    lines.forEach((l, i) => { if (/^add\b.*to cart$/i.test(l)) addIdx.push(i); });
    if (!addIdx.length) continue;

    let prev = 0;
    for (const idx of addIdx) {
      const segLines = lines.slice(prev, idx); // option's own weight + price lines
      prev = idx + 1;
      const wMatch = lines[idx].match(/^add\s+(.+?)\s+to cart$/i);
      // Fallback must be a line that IS a weight token on its own (e.g. "1/2 oz",
      // "3.5g") — not just a line that mentions "oz"/"g" somewhere in a sentence.
      // A bare "Add to cart" button (e.g. a bundle/mix-and-match special widget
      // embedded in the same card) has no weight of its own; if its segment's
      // marketing copy happens to say something like "Make your own 1/2OZ from
      // 8ths", the loose version of this match mistook that phrase for a real
      // weight tier and paired it with a leftover price line from the product
      // above it — silently doubling the reported grams for that price.
      const weightLine = segLines.find((l) => /^\d(?:\/\d)?\s*oz$|^\d+(?:\.\d+)?\s*g(?:rams?)?$/i.test(l.trim()));
      const weightText = wMatch ? wMatch[1] : (weightLine || '');
      if (!weightText) continue;
      // Prices = ONLY standalone price lines in this segment (drops "$X off"
      // discount amounts and promo copy like "2 For $100").
      const priceLines = segLines.filter((l) => /^\$\s*\d/.test(l) && !/off|discount|for\b/i.test(l));
      if (!priceLines.length) continue;
      const blob = [header, ...segLines].join(' | ');
      const key = `${name}::${weightText}::${priceLines.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name, brand, strainText: strainLine, thcText: thcLine,
        weightText, priceText: priceLines.join(' | '), blob, url: href,
      });
    }
  }
  return out;
};

async function scrapeDutchie(context, disp, opts) {
  const menuType = disp.menuType || 'rec';
  const url = `https://dutchie.com/embedded-menu/${disp.slug}/products/flower?menuType=${menuType}`;
  const page = await context.newPage();
  console.log(`\n▶ ${disp.name} (dutchie:${disp.slug})`);
  try {
    await gotoAndSettle(page, url);
    // 404 / bad slug guard
    const bad = await page.evaluate(() =>
      /can't find|not found|404|no products/i.test(document.body?.innerText || '')
    ).catch(() => false);
    await page.waitForTimeout(1200);
    const count = await autoScroll(
      page,
      () => Array.from(document.querySelectorAll('button')).filter((b) => /add .* to cart|^add\b/i.test((b.textContent || '').trim())).length
    );
    if (!count) {
      console.log(`   no product cards found${bad ? ' (menu says not-found — slug likely wrong)' : ''} — skipping`);
      await page.close();
      return [];
    }
    const cards = await page.evaluate(DUTCHIE_HARVEST);
    console.log(`   harvested ${cards.length} card(s)`);
    await page.close();
    return cards.slice(0, opts.maxPerStore).map((c) =>
      normalizeListing({ dispensary: disp.name, dispensaryId: disp.id, ...c })
    );
  } catch (e) {
    console.log(`   error: ${e.message} — skipping`);
    await page.close().catch(() => {});
    return [];
  }
}

// ---- JARS custom storefront adapter ---------------------------------------
// Flow: category/flower -> age gate -> pick state AZ -> pick store -> menu.
async function clickByText(page, texts, { exact = true } = {}) {
  return page.evaluate(
    ({ texts, exact }) => {
      const wanted = texts.map((t) => t.toLowerCase());
      const nodes = Array.from(document.querySelectorAll('button,a,div,span,li'));
      for (const n of nodes) {
        const t = (n.textContent || '').trim().toLowerCase();
        const hit = exact ? wanted.includes(t) : wanted.some((w) => t.includes(w));
        if (hit && n.getClientRects().length) {
          n.click();
          return true;
        }
      }
      return false;
    },
    { texts, exact }
  );
}

const JARS_HARVEST = () => {
  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) =>
    /\/product\//.test((a.getAttribute('href') || '').split('?')[0])
  );
  const cardOf = (a) => {
    const distinct = (el) => {
      const s = new Set();
      el.querySelectorAll('a[href]').forEach((y) => {
        const h = (y.getAttribute('href') || '').split('?')[0];
        if (/\/product\//.test(h)) s.add(h);
      });
      return s.size;
    };
    let el = a, prev = a;
    while (el.parentElement && distinct(el.parentElement) <= 1) { prev = el.parentElement; el = el.parentElement; }
    return prev;
  };
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (seen.has(href)) continue;
    seen.add(href);
    const card = cardOf(a);
    const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const blob = lines.join(' | ');
    // JARS card lines: [promo, name, brand, "SATIVA THC : x%", ".", $sale, $orig, /Ng, In stock, x%]
    const strainLine = lines.find((l) => /(SATIVA|INDICA|HYBRID).*THC|THC/i.test(l)) || '';
    const brand = lines[2] || '';
    const weightLine = lines.find((l) => /^\/?\d+(?:\.\d+)?\s*g/i.test(l) || /oz\b/i.test(l)) || '';
    // Only standalone price lines — excludes promo copy like "$10 Flower 1/8th".
    const priceLines = lines.filter((l) => /^\$\s*\d/.test(l) && !/off|discount|for\b/i.test(l));
    out.push({
      name: lines[1] || lines[0] || '', brand, strainText: strainLine,
      weightText: weightLine, priceText: priceLines.join(' | '), blob, url: a.href,
    });
  }
  return out;
};

// Read whichever store JARS currently thinks you're shopping (the "Pickup from
// <address>" line, or a selected store name). Used to confirm we landed right.
async function jarsCurrentStore(page) {
  return page.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/Pickup from\s*([^\n]+)/i);
    return (m ? m[1] : '').trim();
  }).catch(() => '');
}

// Click a JARS store card's Shop button by a distinctive substring match on the
// store name (e.g. "East Tucson"), rather than an exact full-label match.
async function jarsPickStore(page, matchToken, mode) {
  return page.evaluate(
    ({ matchToken, mode }) => {
      const tok = matchToken.toLowerCase();
      // smallest element whose text names this store
      const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,span,div,a,button')).filter(
        (e) => (e.textContent || '').toLowerCase().includes(tok) && e.querySelectorAll('*').length < 4
      );
      const want = mode === 'med' ? 'shop medical' : 'shop recreational';
      for (const head of heads) {
        let card = head;
        for (let i = 0; i < 7 && card.parentElement; i++) {
          card = card.parentElement;
          const btn = Array.from(card.querySelectorAll('button,a')).find(
            (b) => (b.textContent || '').trim().toLowerCase() === want &&
              (card.textContent || '').toLowerCase().includes(tok)
          );
          if (btn) { btn.click(); return true; }
        }
      }
      return false;
    },
    { matchToken, mode }
  );
}

// Type into a JARS search box in a React-safe way (native setter + input event),
// which plain keyboard typing doesn't always trigger on their controlled inputs.
async function jarsFillSearch(page, placeholderSub, value) {
  return page.evaluate(
    ({ placeholderSub, value }) => {
      const input = Array.from(document.querySelectorAll('input')).find((i) =>
        (i.placeholder || '').toLowerCase().includes(placeholderSub.toLowerCase())
      );
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    { placeholderSub, value }
  );
}

// Wait for the user to manually pick their store in the visible browser window.
// Polls the active /shop/<slug> until it matches the target store (or any store
// whose slug carries the match token, e.g. "east-tucson"), then continues. This
// is how we get JARS from a non-AZ machine: you confirm the location by hand.
async function jarsWaitForManualStore(page, wantSlug, matchToken, timeoutMs = 240000) {
  const tokenSlug = (matchToken || '').toLowerCase().replace(/\s+/g, '-');
  console.log('\n   ┌─ JARS manual confirm ─────────────────────────────────────────');
  console.log('   │ A browser window is open. In it:');
  console.log('   │   1) Click "Enter Site" (age gate)');
  console.log('   │   2) Select Arizona, then your store (East Tucson / Green Valley)');
  console.log('   │   3) Make sure the menu shows that store');
  console.log(`   │ Waiting up to ${Math.round(timeoutMs / 1000)}s for you to land on "${wantSlug}"...`);
  console.log('   └───────────────────────────────────────────────────────────────');
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const slug = await jarsActiveShopSlug(page);
    if (slug && slug !== last) { console.log(`   …current store: ${slug}`); last = slug; }
    if (slug && (slug === wantSlug || (tokenSlug && slug.includes(tokenSlug)))) {
      console.log(`   ✓ store confirmed: ${slug}\n`);
      return slug;
    }
    await page.waitForTimeout(2500);
  }
  return null;
}

// The reliable signal for which store is ACTIVE is the "/shop/<slug>" links in
// the page, NOT the "Pickup from <address>" header (which lags / shows a default).
async function jarsActiveShopSlug(page) {
  return page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[href*="/shop/"]'))
      .map((x) => x.getAttribute('href') || '')
      .find((h) => /\/shop\/[a-z0-9-]+/i.test(h));
    const m = a && a.match(/\/shop\/([a-z0-9-]+)/i);
    return m ? m[1].toLowerCase() : '';
  }).catch(() => '');
}

/**
 * JARS custom storefront (Buddi over Dutchie). CRITICAL FINDING: JARS resolves
 * the active store SERVER-SIDE from your IP's geolocation. From an Arizona
 * connection it serves your local AZ store; from anywhere else it force-locks to
 * an out-of-state store (e.g. Michigan) and NONE of the client-side switches
 * (store picker, /shop/<slug> URL + Confirm, /stores search, or even overriding
 * the browser Geolocation API) can move it. So this adapter only works from an
 * AZ IP — run it on your Tucson connection.
 *
 * Store-switch strategy, best-first:
 *   0) Visit /shop/<shopSlug> and click its "Confirm" store-switch button.
 *   A) Age gate -> Arizona state -> click the store's "Shop Recreational".
 *   B) /stores search by name / zip.
 * Then we VERIFY the active /shop/<slug> matches the target before trusting any
 * prices, and skip loudly if it doesn't (never return a wrong store's menu).
 */
async function scrapeJars(context, disp, opts) {
  const page = await context.newPage();
  const mode = disp.mode || 'rec';
  const token = disp.match || disp.store;
  const wantSlug = (disp.shopSlug || '').toLowerCase();
  console.log(`\n▶ ${disp.name} (jars custom flow)`);
  try {
    await gotoAndSettle(page, 'https://jarscannabis.com/category/flower');
    await page.waitForTimeout(1500);
    await clickByText(page, ['enter site']).catch(() => {}); // age gate (if shown)
    await page.waitForTimeout(1200);

    // --- Path 0: store-scoped URL + Confirm (cleanest switch) ---
    if (wantSlug) {
      await gotoAndSettle(page, `https://jarscannabis.com/shop/${wantSlug}`);
      await page.waitForTimeout(1500);
      await clickByText(page, ['enter site']).catch(() => {});
      await page.waitForTimeout(800);
      await clickByText(page, ['confirm - you can switch later!', 'confirm'], { exact: false }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // --- Path A: state + store picker (residential AZ IP) ---
    let slug = await jarsActiveShopSlug(page);
    if (slug !== wantSlug) {
      await gotoAndSettle(page, 'https://jarscannabis.com/category/flower');
      await page.waitForTimeout(1200);
      await clickByText(page, ['arizona']).catch(() => {});
      await page.waitForTimeout(1500);
      await jarsPickStore(page, token, mode);
      await page.waitForTimeout(1500);
      slug = await jarsActiveShopSlug(page);
    }

    // --- Path B: /stores search by name / zip ---
    if (slug !== wantSlug) {
      await gotoAndSettle(page, 'https://jarscannabis.com/stores');
      await page.waitForTimeout(1200);
      await clickByText(page, ['enter site']).catch(() => {});
      const zip = disp.match === 'Green Valley' ? '85614' : '85710';
      await jarsFillSearch(page, 'store name', token);
      await page.waitForTimeout(1500);
      if (!(await jarsPickStore(page, token, mode))) {
        await jarsFillSearch(page, 'zip', zip);
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(1800);
        await jarsPickStore(page, token, mode);
      }
      await page.waitForTimeout(1500);
      slug = await jarsActiveShopSlug(page);
    }

    // --- Manual confirm: let the user pick the store by hand in the window ---
    const tokenSlug = (disp.match || '').toLowerCase().replace(/\s+/g, '-');
    const matches = (s) => s && (s === wantSlug || (tokenSlug && s.includes(tokenSlug)));
    if (!matches(slug) && opts.jarsManual && opts.headed) {
      const got = await jarsWaitForManualStore(page, wantSlug, disp.match);
      if (got) slug = got;
    }

    // Load the menu and verify the ACTIVE store slug matches the target.
    await gotoAndSettle(page, 'https://jarscannabis.com/category/flower');
    await page.waitForTimeout(2000);
    await autoScroll(page, () => document.querySelectorAll('a[href*="/product/"]').length, { maxRounds: 30 });
    slug = await jarsActiveShopSlug(page);

    if (wantSlug && !matches(slug)) {
      const cur = await jarsCurrentStore(page);
      console.log(`   ⚠ could not switch to "${wantSlug}" — active store is "${slug || 'unknown'}" (${cur}).`);
      if (!opts.jarsManual) console.log(`     Tip: add --jars-manual to confirm the store by hand in the browser window.`);
      else console.log(`     JARS locks the store to your IP's location. Run this from your Tucson/AZ connection.`);
      await page.close();
      return [];
    }

    const cards = await page.evaluate(JARS_HARVEST);
    console.log(`   harvested ${cards.length} card(s) from store "${slug || 'active'}"`);
    await page.close();
    return cards.slice(0, opts.maxPerStore).map((c) =>
      normalizeListing({ dispensary: disp.name, dispensaryId: disp.id, ...c })
    );
  } catch (e) {
    console.log(`   error: ${e.message} — skipping`);
    await page.close().catch(() => {});
    return [];
  }
}

async function scrapeDispensary(context, disp, opts) {
  if (disp.platform === 'dutchie') return scrapeDutchie(context, disp, opts);
  if (disp.platform === 'jars') return scrapeJars(context, disp, opts);
  console.log(`(skipping ${disp.name}: unknown platform "${disp.platform}")`);
  return [];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const money = (n) => (n == null ? '   —  ' : `$${n.toFixed(2)}`);
const ppg = (n) => (n == null ? '  —  ' : `$${n.toFixed(2)}`);

function printTable(ranked, dropped, opts) {
  console.log(`\n${'='.repeat(92)}`);
  console.log(
    `BEST VALUE FLOWER — THC ≥ ${opts.minThc}%, sativa${opts.includeHybrid ? ' / sativa-hybrid / hybrid' : ' & sativa-dominant hybrid'} only`
  );
  console.log(`ranked by REAL price per gram${opts.maxPpg != null ? ` (capped at $${opts.maxPpg}/g ≈ $${(opts.maxPpg * 28).toFixed(0)}/oz)` : ''}`);
  console.log('='.repeat(96));

  if (!ranked.length) {
    console.log('\nNothing qualified. Loosen with --min-thc, --max-ppg, or --include-hybrid, or confirm store slugs loaded.');
  } else {
    console.log(
      `\n${'$/g'.padEnd(7)}${'/oz eq'.padEnd(8)}${'PRICE'.padEnd(9)}${'WT'.padEnd(8)}${'THC'.padEnd(7)}${'LINEAGE'.padEnd(20)}${'DEAL'.padEnd(12)}${'DISPENSARY'.padEnd(20)}PRODUCT`
    );
    console.log('-'.repeat(96));
    for (const r of ranked) {
      const deal =
        r.dealReal === true ? `✓ ${r.discountPct}% off` :
        r.dealReal === false ? '⚠ unverified' :
        r.discountPct != null ? `${r.discountPct}% off` : '';
      // ★ menu-declared pure sativa; ≈ lineage we inferred (Leafly/name); space otherwise
      const mark = r.inferred ? '≈' : (r.strainBucket === 'sativa' ? '★' : ' ');
      const ozEq = r.pricePerGram != null ? `$${(r.pricePerGram * 28).toFixed(0)}` : '—';
      console.log(
        `${mark}${ppg(r.pricePerGram).padEnd(6)}${ozEq.padEnd(8)}${money(r.charged).padEnd(9)}${(r.weightLabel || '?').padEnd(8)}` +
          `${(r.thc != null ? r.thc + '%' : '?').padEnd(7)}${(r.strainLabel || '').slice(0, 19).padEnd(20)}${deal.padEnd(12)}` +
          `${(r.dispensary || '').slice(0, 19).padEnd(20)}${r.brand ? r.brand + ' — ' : ''}${r.name}`
      );
    }

    const bestValue = ranked[0];
    const bestSativa = ranked.find((r) => r.strainBucket === 'sativa');
    console.log(`\n${'─'.repeat(92)}`);
    console.log(`BEST VALUE:  ${ppg(bestValue.pricePerGram)}/g — ${bestValue.name} @ ${bestValue.dispensary}`);
    console.log(`             ${money(bestValue.charged)} / ${bestValue.weightLabel} · ${bestValue.thc}% · ${bestValue.strainLabel}`);
    if (bestValue.url) console.log(`             ${bestValue.url}`);
    if (bestSativa && bestSativa !== bestValue) {
      console.log(`BEST SATIVA: ${ppg(bestSativa.pricePerGram)}/g — ${bestSativa.name} @ ${bestSativa.dispensary}`);
      console.log(`             ${money(bestSativa.charged)} / ${bestSativa.weightLabel} · ${bestSativa.thc}% · pure sativa`);
      if (bestSativa.url) console.log(`             ${bestSativa.url}`);
    }
    console.log(`\n★ = pure sativa   ✓ = discount verified vs struck MSRP   ⚠ = advertised deal we could NOT verify`);
  }

  // Show a few notable near-misses so the filter is auditable.
  const notable = dropped.filter((d) => /THC .* <|not sativa/.test(d.reason)).slice(0, 8);
  if (notable.length) {
    console.log(`\nDropped by filter (sample):`);
    for (const d of notable) {
      console.log(`   ✗ ${d.r.name || '(unnamed)'} @ ${d.r.dispensary} — ${d.reason}`);
    }
  }
}

function writeJson(p, ranked, dropped, opts) {
  fs.writeFileSync(
    p,
    JSON.stringify({ opts, generatedAt: new Date().toISOString(), count: ranked.length, results: ranked, droppedCount: dropped.length }, null, 2)
  );
  console.log(`\nWrote JSON -> ${p}`);
}

function writeCsv(p, ranked) {
  const cols = ['pricePerGram', 'charged', 'original', 'discountPct', 'dealReal', 'grams', 'weightLabel', 'thc', 'strainLabel', 'dispensary', 'brand', 'name', 'url'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [cols.join(',')].concat(ranked.map((r) => cols.map((c) => esc(r[c])).join(',')));
  fs.writeFileSync(p, rows.join('\n'));
  console.log(`Wrote CSV  -> ${p}`);
}

// ---------------------------------------------------------------------------
// Self-test: verify parsing / normalization / deal logic without a browser.
// ---------------------------------------------------------------------------

function selftest() {
  const approx = (a, b, t = 0.01) => Math.abs(a - b) <= t;
  let pass = 0, total = 0;
  const check = (name, cond, got) => {
    total++;
    console.log(`${cond ? '✅' : '❌'} ${name}${cond ? '' : `   got: ${got}`}`);
    if (cond) pass++;
  };

  // weight parsing
  check('1/8 oz = 3.5g', parseWeightGrams('1/8 oz').grams === 3.5);
  check('1/2 oz = 14g', parseWeightGrams('1/2 oz').grams === 14);
  check('1 oz = 28g', parseWeightGrams('1 oz').grams === 28);
  check('14.17g literal', parseWeightGrams('ABUNDANT 14.17G').grams === 14.17);
  check('3.7grams literal', parseWeightGrams('Jar 3.7grams').grams === 3.7);

  // thc + strain
  check('THC colon-space', parseThc('SATIVA THC : 29.9%') === 29.9);
  check('THC no space', parseThc('THC: 27.46%') === 27.46);
  check('classify SATIVA_HYBRID', classifyStrain('SATIVA_HYBRID THC : 20%') === 'sativa_hybrid');
  check('classify INDICA_HYBRID', classifyStrain('INDICA_HYBRID') === 'indica_hybrid');
  check('classify coarse Hybrid', classifyStrain('Hybrid') === 'hybrid');
  check('classify Sativa', classifyStrain('Sativa') === 'sativa');

  // Leafly classification mapping (pure function)
  check('classifyLeafly Sativa cat', classifyLeafly('Sativa', 'a pure sativa') === 'sativa');
  check('classifyLeafly Hybrid sativa-dom', classifyLeafly('Hybrid', 'Blue Dream is a sativa-dominant hybrid') === 'sativa_hybrid');
  check('classifyLeafly Hybrid indica-dom', classifyLeafly('Hybrid', 'GMO is an indica-dominant hybrid') === 'indica_hybrid');
  check('classifyLeafly Hybrid balanced', classifyLeafly('Hybrid', 'a balanced hybrid') === 'hybrid');
  // strain-name cleaning strips brand + weight + packaging
  check('clean strips brand+weight', cleanStrainName('ABUNDANT ORGANICS STRAWBERRY SERENITY 14.17G', 'Abundant Organics').trim() === 'strawberry serenity', cleanStrainName('ABUNDANT ORGANICS STRAWBERRY SERENITY 14.17G', 'Abundant Organics'));
  check('clean strips oz + jar', cleanStrainName('Seed Junky 3.5g - Banana Fruz', 'Seed Junky').includes('banana fruz'), cleanStrainName('Seed Junky 3.5g - Banana Fruz', 'Seed Junky'));
  check('toSlug', toSlug('Super Lemon Haze') === 'super-lemon-haze');
  check('infer piña/pina punch', inferSativaLean('Fenix 1/2 Supercharged Pina Punch') === 'pina punch', inferSativaLean('Fenix 1/2 Supercharged Pina Punch'));
  // end-to-end: JARS Pina Punch (no menu lineage) -> rescued as sativa-lean, passes filters
  const pina = normalizeListing({ dispensary: 'JARS', brand: 'Fenix', name: 'Fenix 1/2 Supercharged Pina Punch', weightText: '14g', priceText: '$40.00 | $70.00', blob: 'Fenix 1/2 Supercharged Pina Punch | Fenix | THC : 29% | 14g | $40.00 | $70.00 | In stock | 43%', thcText: 'THC : 29%' });
  applyLeanInference(pina);
  check('Pina Punch inferred sativa-lean', pina.strainBucket === 'sativa_hybrid' && pina.inferred, `${pina.strainBucket}/${pina.inferred}`);
  check('Pina Punch $/g + passes filter', approx(pina.pricePerGram, 40 / 14) && applyFilters([pina], { minThc: 27, includeHybrid: false }).kept.length === 1, pina.pricePerGram);

  // normalize: real deal (JARS-style)
  const r1 = normalizeListing({
    dispensary: 'T', name: 'Fleur 1/8 Pineapple', brand: 'Fleur',
    blob: 'JARS - $10 Flower 1/8th | Fleur 1/8 Pineapple | Fleur | SATIVA THC : 29.81% | . | $8.00 | $18.00 | /3.5g | In stock | 56%',
  });
  check('r1 $/g = 8/3.5', approx(r1.pricePerGram, 8 / 3.5), r1.pricePerGram);
  check('r1 sativa', r1.strainBucket === 'sativa');
  check('r1 thc 29.81', r1.thc === 29.81);
  check('r1 deal real', r1.dealReal === true && r1.discountPct === 56, `${r1.dealReal}/${r1.discountPct}`);

  // parsePrices must ignore discount amounts and promo copy (the fake-deal bugs)
  check('parsePrices drops "$10 off"', JSON.stringify(parsePrices('$79.00 | $89.00 | $10.00 off')) === '[79,89]', parsePrices('$79.00 | $89.00 | $10.00 off'));
  check('parsePrices drops promo "2 For $100"', JSON.stringify(parsePrices('Bondfire 2 For $100 1/2 Oz | $12.00')) === '[12]', parsePrices('Bondfire 2 For $100 1/2 Oz | $12.00'));

  // REGRESSION: "$X off" discount amount must not be read as the price.
  const rOff = normalizeListing({
    dispensary: 'T', name: 'Crescendo', brand: 'FENO', weightText: '1/2 oz',
    priceText: '$79.00 | $89.00', strainText: 'Sativa', thcText: 'THC: 29.74%',
    blob: 'Crescendo | FENO | Sativa | THC: 29.74% | 1/2 oz | $79.00 | $89.00 | $10.00 off',
  });
  check('Crescendo real $/g = 79/14', approx(rOff.pricePerGram, 79 / 14), rOff.pricePerGram);
  check('Crescendo deal = 11% not 89%', rOff.dealReal === true && rOff.discountPct === 11, `${rOff.dealReal}/${rOff.discountPct}`);

  // REGRESSION: a single weight option must price against only its own segment.
  const rOpt = normalizeListing({
    dispensary: 'T', name: 'Ze Chem', brand: 'Bondfire', weightText: '1/2 oz',
    priceText: '$65.00', strainText: 'Sativa', thcText: 'THC: 27.97%',
    blob: 'Ze Chem | Bondfire | Sativa | THC: 27.97% | 1/2 oz | $65.00',
  });
  check('half-oz option $/g = 65/14', approx(rOpt.pricePerGram, 65 / 14), rOpt.pricePerGram);
  check('half-oz option no bogus deal', rOpt.dealReal === null, `${rOpt.dealReal}`);

  // normalize: Dutchie oz-fraction
  const r2 = normalizeListing({
    dispensary: 'T', name: 'BONDFIRE MEDELLIN', brand: 'Bondfire',
    blob: 'BONDFIRE MEDELLIN | Bondfire | Hybrid | THC: 29.83% | 1/8 oz | $25.00 | Add 1/8 oz to cart',
  });
  check('r2 $/g = 25/3.5', approx(r2.pricePerGram, 25 / 3.5), r2.pricePerGram);
  check('r2 hybrid bucket', r2.strainBucket === 'hybrid');
  check('r2 no deal claim', r2.dealReal === null);

  // normalize: fake deal (%off with no struck price)
  const r3 = normalizeListing({
    dispensary: 'T', name: 'AVENUE PINK CERTZ', brand: 'AVENUE',
    blob: 'AVENUE PINK CERTZ | AVENUE | Hybrid | AVENUE - 40% OFF | 1/8 oz | $27.30 | Add 1/8 oz to cart',
  });
  check('r3 unverified deal', r3.dealReal === false && /no struck MSRP/.test(r3.dealNote || ''), r3.dealNote);

  // normalize: discount math mismatch
  const r4 = normalizeListing({
    dispensary: 'T', name: 'Mismatch', blob: 'X | Sativa | THC: 30% | 90% off | 3.5g | $30.00 | $40.00',
  });
  check('r4 flags math mismatch', r4.dealReal === false && r4.notes.includes('discount math mismatch'), r4.dealNote);

  // filtering: THC floor + lineage
  const recs = [
    normalizeListing({ dispensary: 'T', name: 'A', blob: 'A | Sativa | THC: 28% | 3.5g | $10.00' }),      // keep
    normalizeListing({ dispensary: 'T', name: 'B', blob: 'B | Sativa | THC: 22% | 3.5g | $10.00' }),      // drop thc
    normalizeListing({ dispensary: 'T', name: 'C', blob: 'C | Indica | THC: 31% | 3.5g | $10.00' }),      // drop lineage
    normalizeListing({ dispensary: 'T', name: 'D', blob: 'D | Hybrid | THC: 30% | 3.5g | $10.00' }),      // drop unless include-hybrid
  ];
  const f1 = applyFilters(recs, { minThc: 27, includeHybrid: false });
  check('filter keeps only sativa>=27', f1.kept.length === 1 && f1.kept[0].name === 'A', `${f1.kept.map((x) => x.name)}`);
  const f2 = applyFilters(recs, { minThc: 27, includeHybrid: true });
  check('include-hybrid keeps A+D', f2.kept.length === 2, `${f2.kept.map((x) => x.name)}`);

  // ranking: value first; prefer-sativa flips to lineage-first
  const ranked = rankListings(f2.kept, false);
  check('value sort: cheapest $/g first', ranked[0].pricePerGram <= ranked[1].pricePerGram);
  const rankedS = rankListings([
    normalizeListing({ dispensary: 'T', name: 'cheapHybrid', blob: 'x|Hybrid|THC: 30%|3.5g|$5.00' }),
    normalizeListing({ dispensary: 'T', name: 'pricySativa', blob: 'x|Sativa|THC: 30%|3.5g|$9.00' }),
  ], true);
  check('prefer-sativa: sativa first despite higher $/g', rankedS[0].name === 'pricySativa', rankedS[0].name);

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadDispensaries(opts) {
  let list = DISPENSARIES;
  if (opts.configPath) {
    const raw = JSON.parse(fs.readFileSync(opts.configPath, 'utf8'));
    list = Array.isArray(raw) ? raw : raw.dispensaries || [];
  }
  if (opts.only.length) {
    list = list.filter((d) => opts.only.includes(d.id) || opts.only.includes(d.slug));
  } else if (!opts.includeVerify) {
    // By default skip best-guess slugs so a first run doesn't look broken.
    list = list.filter((d) => !d.verify);
  }
  return list;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.selftest) return selftest();

  if (!chromium) {
    console.error('playwright is not installed. Run:  npm install playwright && npx playwright install chromium');
    console.error('(You can still run the math checks with:  node weed-value-finder.js --selftest)');
    process.exit(1);
  }

  const dispensaries = loadDispensaries(opts);
  if (!dispensaries.length) {
    console.error('No dispensaries selected. Check --only ids or your --config file.');
    process.exit(1);
  }

  console.log(`Weed value finder — THC ≥ ${opts.minThc}%, ${opts.includeHybrid ? 'sativa + coarse hybrids' : 'sativa & sativa-dominant hybrids'}`);
  console.log(`Dispensaries (${dispensaries.length}): ${dispensaries.map((d) => d.name).join(', ')}`);
  if (!opts.includeVerify) console.log(`(unverified best-guess slugs skipped; add --include-unverified-slugs to try them)`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await makeContext(browser);

  let all = [];
  for (const disp of dispensaries) {
    const rows = await scrapeDispensary(context, disp, opts);
    all = all.concat(rows);
    await new Promise((res) => setTimeout(res, 900 + Math.random() * 1200)); // polite pacing
  }
  await browser.close();

  console.log(`\nParsed ${all.length} total listing(s) across ${dispensaries.length} store(s).`);
  if (!opts.strictLineage) {
    // Preferred: actually look each hybrid/unknown strain up on Leafly.
    if (!opts.noStrainLookup) {
      await resolveLeanViaLeafly(all, { log: (m) => console.log(m) });
    }
    // Offline dictionary catches anything Leafly didn't resolve.
    all.forEach(applyLeanInference);
    const n = all.filter((r) => r.inferred).length;
    console.log(`Total sativa-leaning listings rescued from hybrid/unknown: ${n} (≈). Use --strict-lineage for menu labels only.`);
  }
  const { kept, dropped } = applyFilters(all, opts);
  const ranked = rankListings(kept, opts.preferSativa);

  printTable(ranked, dropped, opts);
  if (opts.jsonOut) writeJson(opts.jsonOut, ranked, dropped, opts);
  if (opts.csvOut) writeCsv(opts.csvOut, ranked);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  normalizeListing, applyFilters, rankListings, parseWeightGrams, classifyStrain, parseThc,
  parsePrices, inferSativaLean, applyLeanInference, classifyLeafly, cleanStrainName,
  // shared plumbing reused by sibling finders (e.g. preroll-value-finder.js)
  makeContext, gotoAndSettle, autoScroll, DUTCHIE_HARVEST, resolveLeanViaLeafly,
  BUCKET_LABEL, BUCKET_RANK, DISPENSARIES,
};
