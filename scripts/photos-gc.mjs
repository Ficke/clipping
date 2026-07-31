/** Remove derivative trees that committed photo manifests prove are obsolete. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const albumsAt = args.indexOf('--albums');
const albumsRoot = path.resolve(albumsAt === -1 ? path.join(repoRoot, 'content', 'albums') : args[albumsAt + 1]);
const mediaBucket = process.env.MEDIA_BUCKET;

if (albumsAt !== -1 && !args[albumsAt + 1]) fail('--albums requires a directory');
if (!existsSync(albumsRoot)) fail(`Album directory does not exist: ${albumsRoot}`);
if (!mediaBucket && !dryRun) fail('MEDIA_BUCKET is required unless --dry-run is set');

const manifests = readdirSync(albumsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(albumsRoot, entry.name, 'photos.json')))
  .map((entry) => readManifest(path.join(albumsRoot, entry.name, 'photos.json')));

const live = new Set();
const obsolete = new Map();
for (const manifest of manifests) {
  for (const photo of manifest.photos ?? []) {
    if (validHash(photo.sourceHash)) live.add(identity(manifest.profile, photo.sourceHash));
  }
  for (const entry of manifest.obsoleteMedia ?? []) {
    if (validEntry(entry)) obsolete.set(identity(entry.profile, entry.sourceHash), entry);
  }
}

const removable = [...obsolete]
  .filter(([key]) => !live.has(key))
  .map(([, entry]) => entry)
  .sort((left, right) => identity(left.profile, left.sourceHash).localeCompare(identity(right.profile, right.sourceHash)));

if (!removable.length) {
  console.log('Photo media cleanup: nothing obsolete');
  process.exit(0);
}

console.log(`Photo media cleanup: ${dryRun ? 'would remove' : 'removing'} ${removable.length} derivative tree${removable.length === 1 ? '' : 's'}`);
for (const entry of removable) {
  const prefix = `media/${entry.profile}/${entry.sourceHash.slice(0, 2)}/${entry.sourceHash}/`;
  console.log(`  ${prefix}`);
  if (!dryRun) run('aws', ['s3', 'rm', `s3://${mediaBucket}/${prefix}`, '--recursive', '--only-show-errors']);
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Could not read ${file}: ${error.message}`);
  }
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validEntry(entry) {
  return entry && typeof entry.profile === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(entry.profile)
    && validHash(entry.sourceHash);
}

function identity(profile, sourceHash) {
  return `${profile}:${sourceHash}`;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`photos:gc: ${message}`);
  process.exit(1);
}
