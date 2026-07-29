// Verifies the GA4 tag actually registers and fires a page_view.
//
// Two layers keep this from writing localhost traffic into the real property:
// the tag itself no-ops off the canonical host, and the collect endpoints are
// stubbed below. `?ga-debug` opts the tag back in so there is something to
// verify. Pass --off to assert the opposite -- that an ordinary local visit
// reports nothing.
import { chromium } from 'playwright-core';

// Local preview serves no headers, so replay CloudFront's CSP verbatim
// (infra/main.tf) to catch a policy that would block the tag in production.
const CSP = "default-src 'none'; script-src 'self' https://*.googletagmanager.com; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com; font-src 'self'; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const rawPath = process.argv[2] ?? '/';
const withCsp = process.argv.includes('--csp');
// Off-production the tag no-ops, so opt in unless we are asserting it stays off.
const off = process.argv.includes('--off');
const path = off ? rawPath : rawPath + (rawPath.includes('?') ? '&' : '?') + 'ga-debug';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext()).newPage();

if (withCsp) {
  await page.route('http://localhost:4321/**', async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers(), 'content-security-policy': CSP };
    await route.fulfill({ response, headers });
  });
}

const errors = [];
const hits = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

// Fulfilled as a 204 rather than aborted: gtag sees a normal success and does
// not attempt a fallback, so what we observe is the real request pattern.
const stub = (route) => {
  hits.push(route.request().url());
  route.fulfill({ status: 204, body: '' });
};
await page.route('**://*.google-analytics.com/**', stub);
await page.route('**://*.analytics.google.com/**', stub);
await page.route('**://www.google.com/**', stub);

const loaded = [];
page.on('request', (r) => {
  if (r.url().includes('googletagmanager.com')) loaded.push(r.url());
});

await page.goto(`http://localhost:4321${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  dataLayerLength: window.dataLayer?.length ?? null,
  // gtag.js rewrites each queued item once it has processed it.
  dataLayerKinds: (window.dataLayer ?? []).map((x) => Object.prototype.toString.call(x)),
  gtagType: typeof window.gtag,
}));

console.log('gtag.js loaded:  ', loaded.length ? loaded : 'NO');
console.log('window.gtag:     ', state.gtagType);
console.log('dataLayer items: ', state.dataLayerLength, state.dataLayerKinds);
console.log('collect hits:    ', hits.length);
for (const hit of hits) {
  const url = new URL(hit);
  const params = url.searchParams;
  console.log(`   host=${url.host}  en=${params.get('en')}  tid=${params.get('tid')}  dl=${params.get('dl')}`);
}
console.log('console errors:  ', errors.length ? errors : 'none');

const expected = off ? 0 : 1;
const ok = hits.length === expected;
console.log(ok
  ? `PASS: ${off ? 'no reporting off-production' : 'page_view reported'}`
  : `FAIL: expected ${expected} collect hit(s), got ${hits.length}`);
await browser.close();
process.exit(ok ? 0 : 1);
