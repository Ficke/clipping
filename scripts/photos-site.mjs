/** Reversibly hide or show an existing photograph on public site pages. */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  readPhotosBlock,
  replacePhotosBlock,
  resolveAlbumIndex,
  splitFrontmatter,
  frontmatterValue,
} from './photo-frontmatter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const hide = args.includes('--hide') || args.includes('--remove');
const show = args.includes('--show');
const flags = new Set(['--dry-run', '--hide', '--remove', '--show']);
const positional = args.filter((arg) => !flags.has(arg));
if (hide && show || positional.length !== 2) {
  fail('Usage: bun run photos:site -- <album> <file> [--hide | --show] [--dry-run]');
}

let indexPath;
try {
  indexPath = resolveAlbumIndex(albumsRoot, positional[0]);
} catch (error) {
  fail(error.message);
}
const contents = readFileSync(indexPath, 'utf8');
const { lines } = splitFrontmatter(contents, path.dirname(indexPath));
const { entries } = readPhotosBlock(lines);
const photo = entries.find((entry) => entry.file === positional[1]);
if (!photo) fail(`${positional[1]} is not in ${path.relative(repoRoot, indexPath)}`);

let shouldHide = hide ? true : show ? false : undefined;
if (shouldHide === undefined) shouldHide = await promptVisibility(photo);
if (shouldHide) {
  const cover = frontmatterValue(contents, 'cover');
  if (cover === photo.file) fail('photo is the explicit album cover; choose another cover before hiding it');
  if (!entries.some((entry) => entry.file !== photo.file && entry.hidden !== true)) {
    fail('cannot hide the album\'s last visible photo');
  }
  photo.hidden = true;
  delete photo.forSale;
  delete photo.price;
} else {
  delete photo.hidden;
}

const next = replacePhotosBlock(contents, entries, path.dirname(indexPath));
console.log(`${dryRun ? 'Would update' : 'Updated'} ${path.relative(repoRoot, indexPath)}`);
console.log(`  ${photo.file}: ${shouldHide ? 'hidden from public site and store' : 'visible on public site'}`);
console.log(`  private catalog: ${photo.catalog === false ? 'absent' : 'retained'}`);
if (!dryRun) writeFileSync(indexPath, next);
console.log('Run `bun run build` to validate and preview the change.');

async function promptVisibility(entry) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  show ${entry.file} on the public site? [${entry.hidden ? 'no' : 'yes'}] `)).trim()
      || (entry.hidden ? 'no' : 'yes');
    return !/^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

function fail(message) {
  console.error(`photos:site: ${message}`);
  process.exit(1);
}
