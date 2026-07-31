import { S3Client } from '@aws-sdk/client-s3';
import Stripe from 'stripe';
import { loadCatalog, NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';
import { loadSecrets, readEnv, type Env, type Secrets } from './config';
import { resolveDownload } from './download';
import { CheckoutReturnExpired, fulfillCheckout, type Fulfillment } from './fulfill';
import {
  json,
  method,
  problem,
  query,
  redirect,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './http';
import { InvalidToken } from './tokens';
import { STRIPE_API_VERSION } from './integration';

/**
 * The whole money path: three routes behind one Lambda.
 *
 *   GET  /api/checkout?photo_id=…  → 303 to Stripe Checkout
 *   GET  /api/fulfill?session_id=… → the landing page's copy of the same result
 *   GET  /api/download?t=…         → 302 to a freshly presigned S3 URL
 *
 * One function rather than three keeps a single deploy artifact, one IAM role, and
 * one cold start. They are separate route modules so that adding a fourth — a
 * print order, say — is a new file and a new case, not a rewrite.
 */

const env: Env = readEnv();
const s3 = new S3Client({});

let stripeClient: Stripe | undefined;
function stripe(secrets: Secrets): Stripe {
  stripeClient ??= new Stripe(secrets.stripeApiKey, { apiVersion: STRIPE_API_VERSION });
  return stripeClient;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
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
  const photoId = query(event).get('photo_id');
  if (!photoId) return problem(400, 'Missing photo_id.');

  const catalog = await loadCatalog(env.siteBucket, s3);
  const session = await createCheckoutSession(photoId, {
    stripe: stripe(secrets),
    catalog,
    siteUrl: env.siteUrl,
    stripeProductId: secrets.stripeProductId,
  });
  if (!session.url) throw new Error(`Checkout Session ${session.id} came back without a URL`);
  return redirect(session.url);
}

/**
 * What the buyer's landing page calls. The Session ID is accepted only around
 * the original Checkout return; later recovery uses the trusted local command.
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
      requireFreshReturn: true,
    });
  } catch (error) {
    if (error instanceof CheckoutReturnExpired) {
      return problem(410, 'This checkout return link is no longer renewable. Reply to your Stripe receipt for a fresh download link.');
    }
    if (error instanceof Stripe.errors.StripeInvalidRequestError) {
      /* An id that Stripe does not recognize: a stale or hand-edited URL. */
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
    label: fulfillment.item?.label,
    previewSrc: fulfillment.item?.previewSrc,
  });
}

async function download(secrets: Secrets, event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  const token = query(event).get('t');
  if (!token) return problem(400, 'Missing token.');

  const catalog = await loadCatalog(env.siteBucket, s3);
  const url = await resolveDownload(token, {
    s3,
    originalsBucket: env.originalsBucket,
    downloadTokenKey: secrets.downloadTokenKey,
    catalog,
  });
  /* 302, not 303: this is a GET redirecting to a GET of the same resource. */
  return redirect(url, 302);
}
