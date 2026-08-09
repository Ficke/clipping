/** Explicitly restore a revoked order after a won dispute. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { disputeFacts } from '../commerce/disputes';
import { restoreEntitlement } from '../commerce/entitlement';
import { STRIPE_API_VERSION } from '../commerce/integration';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import {
  assertStripeKeyMode,
  parameterNames,
  parseRestoreArgs,
  tableForMode,
} from './commerce-operator.ts';
import { failCli, operatorInput, readParameter } from './commerce-cli';

const { orderId, actor, reason, mode } = operatorInput(() => parseRestoreArgs(process.argv.slice(2)));
const tableName = operatorInput(() => tableForMode(mode));
process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const key = mode === 'test'
  ? parseSecrets(await readParameter(ssm, names.buyer)).stripeApiKey
  : parseWebhookSecrets(await readParameter(ssm, names.webhook)).stripeReadApiKey;
operatorInput(() => assertStripeKeyMode(key, mode));
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
try {
  const order = await orders.get(orderId);
  if (!order?.stripeSessionId) failCli('commerce:restore', 'Order does not exist or has no Checkout Session.');
  const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, { expand: ['payment_intent.latest_charge'] });
  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') failCli('commerce:restore', 'PaymentIntent is not expanded.');
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') failCli('commerce:restore', 'Charge is not expanded.');
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
  failCli('commerce:restore', `Restoration refused (${name})${detail}`);
}
