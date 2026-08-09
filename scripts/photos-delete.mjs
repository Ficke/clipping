/**
 * Permanently delete a photograph's bytes.
 *
 * Only reachable from `removed`, so nothing on the site can vanish in one step.
 * The frontmatter entry stays behind as the record that the photograph existed,
 * which is also what stops a later push from minting a fresh ID for it.
 *
 * Any download link for it stops working, deliberately. Orders that reference
 * it are reported rather than blocking: the order keeps its own snapshot of
 * what was bought. Bucket versioning keeps the bytes recoverable for 90 days.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { masterKey, metadataKey } from '../src/lib/downloads.ts';
import { locatePhoto, replacePhotosBlock, today } from './photo-frontmatter.mjs';
import { derivativePrefixes, loadManifests } from './photo-media.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const originalsBucket = process.env.ORIGINALS_BUCKET ?? 'adamficke-com-originals';
const mediaBucket = process.env.MEDIA_BUCKET ?? 'adamficke-com-media';
const ordersTable = process.env.COMMERCE_TABLE ?? 'adamficke-com-commerce-orders';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const assumeYes = args.includes('--yes');
const flags = new Set(['--dry-run', '--yes']);
const positional = args.filter((arg) => !flags.has(arg));

if (positional.length < 1 || positional.length > 2) {
  fail('Usage: bun run photos:delete -- [album] <photo-id | file> [--yes] [--dry-run]');
}

const [reference, album] = positional.length === 2
  ? [positional[1], positional[0]]
  : [positional[0], undefined];

let located;
try {
  located = locatePhoto(albumsRoot, reference, album);
} catch (error) {
  fail(error.message);
}
const { indexPath, contents, entries, photo } = located;

if (!photo.removed) {
  fail(`${photo.file} is still in its album. Run \`bun run photos:remove\` first.`);
}
if (photo.deleted) fail(`${photo.file} was already deleted on ${photo.deleted}`);

const prefixes = derivativePrefixes(loadManifests(albumsRoot), photo.photoId);
const orders = countOrders(photo.photoId);

console.log(`${photo.file} (${photo.photoId}), removed ${photo.removed}`);
console.log(`  master     s3://${originalsBucket}/${masterKey(photo.photoId)}`);
console.log(`  metadata   s3://${originalsBucket}/${metadataKey(photo.photoId)}`);
console.log(`  media      ${prefixes.length} derivative tree${prefixes.length === 1 ? '' : 's'}`);
if (orders > 0) {
  console.log(`  ${orders} order${orders === 1 ? '' : 's'} reference this photograph; their download links will stop working`);
}
console.log('  recoverable for 90 days through bucket versioning');

if (!dryRun && !assumeYes) await confirm(photo.file);

remove(originalsBucket, masterKey(photo.photoId));
remove(originalsBucket, metadataKey(photo.photoId));
for (const prefix of prefixes) removeTree(mediaBucket, prefix);

photo.deleted = today();
console.log(`${dryRun ? 'Would update' : 'Updated'} ${path.relative(repoRoot, indexPath)}`);
if (!dryRun) writeFileSync(indexPath, replacePhotosBlock(contents, entries, path.dirname(indexPath)));

function remove(bucket, key) {
  console.log(`${dryRun ? 'Would delete' : 'Deleting'} s3://${bucket}/${key}`);
  if (dryRun) return;
  aws(['s3api', 'delete-object', '--bucket', bucket, '--key', key]);
}

function removeTree(bucket, prefix) {
  console.log(`${dryRun ? 'Would delete' : 'Deleting'} s3://${bucket}/${prefix}`);
  if (dryRun) return;
  aws(['s3', 'rm', `s3://${bucket}/${prefix}`, '--recursive', '--only-show-errors']);
}

/** Informational only — deletion is the operator's call, not the table's. */
function countOrders(photoId) {
  const result = spawnSync('aws', [
    'dynamodb', 'scan', '--table-name', ordersTable,
    '--filter-expression', 'photoId = :p',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: photoId } }),
    '--select', 'COUNT', '--query', 'Count', '--output', 'text',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.warn('  could not read the order table; continuing without an order count');
    return 0;
  }
  return Number.parseInt((result.stdout ?? '0').trim(), 10) || 0;
}

async function confirm(file) {
  if (!process.stdin.isTTY) fail('deleting needs an interactive confirmation or --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Type ${file} to delete it permanently: `)).trim();
    if (answer !== file) fail('deletion cancelled');
  } finally {
    rl.close();
  }
}

function aws(commandArgs) {
  const result = spawnSync('aws', commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail((result.stderr ?? '').trim() || `aws ${commandArgs[1]} failed`);
}

function fail(message) {
  console.error(`photos:delete: ${message}`);
  process.exit(1);
}
