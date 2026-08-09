import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parsePhotoManifest, type PhotoManifestEntry, type PhotoVariant } from '../shared/media';

// Regenerates the derivative images that `photos.json` points at (e.g.
// /media/photo-v1/...) into public/, so `astro dev` can serve them locally.
// In production these are built once in CI and served from S3/CloudFront;
// locally there is no such bucket, so we build them from the album originals
// on disk instead. Albums are skipped once their derivatives already exist.

import { readPhotosBlock, splitFrontmatter } from './photo-frontmatter.ts';

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
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'photo-media-'));
  const staged = path.join(temporary, 'source');
  const metadataDirectory = path.join(temporary, 'metadata');
  const sourceManifest = path.join(temporary, 'source.json');
  const tmpManifest = path.join(temporary, 'photos.json');
  mkdirSync(staged);
  mkdirSync(metadataDirectory);
  try {
    writeFileSync(sourceManifest, sourceManifestFor(albumDir, album));
    run([
      path.join(repoRoot, 'scripts', 'photos-sanitize.ts'),
      '--source', albumDir,
      '--output', staged,
      '--metadata', metadataDirectory,
      '--source-manifest', sourceManifest,
    ], album);
    run([
      path.join(repoRoot, 'scripts', 'photos-build-media.ts'),
      '--source', staged,
      '--source-manifest', sourceManifest,
      '--source-metadata', metadataDirectory,
      '--album', album,
      '--output', publicRoot,
      '--manifest', tmpManifest,
      '--no-upload',
    ], album);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Read identity from frontmatter so a local build never mints one. */
function sourceManifestFor(albumDir: string, album: string): string {
  const indexPath = path.join(albumDir, 'index.md');
  const { lines } = splitFrontmatter(readFileSync(indexPath, 'utf8'), albumDir);
  const photos = readPhotosBlock(lines).entries
    .filter((entry) => !entry.removed)
    .map((entry) => ({ photoId: entry.photoId, file: entry.file }));
  return JSON.stringify({ version: 1, album, photos });
}

function run(args: string[], album: string): void {
  const result = spawnSync('bun', args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[photos:build-media:local] failed to build ${album}`);
    process.exit(result.status ?? 1);
  }
}

function allVariantsPresent(manifestPath: string): boolean {
  const manifest = parsePhotoManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  return manifest.photos.every((photo) =>
    allVariantPaths(photo.variants).every((src) => existsSync(path.join(publicRoot, src))),
  );
}

function allVariantPaths(variants: PhotoManifestEntry['variants']): string[] {
  const paths: string[] = [];
  for (const variant of Object.values(variants.responsive) as PhotoVariant[][]) {
    for (const entry of variant) paths.push(entry.src);
  }
  if (variants.lightbox) paths.push(variants.lightbox.src);
  if (variants.social) paths.push(variants.social.src);
  return paths;
}
