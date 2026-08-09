/** Browser-level smoke check for a production build served by `bun run preview`. */

import path from 'node:path';
import {
  captureBrowserErrors,
  parsePreviewArguments,
  preparePreviewArtifacts,
  previewUrl,
  requireNoBrowserErrors,
  runCli,
  withPreviewBrowser,
} from './preview-check-support';

await runCli('preview:check', async () => {
  const { route } = parsePreviewArguments(process.argv.slice(2), {
    defaultRoute: '/photography/salt-point/',
  });
  const artifacts = preparePreviewArtifacts();

  await withPreviewBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = captureBrowserErrors(page);

    await page.goto(previewUrl(route), { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      for (let offset = 0; offset < document.body.scrollHeight; offset += 800) {
        window.scrollTo(0, offset);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(artifacts, 'page.png'), fullPage: true });

    const lightboxLinks = page.locator('a[data-lightbox]');
    if (await lightboxLinks.count()) {
      await lightboxLinks.first().click();
      const openDialog = page.locator('dialog[open]');
      await openDialog.waitFor();
      await page.screenshot({ path: path.join(artifacts, 'lightbox.png') });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(artifacts, 'lightbox-next.png') });
      await page.keyboard.press('Escape');
      await openDialog.waitFor({ state: 'hidden' });
    }

    requireNoBrowserErrors(errors);
    console.log(`PASS: ${route} rendered without browser errors`);
    console.log(`Screenshots: ${artifacts}`);
  });
});
