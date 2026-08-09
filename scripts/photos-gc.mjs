/**
 * Remove derivative trees that committed photo manifests prove are obsolete,
 * and report masters that no album references.
 *
 * Removed photographs lose their derivatives here, which is what actually stops
 * the image being served. Their masters are left alone: an order may still
 * resolve one, and only `photos:delete` is allowed to destroy bytes.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { masterKey } from '../src/lib/downloads.ts';
import { readPhotosBlock, splitFrontmatter } from './photo-frontmatter.mjs';
import { loadManifests, mediaPrefix, validHash, validProfile } from './photo-media.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const albumsAt = args.indexOf('--albums');
const albumsRoot = path.resolve(albumsAt === -1 ? path.join(repoRoot, 'content', 'albums') : args[albumsAt + 1]);
const mediaBucket = process.env.MEDIA_BUCKET;
const originalsBucket = process.env.ORIGINALS_BUCKET;

if (albumsAt !== -1 && !args[albumsAt + 1]) fail('--albums requires a directory');
if (!existsSync(albumsRoot)) fail(`Album directory does not exist: ${albumsRoot}`);
if (!mediaBucket && !dryRun) fail('MEDIA_BUCKET is required unless --dry-run is set');

const manifests = loadManifests(albumsRoot);

const live = new Set();
const obsolete = new Map();
for (const manifest of manifests) {
  for (const photo of manifest.photos ?? []) {
    if (validHash(photo.sourceHash)) live.add(identity(manifest.profile, photo.sourceHash));
  }
  for (const entry of manifest.obsoleteMedia ?? []) {
    if (validProfile(entry.profile) && validHash(entry.sourceHash)) {
      obsolete.set(identity(entry.profile, entry.sourceHash), entry);
    }
  }
}

const removable = [...obsolete]
  .filter(([key]) => !live.has(key))
  .map(([, entry]) => entry)
  .sort((left, right) => identity(left.profile, left.sourceHash).localeCompare(identity(right.profile, right.sourceHash)));

if (!removable.length) {
  console.log('Photo media cleanup: nothing obsolete');
} else {
  console.log(`Photo media cleanup: ${dryRun ? 'would remove' : 'removing'} ${removable.length} derivative tree${removable.length === 1 ? '' : 's'}`);
  for (const entry of removable) {
    const prefix = mediaPrefix(entry.profile, entry.sourceHash);
    console.log(`  ${prefix}`);
    if (!dryRun) run('aws', ['s3', 'rm', `s3://${mediaBucket}/${prefix}`, '--recursive', '--only-show-errors']);
  }
}

reportOrphanedMasters();

/**
 * A report, never a deletion. An unreferenced master is usually a mistake in
 * the other direction — frontmatter lost, or an album not yet committed — and
 * guessing wrong here destroys the only copy of a photograph.
 */
function reportOrphanedMasters() {
  if (!originalsBucket) return;
  const known = new Set();
  for (const indexPath of readdirSync(albumsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(albumsRoot, entry.name, 'index.md'))
    .filter((indexPath) => existsSync(indexPath))) {
    const { lines } = splitFrontmatter(readFileSync(indexPath, 'utf8'), path.dirname(indexPath));
    for (const entry of readPhotosBlock(lines).entries) {
      if (entry.photoId && !entry.deleted) known.add(masterKey(entry.photoId));
    }
  }

  const listed = runCapture('aws', [
    's3api', 'list-objects-v2', '--bucket', originalsBucket, '--prefix', 'photos/',
    '--query', 'Contents[].Key', '--output', 'json',
  ]);
  const orphans = (JSON.parse(listed || '[]') ?? []).filter((key) => !known.has(key));
  if (!orphans.length) {
    console.log('Masters: every object in photos/ is referenced by an album');
    return;
  }
  console.log(`Masters: ${orphans.length} object${orphans.length === 1 ? '' : 's'} in photos/ referenced by no album`);
  for (const key of orphans) console.log(`  ${key}`);
  console.log('  nothing was deleted. Check the album frontmatter before removing any of these.');
}

function identity(profile, sourceHash) {
  return `${profile}:${sourceHash}`;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

function fail(message) {
  console.error(`photos:gc: ${message}`);
  process.exit(1);
}
