/**
 * jars-api.js — read a JARS store's menu straight from the storefront's own
 * backend API. No browser, no age gate, no store switching, no geo-lock.
 *
 * How it works
 * ------------
 * jarscannabis.com is a "Buddy eCommerce" storefront. Its pages get their data
 * from a public JSON API at jars-api.buddyapi.neutrixsystems.com. Two calls are
 * all we need:
 *
 *   GET  /retailer/all-retailer?type=Pickup
 *        every JARS store (id, name, address, which menus it has). The `data`
 *        field is LZ-UTF8-compressed + base64'd JSON (decoded below).
 *
 *   POST /product-service/filter
 *        { retailerId, menuType, provider, filter:{categories:[...]},
 *          pagination:{offset,limit} }
 *        the store's products as structured JSON: 5-level strain type, THC,
 *        and per-weight variants with list + special prices for MED and REC.
 *
 * The store is chosen by `retailerId` in the request body, so — unlike the
 * website, which picks a store from your IP and hides it in encrypted cookies —
 * this works for any store from any connection, and can never return the wrong
 * store's prices (every product echoes its retailerId; we verify it).
 *
 * This replaces the Playwright/CDP scrape (jars-daemon.js + jars-pull-cdp.js)
 * for the flower finder. run-flower-daily.js still falls back to that scrape if
 * this API ever stops answering.
 *
 * CLI (quick look, no files written):
 *   node jars-api.js                      # East Tucson + Green Valley + North Tucson flower
 *   node jars-api.js --stores             # list every JARS store the API knows
 *   node jars-api.js --category PRE_ROLLS # another category
 */
'use strict';

const API = 'https://jars-api.buddyapi.neutrixsystems.com/api/v1';
const SITE = 'https://jarscannabis.com';
const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json',
  origin: SITE,
  referer: SITE + '/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

// Known Tucson-area retailer ids (from /retailer/all-retailer, 2026-11-14). Used
// as a fallback when the retailer list can't be fetched; normally the id is
// re-resolved from the live list by street address every run.
const KNOWN_IDS = {
  'jars-east-tucson': '920b434d-b4c1-40a9-8fa1-69a61156cbe0',
  'jars-green-valley': '56537e44-d253-4571-9739-79981d703552',
  'jars-north-tucson': '4577c60f-021b-490f-a794-4af758d1c516',
};

// LZ-UTF8 decoder (the API compresses big payloads with the `lzutf8` library and
// base64s the result). Literal bytes pass through; a back-reference is a 2- or
// 3-byte sequence starting 110lllll / 111lllll whose NEXT byte has its top bit
// clear (which is what tells it apart from a real UTF-8 lead byte):
//   110lllll 0ddddddd            copy l bytes from d back
//   111lllll 0ddddddd dddddddd   copy l bytes from a 15-bit distance back
function lzutf8Decode(b64) {
  const inp = Buffer.from(b64, 'base64');
  const out = [];
  const n = inp.length;
  for (let i = 0; i < n; i++) {
    const v = inp[i];
    if ((v >>> 6) !== 3) { out.push(v); continue; }
    const kind = v >>> 5; // 6 = 2-byte pointer, 7 = 3-byte pointer
    if (i === n - 1 || (i === n - 2 && kind === 7) || (inp[i + 1] >>> 7) === 1) { out.push(v); continue; }
    const len = v & 31;
    let dist;
    if (kind === 6) { dist = inp[i + 1]; i += 1; } else { dist = (inp[i + 1] << 8) | inp[i + 2]; i += 2; }
    const start = out.length - dist;
    if (start < 0) throw new Error('lzutf8: back-reference before start of output');
    for (let k = 0; k < len; k++) out.push(out[start + k]);
  }
  return Buffer.from(out).toString('utf8');
}

