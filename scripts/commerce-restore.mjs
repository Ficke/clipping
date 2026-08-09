/** Explicitly restore a revoked order after a won dispute. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { disputeFacts } from '../lambda/disputes.ts';
import { restoreEntitlement } from '../lambda/entitlement.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import {
  assertStripeKeyMode,
  parameterNames,
  parseRestoreArgs,
  tableForMode,
} from './commerce-operator.ts';

const { orderId, actor, reason, mode } = input(() => parseRestoreArgs(process.argv.slice(2)));
const tableName = input(() => tableForMode(mode));
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const key = mode === 'test'
  ? parseSecrets(await parameter(ssm, names.buyer)).stripeApiKey
  : parseWebhookSecrets(await parameter(ssm, names.webhook)).stripeReadApiKey;
input(() => assertStripeKeyMode(key, mode));
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
try {
  const order = await orders.get(orderId);
  if (!order?.stripeSessionId) fail('Order does not exist or has no Checkout Session.');
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, { expand: ['payment_intent.latest_charge'] });
  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') fail('PaymentIntent is not expanded.');
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') fail('Charge is not expanded.');
  const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 });
  const { wonDispute: won, blockingDispute: current } = disputeFacts(charge.disputed, disputes.data);
  const restored = await restoreEntitlement(orders, orderId, {
    actor,
    reason,
    evidence: {
      disputeWon: won,
      refunded: charge.refunded || charge.amount_refunded > 0,
      currentDispute: current,
    },
  });
  console.log(`Restored ${restored.orderId}; audit actor and reason recorded.`);
} catch (error) {
  /* An operator ran this; the name alone does not say which check refused. */
  const name = error instanceof Error ? error.name : 'UnknownError';
  const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
  fail(`Restoration refused (${name})${detail}`);
}

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
  console.error(`commerce:restore: ${message}`);
  process.exit(1);
}

function input(operation) {
  try {
    return operation();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid input.');
  }
}
