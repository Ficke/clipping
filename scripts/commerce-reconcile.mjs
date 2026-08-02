/** On-demand recovery for durable commerce orders. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reconcileAll, reconcileOrder } from '../lambda/reconcile.ts';
import {
  assertStripeKeyMode,
  parameterNames,
  parseReconcileArgs,
  tableForMode,
} from './commerce-operator.mjs';

const { mode, orderId, dryRun } = input(() => parseReconcileArgs(process.argv.slice(2)));
const tableName = input(() => tableForMode(mode));
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const key = mode === 'test'
  ? parseSecrets(await parameter(ssm, names.buyer)).stripeApiKey
  : parseWebhookSecrets(await parameter(ssm, names.webhook)).stripeReadApiKey;
input(() => assertStripeKeyMode(key, mode));

const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
const deps = { stripe: new Stripe(key, { apiVersion: STRIPE_API_VERSION }), orders, dryRun };
let results;
try {
  results = orderId
    ? [await orders.get(orderId).then((order) => order
        ? reconcileOrder(order, deps)
        : Promise.resolve({ orderId, outcome: 'FAILED', action: 'order_not_found' }))]
    : await reconcileAll(deps);
} catch (error) {
  fail(`Reconciliation could not start (${error instanceof Error ? error.name : 'UnknownError'}).`);
}
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

function input(operation) {
  try {
    return operation();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid input.');
  }
}
