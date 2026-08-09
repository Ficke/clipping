import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import type { WebhookSecrets } from './config';
import type { HttpApiEvent, RestApiEvent } from './http';
import type { OrderRepository } from './order-repository';
import {
  InvalidOrderTransition,
  createPendingOrder,
  type EntitlementAudit,
  type Order,
  type RevocationAudit,
} from './orders';
import { applyStripeEvent, handleWebhook, verifyEvent } from './webhook';

const CURRENT = 'whsec_current_test';
const PREVIOUS = 'whsec_previous_test';
const ORIGIN = 'origin-value';
const ORDER_ID = `ord_${'1'.repeat(32)}`;
const SESSION_ID = 'cs_test_1';

function secrets(): WebhookSecrets {
  return {
    stripeReadApiKey: 'rk_test_read',
    stripeWebhookSecret: CURRENT,
    stripeWebhookSecretPrevious: PREVIOUS,
  };
}

function stripeEvent(type = 'checkout.session.completed'): Stripe.Event {
  return {
    id: 'evt_test_1',
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: SESSION_ID } },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as Stripe.Event;
}

function signedRequest(event: Stripe.Event, secret = CURRENT): HttpApiEvent {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  const signature = `t=${timestamp},v1=${digest}`;
  return {
    rawPath: '/api/stripe-webhook',
    rawQueryString: '',
    headers: {
      'x-commerce-origin': ORIGIN,
      'content-type': 'application/json; charset=utf-8',
      'stripe-signature': signature,
    },
    requestContext: { requestId: 'request-1', http: { method: 'POST' } },
    body: payload,
  };
}

function restSignedRequest(event: Stripe.Event, secret = CURRENT): RestApiEvent {
  const request = signedRequest(event, secret);
  const body = request.body ?? '';
  return {
    path: '/api/stripe-webhook',
    httpMethod: 'POST',
    headers: request.headers,
    requestContext: { requestId: 'rest-request-1' },
    body: Buffer.from(body, 'utf8').toString('base64'),
    isBase64Encoded: true,
  };
}

function pending(): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
    }, 1, ORDER_ID),
    stripeSessionId: SESSION_ID,
  };
}

