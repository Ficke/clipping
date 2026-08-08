import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { loadWebhookSecrets, readWebhookEnv, type WebhookSecrets } from './config';
import type { FunctionUrlEvent, FunctionUrlResult } from './http';
import { STRIPE_API_VERSION } from './integration';
import { DynamoOrderRepository } from './order-repository';
import { handleWebhook } from './webhook';

const env = readWebhookEnv();
const orders = new DynamoOrderRepository(
  env.tableName,
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
);
let stripeClient: { key: string; client: Stripe } | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  return handleWebhook(event, {
    originHeaderName: env.originHeaderName,
    originHeaderValues: env.originHeaderValues,
    orders,
    loadSecrets: () => loadWebhookSecrets(env.secretParam),
    stripeFor(secrets: WebhookSecrets) {
      if (stripeClient?.key !== secrets.stripeReadApiKey) {
        stripeClient = {
          key: secrets.stripeReadApiKey,
          client: new Stripe(secrets.stripeReadApiKey, { apiVersion: STRIPE_API_VERSION }),
        };
      }
      return stripeClient.client;
    },
  });
}
