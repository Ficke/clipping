/** Mint a fresh durable entitlement after current Stripe reversal checks. */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../lambda/integration.ts';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reissueDownload, ReissueRefused } from '../lambda/reissue.ts';
import {
  assertStripeKeyMode,
  parameterNames,
  parseLinkArgs,
  tableForMode,
} from './commerce-operator.ts';

const { sessionId, mode } = input(() => parseLinkArgs(process.argv.slice(2)));
const tableName = input(() => tableForMode(mode));

process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const buyerParam = names.buyer;
const buyer = parseSecrets(await parameter(ssm, buyerParam));
const stripeKey = mode === 'test'
  ? buyer.stripeApiKey
  : parseWebhookSecrets(await parameter(ssm, names.webhook)).stripeReadApiKey;
input(() => assertStripeKeyMode(stripeKey, mode));

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
  fail(error instanceof ReissueRefused
    ? `Refused to issue a link: ${error.message}`
    : `Could not verify the purchase (${error instanceof Error ? error.name : 'UnknownError'}).`);
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

function input(operation) {
  try {
    return operation();
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Invalid input.');
  }
}
