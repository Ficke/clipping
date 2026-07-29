import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { PRODUCT_TAX_CODE, type DownloadCatalog } from '../src/lib/downloads';
import { NotForSale } from './catalog';
import { createCheckoutSession } from './checkout';

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
  }, {
    /* A legacy id, to prove the cancel URL drops the date prefix. */
    sku: '2024-12-japan/roll-01.jpg/personal',
    storyId: '2024-12-japan',
    file: 'roll-01.jpg',
    license: 'personal',
    albumTitle: "Japan '24",
    label: 'A platform in Kanazawa.',
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

const deps = (stripe: Stripe) => ({ stripe, catalog, siteUrl: 'https://adamficke.com' });

describe('checkout session', () => {
  test('prices from the catalog, not from anything the caller sent', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    const [params] = calls;
    expect(params!.line_items![0]!.price_data!.unit_amount).toBe(4000);
    expect(params!.line_items![0]!.price_data!.currency).toBe('usd');
  });

  test('tags the line item with the digital-goods tax code and enables Stripe Tax', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    const [params] = calls;
    expect(params!.line_items![0]!.price_data!.product_data!.tax_code).toBe(PRODUCT_TAX_CODE);
    expect(params!.line_items![0]!.price_data!.tax_behavior).toBe('exclusive');
    expect(params!.automatic_tax).toEqual({ enabled: true });
  });

  test('never pins payment_method_types, so Dashboard settings decide', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    expect(calls[0]).not.toHaveProperty('payment_method_types');
  });

  test('carries the SKU into metadata so fulfillment knows what was bought', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    expect(calls[0]!.metadata).toEqual({ sku: SKU });
    expect(calls[0]!.line_items![0]!.price_data!.product_data!.metadata).toEqual({ sku: SKU });
  });

  test('shows the licence terms on the pay button', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    const submit = calls[0]!.custom_text!.submit;
    expect(submit && typeof submit === 'object' ? submit.message : '').toContain('non-commercial');
  });

  test('returns the buyer to the delivery page with the session id', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession(SKU, deps(stripe));

    expect(calls[0]!.success_url).toBe('https://adamficke.com/purchase/?session_id={CHECKOUT_SESSION_ID}');
  });

  test('cancels back to the album, dropping a legacy date prefix from the URL', async () => {
    const { stripe, calls } = recordingStripe();

    await createCheckoutSession('2024-12-japan/roll-01.jpg/personal', deps(stripe));

    expect(calls[0]!.cancel_url).toBe('https://adamficke.com/photography/japan/');
  });

  test('refuses a photo that is not in the catalog', async () => {
    const { stripe, calls } = recordingStripe();

    await expect(createCheckoutSession('yosemite/DSCF0001.jpg/personal', deps(stripe)))
      .rejects.toThrow(NotForSale);
    expect(calls).toHaveLength(0);
  });

  test('refuses an unknown licence tier before touching the catalog', async () => {
    const { stripe, calls } = recordingStripe();

    await expect(createCheckoutSession('lost-coast/DSCF1250.jpg/commercial', deps(stripe)))
      .rejects.toThrow(/Unknown licence tier/);
    expect(calls).toHaveLength(0);
  });

  test('refuses a SKU crafted to escape the album prefix', async () => {
    const { stripe, calls } = recordingStripe();

    await expect(createCheckoutSession('../etc/personal', deps(stripe)))
      .rejects.toThrow(/safe path segment/);
    expect(calls).toHaveLength(0);
  });
});
