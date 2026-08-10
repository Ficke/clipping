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
    const collectionHits: { url: string; body: string }[] = [];
    const loadedTags: string[] = [];
    const stubCollection = async (intercepted: Route): Promise<void> => {
      collectionHits.push({
        url: intercepted.request().url(),
        body: intercepted.request().postData() ?? '',
      });
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

    const firstPhoto = page.locator('a[data-lightbox][data-photo-id]').first();
    const hasPhoto = await firstPhoto.count() > 0;
    if (hasPhoto) {
      await firstPhoto.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1_000);
      await firstPhoto.click();
      // GA may batch non-page events for several seconds before transport.
      await page.waitForTimeout(5_500);
    }

    const state = await page.evaluate(() => ({
      dataLayerLength: window.dataLayer?.length ?? 0,
      dataLayerKinds: (window.dataLayer ?? []).map((item) => Object.prototype.toString.call(item)),
      commands: (window.dataLayer ?? []).map((item) => Array.from(item)),
      gtagType: typeof window.gtag,
    }));
    const pageViewHits = collectionHits.filter(
      (hit) => eventNames(hit).includes('page_view'),
    );
    const expectedPageViews = reportingOff ? 0 : 1;
    if (pageViewHits.length !== expectedPageViews) {
      throw new Error(`Expected ${expectedPageViews} page_view hit(s), received ${pageViewHits.length}`);
    }
    if (reportingOff) {
      if (loadedTags.length) throw new Error('gtag.js loaded while off-production reporting was disabled');
      if (state.gtagType !== 'undefined') throw new Error('window.gtag was installed while reporting was disabled');
    } else {
      if (!loadedTags.length) throw new Error('gtag.js did not load');
      if (state.gtagType !== 'function') throw new Error(`Expected window.gtag to be a function, got ${state.gtagType}`);
      if (!state.dataLayerLength) throw new Error('The analytics data layer is empty');
      const config = state.commands.find((command) => command[0] === 'config');
      if ((config?.[2] as Record<string, unknown> | undefined)?.send_page_view !== false) {
        throw new Error('The automatic, unsanitized page_view was not disabled');
      }
      const pageView = state.commands.find(
        (command) => command[0] === 'event' && command[1] === 'page_view',
      );
      const pageLocation = (pageView?.[2] as Record<string, unknown> | undefined)?.page_location;
      if (typeof pageLocation !== 'string' || new URL(pageLocation).search) {
        throw new Error(`The page_view URL was not sanitized: ${String(pageLocation)}`);
      }
      if (hasPhoto) {
        const names = collectionHits.flatMap(eventNames);
        if (!names.includes('view_item')) throw new Error('The visible photo was not reported');
        if (!names.includes('select_item')) throw new Error('The lightbox photo was not reported');
      }
    }
    requireNoBrowserErrors(errors);

    console.log(`PASS: ${reportingOff ? 'off-production reporting stayed disabled' : 'one page_view was reported'}`);
    console.log(`gtag.js requests: ${loadedTags.length}; data layer: ${state.dataLayerKinds.join(', ') || 'empty'}`);
    for (const hit of collectionHits) {
      const url = new URL(hit.url);
      console.log(`collection: host=${url.host} en=${eventNames(hit).join(',') || null} tid=${url.searchParams.get('tid')}`);
    }
  });
});

function eventNames(hit: { url: string; body: string }): string[] {
  const names = [new URL(hit.url).searchParams.get('en')].filter((name): name is string => Boolean(name));
  for (const match of hit.body.matchAll(/(?:^|[&\n])en=([^&\n]+)/g)) {
    names.push(decodeURIComponent(match[1]!));
  }
  return names;
}
