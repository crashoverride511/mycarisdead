/**
 * jars-pull-cdp.js — the RELIABLE JARS pull: attach to the persistent-profile
 * daemon (jars-daemon.js, CDP 9222), switch to the target store's MEDICAL menu
 * via the flow verified live 2026-08-24, harvest flower + pre-rolls (paginated),
 * write the lists JSON. Prefer this over the fresh-launch jars-lists.js.
 *
 *   node jars-daemon.js &            # once
 *   JARS_WANT=jars-east-tucson JARS_TOKEN="east tucson" JARS_OUT=jars-east-tucson-lists.json JARS_LABEL="JARS - East Tucson" node jars-pull-cdp.js
 *   JARS_WANT=jars-green-valley JARS_TOKEN="green valley" JARS_OUT=jars-green-valley-lists.json JARS_LABEL="JARS - Green Valley" node jars-pull-cdp.js
 *
 * Exits 2 (FLAG) if it can't confirm the store+medical — never harvests the wrong
 * store, never falls back to rec/hand-entry.
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const flower = require('./weed-value-finder.js');
const pr = require('./preroll-value-finder.js');

const PORT = Number(process.env.JARS_PORT || 9222);
const WANT = process.env.JARS_WANT || 'jars-green-valley';
const TOKEN = process.env.JARS_TOKEN || 'green valley';
const OUT = process.env.JARS_OUT || 'jars-green-valley-lists.json';
const LABEL = process.env.JARS_LABEL || 'JARS - Green Valley';
const tokenSlug = WANT.replace(/^jars-/, '');
const tokenRe = new RegExp(TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const PROFILE = process.env.JARS_PROFILE || (PORT === 9223 ? '.jars-chrome-profile-gv' : '.jars-chrome-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is a CDP endpoint responding on this port?
const cdpUp = () => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 2000 }, () => { res(true); req.destroy(); });
  req.on('error', () => res(false));
  req.on('timeout', () => { req.destroy(); res(false); });
});

// NEVER ask a human to start the daemon on a port. If the CDP endpoint isn't up,
// launch jars-daemon.js ourselves (detached, headed) and wait for it. This is
// what stops the "go start the port manually" dead end — JARS is Playwright,
// end to end, no manual pass.
async function ensureDaemonSelf() {
  if (await cdpUp()) return true;
  console.log(`   no daemon on CDP ${PORT} — launching jars-daemon.js (profile ${PROFILE})`);
  const child = spawn('node', ['jars-daemon.js'], { cwd: __dirname, detached: true, stdio: 'ignore', env: { ...process.env, JARS_PROFILE: PROFILE, JARS_PORT: String(PORT) } });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await cdpUp()) return true; await sleep(1000); }
  return false;
}

const pickupAddr = (page) => page.evaluate(() => (document.body.innerText.match(/Pickup from\s*([^\n]+)/i) || [])[1] || '').catch(() => '');
const activeSlug = (page) => page.evaluate(() => {
  const a = Array.from(document.querySelectorAll('a[href*="/shop/"]')).map((x) => x.getAttribute('href') || '')
    .find((h) => /\/shop\/[a-z0-9-]+/i.test(h) && !/\/brand\//.test(h));
  return (a && a.match(/\/shop\/([a-z0-9-]+)/i)) ? RegExp.$1.toLowerCase() : '';
}).catch(() => '');

const HARVEST = () => {
  const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => /\/product\//.test((a.getAttribute('href') || '').split('?')[0]));
  const cardOf = (a) => {
    const distinct = (el) => { const s = new Set(); el.querySelectorAll('a[href]').forEach((y) => { const h = (y.getAttribute('href') || '').split('?')[0]; if (/\/product\//.test(h)) s.add(h); }); return s.size; };
    let el = a, prev = a; while (el.parentElement && distinct(el.parentElement) <= 1) { prev = el.parentElement; el = el.parentElement; } return prev;
  };
  const seen = new Set(); const out = [];
  for (const a of anchors) {
    const href = (a.getAttribute('href') || '').split('?')[0]; if (seen.has(href)) continue; seen.add(href);
    const card = cardOf(a); const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    out.push({ name: lines[1] || lines[0] || '', brand: lines[2] || '', strainText: lines.find((l) => /THC/i.test(l)) || '', weightText: lines.find((l) => /^\/?\d+(?:\.\d+)?\s*g/i.test(l) || /oz\b/i.test(l)) || '', priceText: lines.filter((l) => /^\$\s*\d/.test(l) && !/off|discount|for\b/i.test(l)).join(' | '), blob: lines.join(' | '), url: a.href });
  }
  return out;
};
async function scrollAll(page) { let last = -1; for (let i = 0; i < 40; i++) { const n = await page.evaluate(() => document.querySelectorAll('a[href*="/product/"]').length).catch(() => 0); if (n === last) break; last = n; await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {}); await sleep(700); } }
async function harvestAllPages(page) {
  const byHref = new Map(); const selNow = () => page.evaluate(() => (document.querySelector('li.shop-page-item.selected') || {}).textContent || '').catch(() => '');
  for (let p = 0; p < 40; p++) {
    await scrollAll(page); const cards = await page.evaluate(HARVEST).catch(() => []);
    for (const c of cards) { const k = (c.url || '').split('?')[0]; if (k && !byHref.has(k)) byHref.set(k, c); }
    const before = await selNow();
    const clicked = await page.evaluate(() => { const n = document.querySelector('a[aria-label="Next page"]'); if (!n) return false; if (n.getAttribute('aria-disabled') === 'true' || /disabled/.test(n.className || '') || n.tabIndex === -1) return false; n.click(); return true; }).catch(() => false);
    if (!clicked) break; let changed = false; for (let w = 0; w < 25; w++) { await sleep(350); if ((await selNow()) !== before) { changed = true; break; } } if (!changed) break;
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); await sleep(500);
  }
  return [...byHref.values()];
}

// Proven store-switch (2026-08-24): open picker -> search by store name -> expand
// row -> click VISIBLE "Shop Medical" (or accept "Shopping Medical" already active)
// -> confirm "Yes - I'm Sure" -> verify.
const addrMatches = (addr) => tokenRe.test(addr)
  || (WANT === 'jars-green-valley' && /commerce point|green valley/i.test(addr))
  || (WANT === 'jars-east-tucson' && /tanque verde/i.test(addr));

// Reliably read the active menu mode. "Shopping Medical" is the picker's toggle
// label when the medical menu is live (vs a "Shop Medical" button when it isn't).
// The re-open is flaky, so open the picker and read it up to `tries` times.
async function confirmMedical(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    // ALWAYS reload the homepage first. After the search→expand switch flow the
    // location drawer is left in a filtered/scrolled state where the active
    // "Shopping Medical" label is out of view — checking it there is the exact
    // false-negative we're fixing. A fresh reload gives a clean drawer every time.
    await page.goto('https://jarscannabis.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2200);
    // Open the picker via the pickup-address leaf, then read the toggle.
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => /Commerce Point|Tanque Verde/i.test(e.textContent || '') && e.children.length === 0 && e.offsetParent !== null);
      el && el.click();
    }).catch(() => {});
    await sleep(1800);
    // Read the toggle with a DOM scan, NOT page.getByText(...).first().isVisible():
    // getByText's .first() resolves to a hidden node earlier in DOM order and
    // reports not-visible even when a visible "Shopping Medical" element exists.
    if (await medicalActive(page)) {
      await page.keyboard.press('Escape').catch(() => {});
      return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(800);
  }
  return false;
}

// True iff a VISIBLE element whose exact text is "Shopping Medical" exists (the
// picker's active-mode label). Robust where Playwright's getByText locator is not.
const medicalActive = (page) => page.evaluate(() => {
  const vis = (e) => e.offsetParent !== null && e.getClientRects().length;
  return [...document.querySelectorAll('button,a,span,div,p,li')]
    .some((e) => /^Shopping Medical$/i.test((e.textContent || '').trim()) && vis(e));
}).catch(() => false);

async function switchStoreMedical(page) {
  const openPicker = async () => {
    // Proven 2026-08-25: the picker only opens reliably from the HOMEPAGE by
    // clicking the current pickup ADDRESS *leaf* node (not the "Pickup from"
    // wrapper, not the chevron). A harvest leaves the page on a category URL, so
    // navigate home first.
    if (!/jarscannabis\.com\/?($|\?|#)/.test(page.url())) {
      await page.goto('https://jarscannabis.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(2500);
    }
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('*')].find((e) => /Commerce Point|Tanque Verde/i.test(e.textContent || '') && e.children.length === 0 && e.offsetParent !== null);
      el && el.click();
    }).catch(() => {});
    await sleep(2200);
  };
  // Early-out: if we're ALREADY on the target store, only ensure it's medical
  // (the daemon's persistent profile opens on East Tucson medical). Self-switching
  // to the current store is what fails, so skip the search/expand entirely.
  {
    const cur = await pickupAddr(page);
    if (addrMatches(cur)) {
      await openPicker();
      const onMed = await medicalActive(page);
      if (onMed) { await page.keyboard.press('Escape').catch(() => {}); console.log(`   ✓ Already on ${TOKEN} (${cur}) — MEDICAL.`); return cur; }
      // on the right store but on REC → click its "Shop Medical" (no store change, no confirm)
      const toggled = await page.evaluate(() => { const b = [...document.querySelectorAll('button,a,span,div')].find((e) => /^Shop Medical$/i.test((e.textContent || '').trim()) && e.offsetParent !== null && e.getClientRects().length); if (b) { b.click(); return true; } return false; });
      if (toggled) { await sleep(3500); await page.keyboard.press('Escape').catch(() => {}); const a2 = await pickupAddr(page); console.log(`   ✓ ${TOKEN} switched to MEDICAL (${a2}).`); return a2; }
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  // The search→expand→Shop-Medical sequence is timing-flaky, so RETRY it a few
  // times (re-open the picker each attempt) before giving up.
  const rowRe = new RegExp('jars.{0,6}' + TOKEN.trim().replace(/\s+/g, '.{0,3}'), 'i');
  let state = 'none';
  for (let attempt = 1; attempt <= 4 && state === 'none'; attempt++) {
    let nameBox = page.getByPlaceholder(/Search by store name/i).first();
    for (let i = 0; i < 4 && !(await nameBox.isVisible().catch(() => false)); i++) { await openPicker(); nameBox = page.getByPlaceholder(/Search by store name/i).first(); }
    if (!(await nameBox.isVisible().catch(() => false))) { console.log(`   (attempt ${attempt}: picker not open, retrying)`); continue; }
    await nameBox.scrollIntoViewIfNeeded().catch(() => {});
    await nameBox.click({ force: true }).catch(() => {});
    await nameBox.fill('').catch(() => {});
    await nameBox.type(TOKEN, { delay: 40 }); await sleep(2500);
    // Expand the store row — MUST be a Playwright force-click on the row text
    // (scrolled into view); a DOM .click() does NOT toggle the accordion, and a
    // plain locator click fails "outside of viewport" in the scrollable drawer.
    // Match the STORE ROW specifically ("JARS … <token>"), not the search box /
    // labels that also contain the token — /<token>/ alone is too broad.
    const row = page.getByText(rowRe).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click({ force: true }).catch(() => {});
    await sleep(2000);
    state = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button,a,span,div')]; const vis = (e) => e.offsetParent !== null && e.getClientRects().length;
      const m = all.find((e) => /^Shop Medical$/i.test((e.textContent || '').trim()) && vis(e)); if (m) { m.click(); return 'clicked'; }
      if (all.find((e) => /^Shopping Medical$/i.test((e.textContent || '').trim()) && vis(e))) return 'already-medical';
      return 'none';
    });
    if (state === 'none') { console.log(`   (attempt ${attempt}: Shop Medical not found, retrying)`); await page.keyboard.press('Escape').catch(() => {}); await sleep(800); }
  }
  if (state === 'none') throw new Error(`no visible Shop Medical/Shopping Medical for "${TOKEN}" after retries`);
  if (state === 'clicked') { await sleep(1300); const yes = page.getByRole('button', { name: /Yes\s*-?\s*I.?m Sure/i }).first(); if (await yes.isVisible().catch(() => false)) { await yes.click(); await sleep(4500); } else await sleep(2500); }
  const slug = await activeSlug(page); const addr = await pickupAddr(page);
  const okStore = slug === WANT || (slug && slug.includes(tokenSlug)) || tokenRe.test(addr)
    || (WANT === 'jars-green-valley' && /commerce point|green valley/i.test(addr))
    || (WANT === 'jars-east-tucson' && /tanque verde/i.test(addr));
  if (!okStore) throw new Error(`wrong store — slug "${slug || '?'}", pickup "${addr}" (wanted ${WANT})`);
  // Confirm MEDICAL robustly. The single openPicker→isVisible check was a
  // false-negative machine: re-opening the location drawer is timing-flaky, so a
  // switch that actually succeeded would still throw "could not confirm MEDICAL".
  // Retry opening the picker and reading the active "Shopping Medical" toggle a
  // few times (same pattern the switch loop uses) before giving up.
  const okMed = await confirmMedical(page);
  if (!okMed) throw new Error(`could not confirm MEDICAL for ${TOKEN}`);
  console.log(`   ✓ On ${TOKEN} (${addr}) — MEDICAL confirmed.`);
  return addr;
}

(async () => {
  await ensureDaemonSelf();
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).catch(() => null);
  if (!b) { console.error(`🚩 FLAG: could not bring up a JARS daemon on CDP ${PORT} after launching it.`); process.exit(2); }
  const page = b.contexts()[0].pages()[0] || (await b.contexts()[0].newPage());
  await page.bringToFront().catch(() => {});
  let addr;
  if (process.env.JARS_NOSWITCH === '1') {
    // Harvest the store the daemon is ALREADY on (verified out-of-band, e.g. by
    // screenshot). Still confirm the address matches the intended store.
    addr = await pickupAddr(page);
    const ok = tokenRe.test(addr)
      || (WANT === 'jars-green-valley' && /commerce point|green valley/i.test(addr))
      || (WANT === 'jars-east-tucson' && /tanque verde/i.test(addr));
    if (!ok) { console.error(`🚩 FLAG: NOSWITCH but current store "${addr}" ≠ ${TOKEN}. ${OUT} left unchanged.`); await b.close(); process.exit(2); }
    console.log(`   NOSWITCH — harvesting current store ${TOKEN} (${addr}).`);
  } else {
    console.log(`Switching JARS → ${TOKEN} (medical)…`);
    try { addr = await switchStoreMedical(page); }
    catch (e) { console.error(`🚩 FLAG: could not put JARS on ${TOKEN} MEDICAL — ${e.message}. ${OUT} left unchanged.`); await b.close(); process.exit(2); }
  }
  const out = { store: WANT, pickup: addr, harvestedAt: new Date().toISOString(), flower: [], prerolls: [] };
  for (const [cat, key] of [['flower', 'flower'], ['pre-rolls', 'prerolls']]) {
    await page.goto(`https://jarscannabis.com/category/${cat}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(2500);
    const cards = await harvestAllPages(page);
    out[key] = cards.map((c) => key === 'prerolls' ? pr.toPrerollRecord({ dispensary: LABEL, ...c }) : flower.normalizeListing({ dispensary: LABEL, ...c }));
    console.log(`   ${cat}: ${cards.length} cards`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`Saved -> ${OUT}`);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
