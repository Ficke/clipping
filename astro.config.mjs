import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://adamficke.com',
  integrations: [sitemap()],
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  image: {
    // photos are pre-sized originals in content/; sharp generates responsive variants
    responsiveStyles: true,
  },
  vite: {
    build: {
      // keep scripts/styles as external files so CloudFront can serve a strict CSP
      assetsInlineLimit: 0,
    },
  },
});
