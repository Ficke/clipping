import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Regenerates the derivative images that `photos.json` points at (e.g.
// /media/photo-v1/...) into public/, so `astro dev` can serve them locally.
// In production these are built once in CI and served from S3/CloudFront;
// locally there is no such bucket, so we build them from the album originals
// on disk instead. Albums are skipped once their derivatives already exist.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const publicRoot = path.join(repoRoot, 'public');
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

if (!existsSync(albumsRoot)) process.exit(0);

const albums = readdirSync(albumsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const album of albums) {
  const albumDir = path.join(albumsRoot, album);
  const manifestPath = path.join(albumDir, 'photos.json');
  const hasOriginals = readdirSync(albumDir).some((file) =>
    supportedExtensions.has(path.extname(file).toLowerCase()),
  );
  if (!hasOriginals) continue;

  if (existsSync(manifestPath) && allVariantsPresent(manifestPath)) continue;

  console.log(`[photos:build-media:local] building ${album}...`);
  const tmpManifest = path.join(mkdtempSync(path.join(os.tmpdir(), 'photo-media-')), 'photos.json');
  const result = spawnSync(
    'bun',
    [
      path.join(repoRoot, 'scripts', 'photos-build-media.mjs'),
      '--source', albumDir,
      '--album', album,
      '--output', publicRoot,
      '--manifest', tmpManifest,
      '--no-upload',
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`[photos:build-media:local] failed to build ${album}`);
    process.exit(result.status ?? 1);
  }
}

function allVariantsPresent(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.photos.every((photo) =>
    allVariantPaths(photo.variants).every((src) => existsSync(path.join(publicRoot, src))),
  );
}

function allVariantPaths(variants) {
  const paths = [];
  for (const variant of Object.values(variants.responsive)) {
    for (const entry of variant) paths.push(entry.src);
  }
  if (variants.lightbox) paths.push(variants.lightbox.src);
  if (variants.social) paths.push(variants.social.src);
  return paths;
}
