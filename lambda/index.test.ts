import { describe, expect, test } from 'bun:test';
import type { S3Client } from '@aws-sdk/client-s3';
import type Stripe from 'stripe';
import { forgetCatalog } from './catalog';
import type { Env, Secrets } from './config';
import { handleBuyer, type BuyerRuntime } from './index';
import type { FunctionUrlEvent, HttpApiEvent, RestApiEvent } from './http';
import type { OrderRepository } from './order-repository';
import type { Order } from './orders';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const ORIGIN = 'local-origin-secret';

function event(overrides: Partial<HttpApiEvent> = {}): HttpApiEvent {
  return {
    rawPath: '/api/checkout',
    rawQueryString: '',
    headers: { 'x-commerce-origin': ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { requestId: 'request-1', http: { method: 'POST' } },
    body: `photo_id=${PHOTO_ID}`,
    ...overrides,
  };
}

function restEvent(overrides: Partial<RestApiEvent> = {}): RestApiEvent {
  return {
    path: '/api/checkout',
    httpMethod: 'POST',
    headers: { 'X-Commerce-Origin': ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    requestContext: { requestId: 'rest-request-1' },
    body: Buffer.from(`photo_id=${PHOTO_ID}`, 'utf8').toString('base64'),
    isBase64Encoded: true,
    ...overrides,
  };
}

function runtime(envOverrides: Partial<Env> = {}) {
  let secretLoads = 0;
  const sequence: string[] = [];
  let current: Order | undefined;
  const catalog = {
    version: 3,
    generated: '2026-08-02T00:00:00Z',
    items: [{
      photoId: PHOTO_ID,
      storyId: 'lost-coast', file: 'photo.jpg', priceCents: 4_000,
      albumTitle: 'Lost Coast', label: 'Fog', previewSrc: '/media/fog.webp', width: 1, height: 1,
    }],
  };
  const orders = {
    create: async (order: Order) => {
      sequence.push('order');
      current = order;
      return order;
    },
    attachCheckoutSession: async (_id: string, sessionId: string, expiresAt: number) => {
      current = { ...current!, stripeSessionId: sessionId, checkoutExpiresAt: expiresAt };
      return current;
    },
  } as unknown as OrderRepository;
  const stripe = {
    checkout: { sessions: { create: async () => {
      sequence.push('stripe');
      return {
        id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/test', expires_at: 2_000,
        client_reference_id: current?.orderId,
      };
    } } },
  } as unknown as Stripe;
  const env: Env = {
    secretParam: '/test', tableName: 'orders', originalsBucket: 'originals', siteBucket: 'site',
    siteUrl: 'https://example.test',
    originHeaderName: 'x-commerce-origin', originHeaderValues: [ORIGIN], ...envOverrides,
  };
  const secrets: Secrets = {
    stripeApiKey: 'rk_test_key', stripeProductId: 'prod_download', downloadTokenKey: 'k'.repeat(64),
  };
  const deps: BuyerRuntime = {
    env,
    orders,
    s3: { send: async () => ({ Body: { transformToString: async () => JSON.stringify(catalog) } }) } as unknown as S3Client,
    stripeFor: () => stripe,
    loadSecrets: async () => {
      secretLoads += 1;
      return secrets;
    },
  };
  return { deps, sequence, secretLoads: () => secretLoads };
}

describe('Buyer API', () => {
  test('rejects origin, method, malformed bodies, and attempted extra fields before secrets or Stripe', async () => {
    const cases = [
      event({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
      event({ requestContext: { http: { method: 'PUT' } } }),
      event({ body: `photo_id=${PHOTO_ID}&price=1` }),
      event({ body: `photo_id=${PHOTO_ID}&photo_id=${PHOTO_ID}` }),
      event({ headers: { 'x-commerce-origin': ORIGIN, 'content-type': 'application/json' } }),
      event({ body: `photo_id=${'x'.repeat(1_100)}` }),
      event({
        rawQueryString: `photo_id=${PHOTO_ID}&price=1`,
        requestContext: { http: { method: 'GET' } },
      }),
    ];
    for (const request of cases) {
      const h = runtime();
      const response = await handleBuyer(request, h.deps);
      expect([400, 403, 405]).toContain(response.statusCode);
      expect(h.secretLoads()).toBe(0);
      expect(h.sequence).toEqual([]);
    }
  });

  test('creates the order before Stripe and redirects a valid native form', async () => {
    forgetCatalog();
    const h = runtime();
    const response = await handleBuyer(event(), h.deps);
    expect(response).toMatchObject({
      statusCode: 303,
      headers: { location: 'https://checkout.stripe.com/c/pay/test', 'cache-control': 'no-store, private' },
    });
    expect(h.sequence).toEqual(['order', 'stripe']);
  });

  test('accepts the REST API proxy event without changing checkout semantics', async () => {
    forgetCatalog();
    const h = runtime();
    const response = await handleBuyer(restEvent(), h.deps);
    expect(response).toMatchObject({
      statusCode: 303,
      headers: { location: 'https://checkout.stripe.com/c/pay/test' },
    });
    expect(h.sequence).toEqual(['order', 'stripe']);
  });

  /*
   * A checkout that a link can trigger is prefetchable and cross-site
   * triggerable, and CloudFront adds the origin header to any browser request.
   * Reject before loading a secret or writing an order.
   */
  test('refuses a GET checkout whatever payload shape it arrives in', async () => {
    forgetCatalog();
    const requests = [
      event({
        rawQueryString: `photo_id=${PHOTO_ID}`,
        requestContext: { http: { method: 'GET' } },
        headers: { 'x-commerce-origin': ORIGIN },
        body: undefined,
      }),
      restEvent({
        httpMethod: 'GET',
        headers: { 'X-Commerce-Origin': ORIGIN },
        body: undefined,
        isBase64Encoded: false,
        queryStringParameters: { photo_id: PHOTO_ID },
      }),
    ];

    for (const request of requests) {
      const h = runtime();
      expect(await handleBuyer(request, h.deps)).toMatchObject({
        statusCode: 405,
        headers: { allow: 'POST' },
      });
      expect(h.secretLoads()).toBe(0);
      expect(h.sequence).toEqual([]);
    }
  });
});
