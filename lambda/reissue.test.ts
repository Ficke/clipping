import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { reissueDownload, ReissueRefused } from './reissue';
import type { OrderRepository } from './order-repository';
import { createPendingOrder, type Order } from './orders';

const ORDER_ID = `ord_${'1'.repeat(32)}`;
const SESSION_ID = 'cs_test_1';

function entitled(): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${'ab'.repeat(32)}.jpg`,
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
    }, 1, ORDER_ID),
    state: 'entitled',
    stripeSessionId: SESSION_ID,
    entitledAt: 2,
  };
}

function harness(
  charge: Partial<Stripe.Charge> = {},
  order = entitled(),
  disputeStatuses: Stripe.Dispute.Status[] = [],
) {
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
      payment_intent: {
        id: 'pi_test_1',
        latest_charge: { id: 'ch_test_1', disputed: false, refunded: false, amount_refunded: 0, ...charge },
      },
    }) } },
    disputes: { list: async () => ({ data: disputeStatuses.map((status) => ({ status })) }) },
  } as unknown as Stripe;
  const orders = { get: async () => order } as unknown as OrderRepository;
  return { stripe, orders };
}

describe('manual download reissue', () => {
  test('mints from a currently paid, settled durable order', async () => {
    const h = harness();
    await expect(reissueDownload(SESSION_ID, {
      ...h, siteUrl: 'https://example.test', downloadTokenKey: 'k'.repeat(64),
    })).resolves.toMatchObject({ status: 'paid', item: { albumTitle: 'Lost Coast' } });
  });

  test('refuses refunded, disputed, and revoked orders', async () => {
    for (const h of [
      harness({ refunded: true, amount_refunded: 100 }),
      harness({ disputed: true }, entitled(), ['needs_response']),
      harness({}, { ...entitled(), state: 'revoked' }),
    ]) {
      await expect(reissueDownload(SESSION_ID, {
        ...h, siteUrl: 'https://example.test', downloadTokenKey: 'k'.repeat(64),
      })).rejects.toBeInstanceOf(ReissueRefused);
    }
  });

  test('allows a restored won dispute despite the historical Charge flag', async () => {
    const h = harness({ disputed: true }, entitled(), ['won']);
    await expect(reissueDownload(SESSION_ID, {
      ...h, siteUrl: 'https://example.test', downloadTokenKey: 'k'.repeat(64),
    })).resolves.toMatchObject({ status: 'paid' });
  });
});
