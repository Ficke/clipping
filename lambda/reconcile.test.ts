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

function pages<T>(values: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
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

  test('recovers a missing Session write after validating the metadata match', async () => {
    const initial: Order = { ...pending(), stripeSessionId: undefined, checkoutExpiresAt: undefined };
    let attached: { id: string; expiresAt: number } | undefined;
    let order = initial;
    const recovered = session({ expires_at: 1_000 });
    const orders = {
      attachCheckoutSession: async (_orderId: string, id: string, expiresAt: number) => {
        attached = { id, expiresAt };
        order = { ...order, stripeSessionId: id, checkoutExpiresAt: expiresAt };
        return order;
      },
      get: async () => order,
      entitle: async (_id: string, audit: EntitlementAudit) => {
        order = { ...order, state: 'entitled', ...audit };
        return order;
      },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: {
        list: () => pages([recovered]),
        retrieve: async () => recovered,
      } },
    } as unknown as Stripe;

    await expect(reconcileOrder(initial, { stripe, orders })).resolves.toEqual({
      orderId: ORDER_ID, outcome: 'REPAIRED', action: 'attach_session+entitle',
    });
    expect(attached).toEqual({ id: SESSION_ID, expiresAt: 1_000 });
    expect(order.state).toBe('entitled');
  });

  test('dry-run previews a recovered Session without writing or failing validation', async () => {
    const initial: Order = { ...pending(), stripeSessionId: undefined, checkoutExpiresAt: undefined };
    let writes = 0;
    const recovered = session({ payment_status: 'unpaid', status: 'open', expires_at: 1_000 });
    const orders = {
      attachCheckoutSession: async () => { writes += 1; return initial; },
      close: async () => { writes += 1; return initial; },
      revoke: async () => { writes += 1; return initial; },
      entitle: async () => { writes += 1; return initial; },
    } as unknown as OrderRepository;
    const stripe = {
      checkout: { sessions: {
        list: () => pages([recovered]),
        retrieve: async () => recovered,
      } },
      events: { list: () => pages([]) },
    } as unknown as Stripe;

    await expect(reconcileOrder(initial, { stripe, orders, dryRun: true })).resolves.toEqual({
      orderId: ORDER_ID, outcome: 'REPAIRED', action: 'attach_session',
    });
    expect(writes).toBe(0);
  });

  test('does not attach a Session found by scan until all integrity fields validate', async () => {
    const initial: Order = { ...pending(), stripeSessionId: undefined, checkoutExpiresAt: undefined };
    let writes = 0;
    const stripe = {
      checkout: { sessions: {
        list: () => pages([session({ amount_subtotal: 9_999, expires_at: 1_000 })]),
      } },
    } as unknown as Stripe;
    const orders = {
      attachCheckoutSession: async () => { writes += 1; return initial; },
    } as unknown as OrderRepository;

    await expect(reconcileOrder(initial, { stripe, orders })).rejects.toThrow('amount subtotal');
    expect(writes).toBe(0);
  });

  test('repairs refunds, disputes, and async failures and flags won disputes for review', async () => {
    const charge = (overrides: Record<string, unknown> = {}) => ({
      id: 'ch_test_1', disputed: false, refunded: false, amount_refunded: 0, ...overrides,
    });
    const cases = [
      {
        stripeSession: session({ payment_intent: { id: 'pi_test_1', latest_charge: charge({ refunded: true }) } as Stripe.PaymentIntent }),
        disputes: [], expected: 'revoke:refunded', write: 'revoke',
      },
      {
        stripeSession: session({ payment_intent: { id: 'pi_test_1', latest_charge: charge({ disputed: true }) } as Stripe.PaymentIntent }),
        disputes: [], expected: 'revoke:disputed', write: 'revoke',
      },
      {
        stripeSession: session({ payment_status: 'unpaid', status: 'open' }),
        events: [{ data: { object: { id: SESSION_ID } } }], expected: 'close:failed', write: 'close',
      },
    ];

    for (const item of cases) {
      const writes: string[] = [];
      const orders = {
        revoke: async () => { writes.push('revoke'); return pending(); },
        close: async () => { writes.push('close'); return pending(); },
      } as unknown as OrderRepository;
      const stripe = {
        checkout: { sessions: { retrieve: async () => item.stripeSession } },
        disputes: { list: async () => ({ data: item.disputes ?? [] }) },
        events: { list: () => pages(item.events ?? []) },
      } as unknown as Stripe;
      await expect(reconcileOrder(pending(), { stripe, orders })).resolves.toMatchObject({
        outcome: 'REPAIRED', action: item.expected,
      });
      expect(writes).toEqual([item.write]);
    }

    const revoked = { ...pending(), state: 'revoked' as const };
    const stripe = {
      checkout: { sessions: { retrieve: async () => session({
        payment_intent: { id: 'pi_test_1', latest_charge: charge() } as Stripe.PaymentIntent,
      }) } },
      disputes: { list: async () => ({ data: [{ status: 'won' }] }) },
    } as unknown as Stripe;
    await expect(reconcileOrder(revoked, { stripe, orders: {} as OrderRepository })).resolves.toMatchObject({
      outcome: 'REVIEW', action: 'won_dispute_requires_manual_restore',
    });
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
