import sitemap from '@astrojs/sitemap';
import { defineConfig, sharpImageService } from 'astro/config';

export default defineConfig({
  site: 'https://adamficke.com',
  integrations: [sitemap()],
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  image: {
    responsiveStyles: true,
    service: sharpImageService({
      // AVIF ~q60 is perceptually on par with WebP ~q80 at smaller sizes
      avif: { quality: 60 },
      webp: { quality: 80 },
      jpeg: { quality: 85, mozjpeg: true },
    }),
  },
  vite: {
    build: {
      // keep scripts/styles as external files so CloudFront can serve a strict CSP
      assetsInlineLimit: 0,
    },
  },
});
