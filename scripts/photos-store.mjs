/** List, reprice, delist, or purge an existing photograph from commerce. */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  formatPriceDollars,
  parsePriceDollars,
  readPhotosBlock,
  replacePhotosBlock,
  resolveAlbumIndex,
  splitFrontmatter,
} from './photo-frontmatter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const assumeYes = args.includes('--yes');
const remove = args.includes('--remove');
const purgeCatalog = args.includes('--purge-catalog');
const restoreCatalog = args.includes('--restore-catalog');
const priceAt = args.indexOf('--price');
const priceInput = priceAt === -1 ? undefined : args[priceAt + 1];
const consumed = new Set(['--dry-run', '--yes', '--remove', '--purge-catalog', '--restore-catalog']);
if (priceAt !== -1) {
  consumed.add('--price');
  consumed.add(priceInput);
}
const positional = args.filter((arg) => !consumed.has(arg));
const actions = [priceInput !== undefined, remove, purgeCatalog, restoreCatalog].filter(Boolean).length;

if (actions > 1 || priceAt !== -1 && priceInput === undefined || positional.length !== 2) {
  fail('Usage: bun run photos:store -- <album> <file> [--price 40 | --remove | --purge-catalog | --restore-catalog] [--dry-run] [--yes]');
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

let action = priceInput === undefined ? undefined : { kind: 'price', price: parsePrice(priceInput) };
if (remove) action = { kind: 'remove' };
if (purgeCatalog) action = { kind: 'purge' };
if (restoreCatalog) action = { kind: 'restore' };
if (!action) action = await promptAction(photo);
if (action.kind === 'purge' && !dryRun && !assumeYes) await confirmPurge(photo.file);

if (action.kind === 'price') {
  if (photo.hidden) fail('photo is hidden from the main site; run photos:site --show first');
  photo.forSale = true;
  photo.price = action.price;
  delete photo.catalog;
} else if (action.kind === 'remove') {
  delete photo.forSale;
  delete photo.price;
} else if (action.kind === 'purge') {
  delete photo.forSale;
  delete photo.price;
  photo.catalog = false;
} else if (action.kind === 'restore') {
  delete photo.catalog;
}

const next = replacePhotosBlock(contents, entries, path.dirname(indexPath));
const status = describe(photo);
console.log(`${dryRun ? 'Would update' : 'Updated'} ${path.relative(repoRoot, indexPath)}`);
console.log(`  ${photo.file}: ${status}`);
if (!dryRun) writeFileSync(indexPath, next);
console.log('Run `bun run build` to validate and preview the change.');

async function promptAction(entry) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${entry.file}: ${describe(entry)}`);
    if (entry.catalog === false) {
      const restore = /^y(es)?$/i.test((await rl.question('  restore to private catalog? [yes] ')).trim() || 'yes');
      return restore ? { kind: 'restore' } : { kind: 'purge' };
    }
    const listed = /^y(es)?$/i.test((await rl.question(`  list in store? [${entry.forSale ? 'yes' : 'no'}] `)).trim()
      || (entry.forSale ? 'yes' : 'no'));
    if (!listed) return { kind: 'remove' };
    while (true) {
      const fallback = entry.price ?? 40;
      const answer = (await rl.question(`  price USD [${formatPriceDollars(fallback)}] `)).trim()
        || String(fallback);
      try {
        return { kind: 'price', price: parsePriceDollars(answer) };
      } catch (error) {
        console.log(`  ${error.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function confirmPurge(file) {
  if (!process.stdin.isTTY) fail('catalog purge needs an interactive confirmation or --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Warning: purging breaks fulfillment and manual reissue for every prior purchase of this photo.');
    const answer = (await rl.question(`Type ${file} to purge it from the private catalog: `)).trim();
    if (answer !== file) fail('catalog purge cancelled');
  } finally {
    rl.close();
  }
}

function describe(entry) {
  if (entry.catalog === false) return 'absent from private catalog';
  if (entry.forSale) return `for sale at $${formatPriceDollars(entry.price)}`;
  return 'not for sale; retained in private catalog';
}

function parsePrice(value) {
  try {
    return parsePriceDollars(value);
  } catch (error) {
    fail(error.message);
  }
}

function fail(message) {
  console.error(`photos:store: ${message}`);
  process.exit(1);
}
