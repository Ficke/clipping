/**
 * Remove derivative trees that committed photo manifests prove are obsolete,
 * and report masters that no album references.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { masterKey } from '../src/lib/downloads';
import { albumIndexes, readPhotosBlock, splitFrontmatter } from './photo-frontmatter';
import { livePrefixes, loadManifests, orphanedTrees } from './photo-media';

interface PhotoLifecycleReference {
  photoId?: string;
  deleted?: string;
}

const repoRoot = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const albumsAt = args.indexOf('--albums');
const albumsInput = albumsAt === -1
  ? path.join(repoRoot, 'content', 'albums')
  : args[albumsAt + 1];
if (!albumsInput) fail('--albums requires a directory');
const albumsRoot = path.resolve(albumsInput);
const mediaBucket = process.env.MEDIA_BUCKET;
const originalsBucket = process.env.ORIGINALS_BUCKET;

if (!existsSync(albumsRoot)) fail(`Album directory does not exist: ${albumsRoot}`);
if (!mediaBucket) fail('MEDIA_BUCKET is required: cleanup compares the bucket against the manifests');

const manifests = loadManifests(albumsRoot);
const live = livePrefixes(manifests);

// Comparing the bucket against the manifests only works when the manifests are
// actually loaded. A fresh clone with none of them would make every tree look
// orphaned, so refuse rather than delete the whole media bucket.
if (!live.size) fail('no committed manifest references any media; refusing to compare');

const keys = listKeys(mediaBucket, 'media/');
const orphans = orphanedTrees(manifests, keys);

if (!orphans.length) {
  console.log(`Photo media cleanup: nothing obsolete (${live.size} trees in use)`);
} else {
  console.log(`Photo media cleanup: ${dryRun ? 'would remove' : 'removing'} ${orphans.length} derivative tree${orphans.length === 1 ? '' : 's'}`);
  for (const prefix of orphans) {
    console.log(`  ${prefix}`);
    if (!dryRun) run('aws', ['s3', 'rm', `s3://${mediaBucket}/${prefix}`, '--recursive', '--only-show-errors']);
  }
}

reportOrphanedMasters();

/** Report unreferenced masters; never delete them. */
function reportOrphanedMasters(): void {
  if (!originalsBucket) return;
  const known = new Set<string>();
  for (const indexPath of albumIndexes(albumsRoot)) {
    const { lines } = splitFrontmatter(readFileSync(indexPath, 'utf8'), path.dirname(indexPath));
    const entries = readPhotosBlock(lines).entries as PhotoLifecycleReference[];
    for (const entry of entries) {
      if (entry.photoId && !entry.deleted) known.add(masterKey(entry.photoId));
    }
  }

  const orphaned = listKeys(originalsBucket, 'photos/').filter((key) => !known.has(key));
  if (!orphaned.length) {
    console.log('Masters: every object in photos/ is referenced by an album');
    return;
  }
  console.log(`Masters: ${orphaned.length} object${orphaned.length === 1 ? '' : 's'} in photos/ referenced by no album`);
  for (const key of orphaned) console.log(`  ${key}`);
  console.log('  nothing was deleted. Check the album frontmatter before removing any of these.');
}

function listKeys(bucket: string, prefix: string): string[] {
  const listed = runCapture('aws', [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix,
    '--query', 'Contents[].Key', '--output', 'json',
  ]);
  const parsed: unknown = JSON.parse(listed || '[]');
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    fail(`aws returned a malformed object listing for ${prefix}`);
  }
  return parsed;
}

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

function fail(message: string): never {
  console.error(`photos:gc: ${message}`);
  process.exit(1);
}
