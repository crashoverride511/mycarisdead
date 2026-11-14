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
 * (or an external --config JSON). JARS runs its own storefront; the `jars`
 * adapter reads it from that storefront's backend API (jars-api.js).
 *
 * Where the numbers come from (rewritten 2026-11-14)
 * --------------------------------------------------
 * Both adapters read the menu's STRUCTURED product data, not rendered text:
 *   - Dutchie: the page's own `FilteredProducts` GraphQL responses, every page
 *     of them (the rendered menu only shows the first ~100 products).
 *   - JARS: POST /product-service/filter on the storefront API, by retailer id.
 * So price, list price, weight, THC, lineage and stock are each a field the
 * store's POS published — nothing is inferred from "the lowest dollar amount on
 * the card". Reading rendered cards survives only as the Dutchie fallback
 * (`--dom-only` forces it) and it is flagged in the coverage table when used.
 *
 * Every run ends with a COVERAGE table: each store, how many listings were
 * read, and any store that could not be read — named, never silently skipped.
 * It is also written to the JSON (`coverage`) and shown on the phone page.
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
 *   node weed-value-finder.js --only jars-east-tucson  # JARS alone: ~1 s, no browser
 *   node weed-value-finder.js --concurrency 1         # one store at a time (default 3)
 *   node weed-value-finder.js --dom-only              # old rendered-card scrape (page 1 only)
 *   node weed-value-finder.js --why "silver haze"     # trace matching listings through the filter
 *
 * JARS (East Tucson, Green Valley, North Tucson): read from the storefront API
 * by retailer id — works from any connection, medical menu where the store has
 * one. The old Playwright store-switching scrape (scrapeJars below,
 * jars-pull-cdp.js) is kept only as run-flower-daily.js's fallback.
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
  { id: 'earths-healing-south', name: "Earth's Healing South", platform: 'dutchie', slug: 'earths-healing-south', menuType: 'med' },
  { id: 'earths-healing-north', name: "Earth's Healing North", platform: 'dutchie', slug: 'earths-healing-north', menuType: 'med' },
  { id: 'd2-eastside', name: 'D2 Dispensary (Eastside)', platform: 'dutchie', slug: 'd2-dispensary', menuType: 'med' },
  { id: 'd2-downtown', name: 'D2 Dispensary (Downtown)', platform: 'dutchie', slug: 'the-downtown-dispensary', menuType: 'med' },
  { id: 'botanica', name: 'Botanica', platform: 'dutchie', slug: 'botanica', menuType: 'med' },
  // Trulieve moved off Dutchie: the slug still resolves ("Trulieve of Tucson
  // Blenman Elm") but shows NOT ACCEPTING ORDERS with zero products (checked
  // 2026-11-14; it had been silently returning nothing since at least October).
  // `disabled` entries are skipped by default; run with --only trulieve-tucson to re-check.
  { id: 'trulieve-tucson', name: 'Trulieve / Harvest of Tucson', platform: 'dutchie', slug: 'harvest-of-tucson', menuType: 'med', disabled: 'left Dutchie (menu empty, not accepting orders)' },
  { id: 'nature-med', name: 'Nature Med (Tucson)', platform: 'dutchie', slug: 'nature-med-tucson', menuType: 'med' },
  { id: 'the-flower-shop', name: 'The Flower Shop', platform: 'dutchie', slug: 'the-flower-shop', menuType: 'med' },
  { id: 'tucson-saints', name: 'Tucson Saints', platform: 'dutchie', slug: 'tucson-saints', menuType: 'med' },
  { id: 'green-halo', name: 'Green Halo (Halo Cannabis)', platform: 'dutchie', slug: 'the-halo-blue-palo-verde', menuType: 'med' },
  { id: 'desert-bloom', name: 'Desert Bloom Re-Leaf Center', platform: 'dutchie', slug: 'desert-bloom-re-leaf-center-dispensary', menuType: 'med' }, // live-verified 2026-08-19
  { id: 'nirvana-tucson', name: 'Nirvana Cannabis (Tucson)', platform: 'dutchie', slug: 'arizona-tree-equity-2-tucson', menuType: 'med' }, // live-verified 2026-08-19
  { id: 'sol-flower-south', name: 'Sol Flower (South Tucson)', platform: 'dutchie', slug: 'sol-flower-dispensary-south-tucson', menuType: 'med' }, // live-verified 2026-08-19
  { id: 'sol-flower-north', name: 'Sol Flower (North Tucson)', platform: 'dutchie', slug: 'sol-flower-dispensary-north-tucson', menuType: 'med' }, // live-verified 2026-08-19

  // --- JARS (Tucson + Green Valley): a "Buddy eCommerce" storefront, not a
  //     public Dutchie menu. Read straight from the storefront's backend API by
  //     retailer id (see jars-api.js) — no browser, no store switching, works
  //     from any connection. `match` finds the store in the API's live retailer
  //     list (name | address); medical menu when the store has one, else rec
  //     (flagged "· rec"). `store`/`shopSlug` are only used by the old
  //     Playwright fallback (jars-pull-cdp.js) and the pre-roll finder.
  { id: 'jars-east-tucson', name: 'JARS - East Tucson', platform: 'jars', store: 'JARS - East Tucson (Rec/Med)', match: 'East Tucson', shopSlug: 'jars-east-tucson', mode: 'med' },
  { id: 'jars-green-valley', name: 'JARS - Green Valley', platform: 'jars', store: 'JARS Green Valley / Elevate AZ 1', match: 'Green Valley', shopSlug: 'jars-green-valley', mode: 'med' },
  { id: 'jars-north-tucson', name: 'JARS - North Tucson', platform: 'jars', store: 'JARS - North Tucson', match: 'North Tucson|3008 North Stone', mode: 'med' }, // rec-only store (N Stone Ave), found via the API 2026-11-14

  // --- Add more Tucson dispensaries here. To find a store's Dutchie slug:
  //     open its website's menu, and read the dutchie.com/embedded-menu/<slug>
  //     URL out of the menu iframe's `src`. Confirmed-not-on-public-Dutchie or
  //     unverified / NOT on public Dutchie: Prime Leaf (custom platform),
  //     Curaleaf (own platform), Debbie's, Catalina. ---
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
    why: get('why'), // regex: trace every scraped listing whose name matches it
    category: get('category', 'flower'), // Dutchie menu category, e.g. concentrates
    concurrency: Math.max(1, Number(get('concurrency', 3))), // stores scraped at once
    domOnly: has('dom-only'), // skip the structured read; scrape rendered cards (page 1 only)
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
    // ONLY a price, alone — or a price joined to its weight ("$25.00 - 1/2 oz",
    // single-option Dutchie cards). Promo copy like "$30 Half Ounces" still fails.
    const m = line.match(/^\$\s*(\d+(?:\.\d{1,2})?)(?:\s*[-–]\s*(?:\d+(?:[./]\d+)?|\.\d+)\s*(?:oz|g|grams?)\b)?$/i);
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
  // explicit grams first (e.g. 14.17g, 3.5g, 3.7grams, /14g, and bare-decimal
  // singles like ".5g" / ".7g" that have no leading zero — common on pre-roll cards)
  const g = text.match(/(\d+(?:\.\d+)?|\.\d+)\s*g(?:ram)?s?\b/i);
  if (g) { const n = Number(g[1]); return { grams: n, label: `${n}g` }; }
  // oz fractions (1/8 oz, 1/2 oz, 1 oz)
  // also decimals ("0.5 oz" / ".5oz"), which the old single-digit pattern read
  // as "5 oz" = 140 g
  const oz = text.match(/(\d+\/\d+|\d*\.\d+|\d+)\s*oz\b/i);
  if (oz) {
    const frac = oz[1];
    let grams;
    if (frac.includes('/')) {
      const [a, b] = frac.split('/').map(Number);
      grams = OZ_TO_G[frac] ?? (b ? +((a / b) * 28).toFixed(2) : null);
    } else grams = +(Number(frac) * 28).toFixed(2);
    return { grams, label: `${frac} oz` };
  }
  return { grams: null, label: null };
}

