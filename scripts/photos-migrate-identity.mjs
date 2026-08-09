/**
 * One-shot migration from the two-copy, hash-derived layout to one master per
 * photograph under a minted, permanent ID.
 *
 * Existing photographs keep the ID the old code already derived for them —
 * `photo_` plus the first 24 hex of the sanitized source hash — so the download
 * tokens and Stripe metadata of orders already placed keep resolving. Only
 * photographs added after this get random IDs.
 *
 * Run `--content` first and commit the result, then `--s3`. Neither phase
 * deletes anything: `albums/` and `fulfillment/` are dropped by hand once a
 * download has been verified against the new layout.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exiftool } from 'exiftool-vendored';
import {
  contentTypeFor,
  downloadFilename,
  isPhotoId,
  masterKey,
  metadataKey,
  normalizeExtension,
} from '../src/lib/downloads.ts';
import { archiveMetadata, shotMetadata } from './photo-metadata.mjs';
import { frontmatterValue, readPhotosBlock, replacePhotosBlock, splitFrontmatter } from './photo-frontmatter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const bucket = 'adamficke-com-originals';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const doContent = args.includes('--content');
const doS3 = args.includes('--s3');
if (!doContent && !doS3) fail('Usage: bun run scripts/photos-migrate-identity.mjs --content|--s3 [--dry-run]');

const albums = readdirSync(albumsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(albumsRoot, entry.name, 'photos.json')))
  .map((entry) => path.join(albumsRoot, entry.name));

try {
  for (const albumDirectory of albums) {
    if (doContent) await migrateContent(albumDirectory);
    if (doS3) await migrateObjects(albumDirectory);
  }
} finally {
  await exiftool.end();
}

async function migrateContent(albumDirectory) {
  const indexPath = path.join(albumDirectory, 'index.md');
  const manifestPath = path.join(albumDirectory, 'photos.json');
  const contents = readFileSync(indexPath, 'utf8');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const { lines } = splitFrontmatter(contents, albumDirectory);
  const { entries } = readPhotosBlock(lines);
  const byFile = new Map(manifest.photos.map((photo) => [photo.file, photo]));

  for (const entry of entries) {
    const photo = byFile.get(entry.file);
    if (!photo) fail(`${entry.file} is in index.md but not photos.json`);
    entry.photoId = photoIdFromSourceHash(photo.sourceHash);
    delete entry.forSale;
    delete entry.hidden;
    delete entry.catalog;
  }

  for (const photo of manifest.photos) {
    photo.photoId = photoIdFromSourceHash(photo.sourceHash);
    delete photo.exif;
    const local = path.join(albumDirectory, photo.file);
    photo.shot = existsSync(local) ? await shotMetadata(local) : undefined;
    if (!photo.shot) delete photo.shot;
  }
  manifest.photos = manifest.photos.map(orderManifestEntry);

  const album = path.basename(albumDirectory);
  console.log(`${dryRun ? 'Would rewrite' : 'Rewriting'} ${album}: ${entries.length} photos`);
  if (dryRun) return;
  writeFileSync(indexPath, replacePhotosBlock(contents, entries, albumDirectory));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function migrateObjects(albumDirectory) {
  const indexPath = path.join(albumDirectory, 'index.md');
  const storyId = frontmatterValue(readFileSync(indexPath, 'utf8'), 'storyId');
  const manifest = JSON.parse(readFileSync(path.join(albumDirectory, 'photos.json'), 'utf8'));

  for (const photo of manifest.photos) {
    if (!isPhotoId(photo.photoId ?? '')) fail(`${photo.file} has no photoId — run --content first`);
    const extension = normalizeExtension(photo.file);
    const source = `${bucket}/albums/${storyId}/${photo.file}`;
    const target = masterKey(photo.photoId);

    const alreadyThere = spawnSync('aws', [
      's3api', 'head-object', '--bucket', bucket, '--key', target,
    ], { encoding: 'utf8' }).status === 0;
    console.log(alreadyThere
      ? `Master already present, skipping copy: ${target}`
      : `${dryRun ? 'Would copy' : 'Copying'} ${source} -> ${target}`);
    if (!dryRun && !alreadyThere) {
      // REPLACE, not COPY: the master carries its own content type, download
      // filename, and provenance, none of which the album object has.
      aws([
        's3api', 'copy-object',
        '--bucket', bucket, '--key', target, '--copy-source', encodeURI(source),
        '--metadata-directive', 'REPLACE',
        '--content-type', contentTypeFor(extension),
        '--content-disposition', `attachment; filename="${downloadFilename(photo.photoId, extension)}"`,
        '--metadata', `album=${storyId},file=${photo.file}`,
        '--checksum-algorithm', 'SHA256',
      ]);
    }

    const local = path.join(albumDirectory, photo.file);
    if (!existsSync(local)) {
      console.warn(`  no local copy of ${photo.file}; its metadata sidecar cannot be written`);
      continue;
    }
    const sidecar = {
      version: 1,
      photoId: photo.photoId,
      file: photo.file,
      shot: await shotMetadata(local),
      archive: await archiveMetadata(exiftool, local),
    };
    console.log(`${dryRun ? 'Would write' : 'Writing'} ${metadataKey(photo.photoId)}`);
    if (dryRun) continue;
    const body = path.join(process.env.TMPDIR ?? '/tmp', `${photo.photoId}.json`);
    writeFileSync(body, `${JSON.stringify(sidecar, null, 2)}\n`);
    aws([
      's3api', 'put-object',
      '--bucket', bucket, '--key', metadataKey(photo.photoId),
      '--body', body, '--content-type', 'application/json',
    ]);
  }
}

/** What `photoIdFor` returned before IDs stopped being derived from bytes. */
function photoIdFromSourceHash(sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) fail(`Malformed source hash: ${sourceHash}`);
  return `photo_${sourceHash.slice(0, 24)}`;
}

function orderManifestEntry(photo) {
  const { photoId, file, sourceHash, width, height, shot, variants, ...rest } = photo;
  return { photoId, file, sourceHash, width, height, ...(shot && { shot }), ...rest, variants };
}

function aws(commandArgs) {
  const result = spawnSync('aws', commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail((result.stderr ?? '').trim() || `aws ${commandArgs[1]} failed`);
  return result.stdout;
}

function fail(message) {
  console.error(`photos:migrate: ${message}`);
  process.exit(1);
}
