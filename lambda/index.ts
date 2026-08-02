import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Stripe from 'stripe';
import { loadCatalog, NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';
import { loadSecrets, readEnv, type Env, type Secrets } from './config';
import { resolveDownload } from './download';
import { EntitlementIntegrityError, EntitlementUnavailable } from './entitlement';
import { CheckoutReturnExpired, fulfillCheckout } from './fulfill';
import {
  hasExpectedOrigin,
  header,
  json,
  method,
  methodNotAllowed,
  problem,
  query,
  rawBody,
  rawBodyBytes,
  redirect,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './http';
import { STRIPE_API_VERSION } from './integration';
import { errorCategory, hashIdentifier, logOutcome } from './logging';
import { DynamoOrderRepository, OrderNotFound, type OrderRepository } from './order-repository';
import { InvalidToken } from './tokens';

export interface BuyerRuntime {
  env: Env;
  s3: S3Client;
  orders: OrderRepository;
  stripeFor(secrets: Secrets): Stripe;
  loadSecrets(): Promise<Secrets>;
}

let runtime: BuyerRuntime | undefined;
function defaultRuntime(): BuyerRuntime {
  if (runtime) return runtime;
  const env = readEnv();
  const s3 = new S3Client({});
  const orders = new DynamoOrderRepository(
    env.tableName,
    DynamoDBDocumentClient.from(new DynamoDBClient({})),
  );
  let stripeClient: { key: string; client: Stripe } | undefined;
  runtime = {
    env,
    s3,
    orders,
    stripeFor(secrets) {
      if (stripeClient?.key !== secrets.stripeApiKey) {
        stripeClient = {
          key: secrets.stripeApiKey,
          client: new Stripe(secrets.stripeApiKey, { apiVersion: STRIPE_API_VERSION }),
        };
      }
      return stripeClient.client;
    },
    loadSecrets: () => loadSecrets(env),
  };
  return runtime;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  return handleBuyer(event, defaultRuntime());
}

export async function handleBuyer(
  event: FunctionUrlEvent,
  deps: BuyerRuntime,
): Promise<FunctionUrlResult> {
  const path = event.rawPath.replace(/\/$/, '');
  const verb = method(event);
  const route = `${verb} ${path}`;
  const requestId = event.requestContext.requestId;

  if (!hasExpectedOrigin(event, deps.env.originHeaderName, deps.env.originHeaderValue)) {
    logOutcome('warn', { outcome: 'origin_rejected', route, requestId, status: 403 });
    return problem(403, 'Forbidden.');
  }

  try {
    if (path === '/api/checkout') {
      if (verb !== 'POST') return methodNotAllowed('POST');
      const photoId = checkoutPhotoId(event);
      if (!photoId) return problem(400, 'Checkout form is invalid.');
      const secrets = await deps.loadSecrets();
      const catalog = await loadCatalog(deps.env.siteBucket, deps.s3);
      const { session } = await createCheckoutSession(photoId, {
        stripe: deps.stripeFor(secrets),
        orders: deps.orders,
        catalog,
        siteUrl: deps.env.siteUrl,
        stripeProductId: secrets.stripeProductId,
        livemode: /^(?:rk|sk)_live_/.test(secrets.stripeApiKey),
      });
      if (!session.url) throw new Error('Stripe Checkout Session has no URL');
      logOutcome('info', {
        outcome: 'checkout_created', route, requestId, status: 303,
        identifierHash: hashIdentifier(session.client_reference_id ?? session.id),
      });
      return redirect(session.url);
    }

    if (path === '/api/fulfill') {
      if (verb !== 'GET') return methodNotAllowed('GET');
      const sessionId = query(event).get('session_id');
      if (!sessionId) return problem(400, 'Missing session_id.');
      const secrets = await deps.loadSecrets();
      const fulfillment = await fulfillCheckout(sessionId, {
        stripe: deps.stripeFor(secrets),
        orders: deps.orders,
        siteUrl: deps.env.siteUrl,
        downloadTokenKey: secrets.downloadTokenKey,
        requireFreshReturn: true,
      });
      if (fulfillment.status !== 'paid') {
        const response = json(202, { status: 'pending' });
        response.headers = { ...response.headers, 'retry-after': '2' };
        return response;
      }
      return json(200, {
        status: 'paid',
        downloadUrl: fulfillment.downloadUrl,
        expiresAt: fulfillment.expiresAt,
        albumTitle: fulfillment.item?.albumTitle,
        label: fulfillment.item?.label,
        previewSrc: fulfillment.item?.previewSrc,
      });
    }

    if (path === '/api/download') {
      if (verb !== 'GET') return methodNotAllowed('GET');
      const token = query(event).get('t');
      if (!token) return problem(400, 'Missing token.');
      const secrets = await deps.loadSecrets();
      const url = await resolveDownload(token, {
        s3: deps.s3,
        originalsBucket: deps.env.originalsBucket,
        downloadTokenKey: secrets.downloadTokenKey,
      });
      return redirect(url, 302);
    }

    return problem(404, 'Not found.');
  } catch (error) {
    const identifier = query(event).get('session_id');
    const common = {
      route,
      requestId,
      ...(identifier ? { identifierHash: hashIdentifier(identifier) } : {}),
      errorCategory: errorCategory(error),
    };
    if (error instanceof NotForSale) {
      logOutcome('warn', { ...common, outcome: 'not_for_sale', status: 404 });
      return problem(404, 'That photograph is not for sale.');
    }
    if (error instanceof InvalidToken) {
      logOutcome('warn', { ...common, outcome: 'token_rejected', status: 410 });
      return problem(410, 'This download link is no longer valid. Reply to your receipt and I will send a fresh one.');
    }
    if (error instanceof CheckoutReturnExpired || error instanceof EntitlementUnavailable) {
      logOutcome('warn', { ...common, outcome: 'fulfillment_unavailable', status: 410 });
      return problem(410, 'This order is no longer available from this page. Reply to your receipt for help.');
    }
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      logOutcome('warn', { ...common, outcome: 'session_unknown', status: 404 });
      return problem(404, 'That order could not be found.');
    }
    const integrity = error instanceof EntitlementIntegrityError || error instanceof OrderNotFound;
    logOutcome('error', { ...common, outcome: integrity ? 'integrity_failure' : 'request_failed', status: 500 });
    return problem(500, 'Something went wrong. Nothing was charged twice — reply to your receipt if in doubt.');
  }
}

function checkoutPhotoId(event: FunctionUrlEvent): string | undefined {
  const contentType = header(event, 'content-type')?.toLowerCase().split(';', 1)[0]?.trim();
  if (contentType !== 'application/x-www-form-urlencoded') return undefined;
  if (rawBodyBytes(event).length > 1024) return undefined;
  const fields = [...new URLSearchParams(rawBody(event)).entries()];
  if (fields.length !== 1 || fields[0]?.[0] !== 'photo_id' || !fields[0][1]) return undefined;
  return fields[0][1];
}
