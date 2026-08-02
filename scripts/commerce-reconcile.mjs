/** On-demand recovery for durable commerce orders. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reconcileAll, reconcileOrder } from '../lambda/reconcile.ts';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const modeAt = args.indexOf('--mode');
const mode = args[modeAt + 1];
if (!['test', 'live'].includes(mode)) fail('Usage: bun run commerce:reconcile -- --mode test|live [--dry-run] [--order ord_…]');
const orderAt = args.indexOf('--order');
const orderId = orderAt >= 0 ? args[orderAt + 1] : undefined;
const dryRun = args.includes('--dry-run');
const known = new Set(['--mode', mode, '--dry-run', '--order', orderId].filter(Boolean));
if (args.some((arg) => !known.has(arg))) fail(`Unknown argument: ${args.find((arg) => !known.has(arg))}`);

const tableName = process.env.COMMERCE_TABLE
  ?? (mode === 'live' ? 'adamficke-com-commerce-orders' : undefined);
if (!tableName) fail('COMMERCE_TABLE is required in test mode.');
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const key = mode === 'test'
  ? parseSecrets(await parameter(ssm, process.env.COMMERCE_SECRET_PARAM ?? '/adamficke-com/commerce-test')).stripeApiKey
  : parseWebhookSecrets(await parameter(
      ssm,
      process.env.COMMERCE_WEBHOOK_SECRET_PARAM ?? '/adamficke-com/commerce-webhook',
    )).stripeReadApiKey;
if (!new RegExp(`^[sr]k_${mode}_`).test(key)) fail(`Configured read key is not ${mode} mode.`);

const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
const deps = { stripe: new Stripe(key, { apiVersion: STRIPE_API_VERSION }), orders, dryRun };
const results = orderId
  ? [await orders.get(orderId).then((order) => order
      ? reconcileOrder(order, deps)
      : Promise.resolve({ orderId, outcome: 'FAILED', action: 'order_not_found' }))]
  : await reconcileAll(deps);
for (const result of results) {
  console.log(`${result.outcome.padEnd(9)} ${result.orderId} ${result.action}${result.errorCategory ? ` (${result.errorCategory})` : ''}`);
}
const failed = results.filter((result) => result.outcome === 'FAILED').length;
console.log(`Checked ${results.length}; failed ${failed}${dryRun ? '; dry run' : ''}.`);
if (failed) process.exit(1);

async function parameter(client, name) {
  try {
    const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    if (!response.Parameter?.Value) throw new Error('parameter is empty');
    return response.Parameter.Value;
  } catch (error) {
    fail(`Could not read ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function fail(message) {
  console.error(`commerce:reconcile: ${message}`);
  process.exit(1);
}
