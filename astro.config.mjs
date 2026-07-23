import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Override in CI if the canonical domain changes in the future.
  site: process.env.SITE_URL ?? 'https://adamficke.dev',
  integrations: [sitemap()],
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  vite: {
    build: {
      // keep scripts/styles as external files so CloudFront can serve a strict CSP
      assetsInlineLimit: 0,
    },
  },
});
