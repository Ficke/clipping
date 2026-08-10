/** End-to-end check for GA4 reporting and the production content security policy. */

import type { Route } from 'playwright-core';
import {
  captureBrowserErrors,
  parsePreviewArguments,
  previewUrl,
  PRODUCTION_CSP,
  requireNoBrowserErrors,
  runCli,
  withPreviewBrowser,
} from './preview-check-support';

await runCli('preview:analytics', async () => {
  const { route, flags } = parsePreviewArguments(process.argv.slice(2), {
    defaultRoute: '/',
    allowedFlags: ['--csp', '--off'],
  });
  const reportingOff = flags.has('--off');

  await withPreviewBrowser(async (browser) => {
    const page = await browser.newPage();
    if (flags.has('--csp')) {
      await page.route(`${new URL(previewUrl('/')).origin}/**`, async (intercepted) => {
        const response = await intercepted.fetch();
        await intercepted.fulfill({
          response,
          headers: { ...response.headers(), 'content-security-policy': PRODUCTION_CSP },
        });
      });
    }

    const errors = captureBrowserErrors(page);
    const collectionHits: string[] = [];
    const loadedTags: string[] = [];
    const stubCollection = async (intercepted: Route): Promise<void> => {
      collectionHits.push(intercepted.request().url());
      await intercepted.fulfill({ status: 204, body: '' });
    };
    await page.route('**://*.google-analytics.com/**', stubCollection);
    await page.route('**://*.analytics.google.com/**', stubCollection);
    await page.route('**://www.google.com/**', stubCollection);
    page.on('request', (request) => {
      const requestUrl = new URL(request.url());
      if (requestUrl.hostname === 'googletagmanager.com'
        || requestUrl.hostname.endsWith('.googletagmanager.com')) {
        loadedTags.push(request.url());
      }
    });

    await page.goto(previewUrl(route, !reportingOff), { waitUntil: 'networkidle' });
    await page.waitForTimeout(2_500);

    const state = await page.evaluate(() => ({
      dataLayerLength: window.dataLayer?.length ?? 0,
      dataLayerKinds: (window.dataLayer ?? []).map((item) => Object.prototype.toString.call(item)),
      gtagType: typeof window.gtag,
    }));
    const expectedHits = reportingOff ? 0 : 1;
    if (collectionHits.length !== expectedHits) {
      throw new Error(`Expected ${expectedHits} analytics collection hit(s), received ${collectionHits.length}`);
    }
    if (reportingOff) {
      if (loadedTags.length) throw new Error('gtag.js loaded while off-production reporting was disabled');
      if (state.gtagType !== 'undefined') throw new Error('window.gtag was installed while reporting was disabled');
    } else {
      if (!loadedTags.length) throw new Error('gtag.js did not load');
      if (state.gtagType !== 'function') throw new Error(`Expected window.gtag to be a function, got ${state.gtagType}`);
      if (!state.dataLayerLength) throw new Error('The analytics data layer is empty');
    }
    requireNoBrowserErrors(errors);

    console.log(`PASS: ${reportingOff ? 'off-production reporting stayed disabled' : 'one page_view was reported'}`);
    console.log(`gtag.js requests: ${loadedTags.length}; data layer: ${state.dataLayerKinds.join(', ') || 'empty'}`);
    for (const hit of collectionHits) {
      const url = new URL(hit);
      console.log(`collection: host=${url.host} en=${url.searchParams.get('en')} tid=${url.searchParams.get('tid')}`);
    }
  });
});
