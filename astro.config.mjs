import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
  // Must match var.domain_name in infra/variables.tf: CloudFront 301s every
  // other host here, so emitting a canonical/og:url/feed link on any other
  // domain would point search engines at a URL that redirects elsewhere.
  // Override in CI if the canonical domain changes in the future.
  site: process.env.SITE_URL ?? 'https://adamficke.com',
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
