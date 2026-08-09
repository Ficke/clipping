/**
 * Download one album's masters and metadata sidecars for a media build.
 *
 * Masters are keyed by photo ID, so the source manifest is what says which
 * objects an album is built from, and files are written back under their
 * display names for the builder.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSourceManifest } from '../shared/media.ts';
import { masterKey, metadataKey } from '../src/lib/downloads.ts';

const args = parseArgs(process.argv.slice(2));
const bucket = args.bucket ?? process.env.MANIFEST_BUCKET;
const album = args.album ?? process.env.ALBUM_ID;
const sourceDirectory = path.resolve(args.source);
const metadataDirectory = path.resolve(args.metadata);
const manifestPath = path.resolve(args.manifest);

if (!bucket) fail('A bucket is required through --bucket or MANIFEST_BUCKET');
if (!album) fail('An album is required through --album or ALBUM_ID');

mkdirSync(sourceDirectory, { recursive: true });
mkdirSync(metadataDirectory, { recursive: true });

aws(['s3', 'cp', `s3://${bucket}/manifests/${album}/source.json`, manifestPath, '--only-show-errors']);
const manifest = parseSourceManifest(
  JSON.parse(readFileSync(manifestPath, 'utf8')),
  `s3://${bucket}/manifests/${album}/source.json`,
);

for (const { photoId, file } of manifest.photos) {
  aws(['s3', 'cp', `s3://${bucket}/${masterKey(photoId)}`, path.join(sourceDirectory, file), '--only-show-errors']);
  const sidecar = path.join(metadataDirectory, `${file}.json`);
  const fetched = spawnSync('aws', [
    's3', 'cp', `s3://${bucket}/${metadataKey(photoId)}`, sidecar, '--only-show-errors',
  ], { encoding: 'utf8' });
  // A master predating sidecars still builds; it just carries no shot metadata.
  if (fetched.status !== 0) writeFileSync(sidecar, `${JSON.stringify({ version: 1, file })}\n`);
}

console.log(`Fetched ${manifest.photos.length} master${manifest.photos.length === 1 ? '' : 's'} for ${album}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (['--bucket', '--album', '--source', '--metadata', '--manifest'].includes(value)) {
      parsed[value.slice(2)] = values[++index];
    }
    else fail(`Unknown argument: ${value}`);
  }
  for (const field of ['source', 'metadata', 'manifest']) {
    if (!parsed[field]) fail(`--${field} is required`);
  }
  return parsed;
}

function aws(commandArgs) {
  const result = spawnSync('aws', commandArgs, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) fail(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail(`aws ${commandArgs[1]} failed`);
}

function fail(message) {
  console.error(`photos:fetch-sources: ${message}`);
  process.exit(1);
}
