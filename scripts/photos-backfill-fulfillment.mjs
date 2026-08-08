/** Backfill immutable fulfillment objects from the sanitized S3 archive. */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { frontmatterValue, readPhotosBlock, splitFrontmatter } from './photo-frontmatter.mjs';
import { ensureFulfillmentAsset } from './photo-fulfillment.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = values.includes('--dry-run');
const albumsAt = values.indexOf('--albums');
const bucketAt = values.indexOf('--bucket');
const albumsRoot = path.resolve(albumsAt === -1
  ? path.join(repoRoot, 'content', 'albums')
  : values[albumsAt + 1] ?? '');
const bucket = bucketAt === -1 ? 'adamficke-com-originals' : values[bucketAt + 1];
const recognized = new Set(['--dry-run', '--albums', '--bucket']);

if ((albumsAt !== -1 && !values[albumsAt + 1]) || (bucketAt !== -1 && !values[bucketAt + 1])) usage();
for (let index = 0; index < values.length; index++) {
  const value = values[index];
  if (!value.startsWith('--') || !recognized.has(value)) usage();
  if (value === '--albums' || value === '--bucket') index++;
}
if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) fail('invalid S3 bucket name');
if (!existsSync(albumsRoot)) fail(`Album directory does not exist: ${albumsRoot}`);

const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-fulfillment-backfill-'));
const counts = { uploaded: 0, reused: 0, missing: 0, failed: 0 };
try {
  const albums = readdirSync(albumsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(albumsRoot, entry.name))
    .filter((directory) => existsSync(path.join(directory, 'index.md')) && existsSync(path.join(directory, 'photos.json')))
    .sort();

  for (const albumDirectory of albums) backfillAlbum(albumDirectory);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

console.log(`Fulfillment backfill: ${counts.uploaded} uploaded, ${counts.reused} reused, ${counts.missing} would upload, ${counts.failed} failed`);
if (counts.failed) process.exit(1);

function backfillAlbum(albumDirectory) {
  const indexPath = path.join(albumDirectory, 'index.md');
  const manifestPath = path.join(albumDirectory, 'photos.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    reportFailure(path.relative(repoRoot, manifestPath), `invalid manifest: ${error.message}`);
    return;
  }

  const contents = readFileSync(indexPath, 'utf8');
  const storyId = frontmatterValue(contents, 'storyId');
  if (!storyId || manifest.album !== storyId) {
    reportFailure(path.relative(repoRoot, albumDirectory), 'frontmatter storyId does not match the manifest album');
    return;
  }
  const { lines } = splitFrontmatter(contents, albumDirectory);
  const sellable = readPhotosBlock(lines).entries.filter((entry) => entry.forSale === true);
  const manifestByFile = new Map((manifest.photos ?? []).map((photo) => [photo.file, photo]));

  for (const entry of sellable) {
    const photo = manifestByFile.get(entry.file);
    const label = `${storyId}/${entry.file}`;
    if (!photo || !/^[a-f0-9]{64}$/.test(photo.sourceHash ?? '')) {
      reportFailure(label, 'missing a valid committed sourceHash');
      continue;
    }
    if (path.basename(entry.file) !== entry.file) {
      reportFailure(label, 'photo filename must not contain a path');
      continue;
    }

    const local = path.join(temporary, `${photo.sourceHash}-${entry.file}`);
    const downloaded = spawnSync('aws', [
      's3', 'cp', `s3://${bucket}/albums/${storyId}/${entry.file}`, local, '--only-show-errors',
    ], { encoding: 'utf8' });
    if (downloaded.error || downloaded.status !== 0) {
      reportFailure(label, downloaded.error?.message ?? downloaded.stderr.trim() ?? 'archive object is missing');
      continue;
    }

    try {
      const result = ensureFulfillmentAsset({ bucket, file: local, sourceHash: photo.sourceHash, dryRun });
      counts[result.action]++;
      const status = result.action === 'missing' ? 'WOULD_UPLOAD' : result.action.toUpperCase();
      console.log(`${status} ${label} -> ${result.key}`);
    } catch (error) {
      reportFailure(label, error.message);
    }
  }
}

function reportFailure(label, message) {
  counts.failed++;
  console.error(`FAILED ${label}: ${message}`);
}

function usage() {
  fail('Usage: bun run photos:backfill-fulfillment -- [--dry-run] [--albums directory] [--bucket name]');
}

function fail(message) {
  console.error(`photos:backfill-fulfillment: ${message}`);
  process.exit(1);
}
