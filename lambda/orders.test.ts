import { describe, expect, test } from 'bun:test';
import {
  CLOSED_ORDER_TTL_SECONDS,
  InvalidOrderTransition,
  RestorationNotAllowed,
  createPendingOrder,
  generateOrderId,
  transitionToClosed,
  transitionToEntitled,
  transitionToRestored,
  transitionToRevoked,
  type Order,
} from './orders';

const HASH = 'a'.repeat(64);
const ORDER_ID = `ord_${'b'.repeat(32)}`;

function pending(now = 100): Order {
  return createPendingOrder({
    livemode: false,
    photoId: 'photo_1234567890abcdef12345678',
    assetRef: `${HASH}.jpg`,
    expectedAmount: 4_000,
    albumTitle: 'Lost Coast',
    label: 'Fog over Punta Gorda',
    previewSrc: '/media/lost-coast.webp',
  }, now, ORDER_ID);
}

describe('order model', () => {
  test('generates an order ID with 128 random bits', () => {
    expect(generateOrderId(() => Buffer.alloc(16, 0xab))).toBe(`ord_${'ab'.repeat(16)}`);
  });

  test('snapshots fulfillment and display data in a pending order', () => {
    expect(pending()).toEqual({
      orderId: ORDER_ID,
      state: 'pending',
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      assetRef: `${HASH}.jpg`,
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog over Punta Gorda',
      previewSrc: '/media/lost-coast.webp',
      createdAt: 100,
      updatedAt: 100,
    });
  });

  test('rejects malformed immutable identifiers and amounts', () => {
    expect(() => createPendingOrder({
      ...pending(),
      assetRef: 'albums/lost-coast/file.jpg',
    }, 100, ORDER_ID)).toThrow(/Asset reference/);
    expect(() => createPendingOrder({
      ...pending(),
      assetRef: `${HASH}.gif`,
    }, 100, ORDER_ID)).toThrow(/Asset reference/);
    expect(() => createPendingOrder({
      ...pending(),
      expectedAmount: 0,
    }, 100, ORDER_ID)).toThrow(/Expected amount/);
  });
});

describe('order state machine', () => {
  test('entitles pending orders and treats an entitled duplicate as success', () => {
    const entitled = transitionToEntitled(pending(), {
      stripePaymentIntentId: 'pi_test',
      amountTotal: 4_340,
      presentmentAmount: 4_000,
      presentmentCurrency: 'usd',
      sourceEventId: 'evt_test',
    }, 200);

    expect(entitled).toMatchObject({
      state: 'entitled',
      entitledAt: 200,
      updatedAt: 200,
      stripePaymentIntentId: 'pi_test',
      sourceEventId: 'evt_test',
    });
    expect(transitionToEntitled(entitled, {}, 300)).toBe(entitled);
  });

  test('closes only pending orders and applies a 30-day TTL', () => {
    const closed = transitionToClosed(pending(), 'expired', 500, 'evt_expired');
    expect(closed).toMatchObject({
      state: 'closed',
      closeReason: 'expired',
      deleteAfter: 500 + CLOSED_ORDER_TTL_SECONDS,
      sourceEventId: 'evt_expired',
    });
    expect(transitionToClosed(closed, 'expired', 600)).toBe(closed);
    expect(() => transitionToEntitled(closed, {}, 600)).toThrow(InvalidOrderTransition);
  });

  test('revokes pending or entitled orders and never automatically leaves revoked', () => {
    const fromPending = transitionToRevoked(pending(), {
      reason: 'refunded',
      sourceEventId: 'evt_refund',
      stripePaymentIntentId: 'pi_test',
      stripeChargeId: 'ch_test',
    }, 200);
    expect(fromPending).toMatchObject({
      state: 'revoked',
      revocationReason: 'refunded',
      revokedAt: 200,
      sourceEventId: 'evt_refund',
      stripePaymentIntentId: 'pi_test',
      stripeChargeId: 'ch_test',
    });
    expect(transitionToRevoked(fromPending, { reason: 'dispute', sourceEventId: 'evt_dispute' }, 300))
      .toBe(fromPending);
    expect(() => transitionToEntitled(fromPending, {}, 300)).toThrow(InvalidOrderTransition);

    const entitled = transitionToEntitled(pending(), {}, 200);
    expect(transitionToRevoked(entitled, { reason: 'dispute' }, 300).state).toBe('revoked');
  });

  test('forbids automated transitions from closed orders', () => {
    const closed = transitionToClosed(pending(), 'failed', 200);
    expect(() => transitionToRevoked(closed, { reason: 'refunded' }, 300))
      .toThrow(InvalidOrderTransition);
  });

  test('restores only from revoked with verified Stripe facts and an audit trail', () => {
    const revoked = transitionToRevoked(pending(), { reason: 'dispute', sourceEventId: 'evt_opened' }, 200);
    const restored = transitionToRestored(revoked, {
      actor: 'operator@example.com',
      reason: 'Stripe dispute dp_1 was won',
      evidence: { disputeWon: true, refunded: false, currentDispute: false },
    }, 300);
    expect(restored).toMatchObject({
      state: 'entitled',
      restoredAt: 300,
      restoredBy: 'operator@example.com',
      restorationReason: 'Stripe dispute dp_1 was won',
      revokedAt: 200,
      entitledAt: 300,
    });

    expect(() => transitionToRestored(revoked, {
      actor: 'operator@example.com',
      reason: 'still disputed',
      evidence: { disputeWon: true, refunded: false, currentDispute: true },
    }, 300)).toThrow(RestorationNotAllowed);
    expect(() => transitionToRestored(pending(), {
      actor: 'operator@example.com',
      reason: 'wrong state',
      evidence: { disputeWon: true, refunded: false, currentDispute: false },
    }, 300)).toThrow(InvalidOrderTransition);
  });
});
