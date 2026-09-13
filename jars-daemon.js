/**
 * jars-daemon.js — keep ONE headed Chrome alive with a remote-debugging port so
 * short driver scripts can attach over CDP, act, and detach WITHOUT closing it.
 * Uses a persistent profile, so it opens straight to that profile's saved store.
 *
 * TWO-PROFILE setup (each profile is LOCKED to one store's medical menu, so the
 * daily run never has to switch stores — just NOSWITCH-harvest each):
 *   East Tucson : JARS_PROFILE=.jars-chrome-profile     JARS_PORT=9222 (defaults)
 *   Green Valley: JARS_PROFILE=.jars-chrome-profile-gv  JARS_PORT=9223
 * Run in the background; stop by killing the process.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PROFILE_DIR = path.join(__dirname, process.env.JARS_PROFILE || '.jars-chrome-profile');
const PORT = Number(process.env.JARS_PORT || 9222);
const READY = path.join(__dirname, `.jars-daemon-ready-${PORT}`);

(async () => {
  try { fs.unlinkSync(READY); } catch (_) {}
  // Clear stale Chrome singleton locks before opening the profile. A force-killed
  // Chrome (the kill+relaunch recovery, or any prior-session crash) leaves these
  // behind, and launchPersistentContext then refuses to open the "in use" profile
  // — the profile-state gap that made relaunch unreliable. Every launch path
  // (run-flower-daily ensureDaemon, jars-pull-cdp ensureDaemonSelf, manual) goes
  // through here, so clearing them here fixes it once.
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE_DIR, f), { force: true }); } catch (_) {}
  }
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [`--remote-debugging-port=${PORT}`, '--disable-blink-features=AutomationControlled', '--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  await page.goto('https://jarscannabis.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  fs.writeFileSync(READY, `ready ${new Date().toISOString()} port=${PORT}`);
  console.log(`daemon up on CDP port ${PORT}, profile ${PROFILE_DIR}`);
  ctx.on('close', () => process.exit(0));
  await new Promise(() => {}); // stay alive
})().catch((e) => { console.error('daemon ERR', e.message); process.exit(1); });
