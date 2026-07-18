// Headless smoke-drive of the built site. Usage:
//   bun run build && (bun run preview &) && bun .claude/skills/preview-check/drive.mjs [path]
// Screenshots land in .claude/skills/preview-check/shots/ (gitignored).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const path = process.argv[2] ?? '/photography/salt-point/';
const shots = new URL('./shots/', import.meta.url).pathname;
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`http://localhost:4321${path}`, { waitUntil: 'networkidle' });
// walk the page so loading="lazy" images fetch before the fullPage shot
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 800) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
});
await page.waitForLoadState('networkidle');
await page.screenshot({ path: `${shots}1-page.png`, fullPage: true });

if (await page.locator('a[data-lightbox]').count()) {
  await page.click('a[data-lightbox]');
  await page.waitForSelector('dialog[open]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}2-lightbox.png` });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}3-lightbox-next.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  console.log('dialog open after Esc:', await page.locator('dialog[open]').count());
}
console.log('console errors:', errors.length ? errors : 'none');
await browser.close();
