import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import Stripe from 'stripe';
import { loadCatalog, NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';
import { loadSecrets, readEnv, type Env, type Secrets } from './config';
import { resolveDownload } from './download';
import { sendDelivery } from './email';
import { fulfillCheckout, type Fulfillment } from './fulfill';
import {
  fromEdge,
  header,
  json,
  method,
  problem,
  query,
  rawBody,
  redirect,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './http';
import { InvalidToken } from './tokens';
import { isFulfillable, verifyWebhook } from './webhook';

/**
 * The whole money path: four routes behind one Lambda.
 *
 *   GET  /api/checkout?sku=…       → 303 to Stripe Checkout
 *   POST /api/stripe/webhook       → fulfil and email, signature-verified
 *   GET  /api/fulfill?session_id=… → the landing page's copy of the same result
 *   GET  /api/download?t=…         → 302 to a freshly presigned S3 URL
 *
 * One function rather than four keeps a single deploy artifact, one IAM role, and
 * one cold start. They are separate route modules so that adding a fifth — a
 * print order, say — is a new file and a new case, not a rewrite.
 */

/* Pin the API version so a Stripe-side default change cannot alter behaviour. */
const STRIPE_API_VERSION = '2026-06-24.dahlia';

const env: Env = readEnv();
const s3 = new S3Client({});
const ses = new SESv2Client({});

let stripeClient: Stripe | undefined;
function stripe(secrets: Secrets): Stripe {
  stripeClient ??= new Stripe(secrets.stripeApiKey, { apiVersion: STRIPE_API_VERSION });
  return stripeClient;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  /*
   * Gate on having come through CloudFront before doing anything else, so a
   * request that found the Function URL directly costs no Parameter Store call.
   *
   * The Function URL has to be public rather than OAC-signed: Stripe must POST to
   * it, and an OAC-signed POST requires the caller to send an
   * x-amz-content-sha256 payload hash, which Stripe knows nothing about. This
   * header stands in for that.
   */
  if (!fromEdge(event, env.edgeSecret)) {
    return problem(403, 'Not found.');
  }

  const path = event.rawPath.replace(/\/$/, '');
  const verb = method(event);

  let secrets: Secrets;
  try {
    secrets = await loadSecrets(env);
  } catch (error) {
    console.error('Could not load commerce secrets', error);
    return problem(500, 'Store is temporarily unavailable.');
  }

  try {
    if (verb === 'GET' && path === '/api/checkout') return await checkout(secrets, event);
    if (verb === 'POST' && path === '/api/stripe/webhook') return await webhook(secrets, event);
    if (verb === 'GET' && path === '/api/fulfill') return await fulfill(secrets, event);
    if (verb === 'GET' && path === '/api/download') return await download(secrets, event);
    return problem(404, 'Not found.');
  } catch (error) {
    if (error instanceof NotForSale) {
      /* Only reachable from checkout — fulfillment no longer consults the
         catalog, so a delisted photo still delivers to whoever bought it. */
      console.warn('Request to buy an item that is not for sale', error.message);
      return problem(404, 'That photograph is not for sale.');
    }
    if (error instanceof InvalidToken) {
      /* 410: the link was real once, or was never real. Do not say which. */
      console.warn('Rejected download token', error.message);
      return problem(410, 'This download link is no longer valid. Reply to your receipt and I will send a fresh one.');
    }
    console.error(`Unhandled error on ${verb} ${path}`, error);
    return problem(500, 'Something went wrong. Nothing was charged twice — reply to your receipt if in doubt.');
  }
}

async function checkout(secrets: Secrets, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const sku = query(event).get('sku');
  if (!sku) return problem(400, 'Missing sku.');

  const catalog = await loadCatalog(env.siteBucket, s3);
  const session = await createCheckoutSession(sku, {
    stripe: stripe(secrets),
    catalog,
    siteUrl: env.siteUrl,
  });
  if (!session.url) throw new Error(`Checkout Session ${session.id} came back without a URL`);
  return redirect(session.url);
}

async function webhook(secrets: Secrets, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const signature = header(event, 'stripe-signature');
  if (!signature) return problem(400, 'Missing signature.');

  let received: Stripe.Event;
  try {
    received = await verifyWebhook(
      stripe(secrets),
      rawBody(event),
      signature,
      secrets.stripeWebhookSecret,
    );
  } catch (error) {
    /* An unverified body is not to be parsed, logged, or acted on. */
    console.warn('Rejected webhook with a bad signature', error instanceof Error ? error.message : error);
    return problem(400, 'Invalid signature.');
  }

  if (!isFulfillable(received)) {
    return json(200, { ignored: received.type });
  }

  const session = received.data.object;
  const catalog = await loadCatalog(env.siteBucket, s3);
  const fulfillment = await fulfillCheckout(session.id, {
    stripe: stripe(secrets),
    catalog,
    siteUrl: env.siteUrl,
    downloadTokenKey: secrets.downloadTokenKey,
  });

  if (fulfillment.status !== 'paid') {
    /* Not an error: the money has not arrived yet. Wait for the later event. */
    return json(200, { pending: session.id });
  }

  if (!env.fromEmail) {
    console.warn(`No FROM_EMAIL configured; ${session.id} was not emailed its download link`);
    return json(200, { fulfilled: session.id, emailed: false });
  }
  await sendDelivery(fulfillment, { ses, fromEmail: env.fromEmail });
  return json(200, { fulfilled: session.id, emailed: true });
}

/**
 * What the buyer's landing page calls. Returns the same entitlement the webhook
 * mints, so the file is available the moment they land — before, or instead of,
 * the email arriving.
 */
async function fulfill(secrets: Secrets, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const sessionId = query(event).get('session_id');
  if (!sessionId) return problem(400, 'Missing session_id.');

  const catalog = await loadCatalog(env.siteBucket, s3);
  let fulfillment: Fulfillment;
  try {
    fulfillment = await fulfillCheckout(sessionId, {
      stripe: stripe(secrets),
      catalog,
      siteUrl: env.siteUrl,
      downloadTokenKey: secrets.downloadTokenKey,
    });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      /* An id that Stripe does not recognise: a stale or hand-edited URL. */
      return problem(404, 'That order could not be found.');
    }
    throw error;
  }

  if (fulfillment.status !== 'paid') {
    return json(202, { status: 'pending' });
  }
  return json(200, {
    status: 'paid',
    downloadUrl: fulfillment.downloadUrl,
    expiresAt: fulfillment.expiresAt,
    albumTitle: fulfillment.item?.albumTitle,
    file: fulfillment.item?.file,
  });
}

async function download(secrets: Secrets, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const token = query(event).get('t');
  if (!token) return problem(400, 'Missing token.');

  const url = await resolveDownload(token, {
    s3,
    originalsBucket: env.originalsBucket,
    downloadTokenKey: secrets.downloadTokenKey,
  });
  /* 302, not 303: this is a GET redirecting to a GET of the same resource. */
  return redirect(url, 302);
}
