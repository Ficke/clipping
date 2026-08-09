import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { parseSecrets, parseWebhookSecrets } from '../lambda/config.ts';
import { STRIPE_API_VERSION } from '../commerce/integration';
import { DynamoOrderRepository } from '../lambda/order-repository.ts';
import { reissueDownload, ReissueRefused } from '../commerce/reissue';
import {
  assertStripeKeyMode,
  parameterNames,
  parseLinkArgs,
  tableForMode,
} from './commerce-operator.ts';
import { failCli, operatorInput, readParameter } from './commerce-cli';

const { sessionId, mode } = operatorInput(() => parseLinkArgs(process.argv.slice(2)));
const tableName = operatorInput(() => tableForMode(mode));

process.env.AWS_EC2_METADATA_DISABLED ??= 'true';
const ssm = new SSMClient({ maxAttempts: 2 });
const names = parameterNames(mode);
const buyerParam = names.buyer;
const buyer = parseSecrets(await readParameter(ssm, buyerParam));
const stripeKey = mode === 'test'
  ? buyer.stripeApiKey
  : parseWebhookSecrets(await readParameter(ssm, names.webhook)).stripeReadApiKey;
operatorInput(() => assertStripeKeyMode(stripeKey, mode));

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
  if (!fulfillment.expiresAt || !fulfillment.downloadUrl) failCli('commerce:link', 'Purchase has no downloadable entitlement.');
  console.log(`Expires:  ${new Date(fulfillment.expiresAt * 1000).toLocaleString()}`);
  console.log(`Link:     ${fulfillment.downloadUrl}`);
} catch (error) {
  failCli('commerce:link', error instanceof ReissueRefused
    ? `Refused to issue a link: ${error.message}`
    : `Could not verify the purchase (${error instanceof Error ? error.name : 'UnknownError'}).`);
}
