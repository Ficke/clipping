/** Reconcile durable commerce orders on demand. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../commerce/integration';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reconcileAll, reconcileOrder, type ReconcileResult } from '../commerce/reconcile';
import {
  assertStripeKeyMode,
  parameterNames,
  parseReconcileArgs,
  tableForMode,
} from './commerce-operator.ts';
import { failCli, operatorInput, readParameter } from './commerce-cli';

const { mode, orderId, dryRun } = operatorInput(() => parseReconcileArgs(process.argv.slice(2)));
const tableName = operatorInput(() => tableForMode(mode));
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const key = mode === 'test'
  ? parseSecrets(await readParameter(ssm, names.buyer)).stripeApiKey
  : parseWebhookSecrets(await readParameter(ssm, names.webhook)).stripeReadApiKey;
operatorInput(() => assertStripeKeyMode(key, mode));

const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
const deps = { stripe: new Stripe(key, { apiVersion: STRIPE_API_VERSION }), orders, dryRun };
let results: ReconcileResult[];
try {
  results = orderId
    ? [await orders.get(orderId).then((order) => order
        ? reconcileOrder(order, deps)
        : Promise.resolve({ orderId, outcome: 'FAILED' as const, action: 'order_not_found' }))]
    : await reconcileAll(deps);
} catch (error) {
  failCli('commerce:reconcile', `Reconciliation could not start (${error instanceof Error ? error.name : 'UnknownError'}).`);
}
for (const result of results) {
  console.log(`${result.outcome.padEnd(9)} ${result.orderId} ${result.action}${result.errorCategory ? ` (${result.errorCategory})` : ''}`);
}
const failed = results.filter((result) => result.outcome === 'FAILED').length;
console.log(`Checked ${results.length}; failed ${failed}${dryRun ? '; dry run' : ''}.`);
if (failed) process.exit(1);
