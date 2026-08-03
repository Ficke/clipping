import type Stripe from 'stripe';
import type { WebhookSecrets } from './config';
import { EntitlementUnavailable, ensureEntitlement, validateSession } from './entitlement';
import {
  hasExpectedOrigin,
  header,
  json,
  method,
  methodNotAllowed,
  problem,
  rawBody,
  rawBodyBytes,
  type FunctionUrlEvent,
  type FunctionUrlResult,
} from './http';
import { errorCategory, hashIdentifier, logOutcome } from './logging';
import { OrderNotFound, type OrderRepository } from './order-repository';

export const WEBHOOK_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
] as const;

const ALLOWED_EVENTS = new Set<string>(WEBHOOK_EVENT_TYPES);
const MAX_WEBHOOK_BYTES = 256 * 1024;

export interface WebhookRuntime {
  originHeaderName: string;
  originHeaderValue: string;
  orders: OrderRepository;
  loadSecrets(): Promise<WebhookSecrets>;
  stripeFor(secrets: WebhookSecrets): Stripe;
}

export async function handleWebhook(
  request: FunctionUrlEvent,
  deps: WebhookRuntime,
): Promise<FunctionUrlResult> {
  const route = `${method(request)} ${request.rawPath.replace(/\/$/, '')}`;
  const requestId = request.requestContext.requestId;
  if (!hasExpectedOrigin(request, deps.originHeaderName, deps.originHeaderValue)) {
    logOutcome('warn', { outcome: 'origin_rejected', route, requestId, status: 403 });
    return problem(403, 'Forbidden.');
  }
  if (request.rawPath.replace(/\/$/, '') !== '/api/stripe-webhook') return problem(404, 'Not found.');
  if (method(request) !== 'POST') return methodNotAllowed('POST');

  const contentType = header(request, 'content-type')?.toLowerCase().split(';', 1)[0]?.trim();
  const signature = header(request, 'stripe-signature');
  const bytes = rawBodyBytes(request);
  if (contentType !== 'application/json' || !signature || !bytes.length || bytes.length > MAX_WEBHOOK_BYTES) {
    return problem(400, 'Invalid webhook request.');
  }

  let event: Stripe.Event;
  let stripe: Stripe;
  try {
    const secrets = await deps.loadSecrets();
    stripe = deps.stripeFor(secrets);
    event = await verifyEvent(stripe, rawBody(request), signature, secrets);
  } catch (error) {
    logOutcome('warn', {
      outcome: 'signature_rejected', route, requestId, status: 400,
      errorCategory: errorCategory(error),
    });
    return problem(400, 'Invalid webhook signature.');
  }

  if (!ALLOWED_EVENTS.has(event.type)) {
    logOutcome('warn', { outcome: 'event_rejected', route, requestId, status: 400 });
    return problem(400, 'Unsupported webhook event.');
  }

  try {
    await applyStripeEvent(event, stripe, deps.orders);
    logOutcome('info', {
      outcome: 'event_applied', route, requestId, status: 200,
      identifierHash: hashIdentifier(event.id),
    });
    return json(200, { received: true });
  } catch (error) {
    logOutcome('error', {
      outcome: 'event_failed', route, requestId, status: 500,
      identifierHash: hashIdentifier(event.id),
      errorCategory: errorCategory(error),
    });
    return problem(500, 'Webhook processing failed.');
  }
}

export async function verifyEvent(
  stripe: Stripe,
  payload: string,
  signature: string,
  secrets: WebhookSecrets,
): Promise<Stripe.Event> {
  const candidates = [secrets.stripeWebhookSecret, secrets.stripeWebhookSecretPrevious]
    .filter((value): value is string => Boolean(value));
  let lastError: unknown;
  for (const secret of candidates) {
    try {
      return await stripe.webhooks.constructEventAsync(payload, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No webhook signing secret is configured');
}

export async function applyStripeEvent(
  event: Stripe.Event,
  stripe: Stripe,
  orders: OrderRepository,
): Promise<void> {
  if (event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.async_payment_succeeded') {
    try {
      await ensureEntitlement((event.data.object as Stripe.Checkout.Session).id, {
        stripe,
        orders,
        sourceEventId: event.id,
      });
    } catch (error) {
      // A dispute can arrive before Checkout completion. Revocation is
      // terminal for automation, so acknowledge the later paid event instead
      // of asking Stripe to retry an impossible entitlement forever.
      if (!(error instanceof EntitlementUnavailable && error.orderState === 'revoked')) throw error;
    }
    return;
  }

  if (event.type === 'checkout.session.async_payment_failed'
    || event.type === 'checkout.session.expired') {
    const eventSession = event.data.object as Stripe.Checkout.Session;
    const session = await stripe.checkout.sessions.retrieve(eventSession.id);
    const orderId = session.client_reference_id;
    if (!orderId) throw new Error('Checkout Session has no order reference');
    const order = await orders.get(orderId);
    if (!order) throw new OrderNotFound('Referenced order does not exist');
    validateSession(session, order);
    if (session.payment_status === 'paid') {
      await ensureEntitlement(session.id, { stripe, orders, sourceEventId: event.id });
      return;
    }
    await orders.close(orderId, event.type.endsWith('expired') ? 'expired' : 'failed', event.id);
    return;
  }

  const object = event.data.object as Stripe.Charge | Stripe.Dispute;
  const disputeCharge = event.type === 'charge.refunded' ? undefined : (object as Stripe.Dispute).charge;
  if (event.type !== 'charge.refunded' && !disputeCharge) throw new Error('Dispute has no Charge');
  const chargeId = event.type === 'charge.refunded'
    ? (object as Stripe.Charge).id
    : typeof disputeCharge === 'string'
      ? disputeCharge
      : disputeCharge!.id;
  const charge = await stripe.charges.retrieve(chargeId, { expand: ['payment_intent'] });
  const intent = charge.payment_intent;
  if (!intent || typeof intent === 'string') throw new Error('Charge has no expanded PaymentIntent');
  const orderId = intent.metadata.order_id;
  if (!orderId) throw new Error('PaymentIntent has no order metadata');
  const order = await orders.get(orderId);
  if (!order) throw new OrderNotFound('Referenced order does not exist');
  if (order.livemode !== event.livemode
    || intent.metadata.integration !== 'photo-download-qkzvhrmw'
    || intent.metadata.photo_id !== order.photoId) {
    throw new Error('Charge event integrity mismatch');
  }
  const reason = event.type === 'charge.refunded'
    ? 'refunded'
    : event.type === 'charge.dispute.created'
      ? 'dispute_created'
      : `dispute_closed:${(object as Stripe.Dispute).status}`;
  await orders.revoke(orderId, {
    reason,
    sourceEventId: event.id,
    stripePaymentIntentId: intent.id,
    stripeChargeId: charge.id,
  });
}
