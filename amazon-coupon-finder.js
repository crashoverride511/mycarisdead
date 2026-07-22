/**
 * Find which size/color variants of an Amazon product currently show a coupon
 * (e.g. "Apply 50% coupon"), by reading Amazon's own variation matrix and then
 * visiting each variant ASIN's page to check its coupon widget.
 *
 * How it works:
 *  1. Amazon embeds the full size x color -> ASIN map for a "twister" product
 *     in a script registered as `twister-js-init-dpx-data`. We read it via
 *     `window.P.when('twister-js-init-dpx-data').execute(cb)` inside the page
 *     (this is Amazon's own module loader API, not a hack) to get every ASIN
 *     with its dimension values, instead of clicking through swatches.
 *  2. For each ASIN we visit https://www.amazon.com/dp/<ASIN> and read the
 *     coupon element (#pqv-price-coupon-message / .couponLabelText). If a
 *     coupon applies to that variant, Amazon renders text there like
 *     "Apply 50% coupon Shop items | Terms"; if not, the element is absent.
 *
 * Setup:
 *   npm init -y
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Usage:
 *   node amazon-coupon-finder.js "<amazon product URL>" [--percent 50] [--headed]
 *
 * Notes / caveats:
 *  - Amazon may show a CAPTCHA / "Sorry, we just need to make sure you're not
 *    a robot" page to automated traffic, especially after many requests in a
 *    short time. This script runs headed by default and adds randomized
 *    delays between requests to look more like normal browsing, but this is
 *    not guaranteed. If a CAPTCHA is detected, the script pauses and waits
 *    for you to solve it manually in the opened window, then continues.
 *  - This is for personal price/coupon comparison on a handful of variants of
 *    one product you're looking at yourself - not for bulk/high-volume
 *    scraping. Be a good citizen: keep concurrency at 1 and keep the delays.
 *  - Page markup can change; if selectors stop matching, re-inspect the page.
 */

const { chromium } = require('playwright');

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const url = positional[0];
  const percentFlagIdx = args.indexOf('--percent');
  const targetPercent = percentFlagIdx !== -1 ? Number(args[percentFlagIdx + 1]) : null;
  return { url, targetPercent };
}

async function getVariationMatrix(page) {
  // window.P is defined by an early inline script, but on a slow/partial load
  // (or a stripped bot-check variant of the page) it may not be there yet or
  // ever. Poll for a bit before giving up.
  return page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timeoutMs = 8000;

      function tryNow() {
        if (window.P && window.P.when) {
          let settled = false;
          window.P.when('twister-js-init-dpx-data').execute((data) => {
            if (settled) return;
            settled = true;
            resolve({
              dimensions: data.dimensions, // e.g. ["size_name", "color_name"]
              asinToValues: data.dimensionValuesDisplayData, // { asin: [sizeValue, colorValue] }
            });
          });
          setTimeout(() => {
            if (!settled) reject(new Error('window.P found but twister-js-init-dpx-data never fired'));
          }, timeoutMs - (Date.now() - start));
          return true;
        }
        return false;
      }

      if (tryNow()) return;
      const interval = setInterval(() => {
        if (tryNow() || Date.now() - start > timeoutMs) {
          clearInterval(interval);
          if (!(window.P && window.P.when)) {
            reject(new Error('window.P (Amazon module loader) not found - not a twister/variation page?'));
          }
        }
      }, 250);
    });
  });
}

async function getCouponInfo(page) {
  return page.evaluate(() => {
    const el =
      document.getElementById('pqv-price-coupon-message') ||
      document.querySelector('.couponLabelText') ||
      null;
    if (!el) return { hasCoupon: false, text: null, percent: null };
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d+)\s*%\s*coupon/i);
    return { hasCoupon: Boolean(match), text, percent: match ? Number(match[1]) : null };
  });
}

