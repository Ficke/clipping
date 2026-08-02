/** Mint a fresh durable entitlement after current Stripe reversal checks. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reissueDownload } from '../lambda/reissue.ts';

const sessionId = process.argv[2];
if (!sessionId || !/^cs_(?:test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
  fail('Usage: bun run commerce:link -- cs_test_… | cs_live_…');
}
const mode = sessionId.startsWith('cs_test_') ? 'test' : 'live';
const tableName = process.env.COMMERCE_TABLE
  ?? (mode === 'live' ? 'adamficke-com-commerce-orders' : undefined);
if (!tableName) fail('COMMERCE_TABLE is required for a test-mode reissue.');

process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const buyerParam = process.env.COMMERCE_SECRET_PARAM
  ?? (mode === 'test' ? '/adamficke-com/commerce-test' : '/adamficke-com/commerce');
const buyer = parseSecrets(await parameter(ssm, buyerParam));
const stripeKey = mode === 'test'
  ? buyer.stripeApiKey
  : parseWebhookSecrets(await parameter(
      ssm,
      process.env.COMMERCE_WEBHOOK_SECRET_PARAM ?? '/adamficke-com/commerce-webhook',
    )).stripeReadApiKey;
if (!new RegExp(`^[sr]k_${mode}_`).test(stripeKey)) fail(`Configured read key is not ${mode} mode.`);

try {
  const fulfillment = await reissueDownload(sessionId, {
    stripe: new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION }),
    orders: new DynamoOrderRepository(
      tableName,
      DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 })),
    ),
    siteUrl: (process.env.SITE_URL ?? (mode === 'test' ? 'http://localhost:8787' : 'https://adamficke.com')).replace(/\/$/, ''),
    downloadTokenKey: buyer.downloadTokenKey,
  });
  console.log(`Purchase: ${fulfillment.item?.albumTitle} — ${fulfillment.item?.label}`);
  console.log(`Expires:  ${new Date(fulfillment.expiresAt * 1000).toLocaleString()}`);
  console.log(`Link:     ${fulfillment.downloadUrl}`);
} catch (error) {
  fail(`Refused to issue a link: ${error instanceof Error ? error.message : 'unknown error'}`);
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
  console.error(`commerce:link: ${message}`);
  process.exit(1);
}
