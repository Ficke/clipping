/**
 * Report every order for one photograph.
 *
 * Traceability from an order to its photograph is durable: the order records
 * the photo ID and a snapshot taken at checkout. This is the other direction,
 * and it scans. The expected order volume does not justify a secondary index.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { locatePhoto } from './photo-frontmatter.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const ordersTable = process.env.COMMERCE_TABLE ?? 'adamficke-com-commerce-orders';

const positional = process.argv.slice(2).filter((arg) => arg !== '--' && !arg.startsWith('--'));
if (positional.length < 1 || positional.length > 2) {
  fail('Usage: bun run photos:sales -- [album] <photo-id | file>');
}

const [reference, album] = positional.length === 2
  ? [positional[1], positional[0]]
  : [positional[0], undefined];

let photo;
try {
  ({ photo } = locatePhoto(albumsRoot, reference, album));
} catch (error) {
  fail(error.message);
}

const state = photo.deleted ? `deleted ${photo.deleted}`
  : photo.removed ? `removed ${photo.removed}`
  : photo.price === undefined ? 'in album, not for sale'
  : `for sale at $${photo.price}`;
console.log(`${photo.file} (${photo.photoId}) — ${state}`);

const orders = scan(photo.photoId);
if (!orders.length) {
  console.log('No orders reference this photograph.');
  process.exit(0);
}

console.log(`${orders.length} order${orders.length === 1 ? '' : 's'}:`);
for (const order of orders.sort((left, right) => created(left) - created(right))) {
  const date = new Date(created(order) * 1000).toISOString().slice(0, 10);
  const amount = order.expectedAmount?.N ? `$${(Number(order.expectedAmount.N) / 100).toFixed(2)}` : '—';
  const mode = order.livemode?.BOOL ? 'live' : 'test';
  console.log(`  ${date}  ${order.state?.S?.padEnd(8)}  ${amount.padStart(8)}  ${mode}  ${order.orderId?.S}`);
}

function scan(photoId) {
  const result = spawnSync('aws', [
    'dynamodb', 'scan', '--table-name', ordersTable,
    '--filter-expression', 'photoId = :p',
    '--expression-attribute-values', JSON.stringify({ ':p': { S: photoId } }),
    '--query', 'Items', '--output', 'json',
  ], { encoding: 'utf8' });
  if (result.error) fail(`could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail((result.stderr ?? '').trim() || 'could not scan the order table');
  return JSON.parse(result.stdout || '[]') ?? [];
}

function created(order) {
  return Number(order.createdAt?.N ?? 0);
}

function fail(message) {
  console.error(`photos:sales: ${message}`);
  process.exit(1);
}
