// Public, read-only storefront diagnostics. No customer data or credentials.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'https://kimscandycottage.shop';
const categories = [
  ['Cottage Favorites & Specials', '/shop/ols/categories/cottage-favorites-specials', true],
  ['Collections', '/shop/ols/categories/collections', true],
  ['Individual Flavors', '/shop/ols/categories/individual-flavors', true],
  ['Pocket Packs', '/shop/ols/categories/pocket-packs', false],
];
const out = path.join(process.cwd(), 'monitor-results');
fs.mkdirSync(out, { recursive: true });
const timestamp = new Date().toISOString();
const results = [];
async function main() {
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const detailPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

async function verifyProductDetail(href) {
  try {
    const response = await detailPage.goto(new URL(href, ROOT).href, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await detailPage.waitForFunction(() => /add to cart|buy now|add to bag|select options/i.test(document.body?.innerText || ''), { timeout: 15000 }).catch(() => {});
    const detail = await detailPage.evaluate(() => {
      const text = document.body?.innerText || '';
      const controls = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')]
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .map(el => (el.innerText || el.getAttribute('aria-label') || el.value || '').trim())
        .filter(t => /add to cart|buy now|add to bag|select options|add to basket/i.test(t)).slice(0, 10);
      return { hasPrice: /\$\s*\d+(?:\.\d{2})?/.test(text), controls, excerpt: text.slice(0, 500) };
    });
    return { url: detailPage.url(), httpStatus: response?.status(), ...detail, purchasable: (response?.status() || 0) < 400 && detail.hasPrice && detail.controls.length > 0 };
  } catch (err) { return { error: String(err.message || err), purchasable: false }; }
}


async function inspect(label, url, expectProducts) {
  const entry = { label, url, checkedAt: new Date().toISOString(), status: 'inconclusive' };
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    entry.httpStatus = response?.status() ?? null;
    // GoDaddy can render product grids several seconds after DOM ready.
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return /new products are coming soon!/i.test(text) ||
        ([...document.querySelectorAll('a[href]')].some(a => /\/shop\/ols\/products?\//i.test(a.getAttribute('href') || '')) && /\$\s*\d/.test(text));
    }, { timeout: expectProducts ? 20000 : 7000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const file = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    await page.screenshot({ path: path.join(out, file + '.png'), fullPage: true });
    entry.observation = await page.evaluate(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const text = document.body?.innerText || '';
      const prices = [...document.querySelectorAll('body *')]
        .filter(el => el.children.length === 0 && visible(el) && /\$\s*\d+(?:\.\d{2})?/.test(el.textContent || ''))
        .map(el => el.textContent.trim()).slice(0, 25);
      const productLinks = [...document.querySelectorAll('a[href]')]
        .filter(visible)
        .map(a => ({ name: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 100), href: a.getAttribute('href') }))
        .filter(a => /\/shop\/ols\/products?\//i.test(a.href || '')).slice(0, 25);
      const purchaseControls = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
        .filter(visible)
        .map(el => (el.innerText || el.getAttribute('aria-label') || el.value || '').trim())
        .filter(t => /add to cart|buy now|add to bag|select options/i.test(t)).slice(0, 25);
      return {
        title: document.title,
        comingSoon: /new products are coming soon!/i.test(text),
        visiblePrices: prices,
        productLinks,
        purchaseControls,
        textExcerpt: text.slice(0, 650),
      };
    });
    const o = entry.observation;
    if (expectProducts && o.productLinks.length && o.visiblePrices.length) {
      entry.productDetailCheck = await verifyProductDetail(o.productLinks[0].href);
    }
    if (entry.httpStatus >= 400 || o.comingSoon) {
      entry.status = expectProducts ? 'failure' : 'expected-empty-or-unavailable';
    } else if (o.productLinks.length && o.visiblePrices.length && (o.purchaseControls.length || entry.productDetailCheck?.purchasable)) {
      entry.status = 'verified';
    } else if (!expectProducts && !o.productLinks.length) {
      entry.status = 'expected-empty';
    } else {
      entry.status = 'inconclusive'; // avoid false outage reports on unknown storefront markup
    }
  } catch (err) {
    entry.error = String(err.message || err);
    entry.status = 'inconclusive';
  }
  results.push(entry);
  console.log(label + ': ' + entry.status + ' (' + (entry.observation?.productLinks.length || 0) + ' product links, ' + (entry.observation?.visiblePrices.length || 0) + ' prices)');
}

for (const [label, route, expected] of categories) {
  const pocketActive = new Date().toISOString().slice(0, 10) >= '2026-11-13';
  await inspect(label, ROOT + route, label === 'Pocket Packs' ? pocketActive : expected);
}

// Verify the public homepage's Shop Candy button reaches the All Products listing.
async function checkShopCandyNavigation() {
  const entry = { label: 'Homepage Shop Candy navigation', url: ROOT + '/', checkedAt: new Date().toISOString(), status: 'inconclusive' };
  try {
    const response = await page.goto(ROOT + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    const candidates = page.getByRole('link', { name: /shop candy/i });
    const count = await candidates.count();
    entry.matchCount = count;
    if (response?.status() >= 400) {
      entry.status = 'failure';
      entry.reason = 'Homepage returned HTTP ' + response.status();
    } else if (count === 0) {
      entry.status = 'inconclusive';
      entry.reason = 'No Shop Candy link found; may use a non-link element or alternate label';
    } else {
      const link = candidates.first();
      entry.linkHref = await link.getAttribute('href');
      await link.click({ timeout: 15000 });
      // A slow GoDaddy transition can display the catalog at /shop rather than /shop/ols/all.
      await page.waitForFunction(() => {
        const text = document.body?.innerText || '';
        const productLinks = [...document.querySelectorAll('a[href]')].filter(a => /\/shop\/ols\/products?\//i.test(a.getAttribute('href') || ''));
        return productLinks.length > 0 && /\$\s*\d/.test(text);
      }, { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1500);
      entry.destination = page.url();
      entry.catalogEvidence = await page.evaluate(() => ({
        productLinks: [...document.querySelectorAll('a[href]')].filter(a => /\/shop\/ols\/products?\//i.test(a.getAttribute('href') || '')).length,
        hasPrice: /\$\s*\d/.test(document.body?.innerText || ''),
        comingSoon: /new products are coming soon!/i.test(document.body?.innerText || ''),
      }));
      const evidence = entry.catalogEvidence;
      entry.status = evidence.productLinks > 0 && evidence.hasPrice && !evidence.comingSoon ? 'verified' : 'inconclusive';
      entry.reason = entry.status === 'verified' ? 'Shop Candy click displayed a product catalog with prices' : 'Catalog not reliably observed after clicking Shop Candy';
      await page.screenshot({ path: path.join(out, 'homepage-shop-candy-navigation.png'), fullPage: true });
    }
  } catch (err) {
    entry.status = 'inconclusive';
    entry.error = String(err.message || err);
  }
  results.push(entry);
  console.log(entry.label + ': ' + entry.status + ' (' + (entry.destination || entry.reason || entry.error || '') + ')');
}

await checkShopCandyNavigation();

// All Products: use the verified direct GoDaddy listing URL.
await inspect('All Products', ROOT + '/shop/ols/all', true);

await browser.close();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ timestamp, results }, null, 2));
console.log('\nDiagnostics saved in monitor-results/results.json');
if (results.some(r => r.status === 'failure')) process.exitCode = 1;

}
main().catch(err => { console.error(err); process.exitCode = 1; });
