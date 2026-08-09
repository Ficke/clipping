/**
 * Take a photograph out of an album, or put it back.
 *
 * Removing is reversible and keeps everything: the frontmatter entry stays as
 * the record, and the master stays in S3 so anyone who already bought the
 * photograph keeps a working download. What it does end is publication — the
 * derivative tree becomes obsolete, so the next `photos:gc` stops the image
 * being served at its CloudFront URL. Restoring rebuilds those from the master.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  frontmatterValue,
  locatePhoto,
  replacePhotosBlock,
  today,
} from './photo-frontmatter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const restore = args.includes('--restore');
const flags = new Set(['--dry-run', '--restore']);
const positional = args.filter((arg) => !flags.has(arg));

if (positional.length < 1 || positional.length > 2) {
  fail('Usage: bun run photos:remove -- [album] <photo-id | file> [--restore] [--dry-run]');
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
const relative = path.relative(repoRoot, indexPath);

if (photo.deleted) fail(`${photo.file} was permanently deleted on ${photo.deleted}; its master is gone`);

if (restore) {
  if (!photo.removed) fail(`${photo.file} is already in the album`);
  delete photo.removed;
} else {
  if (photo.removed) fail(`${photo.file} was already removed on ${photo.removed}`);
  const cover = frontmatterValue(contents, 'cover');
  if (cover === photo.file) fail('photo is the explicit album cover; choose another cover first');
  if (!entries.some((entry) => entry !== photo && !entry.removed)) {
    fail("cannot remove the album's last photograph");
  }
  photo.removed = today();
  delete photo.price;
}

console.log(`${dryRun ? 'Would update' : 'Updated'} ${relative}`);
console.log(`  ${photo.file} (${photo.photoId}): ${restore ? 'back in the album' : `removed ${photo.removed}`}`);
if (!dryRun) writeFileSync(indexPath, replacePhotosBlock(contents, entries, path.dirname(indexPath)));
console.log(restore
  ? 'Run `bun run photos:push` to rebuild its derivatives, then `bun run build`.'
  : 'Run `bun run build` to validate, then `bun run photos:gc` to stop serving its derivatives.');

function fail(message) {
  console.error(`photos:${restore ? 'restore' : 'remove'}: ${message}`);
  process.exit(1);
}
