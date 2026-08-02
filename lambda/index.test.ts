import { describe, expect, test } from 'bun:test';
import type { S3Client } from '@aws-sdk/client-s3';
import type Stripe from 'stripe';
import { forgetCatalog } from './catalog';
import type { Env, Secrets } from './config';
import { handleBuyer, type BuyerRuntime } from './index';
import type { FunctionUrlEvent } from './http';
import type { OrderRepository } from './order-repository';
import type { Order } from './orders';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const ORIGIN = 'local-origin-secret';

function event(overrides: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  return {
    rawPath: '/api/checkout',
    rawQueryString: '',
    headers: { 'x-commerce-origin': ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { requestId: 'request-1', http: { method: 'POST' } },
    body: `photo_id=${PHOTO_ID}`,
    ...overrides,
  };
}

function runtime() {
  let secretLoads = 0;
  const sequence: string[] = [];
  let current: Order | undefined;
  const catalog = {
    version: 2,
    generated: '2026-08-02T00:00:00Z',
    items: [{
      photoId: PHOTO_ID,
      assetRef: `${'ab'.repeat(32)}.jpg`,
      storyId: 'lost-coast', file: 'photo.jpg', forSale: true, priceCents: 4_000,
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
    siteUrl: 'https://example.test', originHeaderName: 'x-commerce-origin', originHeaderValue: ORIGIN,
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
      event({ requestContext: { http: { method: 'GET' } } }),
      event({ body: `photo_id=${PHOTO_ID}&price=1` }),
      event({ body: `photo_id=${PHOTO_ID}&photo_id=${PHOTO_ID}` }),
      event({ headers: { 'x-commerce-origin': ORIGIN, 'content-type': 'application/json' } }),
      event({ body: `photo_id=${'x'.repeat(1_100)}` }),
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
});