async function gotoAndSettle(page, url) {
  await page.goto(url, { waitUntil: 'load' });
  // Amazon frequently redirects/reloads a fresh session once right after the
  // initial load (e.g. to attach cookies), which yanks the JS execution
  // context out from under us mid-evaluate. Waiting for network to go quiet
  // lets that settle before we touch the page.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function withRetry(fn, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (/execution context was destroyed|target closed/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 1000 + i * 500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function isBlockedPage(page) {
  const title = await page.title().catch(() => '');
  if (/robot check|sorry/i.test(title)) return true;
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  return /enter the characters you see below|api-services-support@amazon\.com/i.test(bodyText);
}

async function waitForManualCaptchaSolve(page) {
  console.log('\n⚠️  Amazon is showing a verification / CAPTCHA page.');
  console.log('   Please solve it manually in the opened browser window.');
  console.log('   Waiting up to 3 minutes for you to continue...\n');
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await isBlockedPage(page))) {
      console.log('   Looks clear, continuing.\n');
      return;
    }
  }
  throw new Error('Still blocked after waiting - aborting.');
}

async function main() {
  const { url, targetPercent } = parseArgs(process.argv);
  if (!url) {
    console.error('Usage: node amazon-coupon-finder.js "<amazon product URL>" [--percent 50]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });
  // Playwright's Chromium sets navigator.webdriver = true by default, which
  // some sites use to serve a stripped-down page to bots. Mask it.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();

  console.log(`Opening product page:\n  ${url}\n`);
  await gotoAndSettle(page, url);
  if (await isBlockedPage(page)) await waitForManualCaptchaSolve(page);

  let matrix;
  try {
    matrix = await withRetry(() => getVariationMatrix(page));
  } catch (e) {
    console.error(`Could not read variation data: ${e.message}`);
    console.error(`Page title was: "${await page.title().catch(() => '?')}"`);
    const snippet = await page
      .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300))
      .catch(() => '(could not read body text)');
    console.error(`Page text starts with: "${snippet}"`);
    await page.screenshot({ path: 'amazon-debug.png' }).catch(() => {});
    console.error('Saved a screenshot to amazon-debug.png for inspection.');
    console.error('This product may not have multiple size/color options, or the page structure changed.');
    await browser.close();
    process.exit(1);
  }

  const { dimensions, asinToValues } = matrix;
  const entries = Object.entries(asinToValues);
  console.log(`Found ${entries.length} variant combinations across: ${dimensions.join(', ')}\n`);

  const results = [];
  for (const [asin, values] of entries) {
    const label = dimensions.map((d, i) => `${d.replace('_name', '')}=${values[i]}`).join(', ');
    const variantUrl = `https://www.amazon.com/dp/${asin}`;

    try {
      await gotoAndSettle(page, variantUrl);
      if (await isBlockedPage(page)) await waitForManualCaptchaSolve(page);
      await page.waitForTimeout(600); // let the coupon widget render

      const coupon = await withRetry(() => getCouponInfo(page));
      results.push({ asin, label, ...coupon });

      const marker = coupon.hasCoupon ? `✅ ${coupon.percent}% off` : '  no coupon';
      console.log(`${marker}   ${asin}   ${label}`);
    } catch (e) {
      results.push({ asin, label, hasCoupon: false, error: e.message });
      console.log(`⚠️  error   ${asin}   ${label}   (${e.message})`);
    }

    // Polite randomized delay between requests.
    await page.waitForTimeout(1200 + Math.random() * 1200);
  }

  const wanted = targetPercent
    ? results.filter((r) => r.percent === targetPercent)
    : results.filter((r) => r.hasCoupon);

  console.log(`\n=== Variants with${targetPercent ? ` ${targetPercent}%` : ''} coupon ===`);
  if (wanted.length === 0) {
    console.log('(none found)');
  } else {
    wanted.forEach((r) =>
      console.log(`${r.asin}   ${r.label}   https://www.amazon.com/dp/${r.asin}   "${r.text}"`)
    );
  }

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
