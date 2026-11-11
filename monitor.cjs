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
    await detailPage.waitForTimeout(3500);
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
    await page.waitForTimeout(5000); // allow GoDaddy storefront client-side rendering
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

// All Products: follow a real navigation link rather than assuming a URL.
try {
  await page.goto(ROOT + '/shop', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const allHref = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href]')].find(a => /all products/i.test((a.innerText || '').trim()));
    return a?.href || null;
  });
  if (allHref) await inspect('All Products', allHref, true);
  else results.push({ label: 'All Products', status: 'inconclusive', reason: 'Could not discover All Products link from storefront navigation' });
} catch (err) {
  results.push({ label: 'All Products', status: 'inconclusive', error: String(err.message || err) });
}

await browser.close();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ timestamp, results }, null, 2));
console.log('\nDiagnostics saved in monitor-results/results.json');
if (results.some(r => r.status === 'failure')) process.exitCode = 1;

}
main().catch(err => { console.error(err); process.exitCode = 1; });
