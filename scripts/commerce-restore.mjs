/** Explicitly restore a revoked order after a won dispute. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { restoreEntitlement } from '../lambda/entitlement.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const orderId = args[0];
const actor = value('--actor');
const reason = value('--reason');
const mode = value('--mode') ?? 'live';
if (!/^ord_[a-f0-9]{32}$/.test(orderId ?? '') || !actor || !reason || !['test', 'live'].includes(mode)) {
  fail('Usage: bun run commerce:restore -- ord_… --actor <value> --reason <value> [--mode test|live]');
}
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
const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION });
const orders = new DynamoOrderRepository(
  tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
);
const order = await orders.get(orderId);
if (!order?.stripeSessionId) fail('Order does not exist or has no Checkout Session.');
const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, { expand: ['payment_intent.latest_charge'] });
const intent = session.payment_intent;
if (!intent || typeof intent === 'string') fail('PaymentIntent is not expanded.');
const charge = intent.latest_charge;
if (!charge || typeof charge === 'string') fail('Charge is not expanded.');
const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 });
const won = disputes.data.some((dispute) => dispute.status === 'won' || dispute.status === 'warning_closed');
const current = charge.disputed || disputes.data.some((dispute) => !['won', 'warning_closed'].includes(dispute.status));
const restored = await restoreEntitlement(orders, orderId, {
  actor,
  reason,
  evidence: {
    disputeWon: won,
    refunded: charge.refunded || charge.amount_refunded > 0,
    currentDispute: current,
  },
});
console.log(`Restored ${restored.orderId}; actor ${restored.restoredBy}; reason ${restored.restorationReason}.`);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
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
