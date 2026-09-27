// One-off helper: dumps the raw text (and a screenshot) of a Dutchie
// "specials/offer" page so we can see how mix-and-match bundle deals are
// actually laid out, since the main scraper doesn't visit these pages yet.
// Usage: node debug-special.js [url]
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'https://dutchie.com/embedded-menu/earths-healing-south/specials/offer/6aad956061ee180007aa43da';
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  // Dutchie keeps some background connection (websocket/analytics/chat) open
  // indefinitely, so a strict 'networkidle' wait times out. Match the main
  // scraper's approach: wait for DOM content, then give networkidle a short
  // grace period and move on regardless.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2500);
  console.log('----- RAW PAGE TEXT -----');
  console.log(await page.evaluate(() => document.body.innerText));
  await page.screenshot({ path: 'debug-special.png', fullPage: true });
  console.log('\nScreenshot saved -> debug-special.png');
  await browser.close();
})();
