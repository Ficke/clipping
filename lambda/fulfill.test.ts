import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { CheckoutReturnExpired, fulfillCheckout } from './fulfill';
import type { OrderRepository } from './order-repository';
import { createPendingOrder, type EntitlementAudit, type Order } from './orders';
import { readToken } from './tokens';

const NOW = Date.UTC(2026, 7, 2);
const ORDER_ID = `ord_${'1'.repeat(32)}`;
const SESSION_ID = 'cs_test_1';
const KEY = 'k'.repeat(64);

function order(): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${'ab'.repeat(32)}.jpg`,
      expectedAmount: 4_000,
      albumTitle: 'Stored title',
      label: 'Stored label',
      previewSrc: '/media/stored.webp',
    }, Math.floor(NOW / 1000) - 100, ORDER_ID),
    stripeSessionId: SESSION_ID,
    checkoutExpiresAt: Math.floor(NOW / 1000) + 100,
  };
}

function harness(paymentStatus: Stripe.Checkout.Session['payment_status'] = 'paid') {
  let current = order();
  const orders = {
    get: async () => current,
    entitle: async (_id: string, audit: EntitlementAudit) => {
      current = { ...current, ...audit, state: 'entitled', entitledAt: 2, updatedAt: 2 };
      return current;
    },
  } as unknown as OrderRepository;
  const stripe = {
    checkout: { sessions: { retrieve: async () => ({
      id: SESSION_ID,
      client_reference_id: ORDER_ID,
      mode: 'payment',
      metadata: {
        integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID,
        photo_id: current.photoId,
      },
      livemode: false,
      payment_status: paymentStatus,
      currency: 'usd',
      amount_subtotal: 4_000,
      amount_total: 4_000,
      payment_intent: 'pi_test_1',
    }) } },
  } as unknown as Stripe;
  return { stripe, orders };
}

describe('durable fulfillment', () => {
  test('mints a versioned token from the stored immutable snapshot', async () => {
    const h = harness();
    const result = await fulfillCheckout(SESSION_ID, {
      stripe: h.stripe,
      orders: h.orders,
      siteUrl: 'https://example.test',
      downloadTokenKey: KEY,
      now: NOW,
      requireFreshReturn: true,
    });
    expect(result).toMatchObject({
      status: 'paid',
      item: { albumTitle: 'Stored title', label: 'Stored label', previewSrc: '/media/stored.webp' },
    });
    const token = new URL(result.downloadUrl!).searchParams.get('t')!;
    expect(readToken(token, KEY, NOW)).toMatchObject({
      version: 1,
      orderId: ORDER_ID,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${'ab'.repeat(32)}.jpg`,
    });
  });

  test('leaves a delayed unpaid Session pending without minting a link', async () => {
    const h = harness('unpaid');
    await expect(fulfillCheckout(SESSION_ID, {
      stripe: h.stripe,
      orders: h.orders,
      siteUrl: 'https://example.test',
      downloadTokenKey: KEY,
      now: NOW,
    })).resolves.toEqual({ status: 'unpaid' });
  });

  test('enforces the browser return window while trusted flows can omit it', async () => {
    const h = harness();
    const late = NOW + 2 * 60 * 60 * 1000;
    await expect(fulfillCheckout(SESSION_ID, {
      stripe: h.stripe,
      orders: h.orders,
      siteUrl: 'https://example.test',
      downloadTokenKey: KEY,
      now: late,
      requireFreshReturn: true,
    })).rejects.toBeInstanceOf(CheckoutReturnExpired);

    await expect(fulfillCheckout(SESSION_ID, {
      stripe: h.stripe,
      orders: h.orders,
      siteUrl: 'https://example.test',
      downloadTokenKey: KEY,
      now: late,
    })).resolves.toMatchObject({ status: 'paid' });
  });
});
