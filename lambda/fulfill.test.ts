import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { fulfillCheckout } from './fulfill';
import { readToken } from './tokens';

const KEY = 'k'.repeat(64);
const NOW = Date.UTC(2026, 6, 29);
const SKU = 'lost-coast/DSCF1250.jpg/personal';

const catalog: DownloadCatalog = {
  version: 1,
  generated: '2026-07-29T00:00:00.000Z',
  items: [{
    sku: SKU,
    storyId: 'lost-coast',
    file: 'DSCF1250.jpg',
    license: 'personal',
    albumTitle: 'Lost Coast',
    label: 'Fog coming over Punta Gorda.',
    priceCents: 4000,
    width: 6000,
    height: 4000,
  }],
};

function stripeReturning(session: Partial<Stripe.Checkout.Session>): Stripe {
  return {
    checkout: { sessions: { retrieve: async () => session } },
  } as unknown as Stripe;
}

const deps = (stripe: Stripe) => ({
  stripe,
  catalog,
  siteUrl: 'https://adamficke.com',
  downloadTokenKey: KEY,
  now: NOW,
});

describe('fulfillment', () => {
  test('issues a download link for a paid session', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: SKU },
      customer_details: { email: 'buyer@example.test' } as Stripe.Checkout.Session.CustomerDetails,
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result.status).toBe('paid');
    expect(result.email).toBe('buyer@example.test');
    expect(result.item).toMatchObject({
      albumTitle: 'Lost Coast',
      file: 'DSCF1250.jpg',
      dimensions: { width: 6000, height: 4000 },
    });
    expect(result.downloadUrl).toStartWith('https://adamficke.com/api/download?t=');
  });

  test('the link carries a token this key can verify, naming what was bought', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: SKU },
    });

    const { downloadUrl } = await fulfillCheckout('cs_test_1', deps(stripe));
    const token = new URL(downloadUrl!).searchParams.get('t')!;

    expect(readToken(token, KEY, NOW)).toMatchObject({ sku: SKU, sessionId: 'cs_test_1' });
  });

  test('withholds the file until a delayed payment actually settles', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'unpaid',
      metadata: { sku: SKU },
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result).toEqual({ status: 'unpaid' });
    expect(result.downloadUrl).toBeUndefined();
  });

  test('still delivers a photo that has since been delisted', async () => {
    /*
     * The buyer paid while it was listed, or a bank debit settled after it was
     * pulled. Refusing here would 404 the webhook until Stripe stopped retrying
     * and tell them their own purchase was unavailable.
     */
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: 'yosemite/DSCF0001.jpg/personal' },
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result.status).toBe('paid');
    expect(result.downloadUrl).toBeTruthy();
    expect(result.item).toMatchObject({ storyId: 'yosemite', file: 'DSCF0001.jpg' });
    /* No catalog entry, so no dimensions — and the id stands in for the title. */
    expect(result.item?.dimensions).toBeUndefined();
    expect(result.item?.albumTitle).toBe('yosemite');
  });

  test('the delisted photo still resolves to its real S3 key', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: 'yosemite/DSCF0001.jpg/personal' },
    });

    const { downloadUrl } = await fulfillCheckout('cs_test_1', deps(stripe));
    const token = new URL(downloadUrl!).searchParams.get('t')!;

    expect(readToken(token, KEY, NOW).sku).toBe('yosemite/DSCF0001.jpg/personal');
  });

  test('refuses a session whose SKU is malformed', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: '../etc/personal' },
    });

    await expect(fulfillCheckout('cs_test_1', deps(stripe))).rejects.toThrow(/safe path segment/);
  });

  test('refuses a session with no SKU rather than guessing what was bought', async () => {
    const stripe = stripeReturning({ id: 'cs_test_1', payment_status: 'paid', metadata: {} });

    await expect(fulfillCheckout('cs_test_1', deps(stripe))).rejects.toThrow(/no sku in metadata/);
  });

  test('is safe to repeat: two calls produce equivalent entitlements', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { sku: SKU },
    });

    const first = await fulfillCheckout('cs_test_1', deps(stripe));
    const second = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(first.downloadUrl).toBe(second.downloadUrl);
  });
});
