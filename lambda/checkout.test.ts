import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const OTHER_PHOTO_ID = 'photo_abcdef1234567890abcdef12';

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
    /* A legacy id, to prove the cancel URL drops the date prefix. */
    photoId: OTHER_PHOTO_ID,
    storyId: '2024-12-japan',
    file: 'roll-01.jpg',
    forSale: true,
    albumTitle: "Japan '24",
    label: 'A platform in Kanazawa.',
    previewSrc: '/media/photo-japan.webp',
    priceCents: 4000,
    width: 6000,
    height: 4000,
  }],
};

function recordingStripe() {
  const calls: Stripe.Checkout.SessionCreateParams[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          calls.push(params);
          return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
        },
      },
    },
  } as unknown as Stripe;
  return { stripe, calls };
}

const deps = (stripe: Stripe) => ({
  stripe,
  catalog,
  siteUrl: 'https://adamficke.com',
  stripeProductId: 'prod_download',
});

describe('checkout session', () => {
  test('prices from the catalog, not from anything the caller sent', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    const [params] = calls;
    expect(params!.line_items![0]!.price_data!.unit_amount).toBe(4000);
    expect(params!.line_items![0]!.price_data!.currency).toBe('usd');
  });

  test('enables Managed Payments and leaves tax entirely to Stripe', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    const [params] = calls;
    expect(params!.managed_payments).toEqual({ enabled: true });
    expect(params).not.toHaveProperty('automatic_tax');
    expect(params!.line_items![0]!.price_data).not.toHaveProperty('tax_behavior');
  });

  test('uses one classified Stripe Product while keeping the photo identity in Session metadata', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    const price = calls[0]!.line_items![0]!.price_data!;
    expect(price.product).toBe('prod_download');
    expect(price).not.toHaveProperty('product_data');
  });

  test('never pins payment_method_types, so Dashboard settings decide', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    expect(calls[0]).not.toHaveProperty('payment_method_types');
  });

  test('carries only the opaque photo ID into transaction metadata', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    expect(calls[0]!.metadata).toEqual({ photo_id: PHOTO_ID, integration: 'photo-download-qkzvhrmw' });
    expect(calls[0]!.payment_intent_data!.metadata).toEqual({
      photo_id: PHOTO_ID,
      integration: 'photo-download-qkzvhrmw',
    });
    expect(calls[0]!.payment_intent_data!.description).not.toContain('Lost Coast');
    expect(calls[0]!.payment_intent_data!.description).not.toContain('DSCF1250');
  });

  test('leaves Checkout disclosures to Managed Payments', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    expect(calls[0]).not.toHaveProperty('custom_text');
  });

  test('returns the buyer to the delivery page with the session id', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(PHOTO_ID, deps(stripe));

    expect(calls[0]!.success_url).toBe('https://adamficke.com/purchase/?session_id={CHECKOUT_SESSION_ID}');
  });

  test('cancels back to the store, the only place a buy link lives', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(OTHER_PHOTO_ID, deps(stripe));

    expect(calls[0]!.cancel_url).toBe('https://adamficke.com/store/');
  });

  test('refuses a photo that is not in the catalog', async () => {
    const { stripe, calls } = recordingStripe();

    await expect(createCheckoutSession('photo_000000000000000000000000', deps(stripe)))
      .rejects.toThrow(NotForSale);
    expect(calls).toHaveLength(0);
  });

  test('refuses a delisted photo even though fulfillment retains its mapping', async () => {
    const { stripe, calls } = recordingStripe();
    const delisted = structuredClone(catalog);
    delisted.items[0]!.forSale = false;

    await expect(createCheckoutSession(PHOTO_ID, { ...deps(stripe), catalog: delisted }))
      .rejects.toThrow(NotForSale);
    expect(calls).toHaveLength(0);
  });
});
