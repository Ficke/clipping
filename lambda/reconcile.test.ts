import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { reconcileAll, reconcileOrder } from './reconcile';
import type { OrderRepository } from './order-repository';
import { createPendingOrder, type EntitlementAudit, type Order } from './orders';

const ORDER_ID = `ord_${'1'.repeat(32)}`;
const SESSION_ID = 'cs_test_1';

function pending(): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${'ab'.repeat(32)}.jpg`,
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
    }, 100, ORDER_ID),
    stripeSessionId: SESSION_ID,
    checkoutExpiresAt: 1_000,
  };
}

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: SESSION_ID,
    client_reference_id: ORDER_ID,
    mode: 'payment',
    metadata: { integration: 'photo-download-qkzvhrmw', order_id: ORDER_ID, photo_id: pending().photoId },
    livemode: false,
    payment_status: 'paid',
    status: 'complete',
    currency: 'usd',
    amount_subtotal: 4_000,
    amount_total: 4_000,
    payment_intent: 'pi_test_1',
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

describe('commerce reconciliation', () => {
  test('repairs a paid pending order through the normal entitlement operation', async () => {
    let order = pending();
    const orders = {
      get: async () => order,
      entitle: async (_id: string, audit: EntitlementAudit) => {
        order = { ...order, state: 'entitled', ...audit };
        return order;
      },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => session() } },
    } as unknown as Stripe;
    await expect(reconcileOrder(order, { stripe, orders })).resolves.toEqual({
      orderId: ORDER_ID, outcome: 'REPAIRED', action: 'entitle',
    });
    expect(order.state).toBe('entitled');
  });

  test('closes a currently expired unpaid order', async () => {
    let closeReason: string | undefined;
    const orders = {
      get: async () => pending(),
      close: async (_id: string, reason: string) => {
        closeReason = reason;
        return { ...pending(), state: 'closed' as const };
      },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => session({ payment_status: 'unpaid', status: 'expired' }) } },
    } as unknown as Stripe;
    await expect(reconcileOrder(pending(), { stripe, orders })).resolves.toMatchObject({
      outcome: 'REPAIRED', action: 'close:expired',
    });
    expect(closeReason).toBe('expired');
  });

  test('reports failures per order and continues the scan', async () => {
    const orders = {
      scanNonClosed: async () => [pending()],
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: { retrieve: async () => { throw new Error('dependency down'); } } },
    } as unknown as Stripe;
    await expect(reconcileAll({ stripe, orders })).resolves.toEqual([{
      orderId: ORDER_ID,
      outcome: 'FAILED',
      action: 'dependency_or_integrity_error',
      errorCategory: 'Error',
    }]);
  });
});
