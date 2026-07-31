import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { reissueDownload } from './reissue';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
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
  }],
};

function stripeReturning(overrides: Record<string, unknown> = {}): Stripe {
  const charge = {
    id: 'ch_1',
    object: 'charge',
    disputed: false,
    refunded: false,
    amount_refunded: 0,
    ...overrides,
  };
  return {
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_live_1',
          payment_status: 'paid',
          metadata: { photo_id: PHOTO_ID, integration: 'photo-download-qkzvhrmw' },
          payment_intent: { id: 'pi_1', object: 'payment_intent', latest_charge: charge },
        }),
      },
    },
  } as unknown as Stripe;
}

const deps = (stripe: Stripe) => ({
  stripe,
  catalog,
  siteUrl: 'https://adamficke.com',
  downloadTokenKey: 'k'.repeat(64),
  now: Date.UTC(2026, 6, 31),
});

describe('manual download reissue', () => {
  test('mints a fresh entitlement for a paid settled charge', async () => {
    const result = await reissueDownload('cs_live_1', deps(stripeReturning()));
    expect(result.status).toBe('paid');
    expect(result.downloadUrl).toStartWith('https://adamficke.com/api/download?t=');
  });

  test('refuses a refunded charge', async () => {
    await expect(reissueDownload('cs_live_1', deps(stripeReturning({
      refunded: true,
      amount_refunded: 4000,
    })))).rejects.toThrow(/refunded charge/);
  });

  test('refuses a disputed charge', async () => {
    await expect(reissueDownload('cs_live_1', deps(stripeReturning({ disputed: true }))))
      .rejects.toThrow(/disputed charge/);
  });
});
