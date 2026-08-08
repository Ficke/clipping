import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';
import type { OrderRepository } from './order-repository';
import type { Order } from './orders';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const ASSET_REF = `${'ab'.repeat(32)}.jpg`;

function catalog(forSale = true): DownloadCatalog {
  return {
    version: 2,
    generated: '2026-08-02T00:00:00Z',
    items: [{
      photoId: PHOTO_ID,
      assetRef: ASSET_REF,
      storyId: 'lost-coast',
      file: 'DSCF1.jpg',
      forSale,
      priceCents: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
      previewSrc: '/media/fog.webp',
      width: 6_000,
      height: 4_000,
    }],
  };
}

function harness() {
  const sequence: string[] = [];
  const created: Order[] = [];
  let params: Stripe.Checkout.SessionCreateParams | undefined;
  let options: Stripe.RequestOptions | undefined;
  const orders = {
    create: async (order: Order) => {
      sequence.push('order');
      created.push(order);
      return order;
    },
    attachCheckoutSession: async (_orderId: string, id: string, expiresAt: number) => ({
      ...created[0]!, stripeSessionId: id, checkoutExpiresAt: expiresAt,
    }),
  } as unknown as OrderRepository;
  const stripe = {
    checkout: { sessions: { create: async (input: Stripe.Checkout.SessionCreateParams, request: Stripe.RequestOptions) => {
      sequence.push('stripe');
      params = input;
      options = request;
      return {
        id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/test', expires_at: 2_000,
      } as Stripe.Checkout.Session;
    } } },
  } as unknown as Stripe;
  return { sequence, created, orders, stripe, params: () => params!, options: () => options! };
}

describe('durable checkout', () => {
  test('persists the immutable order before creating a Stripe Session', async () => {
    const h = harness();
    const result = await createCheckoutSession(PHOTO_ID, {
      stripe: h.stripe,
      orders: h.orders,
      catalog: catalog(),
      siteUrl: 'https://example.test',
      stripeProductId: 'prod_download',
      livemode: false,
      now: 1_000,
    });
    expect(h.sequence).toEqual(['order', 'stripe']);
    expect(h.created[0]).toMatchObject({
      state: 'pending', photoId: PHOTO_ID, assetRef: ASSET_REF, expectedAmount: 4_000,
    });
    expect(result.order).toMatchObject({ stripeSessionId: 'cs_test_1', checkoutExpiresAt: 2_000 });
  });

  test('uses the order identity for idempotency and all Stripe metadata', async () => {
    const h = harness();
    await createCheckoutSession(PHOTO_ID, {
      stripe: h.stripe,
      orders: h.orders,
      catalog: catalog(),
      siteUrl: 'https://example.test',
      stripeProductId: 'prod_download',
      livemode: false,
      now: 1_000,
    });
    const orderId = h.created[0]!.orderId;
    expect(h.options().idempotencyKey).toBe(orderId);
    expect(h.params()).toMatchObject({
      mode: 'payment',
      managed_payments: { enabled: true },
      client_reference_id: orderId,
      metadata: { order_id: orderId, photo_id: PHOTO_ID, integration: 'photo-download-qkzvhrmw' },
      payment_intent_data: {
        metadata: { order_id: orderId, photo_id: PHOTO_ID, integration: 'photo-download-qkzvhrmw' },
      },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 4_000, product: 'prod_download' } }],
      success_url: 'https://example.test/purchase/?session_id={CHECKOUT_SESSION_ID}',
    });
    expect(h.params().payment_method_types).toBeUndefined();
    expect(h.params()).not.toHaveProperty('automatic_tax');
  });

  test('rejects a delisted or asset-less photo before any durable or Stripe call', async () => {
    for (const candidate of [catalog(false), { ...catalog(), items: [{ ...catalog().items[0]!, assetRef: undefined }] }]) {
      const h = harness();
      await expect(createCheckoutSession(PHOTO_ID, {
        stripe: h.stripe,
        orders: h.orders,
        catalog: candidate,
        siteUrl: 'https://example.test',
        stripeProductId: 'prod_download',
        livemode: false,
      })).rejects.toBeInstanceOf(NotForSale);
      expect(h.sequence).toEqual([]);
    }
  });
});