describe('Stripe webhook', () => {
  test('accepts either signing secret during overlap', async () => {
    const stripe = new Stripe('rk_test_read');
    for (const secret of [CURRENT, PREVIOUS]) {
      const request = signedRequest(stripeEvent(), secret);
      expect((await verifyEvent(stripe, request.body!, request.headers['stripe-signature']!, secrets())).id)
        .toBe('evt_test_1');
    }
  });

  test('rejects missing origin and invalid signatures without touching orders', async () => {
    let reads = 0;
    const stripe = new Stripe('rk_test_read');
    const orders = { get: async () => { reads += 1; } } as unknown as OrderRepository;
    const base = signedRequest(stripeEvent());
    const runtime = {
      originHeaderName: 'x-commerce-origin', originHeaderValues: [ORIGIN], orders,
      loadSecrets: async () => secrets(), stripeFor: () => stripe,
    };
    expect((await handleWebhook({ ...base, headers: { ...base.headers, 'x-commerce-origin': undefined } }, runtime)).statusCode)
      .toBe(403);
    expect((await handleWebhook({ ...base, headers: { ...base.headers, 'stripe-signature': 'invalid' } }, runtime)).statusCode)
      .toBe(400);
    expect(reads).toBe(0);
  });

  test('retrieves current paid state and commits entitlement before success', async () => {
    let current = pending();
    const audits: EntitlementAudit[] = [];
    const orders = {
      get: async () => current,
      entitle: async (_id: string, audit: EntitlementAudit) => {
        audits.push(audit);
        current = { ...current, state: 'entitled', ...audit };
        return current;
      },
    } as unknown as OrderRepository;
    const stripe = new Stripe('rk_test_read');
    (stripe.checkout.sessions as any).retrieve = async () => ({
      id: SESSION_ID, client_reference_id: ORDER_ID, mode: 'payment',
      metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: current.photoId },
      livemode: false, payment_status: 'paid', currency: 'usd', amount_subtotal: 4_000,
      amount_total: 4_000, payment_intent: 'pi_test_1',
    }) as unknown as Stripe.Checkout.Session;
    const response = await handleWebhook(signedRequest(stripeEvent()), {
      originHeaderName: 'x-commerce-origin', originHeaderValues: [ORIGIN], orders,
      loadSecrets: async () => secrets(), stripeFor: () => stripe,
    });
    expect(response.statusCode).toBe(200);
    expect(current.state).toBe('entitled');
    expect(audits[0]?.sourceEventId).toBe('evt_test_1');
  });

  test('verifies exact webhook bytes from the REST API proxy event', async () => {
    let current = pending();
    const orders = {
      get: async () => current,
      entitle: async (_id: string, audit: EntitlementAudit) => {
        current = { ...current, state: 'entitled', ...audit };
        return current;
      },
    } as unknown as OrderRepository;
    const stripe = new Stripe('rk_test_read');
    (stripe.checkout.sessions as any).retrieve = async () => ({
      id: SESSION_ID, client_reference_id: ORDER_ID, mode: 'payment',
      metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: current.photoId },
      livemode: false, payment_status: 'paid', currency: 'usd', amount_subtotal: 4_000,
      amount_total: 4_000, payment_intent: 'pi_test_1',
    }) as unknown as Stripe.Checkout.Session;

    const response = await handleWebhook(restSignedRequest(stripeEvent()), {
      originHeaderName: 'x-commerce-origin', originHeaderValues: [ORIGIN], orders,
      loadSecrets: async () => secrets(), stripeFor: () => stripe,
    });
    expect(response.statusCode).toBe(200);
    expect(current.state).toBe('entitled');
  });

  test('revokes charge-derived events through PaymentIntent order metadata', async () => {
    const audits: RevocationAudit[] = [];
    const order = { ...pending(), state: 'entitled' as const };
    const orders = {
      get: async () => order,
      revoke: async (_id: string, audit: RevocationAudit) => {
        audits.push(audit);
        return { ...order, state: 'revoked' as const };
      },
    } as unknown as OrderRepository;
    const stripe = {
      charges: { retrieve: async () => ({
        id: 'ch_test_1', payment_intent: {
          id: 'pi_test_1',
          metadata: { order_id: ORDER_ID, photo_id: order.photoId, integration: 'photo-download-qkzvhrmw' },
        },
      }) },
    } as unknown as Stripe;
    const event = {
      ...stripeEvent('charge.refunded'),
      data: { object: { id: 'ch_test_1' } },
    } as Stripe.Event;
    await applyStripeEvent(event, stripe, orders);
    expect(audits).toEqual([{
      reason: 'refunded', sourceEventId: 'evt_test_1',
      stripePaymentIntentId: 'pi_test_1', stripeChargeId: 'ch_test_1',
    }]);
  });

  test('acknowledges Checkout completion after an earlier dispute revoked the order', async () => {
    const order = { ...pending(), state: 'revoked' as const, revocationReason: 'dispute_created' };
    let entitlementWrites = 0;
    const orders = {
      get: async () => order,
      entitle: async () => { entitlementWrites += 1; return order; },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => ({
        id: SESSION_ID,
        client_reference_id: ORDER_ID,
        mode: 'payment',
        metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: order.photoId },
        livemode: false,
        payment_status: 'paid',
        currency: 'usd',
        amount_subtotal: 4_000,
      }) } },
    } as unknown as Stripe;

    await expect(applyStripeEvent(stripeEvent(), stripe, orders)).resolves.toBeUndefined();
    expect(entitlementWrites).toBe(0);
  });

  /*
   * Stripe redelivers, so an expiry or failure can land after the order has
   * already reached a terminal state. `close` refuses that transition; the
   * handler must acknowledge rather than 500 into an endless retry.
   */
  test.each([
    ['checkout.session.expired', 'revoked'],
    ['checkout.session.async_payment_failed', 'entitled'],
  ] as const)('acknowledges %s for an order already %s', async (type, state) => {
    const order = { ...pending(), state };
    let closes = 0;
    const orders = {
      get: async () => order,
      close: async () => {
        closes += 1;
        throw new InvalidOrderTransition(ORDER_ID, state, 'closed');
      },
      entitle: async () => { throw new Error('must not entitle'); },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => ({
        id: SESSION_ID,
        client_reference_id: ORDER_ID,
        mode: 'payment',
        metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: order.photoId },
        livemode: false,
        payment_status: 'unpaid',
        currency: 'usd',
        amount_subtotal: 4_000,
      }) } },
    } as unknown as Stripe;

    await expect(applyStripeEvent(stripeEvent(type), stripe, orders)).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });

  test('still surfaces a close failure the order state does not explain', async () => {
    const order = { ...pending(), state: 'pending' as const };
    const orders = {
      get: async () => order,
      close: async () => { throw new Error('DynamoDB unavailable'); },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => ({
        id: SESSION_ID,
        client_reference_id: ORDER_ID,
        mode: 'payment',
        metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: order.photoId },
        livemode: false,
        payment_status: 'unpaid',
        currency: 'usd',
        amount_subtotal: 4_000,
      }) } },
    } as unknown as Stripe;

    await expect(applyStripeEvent(stripeEvent('checkout.session.expired'), stripe, orders))
      .rejects.toThrow('DynamoDB unavailable');
  });
});
