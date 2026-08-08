import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import {
  EntitlementIntegrityError,
  EntitlementUnavailable,
  ensureEntitlement,
  restoreEntitlement,
  validateSession,
} from './entitlement';
import type { OrderRepository } from './order-repository';
import { createPendingOrder, type EntitlementAudit, type Order, type RestorationAudit } from './orders';

const ORDER_ID = `ord_${'1'.repeat(32)}`;
const SESSION_ID = 'cs_test_1';

function pending(): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${'a'.repeat(64)}.jpg`,
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
      previewSrc: '/media/fog.webp',
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
    metadata: {
      integration: 'photo-download-qkzvhrmw',
      order_id: ORDER_ID,
      photo_id: 'photo_1234567890abcdef12345678',
    },
    livemode: false,
    payment_status: 'paid',
    currency: 'usd',
    amount_subtotal: 4_000,
    amount_total: 4_320,
    payment_intent: 'pi_test_1',
    presentment_details: {
      presentment_amount: 5_800,
      presentment_currency: 'cad',
    },
    ...overrides,
  } as Stripe.Checkout.Session;
}

function harness(initial = pending(), stripeSession = session()) {
  let current = initial;
  const audits: EntitlementAudit[] = [];
  let gets = 0;
  const repository = {
    get: async () => {
      gets += 1;
      return current;
    },
    entitle: async (_orderId: string, audit: EntitlementAudit) => {
      audits.push(audit);
      current = { ...current, ...audit, state: 'entitled', entitledAt: 200, updatedAt: 200 };
      return current;
    },
  } as unknown as OrderRepository;
  const stripe = {
    checkout: { sessions: { retrieve: async () => stripeSession } },
  } as unknown as Pick<Stripe, 'checkout'>;
  return { repository, stripe, audits, gets: () => gets };
}

describe('ensureEntitlement', () => {
  test('retrieves current Stripe state, reads the order, and conditionally entitles it', async () => {
    const h = harness();
    const result = await ensureEntitlement(SESSION_ID, { stripe: h.stripe, orders: h.repository });
    expect(result).toMatchObject({ status: 'entitled', order: { state: 'entitled', assetRef: `${'a'.repeat(64)}.jpg` } });
    expect(h.gets()).toBe(1);
    expect(h.audits).toEqual([{
      stripePaymentIntentId: 'pi_test_1',
      amountTotal: 4_320,
      presentmentAmount: 5_800,
      presentmentCurrency: 'cad',
    }]);
  });

  test('records a webhook source event without trusting its snapshot', async () => {
    const h = harness();
    await ensureEntitlement(SESSION_ID, {
      stripe: h.stripe,
      orders: h.repository,
      sourceEventId: 'evt_test_1',
    });
    expect(h.audits[0]?.sourceEventId).toBe('evt_test_1');
  });

  test('leaves an unpaid delayed payment pending, then entitles current paid state', async () => {
    const unpaid = harness(pending(), session({ payment_status: 'unpaid' }));
    await expect(ensureEntitlement(SESSION_ID, { stripe: unpaid.stripe, orders: unpaid.repository }))
      .resolves.toMatchObject({ status: 'pending', order: { state: 'pending' } });
    expect(unpaid.audits).toHaveLength(0);

    const paid = harness();
    await expect(ensureEntitlement(SESSION_ID, { stripe: paid.stripe, orders: paid.repository }))
      .resolves.toMatchObject({ status: 'entitled' });
  });

  test('returns an already-entitled order without another write', async () => {
    const h = harness({ ...pending(), state: 'entitled', entitledAt: 150 });
    await expect(ensureEntitlement(SESSION_ID, { stripe: h.stripe, orders: h.repository }))
      .resolves.toMatchObject({ status: 'entitled' });
    expect(h.audits).toHaveLength(0);
  });

  test('blocks closed and revoked orders even when Stripe is paid', async () => {
    for (const state of ['closed', 'revoked'] as const) {
      const h = harness({ ...pending(), state });
      await expect(ensureEntitlement(SESSION_ID, { stripe: h.stripe, orders: h.repository }))
        .rejects.toBeInstanceOf(EntitlementUnavailable);
    }
  });

  test('rejects every integrity mismatch before entitlement', () => {
    const base = pending();
    const cases: Array<[string, Stripe.Checkout.Session, Order]> = [
      ['session ID', session({ id: 'cs_test_other' }), base],
      ['mode', session({ mode: 'setup' }), base],
      ['order reference', session({ client_reference_id: `ord_${'2'.repeat(32)}` }), base],
      ['integration marker', session({ metadata: { ...session().metadata, integration: 'other' } }), base],
      ['order metadata', session({ metadata: { ...session().metadata, order_id: `ord_${'2'.repeat(32)}` } }), base],
      ['photo metadata', session({ metadata: { ...session().metadata, photo_id: 'photo_abcdefabcdefabcdefabcdef' } }), base],
      ['live mode', session({ livemode: true }), base],
      ['currency', session({ currency: 'eur' }), base],
      ['amount subtotal', session({ amount_subtotal: 3_999 }), base],
    ];
    for (const [label, candidate, order] of cases) {
      expect(() => validateSession(candidate, order), label).toThrow(EntitlementIntegrityError);
    }
  });
});

describe('trusted restoration', () => {
  test('requires verified Stripe facts before calling the conditional repository operation', async () => {
    const calls: RestorationAudit[] = [];
    const repository = {
      restore: async (_orderId: string, audit: RestorationAudit) => {
        calls.push(audit);
        return { ...pending(), state: 'entitled' as const };
      },
    } as unknown as OrderRepository;
    const valid: RestorationAudit = {
      actor: 'ops',
      reason: 'won dispute',
      evidence: { disputeWon: true, refunded: false, currentDispute: false },
    };
    await expect(restoreEntitlement(repository, ORDER_ID, valid)).resolves.toMatchObject({ state: 'entitled' });
    expect(calls).toEqual([valid]);

    const invalid = { ...valid, evidence: { ...valid.evidence, refunded: true } };
    expect(() => restoreEntitlement(repository, ORDER_ID, invalid)).toThrow(EntitlementUnavailable);
    expect(calls).toHaveLength(1);
  });
});
