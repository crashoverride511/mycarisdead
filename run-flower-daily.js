/**
 * run-flower-daily.js — one-shot daily FLOWER pipeline (no pre-rolls).
 * Runs every step in order, then leaves an updated tucson-flower.html ready to
 * publish:
 *   1. scrape every store (weed-value-finder.js): Dutchie menus + JARS via its
 *      storefront API (jars-api.js) — JARS no longer needs a browser
 *   2. only if the JARS API failed for a store: live Playwright fallback for it
 *      (jars-daemon.js + jars-pull-cdp.js, kill+relaunch on a block)
 *   3. merge (merge-strainpicker.js) -> weed-results-merged.json
 *   4. build cards + assemble the artifact HTML (build-artifact-cards + assemble)
 *   5. deal alert + daily archive
 *
 * Env:
 *   SKIP_JARS=1   leave JARS out entirely (Dutchie-only)
 *
 * Publishing is done by the caller (flower-daily wrapper -> `claude -p`), since
 * the Artifact tool lives in Claude Code, not in a plain Node process.
 * Exits non-zero if a REQUIRED step fails; JARS failures are logged but tolerated
 * (never let one store kill the whole run).
 */
'use strict';
const { spawnSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const DIR = __dirname;
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(label, args, env, { required = true } = {}) {
  log(`▶ ${label}`);
  const r = spawnSync('node', args, { cwd: DIR, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    const msg = `✗ ${label} exited ${r.status}${r.error ? ' (' + r.error.message + ')' : ''}`;
    if (required) { log(msg + ' — REQUIRED, aborting'); process.exit(1); }
    log(msg + ' — optional, continuing');
    return false;
  }
  log(`✓ ${label}`);
  return true;
}

// Is a JARS daemon's CDP endpoint responding on this port?
const cdpUp = (port) => new Promise((res) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 2000 }, () => { res(true); req.destroy(); });
  req.on('error', () => res(false));
  req.on('timeout', () => { req.destroy(); res(false); });
});

// Ensure a persistent-profile JARS daemon is running on `port`; start it detached
// (headed Chrome — needs an interactive desktop, i.e. the scheduled task's
// "run only when logged on") and leave it up for reuse. Each profile is locked
// to one store's medical menu, so no store switching is ever needed.
async function ensureDaemon(profile, port) {
  if (await cdpUp(port)) { log(`daemon on ${port} already up`); return true; }
  log(`starting JARS daemon: profile ${profile}, port ${port}`);
  const child = spawn('node', ['jars-daemon.js'], { cwd: DIR, detached: true, stdio: 'ignore', env: { ...process.env, JARS_PROFILE: profile, JARS_PORT: String(port) } });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await cdpUp(port)) { log(`daemon ${port} ready`); return true; } await sleep(1000); }
  log(`⚠ daemon ${port} did not come up in 60s — JARS ${profile} may be skipped`);
  return false;
}

// Kill all JARS instances: only the daemon Chrome (matched by a jars profile or
// a JARS debug port) and the jars-daemon.js node processes, then clear the ready
// flags. Scoped to JARS ports so it never touches the Dutchie scrape's browser
// or the user's own Chrome. Recovery for a blocked pull: kill JARS, relaunch,
// pull again.
function killAllJars() {
  // NB: exclude $PID — this PowerShell's own command line contains the pattern
  // below, so without the guard the pipeline matches its own shell and kills
  // itself mid-run, leaving the rest of the targets alive.
  const psCmd = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'jars-chrome-profile|jars-daemon\\.js|remote-debugging-port=(9222|9223)' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }";
  spawnSync('powershell', ['-NoProfile', '-Command', psCmd], { cwd: DIR, stdio: 'ignore' });
  for (const p of [9222, 9223]) { try { require('fs').unlinkSync(path.join(DIR, `.jars-daemon-ready-${p}`)); } catch (_) {} }
}

// JARS = Playwright, 100% of the time. Pull the store live; if Playwright is
// blocked/fails, kill ALL JARS instances and relaunch, then pull again.
async function pullJars(label, profile, port, env) {
  await ensureDaemon(profile, port);
  if (run(label, ['jars-pull-cdp.js'], env, { required: false })) return true;
  log(`↻ ${label} blocked — killing all JARS instances and relaunching`);
  killAllJars();
  await sleep(3000);
  await ensureDaemon(profile, port);
  return run(`${label} (relaunch)`, ['jars-pull-cdp.js'], env, { required: false });
}

// Playwright fallback config for the JARS stores that have one (profile + port).
const JARS_FALLBACK = {
  'jars-east-tucson': ['JARS East Tucson', '.jars-chrome-profile', 9222, {
    JARS_PORT: '9222', JARS_WANT: 'jars-east-tucson',
    JARS_TOKEN: 'east tucson', JARS_OUT: 'jars-east-tucson-lists.json', JARS_LABEL: 'JARS - East Tucson',
  }],
  'jars-green-valley': ['JARS Green Valley', '.jars-chrome-profile-gv', 9223, {
    JARS_PORT: '9223', JARS_WANT: 'jars-green-valley',
    JARS_TOKEN: 'green valley', JARS_OUT: 'jars-green-valley-lists.json', JARS_LABEL: 'JARS - Green Valley',
  }],
};

(async () => {
  log('=== daily flower run start ===');

  // 1) The finder reads EVERY store: Dutchie menus via their product JSON, and
  //    JARS via its storefront API (jars-api.js — no browser, ~1 s per store).
  const only = process.env.SKIP_JARS
    ? ['--only', require('./weed-value-finder.js').DISPENSARIES.filter((d) => d.platform !== 'jars' && !d.disabled && !d.verify).map((d) => d.id).join(',')]
    : [];
  if (process.env.SKIP_JARS) log('SKIP_JARS set — leaving JARS out of this run');
  run('Scrape all stores', ['weed-value-finder.js', '--headless', '--json', 'weed-results.json', '--csv', 'weed-results.csv', ...only]);

  // 2) JARS safety net. If the API didn't deliver a JARS store, fall back to the
  //    old live Playwright scrape for that store (kill+relaunch on a block), and
  //    let the merge step fold in whatever it harvested. Never serves stale data:
  //    the merge refuses lists files that weren't harvested just now.
  if (!process.env.SKIP_JARS) {
    let coverage = [];
    try { coverage = JSON.parse(require('fs').readFileSync(path.join(DIR, 'weed-results.json'), 'utf8')).coverage || []; } catch (_) {}
    for (const [id, cfg] of Object.entries(JARS_FALLBACK)) {
      const c = coverage.find((x) => x.id === id);
      if (c && c.ok) continue;
      log(`⚠ JARS API did not deliver ${id} (${c ? c.error : 'no coverage record'}) — falling back to the Playwright scrape`);
      await pullJars(...cfg);
    }
  }

  // Build weed-results-merged.json (pass-through unless a fallback pull ran)
  run('Merge', ['merge-strainpicker.js']);
  // Build artifact HTML
  run('Build cards', ['build-artifact-cards.js']);
  run('Assemble HTML', ['assemble-artifact.js']);
  // Deal alert: flags a NEW pick that beats $88/oz (writes flower-alert.json)
  run('Deal alert check', ['flower-alert.js'], {}, { required: false });
  // Archive: append today's board to history/ + deal-history.csv for trend analysis
  run('Archive day', ['flower-archive.js'], {}, { required: false });

  log('=== done -> ' + path.join(DIR, 'tucson-flower.html') + ' ===');
})();
