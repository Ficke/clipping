import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  formatPriceDollars,
  locatePhoto,
  parsePriceDollars,
  replacePhotosBlock,
} from './photo-frontmatter';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const defaultPriceDollars = 40;

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const delist = args.includes('--delist');
const priceAt = args.indexOf('--price');
const priceInput = priceAt === -1 ? undefined : args[priceAt + 1];
const consumed = new Set(['--dry-run', '--delist']);
if (priceAt !== -1) {
  consumed.add('--price');
  if (priceInput !== undefined) consumed.add(priceInput);
}
const positional = args.filter((arg) => !consumed.has(arg));

if (delist && priceInput !== undefined
  || priceAt !== -1 && priceInput === undefined
  || positional.length < 1 || positional.length > 2) {
  fail('Usage: bun run photos:store -- [album] <photo-id | file> [--price <usd> | --delist] [--dry-run]');
}

const [reference, album] = positional.length === 2
  ? [positional[1], positional[0]]
  : [positional[0], undefined];

let located;
try {
  located = locatePhoto(albumsRoot, reference, album);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const { indexPath, contents, entries, photo } = located;

if (photo.removed) {
  fail(`${photo.file} was removed from its album on ${photo.removed}; restore it before selling it`);
}

const action = priceInput !== undefined
  ? { kind: 'price', price: parsePrice(priceInput) }
  : delist ? { kind: 'delist' } : await promptAction(photo);

if (action.kind === 'price') photo.priceDollars = action.price;
else delete photo.priceDollars;

console.log(`${dryRun ? 'Would update' : 'Updated'} ${path.relative(repoRoot, indexPath)}`);
console.log(`  ${photo.file} (${photo.photoId}): ${describe(photo)}`);
if (!dryRun) writeFileSync(indexPath, replacePhotosBlock(contents, entries, path.dirname(indexPath)));
console.log('Run `bun run build` to validate and preview the change.');

async function promptAction(entry: import('./photo-frontmatter').FrontmatterPhoto): Promise<{ kind: 'price'; price: number } | { kind: 'delist' }> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${entry.file}: ${describe(entry)}`);
    const listed = /^y(es)?$/i.test((await rl.question(`  list in store? [${entry.priceDollars ? 'yes' : 'no'}] `)).trim()
      || (entry.priceDollars ? 'yes' : 'no'));
    if (!listed) return { kind: 'delist' };
    while (true) {
      const fallback = entry.priceDollars ?? defaultPriceDollars;
      const answer = (await rl.question(`  price USD [${formatPriceDollars(fallback)}] `)).trim()
        || String(fallback);
      try {
        return { kind: 'price', price: parsePriceDollars(answer) };
      } catch (error) {
        console.log(`  ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}

function describe(entry: import('./photo-frontmatter').FrontmatterPhoto): string {
  return entry.priceDollars === undefined
    ? 'not for sale'
    : `for sale at $${formatPriceDollars(entry.priceDollars)}`;
}

function parsePrice(value: string): number {
  try {
    return parsePriceDollars(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message: string): never {
  console.error(`photos:store: ${message}`);
  process.exit(1);
}
