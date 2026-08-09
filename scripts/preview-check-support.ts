import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';

export const DEFAULT_PREVIEW_URL = 'http://127.0.0.1:4321';
export const PREVIEW_ARTIFACTS_DIRECTORY = path.resolve(import.meta.dir, '..', 'artifacts', 'preview-check');

export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self' https://*.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https://*.google-analytics.com https://*.googletagmanager.com",
  "font-src 'self'",
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self' https://checkout.stripe.com",
].join('; ');

export interface PreviewArguments {
  route: string;
  flags: Set<string>;
}

export function parsePreviewArguments(
  values: string[],
  { defaultRoute, allowedFlags = [] }: { defaultRoute: string; allowedFlags?: string[] },
): PreviewArguments {
  const flags = new Set<string>();
  let route: string | undefined;

  for (const value of values) {
    if (value.startsWith('--')) {
      if (!allowedFlags.includes(value)) throw new Error(`Unknown option: ${value}`);
      flags.add(value);
    } else if (route) {
      throw new Error(`Unexpected argument: ${value}`);
    } else {
      route = value;
    }
  }

  const normalized = route ?? defaultRoute;
  if (!normalized.startsWith('/')) throw new Error(`Preview route must start with "/": ${normalized}`);
  return { route: normalized, flags };
}

export function previewUrl(route: string, debugAnalytics = false): string {
  const baseUrl = process.env.PREVIEW_BASE_URL ?? DEFAULT_PREVIEW_URL;
  const url = new URL(route, `${baseUrl.replace(/\/$/, '')}/`);
  if (url.origin !== new URL(baseUrl).origin) throw new Error(`Preview route must stay on ${baseUrl}`);
  if (debugAnalytics) url.searchParams.set('ga-debug', '');
  return url.href;
}

export function preparePreviewArtifacts(): string {
  rmSync(PREVIEW_ARTIFACTS_DIRECTORY, { recursive: true, force: true });
  mkdirSync(PREVIEW_ARTIFACTS_DIRECTORY, { recursive: true });
  return PREVIEW_ARTIFACTS_DIRECTORY;
}

export function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

export async function withPreviewBrowser<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({
    channel: process.env.PREVIEW_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
  });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

export function requireNoBrowserErrors(errors: string[]): void {
  if (errors.length) throw new Error(`Browser reported ${errors.length} error(s):\n${errors.join('\n')}`);
}

export async function runCli(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${name}: ${message}`);
    process.exitCode = 1;
  }
}
