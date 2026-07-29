import type Stripe from 'stripe';
import {
  CURRENCY,
  PRODUCT_TAX_CODE,
  formatPrice,
  licenseTier,
  parseSku,
  slugForStoryId,
  type CatalogItem,
  type DownloadCatalog,
} from '../src/lib/downloads';
import { requireItem } from './catalog';

/**
 * Creating the Checkout Session a buy link redirects to.
 *
 * The price is read from the published catalog, never from the request: the only
 * thing the browser supplies is a SKU. That is what makes a plain `<a href>` a
 * safe buy button, and it is why the buy link needs no signing.
 */

/**
 * Labels this flow in the Stripe Dashboard so it can be compared against any
 * later one (prints, a different licence tier). Stable by design — changing it
 * splits the reporting history.
 */
const INTEGRATION_IDENTIFIER = 'photo-download-qkzvhrmw';

export interface CheckoutDeps {
  stripe: Stripe;
  catalog: DownloadCatalog;
  siteUrl: string;
}

export async function createCheckoutSession(
  sku: string,
  { stripe, catalog, siteUrl }: CheckoutDeps,
): Promise<Stripe.Checkout.Session> {
  /* Shape first, so a malformed SKU never reaches the catalog or Stripe. */
  const { storyId, license } = parseSku(sku);
  const tier = licenseTier(license);
  if (!tier) throw new Error(`Unknown licence tier "${license}"`);
  const item = requireItem(catalog, sku);

  return stripe.checkout.sessions.create({
    mode: 'payment',
    integration_identifier: INTEGRATION_IDENTIFIER,
    /*
     * No payment_method_types: omitting it enables dynamic payment methods, so
     * what a buyer is offered is configured in the Dashboard rather than here.
     */
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: item.priceCents,
          tax_behavior: 'exclusive',
          product_data: {
            name: `${item.albumTitle} — ${tier.name}`,
            description: descriptionFor(item),
            tax_code: PRODUCT_TAX_CODE,
            metadata: { sku },
          },
        },
      },
    ],
    /*
     * Tax is calculated only where there is an active registration in Stripe.
     * With none, this silently collects nothing — see the go-live checklist in
     * the README.
     */
    automatic_tax: { enabled: true },
    /* The licence is the product, so state it on the pay button. */
    custom_text: { submit: { message: tier.terms } },
    metadata: { sku },
    client_reference_id: sku,
    payment_intent_data: {
      description: `${formatPrice(item.priceCents)} — ${item.albumTitle} (${item.file})`,
    },
    success_url: `${siteUrl}/purchase/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/photography/${slugForStoryId(storyId)}/`,
  });
}

function descriptionFor(item: CatalogItem): string {
  return `${item.label} Full resolution, ${item.width} × ${item.height} pixels.`;
}