async function http(path, { method = 'GET', body, timeoutMs = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(API + path, {
        method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Every JARS store. Handles both a plain array and the compressed-string form.
async function fetchRetailers() {
  const d = await http('/retailer/all-retailer?type=Pickup');
  const data = d && d.data;
  const list = typeof data === 'string' ? JSON.parse(lzutf8Decode(data)) : data;
  if (!Array.isArray(list) || !list.length) throw new Error('retailer list came back empty/unreadable');
  return list;
}

// Find a store in the live retailer list. `match` is a regex source tested
// against "name | address" — use the street address, it's the stable part.
function findRetailer(retailers, match) {
  const re = new RegExp(match, 'i');
  return retailers.find((r) => re.test(`${r.retailerName || r.name || ''} | ${r.address || ''}`)) || null;
}

/**
 * Resolve a dispensary config entry to { id, name, address, menuTypes }.
 * disp = { id:'jars-east-tucson', match:'Tanque Verde', ... }
 * Prefers the live list (so a re-issued retailer id heals itself); falls back to
 * the known id if the list is unreachable.
 */
async function resolveStore(disp, retailers) {
  let list = retailers;
  if (!list) { try { list = await fetchRetailers(); } catch (_) { list = null; } }
  const hit = list && findRetailer(list, disp.match || disp.name);
  if (hit) return { id: hit.id, name: (hit.retailerName || hit.name || '').trim(), address: hit.address || '', menuTypes: hit.menuTypes || [] };
  const known = disp.retailerId || KNOWN_IDS[disp.id];
  if (known) return { id: known, name: disp.name, address: '', menuTypes: [] };
  throw new Error(`JARS store "${disp.name}" not found in the retailer list and no known id`);
}

/**
 * All products of one category at one store, on one menu.
 * menuType: 'MEDICAL' | 'RECREATIONAL'.  category: 'FLOWER', 'PRE_ROLLS', ...
 * Paginates until the API's own productsCount is reached and verifies every
 * product belongs to the requested retailer.
 */
async function fetchProducts(retailerId, { menuType = 'MEDICAL', category = 'FLOWER', pageSize = 1000 } = {}) {
  // The API's sort order is NOT stable between requests (measured: offset 100
  // returned rows 62-161 of a prior full listing), so walking small pages skips
  // and repeats products. Ask for the whole category in one page — a store has
  // a few hundred flower products at most — and only page, unioning by product
  // id, if the store somehow has more than one page's worth.
  const byId = new Map();
  let total = Infinity;
  for (let offset = 0, guard = 0; byId.size < total && guard < 8; guard++) {
    const d = await http('/product-service/filter', {
      method: 'POST',
      body: { retailerId, menuType, provider: 'dutchie', filter: { categories: [category] }, pagination: { offset, limit: pageSize } },
    });
    const menu = d && d.menu;
    if (!menu || !Array.isArray(menu.products)) throw new Error(`unexpected product response shape: ${JSON.stringify(d).slice(0, 160)}`);
    total = Number(menu.productsCount) || menu.products.length;
    if (!menu.products.length) break;
    for (const p of menu.products) byId.set(p.id || p.productId || p.slug, p);
    offset += menu.products.length;
    if (offset >= total) offset = 0; // order shifted under us — sweep again for the stragglers
  }
  const all = [...byId.values()];
  const wrong = all.filter((p) => (p.retailerId && p.retailerId !== retailerId) || (p.category && p.category !== category));
  if (wrong.length) throw new Error(`${wrong.length} product(s) came back for the wrong store/category — refusing the batch`);
  if (Number.isFinite(total) && all.length < total) throw new Error(`store lists ${total} ${category} products but only ${all.length} could be read`);
  return all;
}

// A store special's name -> a multi-buy price, when the name states one we can
// compute safely. Returns { label, qty, unitPrice } or null.
//   "… BOGO (MSRP) …"        buy one at MSRP, get one free  -> 2 for MSRP
//   "… 2 for $85 …"          N for $X (single-product bundles only)
// Mixed bundles ("2 Reserve Eighths + 1 Select Eighth for $30") and a bare
// "BOGO" (unclear which price it applies to) are left as a label only.
function bundleFromSpecial(name, listPrice) {
  const s = String(name || '');
  if (/\+/.test(s)) return null;
  if (/\bBOGO\b/i.test(s)) {
    if (/\(MSRP\)/i.test(s) && listPrice > 0) return { label: `2 for $${fmt(listPrice)}`, qty: 2, unitPrice: listPrice / 2 };
    return null;
  }
  const m = s.match(/\b(\d{1,2})\s*for\s*\$\s*(\d+(?:\.\d{1,2})?)/i);
  if (m && Number(m[1]) >= 2) { const qty = Number(m[1]); const tot = Number(m[2]); return { label: `${qty} for $${fmt(tot)}`, qty, unitPrice: tot / qty }; }
  return null;
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Flatten API products into the "raw card" rows weed-value-finder's
 * normalizeListing() takes — one row per in-stock weight variant.
 * menuType picks which price pair is used (specialPriceMed/priceMed or the Rec
 * pair). Rows are marked `structured` so the normalizer trusts the fields as
 * given instead of sniffing free text.
 */
function toRawCards(products, { menuType = 'MEDICAL' } = {}) {
  const med = menuType === 'MEDICAL';
  const rows = [];
  for (const p of products) {
    const range = (p.potencyThc && p.potencyThc.range) || [];
    const unit = p.potencyThc && p.potencyThc.unit;
    const thc = range.length && (unit === '%' || unit == null) ? Math.min(...range) : null;
    const strain = p.strainType && p.strainType !== 'NOT_APPLICABLE' ? p.strainType : '';
    const specials = (p.specials || []).map((s) => s && s.name).filter(Boolean);
    for (const v of p.variants || []) {
      if (!(v.quantity > 0)) continue; // out of stock
      const list = med ? v.priceMed : v.priceRec;
      const special = med ? v.specialPriceMed : v.specialPriceRec;
      if (!(list > 0) && !(special > 0)) continue;
      const onSale = special > 0 && list > 0 && special < list;
      const charged = onSale ? special : (list > 0 ? list : special);
      // best computable multi-buy among this product's specials
      let bundle = null;
      for (const s of specials) {
        const b = bundleFromSpecial(s, list);
        if (b && b.unitPrice < charged && (!bundle || b.unitPrice < bundle.unitPrice)) bundle = { ...b, special: s };
      }
      rows.push({
        structured: true,
        name: p.productName || p.name || '',
        brand: p.brandName || (p.brand && p.brand.name) || '',
        strainText: strain,
        thcText: thc != null ? `THC: ${thc}%` : '',
        weightText: v.option || '',
        priceText: onSale ? `$${special} | $${list}` : `$${charged}`,
        url: `${SITE}/product/${p.slug || p.productSlug}`,
        extra: { jars: true, stock: v.quantity, specials, bundle, subcategory: p.subcategory || null },
      });
    }
  }
  return rows;
}

/**
 * One call for the finder: resolve the store, pick its menu (medical when the
 * store has one, else rec), fetch the category, return raw cards + metadata.
 * Never throws for "store has no medical menu" — reports usedRec instead.
 */
async function pullStore(disp, { category = 'FLOWER', retailers } = {}) {
  const store = await resolveStore(disp, retailers);
  const wantMed = (disp.mode || 'med') === 'med';
  const hasMed = !store.menuTypes.length || store.menuTypes.includes('MEDICAL');
  const menuType = wantMed && hasMed ? 'MEDICAL' : 'RECREATIONAL';
  const products = await fetchProducts(store.id, { menuType, category });
  return { store, menuType, usedRec: wantMed && menuType === 'RECREATIONAL', products, cards: toRawCards(products, { menuType }) };
}

module.exports = { fetchRetailers, findRetailer, resolveStore, fetchProducts, toRawCards, pullStore, bundleFromSpecial, lzutf8Decode, KNOWN_IDS };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const retailers = await fetchRetailers();
    if (args.includes('--stores')) {
      for (const r of retailers) console.log(`${r.id}  ${(r.retailerName || '').trim().padEnd(46)} ${(r.menuTypes || []).join('+').padEnd(22)} ${r.address}`);
      return;
    }
    const ci = args.indexOf('--category');
    const category = ci !== -1 && args[ci + 1] ? args[ci + 1].toUpperCase() : 'FLOWER';
    const { DISPENSARIES } = require('./weed-value-finder.js');
    for (const disp of DISPENSARIES.filter((d) => d.platform === 'jars')) {
      const t0 = Date.now();
      const r = await pullStore(disp, { category, retailers });
      console.log(`${disp.name}: ${r.products.length} ${category} product(s), ${r.cards.length} in-stock row(s) on ${r.menuType} — ${Date.now() - t0} ms  (${r.store.address})`);
    }
  })().catch((e) => { console.error('jars-api ERR:', e.message); process.exit(1); });
}