// Classify lineage text into a bucket. Returns one of:
// 'sativa' | 'sativa_hybrid' | 'hybrid' | 'indica_hybrid' | 'indica' | 'unknown'
function classifyStrain(text) {
  if (!text) return 'unknown';
  const t = text.toUpperCase();
  // Separators vary by source: JARS "SATIVA_HYBRID", Dutchie "Sativa-Hybrid",
  // menus "Sativa Hybrid" / "Sativa Dominant". A hyphenated "Sativa-Hybrid" used
  // to fall through to plain SATIVA and get starred as pure sativa.
  if (/SATIVA[\s_-]*HYBRID|SATIVA[\s_-]*DOM/.test(t)) return 'sativa_hybrid';
  if (/HYBRID[\s_-]*SATIVA/.test(t)) return 'sativa_hybrid';
  if (/INDICA[\s_-]*HYBRID|HYBRID[\s_-]*INDICA|INDICA[\s_-]*DOM/.test(t)) return 'indica_hybrid';
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
const PACKAGING_WORDS = /\b(jar|mylar|bag|can|cannabis|pre-?pack(?:ed|aged)?|preroll|pre-roll|smalls?|small|flower|infused|ground|reserve|select|minis?|premium|indoor|outdoor|greenhouse|whole|half|quarter|eighth|oz|ounce|gram|grams|deli|shake|popcorn|mix|match|bogo)\b/gi;
function cleanStrainName(name, brand) {
  let s = ` ${(name || '').toLowerCase()} `;
  if (brand) s = s.split(brand.toLowerCase()).join(' '); // drop the brand string
  s = s
    .replace(/\d+(?:\.\d+)?\s*(?:g|grams?|oz|ounces?)\b/gi, ' ') // weights
    .replace(/\b\d\/\d\s*(?:oz|g)?\b/gi, ' ') // 1/8, 1/2
    // strip only STANDALONE numbers (batch/stray) — keep digits fused to a strain
    // token so "XJ-13", "MAC-1", "GMO 4"→"gmo" survive their letters. Was eating
    // the "13" out of "XJ-13" and breaking the Leafly lookup entirely.
    .replace(/#\d+|(?<![a-z0-9-])\d+(?:\.\d+)?%?(?![a-z0-9-])/gi, ' ')
    .replace(PACKAGING_WORDS, ' ')
    .replace(/[^a-z0-9'\s-]/gi, ' ')
    .replace(/(^|\s)[-]+(?=\s|$)/g, ' ') // drop standalone dashes left where segments were removed
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

// Fetch Leafly JSON. Returns the body, or null for a definitive "no such
// strain" (404). THROWS on anything else (timeout, 429, 5xx, bad body) so a
// network hiccup is never mistaken for — and cached as — "strain unknown".
async function leaflyFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`Leafly HTTP ${r.status}`);
  return r.json();
}

// A cached miss is trusted for this long, then looked up again (Leafly adds
// strains, and our name-cleaning improves). Misses are stored as
// { miss:true, at:<ISO> }; a bare `null` is a legacy miss with no date — those
// were cached forever even when the "miss" was really a failed request, so they
// are all re-checked once.
const LEAFLY_MISS_TTL_DAYS = 30;
const cachedLeafly = (cache, key) => {
  if (!Object.prototype.hasOwnProperty.call(cache, key)) return undefined;
  const v = cache[key];
  if (v && !v.miss) return v; // a real classification
  if (v && v.miss && Date.now() - Date.parse(v.at) < LEAFLY_MISS_TTL_DAYS * 864e5) return null; // fresh miss
  return undefined; // legacy/stale miss -> look it up again
};

// Look up one cleaned strain name on Leafly. Returns { bucket, slug, category,
// matchedName } or null. Tries the direct slug first, then a name-matched search
// hit. `cache` is keyed by the cleaned strain string. Throws on network trouble
// (caller treats that as "unknown for this run" and does not cache it).
async function leaflyClassifyStrain(cleaned, cache) {
  if (!cleaned || cleaned.length < 3) return null;
  const hit0 = cachedLeafly(cache, cleaned);
  if (hit0 !== undefined) return hit0;

  let result = null;
  // 1) direct slug
  const direct = await leaflyFetchJson(LEAFLY_API + toSlug(cleaned));
  if (direct && direct.category) {
    result = { bucket: classifyLeafly(direct.category, direct.descriptionPlain || direct.shortDescriptionPlain), slug: direct.slug, category: direct.category, matchedName: direct.name };
  } else {
    // 2) search, accept a hit only if its name is a strong match (slug is a
    //    subset of, or equal to, our cleaned slug) — avoids Leafly's fuzzy
    //    top-hit returning an unrelated popular strain.
    const search = await leaflyFetchJson(`${LEAFLY_SEARCH}?query=${encodeURIComponent(cleaned)}&take=8`);
    const hits = (search && search.hits && search.hits.strain) || [];
    const mySlug = toSlug(cleaned);
    const hit = hits.find((h) => h.slug && (h.slug === mySlug || mySlug.includes(h.slug) || h.slug.includes(mySlug)));
    if (hit) {
      const full = await leaflyFetchJson(LEAFLY_API + hit.slug);
      const desc = (full && (full.descriptionPlain || full.shortDescriptionPlain)) || hit.shortDescriptionPlain;
      result = { bucket: classifyLeafly(hit.category, desc), slug: hit.slug, category: hit.category, matchedName: hit.name };
    }
  }
  // Only definitive answers reach here (network errors threw above).
  cache[cleaned] = result || { miss: true, at: new Date().toISOString() };
  return result;
}

// Resolve lineage for every hybrid/unknown listing by looking the strain up on
// Leafly. Mutates records in place. One lookup per DISTINCT strain, cached to
// disk, paced politely. Falls back to the offline dictionary on a miss.
//   only      optional predicate: look up just the listings where the answer can
//             matter (the finder passes "clears the THC floor and has a price" —
//             ~3/4 of hybrids fail the floor, so classifying them is wasted calls)
//   budgetMs  wall-clock cap on new network lookups. Leafly's search endpoint
//             can take 10 s+ per call; whatever isn't reached falls back to the
//             name dictionary this run and is fetched on a later run.
async function resolveLeanViaLeafly(records, { concurrency = 6, log = () => {}, only = null, budgetMs = 120000 } = {}) {
  const cache = loadStrainCache();
  const targets = records.filter((r) => (r.strainBucket === 'hybrid' || r.strainBucket === 'unknown') && (!only || only(r)));
  // group by cleaned strain so we look each strain up once
  const byStrain = new Map();
  for (const r of targets) {
    const cleaned = cleanStrainName(r.name, r.brand);
    if (!cleaned) continue;
    if (!byStrain.has(cleaned)) byStrain.set(cleaned, []);
    byStrain.get(cleaned).push(r);
  }
  const entries = [...byStrain.entries()];
  const netBefore = entries.filter(([c]) => cachedLeafly(cache, c) === undefined).length;
  log(`Looking up ${byStrain.size} distinct strain(s) on Leafly (${netBefore} to fetch, ${byStrain.size - netBefore} cached)...`);

  // Resolve all lookups with a bounded worker pool (network-bound -> parallel is
  // a huge speedup vs. sequential). Results collected, then applied below.
  const infoByStrain = new Map();
  let idx = 0, netErrors = 0, deferred = 0;
  const deadline = Date.now() + budgetMs;
  const worker = async () => {
    while (idx < entries.length) {
      const [cleaned] = entries[idx++];
      let info = null;
      const cached = cachedLeafly(cache, cleaned);
      if (cached !== undefined) info = cached; // cache hits are free — always apply them
      else if (Date.now() > deadline) deferred++;
      else { try { info = await leaflyClassifyStrain(cleaned, cache); } catch (_) { info = null; netErrors++; } }
      infoByStrain.set(cleaned, info);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length || 1) }, worker));
  if (netErrors) log(`⚠ ${netErrors} Leafly lookup(s) failed (network) — those strains fall back to the name dictionary this run and will be retried next run.`);
  if (deferred) log(`⚠ Leafly time budget (${Math.round(budgetMs / 1000)}s) reached — ${deferred} strain(s) not looked up this run (name dictionary only); they'll be fetched next run.`);

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
  // Weight: usually the menu/cart label is authoritative (it's the pack TOTAL).
  // But for a SINGLE whose product name states an explicit weight that disagrees
  // with the cart label (e.g. name "...1.3G" vs a stray cart "3g"), trust the
  // name — it's the product spec. Guard on pack-ish text so we never override a
  // multipack's total (where the name may show per-joint grams).
  const cartW = parseWeightGrams(raw.weightText || blob);
  const nameW = parseWeightGrams(raw.name || '');
  const packish = /\b\d+\s*(?:pk|pack|ct)\b|\bpre-?rolls\b|\bblunts\b/i.test(`${raw.name || ''} ${raw.weightText || ''} ${blob}`);
  let grams, weightLabel;
  // Structured rows (API data) carry the POS weight for THIS price option — never
  // let a weight mentioned in the product name override it (a "…14g" name on a
  // multi-weight product would otherwise price its 1/8 oz option as 14 g).
  if (!raw.structured && !packish && nameW.grams != null && cartW.grams != null && Math.abs(nameW.grams - cartW.grams) > 1e-6) {
    ({ grams, label: weightLabel } = nameW);
  } else {
    ({ grams, label: weightLabel } = cartW.grams != null ? cartW : nameW);
  }
  // Structured rows give lineage as its own field; an empty one means "none
  // given" — don't go fishing in the blob (it holds the product NAME, so a
  // strain called "Sativa Sunrise" would classify itself).
  const bucket = classifyStrain(raw.structured ? raw.strainText : (raw.strainText || blob));

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
  out.rawText = (raw.priceText ? `${raw.priceText} || ${blob}` : blob).slice(0, 400); // for --why tracing
  // Extra structured facts (stock, store specials, multi-buy price, source).
  if (raw.extra) Object.assign(out, raw.extra);
  if (out.bundle && grams) out.bundle = { ...out.bundle, pricePerGram: out.bundle.unitPrice / grams };

  // ---- Deal verification ------------------------------------------------
  // Free-text sniffing is for scraped card text only. On structured rows the
  // sale-vs-list pair IS the verification, and sniffing misfires on names (the
  // brand "Daze Off" tripped /OFF\b/ and earned every one of its jars a ⚠).
  const claimsDiscount = (!raw.structured && /%\s*off|OFF\b|\bdeal\b|\bsale\b/i.test(blob)) || original != null;
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
// Collapse duplicate rows for the SAME product+weight at the SAME store. Some
// Dutchie menus render a product twice (e.g. a "Featured"/staff-picks carousel
// AND the main grid), sometimes with the add-button weight labelled differently
// ("14G" vs "1/2 oz") — the per-card dedupe key (name::weightText::price) treats
// those as distinct, so the same jar shows up as two board rows. Key on the
// canonical product URL + gram weight (both grams are equal for a true dup);
// genuine multi-weight products keep separate rows because their grams differ.
// Keep the cheapest of any collision (and, tie, the one that already parsed a
// deal), so we never lose the best price.
function dedupeListings(list) {
  const best = new Map();
  const order = [];
  for (const r of list) {
    const idPart = r.url || `${r.name}|${r.brand}`;
    const gPart = r.grams != null ? r.grams.toFixed(2) : '?';
    const key = `${r.dispensaryId || r.dispensary}::${idPart}::${gPart}`;
    const prev = best.get(key);
    if (!prev) { best.set(key, r); order.push(key); continue; }
    const rp = r.pricePerGram ?? Infinity;
    const pp = prev.pricePerGram ?? Infinity;
    if (rp < pp) best.set(key, r); // strictly cheaper wins; equal keeps the first seen
  }
  return order.map((k) => best.get(k));
}

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
      const weightText = wMatch ? wMatch[1] : (segLines.find((l) => /oz|\bg\b|gram/i.test(l)) || '');
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

// ---- Dutchie structured path (preferred) -----------------------------------
// The embedded menu fills itself from a GraphQL call, `FilteredProducts`, that
// returns the store's products as JSON, 100 per page. The rendered page only
// ever shows page 1 (there is a pager at the bottom, not infinite scroll), so
// scraping the DOM silently missed everything past the first ~100 products —
// about 40% of a big menu like Earth's Healing. So instead of reading cards:
//   1. load the menu page as before (a real browser gets past Cloudflare) and
//      capture the page's OWN FilteredProducts request + response;
//   2. replay that exact request from inside the page for pages 2..N (same
//      query hash and headers — nothing hard-coded to go stale);
//   3. map the JSON to rows: one per in-stock weight option, with the POS
//      weight, list price and special price for the menu type we asked for.
// The DOM harvest below remains as the fallback if no such response shows up.

// THC as a percent from Dutchie's potency object. A few stores key the flower
// percent in with the unit set to MILLIGRAMS ("28.12 mg"); for flower a value in
// the plausible percent band can only be a percent, so read it as one.
function dutchieThcPercent(p, category) {
  const c = p.THCContent;
  const range = (c && Array.isArray(c.range) ? c.range : []).filter((n) => typeof n === 'number' && n > 0);
  if (!range.length) return { thc: null, note: null };
  const v = +Math.min(...range).toFixed(2); // some stores publish 28.6792


  if (c.unit === 'PERCENTAGE') return { thc: v, note: null };
  if (c.unit === 'MILLIGRAMS' && /flower/i.test(category || '') && v >= 5 && v <= 45) {
    return { thc: v, note: `THC listed as ${v} mg on the menu — read as ${v}%` };
  }
  return { thc: null, note: null };
}

// Best "N for $X" multi-buy that applies to ONE weight option of a product, from
// Dutchie's own special data (not from the special's name):
//   specialIdsPerOption  -> which special ids apply to this option
//   bogoSpecials[].itemsForAPrice {enabled, value}      -> the bundle total
//   bogoSpecials[].bogoRewards[].totalQuantity.quantity -> how many you must buy
// Only plain "buy N of these for $X" bundles are computed; specials with a
// separate buy-condition ("buy A, get B") are left alone. Returns
// { label, qty, unitPrice, special } or null. Shown on the card, never ranked.
function dutchieBundleFor(p, opt, pricingType, charged) {
  const per = (p.specialIdsPerOption || []).find((o) => o && o.option === opt);
  const ids = new Set([...(per && per.rewardIds || []), ...(per && per.conditionIds || [])]);
  if (!ids.size) return null;
  let best = null;
  for (const s of ((p.specialData || {}).bogoSpecials || [])) {
    if (!s || !ids.has(s.specialId)) continue;
    const mt = String(s.menuType || 'both').toLowerCase();
    if (mt !== 'both' && !mt.startsWith(pricingType)) continue;
    if ((s.bogoConditions || []).length) continue;
    const total = s.itemsForAPrice && s.itemsForAPrice.enabled ? Number(s.itemsForAPrice.value) : NaN;
    const rw = (s.bogoRewards || []).find((r) => r && r.totalQuantity && r.totalQuantity.enabled);
    const qty = rw ? Number(rw.totalQuantity.quantity) : NaN;
    if (!(total > 0) || !(qty >= 2)) continue;
    const unitPrice = total / qty;
    if (unitPrice < charged && (!best || unitPrice < best.unitPrice)) {
      best = { label: `${qty} for $${Number.isInteger(total) ? total : total.toFixed(2)}`, qty, unitPrice, special: s.specialName || null };
    }
  }
  return best;
}

// One Dutchie product -> raw rows for normalizeListing (pure; unit-tested).
// pricingType 'med' | 'rec' selects medicalPrices/medicalSpecialPrices or the
// rec pair; Options[i] lines up with each price array by index.
function dutchieProductToRaws(p, pricingType, slug, category = 'flower') {
  const med = pricingType === 'med';
  if (med ? p.recOnly : p.medicalOnly) return [];
  const options = p.Options || [];
  const list = (med ? p.medicalPrices : p.recPrices) || p.Prices || [];
  const special = (med ? p.medicalSpecialPrices : p.recSpecialPrices) || [];
  const below = new Set(p.optionsBelowThreshold || []);
  const children = (p.POSMetaData && p.POSMetaData.children) || [];
  const { thc, note } = dutchieThcPercent(p, category);
  const sd = p.specialData || {};
  const specials = [...(sd.saleSpecials || []), ...(sd.bogoSpecials || [])].map((s) => s && s.specialName).filter(Boolean);
  const rows = [];
  options.forEach((opt, i) => {
    const lp = Number(list[i]);
    if (!(lp > 0) || below.has(opt)) return;
    const sp = special.length === options.length ? Number(special[i]) : NaN;
    const onSale = sp > 0 && sp < lp;
    const child = children.find((c) => c && c.option === opt);
    rows.push({
      structured: true,
      name: p.Name || '',
      brand: p.brandName || (p.brand && p.brand.name) || '',
      strainText: p.strainType || '',
      thcText: thc != null ? `THC: ${thc}%` : '',
      weightText: opt,
      priceText: onSale ? `$${sp} | $${lp}` : `$${lp}`,
      url: p.cName ? `https://dutchie.com/embedded-menu/${slug}/product/${p.cName}` : null,
      extra: {
        stock: child && child.quantityAvailable != null ? child.quantityAvailable : null,
        specials: [...new Set(specials)],
        bundle: dutchieBundleFor(p, opt, pricingType, onSale ? sp : lp),
        subcategory: p.subcategory || null,
        ...(note ? { thcNote: note } : {}),
      },
    });
  });
  return rows;
}

// Load one menu URL and return every product via the page's own GraphQL call.
// Returns { products, total } or null when the page never made that call.
async function fetchDutchieStructured(page, url) {
  const isProductList = (r) => {
    const u = r.url();
    if (!/operationName=FilteredProducts/.test(u) || r.status() !== 200) return false;
    try {
      const v = JSON.parse(new URL(u).searchParams.get('variables'));
      return v && v.productsFilter && !(v.productsFilter.productIds || []).length && typeof v.page === 'number';
    } catch (_) { return false; }
  };
  const waiter = page.waitForResponse(isProductList, { timeout: 25000 }).catch(() => null);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  const first = await waiter;
  if (!first) return null;
  const body = await first.json().catch(() => null);
  const fp = body && body.data && body.data.filteredProducts;
  if (!fp || !Array.isArray(fp.products)) return null;
  const products = [...fp.products];
  const totalPages = (fp.queryInfo && fp.queryInfo.totalPages) || 1;
  const total = (fp.queryInfo && fp.queryInfo.totalCount) ?? products.length;

  // Replay the same request for the remaining pages from inside the page.
  const reqUrl = first.url();
  const reqHeaders = first.request().headers();
  const headers = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (k === 'content-type' || k === 'accept' || k.startsWith('apollographql-') || (k.startsWith('x-') && !k.startsWith('x-client-data'))) headers[k] = v;
  }
  for (let n = 1; n < totalPages && n < 30; n++) {
    const u = new URL(reqUrl);
    const vars = JSON.parse(u.searchParams.get('variables'));
    vars.page = n;
    u.searchParams.set('variables', JSON.stringify(vars));
    let got = null;
    for (let attempt = 0; attempt < 2 && !got; attempt++) {
      got = await page.evaluate(async ({ url, headers }) => {
        try {
          const r = await fetch(url, { headers, credentials: 'include' });
          if (!r.ok) return null;
          const j = await r.json();
          return (j && j.data && j.data.filteredProducts && j.data.filteredProducts.products) || null;
        } catch (_) { return null; }
      }, { url: u.toString(), headers }).catch(() => null);
      if (!got) await page.waitForTimeout(1200);
    }
    if (!got) throw new Error(`page ${n + 1}/${totalPages} of the product list failed to load`);
    products.push(...got);
  }
  // de-dupe by id (featured rows can repeat across pages)
  const seen = new Set();
  const uniq = products.filter((p) => { const k = p.id || p._id || p.cName; if (seen.has(k)) return false; seen.add(k); return true; });
  return { products: uniq, total };
}

// Scrape one Dutchie store. Returns { rows, menu:'med'|'rec'|null, source, error }.
async function scrapeDutchie(context, disp, opts) {
  const log = opts.log || console.log;
  const primary = disp.menuType || 'rec';
  const category = opts.category || 'flower';
  const tryOrder = primary === 'med' ? ['med', 'rec'] : [primary];
  log(`\n▶ ${disp.name} (dutchie:${disp.slug})`);
  let lastErr = null;
  if (!opts.domOnly) {
    for (let i = 0; i < tryOrder.length; i++) {
      const mt = tryOrder[i];
      const url = `https://dutchie.com/embedded-menu/${disp.slug}/products/${category}?menuType=${mt}`;
      const page = await context.newPage();
      try {
        const res = await fetchDutchieStructured(page, url);
        await page.close().catch(() => {});
        if (!res) { lastErr = 'no product-list response'; break; } // page shape changed / blocked -> DOM fallback
        const usedRec = mt === 'rec' && primary === 'med';
        const raws = res.products.flatMap((p) => dutchieProductToRaws(p, mt, disp.slug, category));
        if (!raws.length) {
          if (i < tryOrder.length - 1) { log(`   ${mt} menu is empty — trying ${tryOrder[i + 1]} menu…`); continue; }
          log(`   menu answered but lists no ${category} products (store closed online ordering or left Dutchie?)`);
          return { rows: [], menu: null, source: 'api', error: `menu lists no ${category} products`, products: 0, definitive: true };
        }
        log(`   ${res.products.length} product(s) → ${raws.length} priced option(s)${usedRec ? '  ⚠ REC menu (store has no medical menu — prices flagged “rec”)' : ''}`);
        // totalCount runs a little high (the server drops a few below-stock rows
        // after paginating), so only flag a real shortfall.
        if (res.products.length < res.total * 0.85) log(`   ⚠ menu reports ${res.total} products but only ${res.products.length} came back`);
        const label = disp.name + (usedRec ? ' · rec' : '');
        const rows = raws.slice(0, opts.maxPerStore * 4).map((c) => normalizeListing({ dispensary: label, dispensaryId: disp.id, ...c }));
        return { rows, menu: mt, source: 'api', error: null, products: res.products.length };
      } catch (e) {
        lastErr = e.message;
        log(`   structured read failed on ${mt}: ${e.message}`);
        await page.close().catch(() => {});
        break; // fall back to the DOM harvest
      }
    }
    log(`   ↪ falling back to reading the rendered page (${lastErr || 'unknown'}) — page 1 only`);
  }
  const rows = await scrapeDutchieDom(context, disp, opts);
  return { rows, menu: rows.length ? (/· rec$/.test(rows[0].dispensary) ? 'rec' : primary) : null, source: 'dom', error: rows.length ? null : (lastErr || 'no product cards found') };
}

// ---- Dutchie DOM fallback (the original scraper; page 1 of the menu only) ----
async function scrapeDutchieDom(context, disp, opts) {
  const console = { log: opts.log || globalThis.console.log }; // route through the per-store log buffer
  const primary = disp.menuType || 'rec';
  // Medical-first, then fall back to the REC menu for rec-only stores. The user
  // wants rec deals included when a store has no medical menu (e.g. Sol Flower is
  // rec-only). Rec-sourced items are FLAGGED (dispensary name gets a " · rec"
  // suffix) so medical vs rec pricing is never confused on the board.
  const tryOrder = primary === 'med' ? ['med', 'rec'] : [primary];
  for (let i = 0; i < tryOrder.length; i++) {
    const mt = tryOrder[i];
    const url = `https://dutchie.com/embedded-menu/${disp.slug}/products/${opts.category || 'flower'}?menuType=${mt}`;
    const page = await context.newPage();
    try {
      await gotoAndSettle(page, url);
      const bad = await page.evaluate(() => /can't find|not found|404|no products/i.test(document.body?.innerText || '')).catch(() => false);
      await page.waitForTimeout(1200);
      const count = await autoScroll(
        page,
        () => Array.from(document.querySelectorAll('button')).filter((b) => /add .* to cart|^add\b/i.test((b.textContent || '').trim())).length
      );
      if (!count) {
        await page.close();
        if (i < tryOrder.length - 1) { console.log(`   no cards on ${mt} menu${bad ? ' (not-found)' : ''} — trying ${tryOrder[i + 1]} menu…`); continue; }
        console.log(`   no product cards found${bad ? ' (menu says not-found — slug likely wrong)' : ''} — skipping`);
        return [];
      }
      const cards = await page.evaluate(DUTCHIE_HARVEST);
      const usedRec = mt === 'rec' && primary === 'med';
      console.log(`   harvested ${cards.length} card(s)${usedRec ? '  ⚠ REC menu (store has no medical menu — prices flagged “rec”)' : ''}`);
      await page.close();
      const label = disp.name + (usedRec ? ' · rec' : '');
      return cards.slice(0, opts.maxPerStore).map((c) =>
        normalizeListing({ dispensary: label, dispensaryId: disp.id, ...c })
      );
    } catch (e) {
      console.log(`   error on ${mt}: ${e.message}`);
      await page.close().catch(() => {});
      // fall through to next menu type if any
    }
  }
  return [];
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
async function scrapeJars(context, disp, opts, hooks = {}) {
  // Sibling finders (e.g. pre-rolls) reuse the whole store-switch flow but need a
  // different category page and record mapper. Default to flower behavior.
  const category = hooks.category || 'flower';
  const mapCard = hooks.mapCard || normalizeListing;
  const page = await context.newPage();
  const mode = disp.mode || 'rec';
  const token = disp.match || disp.store;
  const wantSlug = (disp.shopSlug || '').toLowerCase();
  console.log(`\n▶ ${disp.name} (jars custom flow)`);
  try {
    await gotoAndSettle(page, `https://jarscannabis.com/category/${category}`);
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
      await gotoAndSettle(page, `https://jarscannabis.com/category/${category}`);
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
    await gotoAndSettle(page, `https://jarscannabis.com/category/${category}`);
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
      mapCard({ dispensary: disp.name, dispensaryId: disp.id, ...c })
    );
  } catch (e) {
    console.log(`   error: ${e.message} — skipping`);
    await page.close().catch(() => {});
    return [];
  }
}

// JARS: read the store's menu from the storefront's backend API (jars-api.js) —
// plain HTTPS, store chosen by retailer id, so no browser, age gate, store
// switching or IP geo-lock. Returns the same shape as scrapeDutchie.
async function scrapeJarsApi(disp, opts) {
  const log = opts.log || console.log;
  log(`\n▶ ${disp.name} (jars api)`);
  const jars = require('./jars-api.js');
  const category = JARS_CATEGORY[(opts.category || 'flower').toLowerCase()];
  if (!category) { log(`   no JARS category mapping for "${opts.category}" — skipping`); return { rows: [], menu: null, source: 'api', error: `unsupported category ${opts.category}` }; }
  try {
    const r = await jars.pullStore(disp, { category });
    const label = disp.name + (r.usedRec ? ' · rec' : '');
    log(`   ${r.products.length} product(s) → ${r.cards.length} in-stock option(s) on the ${r.menuType.toLowerCase()} menu${r.usedRec ? '  ⚠ store has no medical menu — prices flagged “rec”' : ''}  [${r.store.address || r.store.id}]`);
    const rows = r.cards.map((c) => normalizeListing({ dispensary: label, dispensaryId: disp.id, ...c }));
    return { rows, menu: r.menuType === 'MEDICAL' ? 'med' : 'rec', source: 'api', error: rows.length ? null : 'store returned no products', products: r.products.length };
  } catch (e) {
    log(`   ✗ JARS API failed: ${e.message}`);
    return { rows: [], menu: null, source: 'api', error: e.message };
  }
}
const JARS_CATEGORY = { flower: 'FLOWER', 'pre-rolls': 'PRE_ROLLS', prerolls: 'PRE_ROLLS', concentrates: 'CONCENTRATES', vaporizers: 'VAPORIZERS', edibles: 'EDIBLES' };

// -> { rows, menu, source, error }
async function scrapeDispensary(context, disp, opts) {
  if (disp.platform === 'dutchie') return scrapeDutchie(context, disp, opts);
  if (disp.platform === 'jars') return scrapeJarsApi(disp, opts);
  (opts.log || console.log)(`(skipping ${disp.name}: unknown platform "${disp.platform}")`);
  return { rows: [], menu: null, source: null, error: `unknown platform "${disp.platform}"` };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const money = (n) => (n == null ? '   —  ' : `$${n.toFixed(2)}`);
const ppg = (n) => (n == null ? '  —  ' : `$${n.toFixed(2)}`);

function printTable(ranked, dropped, opts) {
  console.log(`\n${'='.repeat(92)}`);
  console.log(
    `BEST VALUE ${(opts.category || 'flower').toUpperCase()} — THC ≥ ${opts.minThc}%, sativa${opts.includeHybrid ? ' / sativa-hybrid / hybrid' : ' & sativa-dominant hybrid'} only`
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

  // --why <regex>: trace a specific product through the filter.
  if (opts.why) {
    const re = new RegExp(opts.why, 'i');
    const hits = [
      ...ranked.filter((r) => re.test(r.name || '')).map((r) => ({ r, reason: 'KEPT' })),
      ...dropped.filter((d) => re.test(d.r.name || '')),
    ];
    console.log(`\n--why /${opts.why}/: ${hits.length} scraped listing(s) matched`);
    for (const d of hits) {
      console.log(`   ${d.reason === 'KEPT' ? '✓' : '✗'} ${d.r.name} @ ${d.r.dispensary} [${d.r.weightLabel || '?'} ${d.r.charged ?? '?'} thc=${d.r.thc} ${d.r.strainLabel}] — ${d.reason}`);
      if (d.reason !== 'KEPT') console.log(`       raw: ${String(d.r.rawText || '').slice(0, 400)}`);
    }
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

function writeJson(p, ranked, dropped, opts, coverage = []) {
  fs.writeFileSync(
    p,
    JSON.stringify({ opts, generatedAt: new Date().toISOString(), count: ranked.length, coverage, results: ranked, droppedCount: dropped.length }, null, 2)
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

  // normalize: single-option card with price+weight on one line (Tucson Saints)
  const rTw = normalizeListing({
    dispensary: 'T', name: 'Pre-Ground: Timewreck 14g', weightText: '1/2 oz', priceText: '$25.00 - 1/2 oz',
    blob: 'Pre-Ground: Timewreck 14g | SAINTS | Sativa | THC: 30.76% | $25.00 - 1/2 oz',
  });
  check('"$25.00 - 1/2 oz" parses: $/g = 25/14', approx(rTw.pricePerGram, 25 / 14), rTw.pricePerGram);
  check('"$30 Half Ounces" promo is NOT a price', parsePrices('$30 Half Ounces').length === 0);

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

  // ---- 2026-11-14 additions ------------------------------------------------
  // weights: decimal oz used to parse as "5 oz"; fused "1/8oz" is Dutchie's option format
  check('0.5 oz = 14g (not 140g)', parseWeightGrams('0.5 oz').grams === 14, parseWeightGrams('0.5 oz').grams);
  check('.5oz = 14g', parseWeightGrams('.5oz').grams === 14, parseWeightGrams('.5oz').grams);
  check('1/8oz fused = 3.5g', parseWeightGrams('1/8oz').grams === 3.5);
  check('1oz fused = 28g', parseWeightGrams('1oz').grams === 28);
  // lineage: hyphenated labels (Dutchie data) — "Sativa-Hybrid" must NOT read as pure sativa
  check('classify Sativa-Hybrid', classifyStrain('Sativa-Hybrid') === 'sativa_hybrid', classifyStrain('Sativa-Hybrid'));
  check('classify Indica-Hybrid', classifyStrain('Indica-Hybrid') === 'indica_hybrid', classifyStrain('Indica-Hybrid'));
  check('classify NOT_APPLICABLE = unknown', classifyStrain('') === 'unknown' && classifyStrain('N/A') === 'unknown');

  // Dutchie product JSON -> rows
  const dp = {
    Name: 'DAZE OFF 14G PRE-GROUND | HEADBAND', brandName: 'Daze Off', strainType: 'Sativa', cName: 'daze-off-headband',
    THCContent: { unit: 'PERCENTAGE', range: [31.78] }, Options: ['1/8oz', '1/2oz', '1oz'],
    medicalPrices: [12, 30, 55], medicalSpecialPrices: [12, 24, 55], recPrices: [14, 34, 60], recSpecialPrices: [14, 34, 60],
    optionsBelowThreshold: ['1oz'], special: true,
    specialData: { saleSpecials: [{ specialName: 'Half Oz Friday' }], bogoSpecials: null },
    POSMetaData: { children: [{ option: '1/2oz', quantityAvailable: 3 }] },
  };
  const dMed = dutchieProductToRaws(dp, 'med', 'store-x').map((r) => normalizeListing({ dispensary: 'T', ...r }));
  check('dutchie: one row per in-stock option (1oz below threshold dropped)', dMed.length === 2, dMed.length);
  const dHalf = dMed.find((r) => r.grams === 14) || {};
  check('dutchie: half-oz = special $24 vs list $30', dHalf.charged === 24 && dHalf.original === 30 && dHalf.discountPct === 20 && dHalf.dealReal === true, `${dHalf.charged}/${dHalf.original}/${dHalf.discountPct}`);
  check('dutchie: option weight wins over the "14G" in the name', (dMed.find((r) => r.charged === 12) || {}).grams === 3.5, (dMed.find((r) => r.charged === 12) || {}).grams);
  check('dutchie: special == list is NOT a deal', (dMed.find((r) => r.grams === 3.5) || {}).dealReal === null);
  check('dutchie: brand "Daze Off" no longer trips the ⚠ sniff', dMed.every((r) => r.dealReal !== false));
  check('dutchie: stock + special name carried', dHalf.stock === 3 && (dHalf.specials || [])[0] === 'Half Oz Friday', JSON.stringify([dHalf.stock, dHalf.specials]));
  check('dutchie: url from cName', dHalf.url === 'https://dutchie.com/embedded-menu/store-x/product/daze-off-headband', dHalf.url);
  const dRec = dutchieProductToRaws(dp, 'rec', 'store-x').map((r) => normalizeListing({ dispensary: 'T', ...r }));
  check('dutchie: rec menu uses rec prices', (dRec.find((r) => r.grams === 14) || {}).charged === 34, (dRec.find((r) => r.grams === 14) || {}).charged);
  check('dutchie: medicalOnly product hidden on rec', dutchieProductToRaws({ ...dp, medicalOnly: true }, 'rec', 's').length === 0);
  check('dutchie: THC keyed as mg on flower reads as %', dutchieThcPercent({ THCContent: { unit: 'MILLIGRAMS', range: [28.12] } }, 'flower').thc === 28.12);
  check('dutchie: THC mg off-band stays unknown', dutchieThcPercent({ THCContent: { unit: 'MILLIGRAMS', range: [850] } }, 'flower').thc === null);
  const dBundle = { ...dp, specialIdsPerOption: [{ option: '1/8oz', rewardIds: ['s1'] }, { option: '1/2oz', rewardIds: [] }],
    specialData: { saleSpecials: [], bogoSpecials: [{ specialId: 's1', specialName: '8ths Bundle 4 for $39.99', menuType: 'both', bogoConditions: [], itemsForAPrice: { enabled: true, value: '39.99' }, bogoRewards: [{ totalQuantity: { enabled: true, quantity: 4 } }] }] } };
  const dB = dutchieProductToRaws(dBundle, 'med', 's').map((r) => normalizeListing({ dispensary: 'T', ...r }));
  const dB8 = dB.find((r) => r.grams === 3.5) || {};
  check('dutchie: "4 for $39.99" bundle lands on the 1/8 option only', dB8.bundle && dB8.bundle.qty === 4 && approx(dB8.bundle.pricePerGram, 39.99 / 4 / 3.5) && !(dB.find((r) => r.grams === 14) || {}).bundle, JSON.stringify(dB8.bundle));
  check('dutchie: bundle never changes the ranked $/g', approx(dB8.pricePerGram, 12 / 3.5), dB8.pricePerGram);
  check('dutchie: THC rounded to 2 dp', dutchieThcPercent({ THCContent: { unit: 'PERCENTAGE', range: [28.6792] } }, 'flower').thc === 28.68);
  check('dutchie: THC range -> lower bound', dutchieThcPercent({ THCContent: { unit: 'PERCENTAGE', range: [24.5, 29] } }, 'flower').thc === 24.5);

  // JARS API product JSON -> rows
  const jars = require('./jars-api.js');
  const jp = [{
    productName: 'Fenix Fuerzzza Supercharged 14g Pina Punch', brandName: 'Fenix', strainType: 'SATIVA_HYBRID', slug: 'fenix-pina-punch',
    potencyThc: { unit: '%', range: [28.89] }, specials: [{ name: 'Fenix - $40 Supercharged Half Ounces' }, { name: 'Fenix - BOGO (MSRP) Supercharged Half Ounces Mix & Match' }],
    variants: [
      { option: '14g', priceMed: 70, specialPriceMed: 40, priceRec: 75, specialPriceRec: 45, quantity: 9 },
      { option: '3.5g', priceMed: 20, specialPriceMed: 12, priceRec: 20, specialPriceRec: 12, quantity: 0 },
    ],
  }];
  const jMed = jars.toRawCards(jp, { menuType: 'MEDICAL' }).map((r) => normalizeListing({ dispensary: 'JARS', ...r }));
  check('jars: out-of-stock variant skipped', jMed.length === 1, jMed.length);
  const j0 = jMed[0] || {};
  check('jars: med sale $40 vs list $70 = $2.86/g, 43% verified', j0.charged === 40 && j0.original === 70 && approx(j0.pricePerGram, 40 / 14) && j0.discountPct === 43 && j0.dealReal === true, `${j0.charged}/${j0.original}/${j0.discountPct}`);
  check('jars: 5-level lineage kept (SATIVA_HYBRID)', j0.strainBucket === 'sativa_hybrid' && j0.thc === 28.89 && j0.jars === true);
  check('jars: BOGO (MSRP) = 2 for list price -> $2.50/g bundle', j0.bundle && j0.bundle.qty === 2 && approx(j0.bundle.pricePerGram, 35 / 14), JSON.stringify(j0.bundle));
  check('jars: rec menu uses rec pair', jars.toRawCards(jp, { menuType: 'RECREATIONAL' })[0].priceText === '$45 | $75');
  check('jars: "2 for $85" bundle', (jars.bundleFromSpecial('Mohave - 2 for $85 Select Halves', 59) || {}).unitPrice === 42.5);
  check('jars: mixed bundle is label-only', jars.bundleFromSpecial('Mohave - 2 Reserve Eighths + 1 Select Eighth for $30', 25) === null);
  check('jars: plain "$30 Half Ounces" is not a bundle', jars.bundleFromSpecial('Fleur - $30 Half Ounces', 70) === null);
  // LZ-UTF8: "abc" + pointer(len 3, dist 3) -> "abcabc"; a real 2-byte UTF-8 char passes through
  check('lzutf8 back-reference', jars.lzutf8Decode(Buffer.from([0x61, 0x62, 0x63, 0xc3, 0x03]).toString('base64')) === 'abcabc');
  check('lzutf8 keeps real UTF-8', jars.lzutf8Decode(Buffer.from('café – ok', 'utf8').toString('base64')) === 'café – ok');

  // Leafly cache: classifications stick, fresh misses stick, legacy/stale misses get re-checked
  const lc = { a: { bucket: 'sativa' }, b: { miss: true, at: new Date().toISOString() }, c: null, d: { miss: true, at: '2020-01-01T00:00:00Z' } };
  check('leafly cache: hit', cachedLeafly(lc, 'a') === lc.a);
  check('leafly cache: fresh miss is trusted', cachedLeafly(lc, 'b') === null);
  check('leafly cache: legacy null + stale miss are re-fetched', cachedLeafly(lc, 'c') === undefined && cachedLeafly(lc, 'd') === undefined && cachedLeafly(lc, 'zz') === undefined);

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
  } else {
    // By default skip best-guess slugs so a first run doesn't look broken, and
    // stores known to be gone (kept in the list, with the reason, so it's a
    // visible decision rather than a silent hole).
    if (!opts.includeVerify) list = list.filter((d) => !d.verify);
    for (const d of list.filter((x) => x.disabled)) console.log(`(not checking ${d.name}: ${d.disabled})`);
    list = list.filter((d) => !d.disabled);
  }
  return list;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.selftest) return selftest();

  const dispensaries = loadDispensaries(opts);
  if (!dispensaries.length) {
    console.error('No dispensaries selected. Check --only ids or your --config file.');
    process.exit(1);
  }
  // Only the Dutchie stores need a browser; JARS is plain HTTPS.
  if (!chromium && dispensaries.some((d) => d.platform === 'dutchie')) {
    console.error('playwright is not installed. Run:  npm install playwright && npx playwright install chromium');
    console.error('(JARS-only runs and the math checks work without it:  --only jars-east-tucson  /  --selftest)');
    process.exit(1);
  }

  console.log(`Weed value finder — THC ≥ ${opts.minThc}%, ${opts.includeHybrid ? 'sativa + coarse hybrids' : 'sativa & sativa-dominant hybrids'}`);
  console.log(`Dispensaries (${dispensaries.length}): ${dispensaries.map((d) => d.name).join(', ')}`);
  if (!opts.includeVerify) console.log(`(unverified best-guess slugs skipped; add --include-unverified-slugs to try them)`);

  const needBrowser = dispensaries.some((d) => d.platform === 'dutchie');
  const browser = needBrowser ? await chromium.launch({ headless: !opts.headed }) : null;
  const context = browser ? await makeContext(browser) : null;

  // Scrape stores a few at a time. Each store logs into its own buffer, printed
  // whole when the store finishes, so parallel output stays readable. A store
  // that comes back empty with an error gets one retry at the end.
  const results = new Map(); // disp.id -> { rows, menu, source, error, ms }
  const runOne = async (disp) => {
    const buf = [];
    const t0 = Date.now();
    let r;
    try { r = await scrapeDispensary(context, disp, { ...opts, log: (m) => buf.push(m) }); }
    catch (e) { r = { rows: [], menu: null, source: null, error: e.message }; buf.push(`   error: ${e.message}`); }
    r.ms = Date.now() - t0;
    console.log(buf.join('\n'));
    results.set(disp.id, r);
  };
  const pool = async (list, size) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => {
      while (i < list.length) {
        const disp = list[i++];
        await runOne(disp);
        await new Promise((res) => setTimeout(res, 400 + Math.random() * 600)); // polite pacing
      }
    }));
  };
  await pool(dispensaries, opts.concurrency);
  const failed = dispensaries.filter((d) => { const r = results.get(d.id); return !r.rows.length && r.error && !r.definitive; });
  if (failed.length) {
    console.log(`\n↻ retrying ${failed.length} store(s) that came back empty: ${failed.map((d) => d.name).join(', ')}`);
    await pool(failed, 1);
  }
  if (browser) await browser.close();

  let all = [];
  for (const disp of dispensaries) all = all.concat(results.get(disp.id).rows);
  console.log(`\nParsed ${all.length} total listing(s) across ${dispensaries.length} store(s).`);
  if (!opts.strictLineage) {
    // Preferred: actually look each hybrid/unknown strain up on Leafly.
    if (!opts.noStrainLookup) {
      await resolveLeanViaLeafly(all, {
        log: (m) => console.log(m),
        // lineage only matters for a listing that could otherwise make the board
        only: (r) => r.pricePerGram != null && r.thc != null && r.thc >= opts.minThc && (opts.maxPpg == null || r.pricePerGram <= opts.maxPpg),
      });
    }
    // Offline dictionary catches anything Leafly didn't resolve.
    all.forEach(applyLeanInference);
    const n = all.filter((r) => r.inferred).length;
    console.log(`Total sativa-leaning listings rescued from hybrid/unknown: ${n} (≈). Use --strict-lineage for menu labels only.`);
  }
  const deduped = dedupeListings(all);
  if (deduped.length !== all.length) {
    console.log(`De-duplicated ${all.length - deduped.length} repeated product row(s) (same store+URL+weight).`);
  }
  const { kept, dropped } = applyFilters(deduped, opts);
  const ranked = rankListings(kept, opts.preferSativa);

  // Per-store coverage: what was actually read, so a store that silently failed
  // can never pass for "nothing qualified there today".
  const coverage = dispensaries.map((d) => {
    const r = results.get(d.id);
    return {
      id: d.id, name: d.name, platform: d.platform, ok: r.rows.length > 0, menu: r.menu, source: r.source,
      listings: r.rows.length, qualified: ranked.filter((x) => x.dispensaryId === d.id).length,
      error: r.rows.length ? null : (r.error || 'no listings'), ms: r.ms,
    };
  });

  printTable(ranked, dropped, opts);
  printCoverage(coverage);
  if (opts.jsonOut) writeJson(opts.jsonOut, ranked, dropped, opts, coverage);
  if (opts.csvOut) writeCsv(opts.csvOut, ranked);
  if (!coverage.some((c) => c.ok)) { console.error('\nEvery store failed — nothing was read.'); process.exit(1); }
}

function printCoverage(coverage) {
  console.log(`\nCOVERAGE — ${coverage.filter((c) => c.ok).length}/${coverage.length} stores read`);
  for (const c of coverage) {
    const how = c.ok ? `${String(c.listings).padStart(4)} listings, ${String(c.qualified).padStart(2)} qualify  (${c.menu}${c.source === 'dom' ? ', page-1 fallback' : ''}, ${(c.ms / 1000).toFixed(1)}s)` : `NOT READ — ${c.error}`;
    console.log(`   ${c.ok ? '✓' : '✗'} ${c.name.padEnd(30)} ${how}`);
  }
  const bad = coverage.filter((c) => !c.ok);
  if (bad.length) console.log(`\n⚠  ${bad.length} store(s) were NOT read this run: ${bad.map((c) => c.name).join(', ')}. The board does not cover them.`);
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
  dutchieProductToRaws, dutchieThcPercent, dedupeListings,
  scrapeJars, BUCKET_LABEL, BUCKET_RANK, DISPENSARIES,
};
