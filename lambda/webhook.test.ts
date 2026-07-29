import { describe, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { BadSignature, isFulfillable, verifyWebhook } from './webhook';

/*
 * A real Stripe client against real signing, not a fake. The bug this guards
 * against lives in the SDK's crypto provider selection, so stubbing the SDK
 * would stub out exactly the thing under test.
 */
const stripe = new Stripe('rk_test_notused', { apiVersion: '2026-06-24.dahlia' });
const SECRET = 'whsec_test_secret';

function eventBody(type: string, id = 'cs_test_1'): string {
  return JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type,
    data: { object: { id, object: 'checkout.session' } },
  });
}

async function sign(payload: string, secret = SECRET): Promise<string> {
  return stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
}

describe('webhook verification', () => {
  test('accepts a correctly signed payload', async () => {
    const payload = eventBody('checkout.session.completed');

    const event = await verifyWebhook(stripe, payload, await sign(payload), SECRET);

    expect(event.type).toBe('checkout.session.completed');
  });

  test('rejects a payload altered after signing', async () => {
    const payload = eventBody('checkout.session.completed');
    const signature = await sign(payload);

    const tampered = payload.replace('cs_test_1', 'cs_test_2');

    await expect(verifyWebhook(stripe, tampered, signature, SECRET)).rejects.toThrow(BadSignature);
  });

  test('rejects a payload signed with a different secret', async () => {
    const payload = eventBody('checkout.session.completed');
    const signature = await sign(payload, 'whsec_someone_elses');

    await expect(verifyWebhook(stripe, payload, signature, SECRET)).rejects.toThrow(BadSignature);
  });

  test('rejects a missing or malformed signature header', async () => {
    const payload = eventBody('checkout.session.completed');

    await expect(verifyWebhook(stripe, payload, '', SECRET)).rejects.toThrow(BadSignature);
    await expect(verifyWebhook(stripe, payload, 'garbage', SECRET)).rejects.toThrow(BadSignature);
  });
});

describe('which events fulfil', () => {
  test('a completed card checkout does', async () => {
    const payload = eventBody('checkout.session.completed');
    expect(isFulfillable(await verifyWebhook(stripe, payload, await sign(payload), SECRET))).toBe(true);
  });

  test('a delayed payment that later succeeds does', async () => {
    const payload = eventBody('checkout.session.async_payment_succeeded');
    expect(isFulfillable(await verifyWebhook(stripe, payload, await sign(payload), SECRET))).toBe(true);
  });

  test('anything else does not', async () => {
    for (const type of [
      'checkout.session.expired',
      'checkout.session.async_payment_failed',
      'payment_intent.created',
      'charge.refunded',
    ]) {
      const payload = eventBody(type);
      expect(isFulfillable(await verifyWebhook(stripe, payload, await sign(payload), SECRET))).toBe(false);
    }
  });
});
