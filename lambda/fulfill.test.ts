import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { CHECKOUT_RETURN_GRACE_SECONDS, fulfillCheckout } from './fulfill';
import { readToken } from './tokens';

const KEY = 'k'.repeat(64);
const NOW = Date.UTC(2026, 6, 29);
const PHOTO_ID = 'photo_1234567890abcdef12345678';
const DELISTED_PHOTO_ID = 'photo_abcdef1234567890abcdef12';
const STORE_METADATA = { photo_id: PHOTO_ID, integration: 'photo-download-qkzvhrmw' };

const catalog: DownloadCatalog = {
  version: 2,
  generated: '2026-07-29T00:00:00.000Z',
  items: [{
    photoId: PHOTO_ID,
    storyId: 'lost-coast',
    file: 'DSCF1250.jpg',
    forSale: true,
    albumTitle: 'Lost Coast',
    label: 'Fog coming over Punta Gorda.',
    previewSrc: '/media/photo-lost-coast.webp',
    priceCents: 4000,
    width: 6000,
    height: 4000,
  }, {
    photoId: DELISTED_PHOTO_ID,
    storyId: 'yosemite',
    file: 'DSCF0001.jpg',
    forSale: false,
    albumTitle: 'Yosemite',
    label: 'Yosemite photograph',
    previewSrc: '/media/photo-yosemite.webp',
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
      metadata: STORE_METADATA,
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result.status).toBe('paid');
    expect(result.item).toMatchObject({
      albumTitle: 'Lost Coast',
      file: 'DSCF1250.jpg',
      label: 'Fog coming over Punta Gorda.',
      previewSrc: '/media/photo-lost-coast.webp',
      dimensions: { width: 6000, height: 4000 },
    });
    expect(result.downloadUrl).toStartWith('https://adamficke.com/api/download?t=');
  });

  test('the link carries a token this key can verify, naming what was bought', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: STORE_METADATA,
    });

    const { downloadUrl } = await fulfillCheckout('cs_test_1', deps(stripe));
    const token = new URL(downloadUrl!).searchParams.get('t')!;

    expect(readToken(token, KEY, NOW)).toMatchObject({ photoId: PHOTO_ID, sessionId: 'cs_test_1' });
  });

  test('withholds the file until a delayed payment actually settles', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'unpaid',
      metadata: STORE_METADATA,
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result).toEqual({ status: 'unpaid' });
    expect(result.downloadUrl).toBeUndefined();
  });

  test('still delivers a photo that has since been delisted', async () => {
    /* Delisting after payment must not strand the buyer. */
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { photo_id: DELISTED_PHOTO_ID, integration: 'photo-download-qkzvhrmw' },
    });

    const result = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(result.status).toBe('paid');
    expect(result.downloadUrl).toBeTruthy();
    expect(result.item).toMatchObject({ storyId: 'yosemite', file: 'DSCF0001.jpg' });
    expect(result.item?.dimensions).toEqual({ width: 6000, height: 4000 });
    expect(result.item?.albumTitle).toBe('Yosemite');
  });

  test('the delisted photo still resolves to its real S3 key', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { photo_id: DELISTED_PHOTO_ID, integration: 'photo-download-qkzvhrmw' },
    });

    const { downloadUrl } = await fulfillCheckout('cs_test_1', deps(stripe));
    const token = new URL(downloadUrl!).searchParams.get('t')!;

    expect(readToken(token, KEY, NOW).photoId).toBe(DELISTED_PHOTO_ID);
  });

  test('refuses a malformed photo ID', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { photo_id: '../etc', integration: 'photo-download-qkzvhrmw' },
    });

    await expect(fulfillCheckout('cs_test_1', deps(stripe))).rejects.toThrow(/no valid photo_id/);
  });

  test('refuses a session with no photo ID rather than guessing what was bought', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { integration: 'photo-download-qkzvhrmw' },
    });

    await expect(fulfillCheckout('cs_test_1', deps(stripe))).rejects.toThrow(/no valid photo_id/);
  });

  test('refuses a paid Session created by another integration', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: { photo_id: PHOTO_ID },
    });

    await expect(fulfillCheckout('cs_test_1', deps(stripe))).rejects.toThrow(/not created by this store/);
  });

  test('allows the Checkout return through its expiration grace period', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: STORE_METADATA,
      expires_at: Math.floor(NOW / 1000) - CHECKOUT_RETURN_GRACE_SECONDS,
    });

    const result = await fulfillCheckout('cs_test_1', {
      ...deps(stripe),
      requireFreshReturn: true,
    });
    expect(result.status).toBe('paid');
  });

  test('refuses an old Checkout return while trusted reissue remains possible', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: STORE_METADATA,
      expires_at: Math.floor(NOW / 1000) - CHECKOUT_RETURN_GRACE_SECONDS - 1,
    });

    await expect(fulfillCheckout('cs_test_1', {
      ...deps(stripe),
      requireFreshReturn: true,
    })).rejects.toThrow(/outside its return window/);
    expect((await fulfillCheckout('cs_test_1', deps(stripe))).status).toBe('paid');
  });

  test('is safe to repeat: two calls produce equivalent entitlements', async () => {
    const stripe = stripeReturning({
      id: 'cs_test_1',
      payment_status: 'paid',
      metadata: STORE_METADATA,
    });

    const first = await fulfillCheckout('cs_test_1', deps(stripe));
    const second = await fulfillCheckout('cs_test_1', deps(stripe));

    expect(first.downloadUrl).toBe(second.downloadUrl);
  });
});
