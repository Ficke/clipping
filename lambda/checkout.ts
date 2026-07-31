import type Stripe from 'stripe';
import {
  CURRENCY,
  PRODUCT_TAX_CODE,
  formatPrice,
  licenseTerms,
  licenseTier,
  parseSku,
  type CatalogItem,
  type DownloadCatalog,
} from '../src/lib/downloads';
import { requireItem } from './catalog';

/**
 * The browser supplies only a SKU; the price comes from the catalog. That is
 * what makes a plain `<a href>` a safe buy button, needing no signing.
 */

/** Stable by design: changing it splits the Stripe Dashboard's reporting history. */
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
  const { license } = parseSku(sku);
  const tier = licenseTier(license);
  if (!tier) throw new Error(`Unknown license tier "${license}"`);
  const item = requireItem(catalog, sku);

  return stripe.checkout.sessions.create({
    mode: 'payment',
    integration_identifier: INTEGRATION_IDENTIFIER,
    /* No payment_method_types: omitting it lets the Dashboard decide. */
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
    /* Collects nothing, silently, in any state with no active Stripe
       registration — see the README's go-live checklist. */
    automatic_tax: { enabled: true },
    custom_text: { submit: { message: licenseTerms(tier) } },
    metadata: { sku },
    client_reference_id: sku,
    payment_intent_data: {
      description: `${formatPrice(item.priceCents)} — ${item.albumTitle} (${item.file})`,
    },
    success_url: `${siteUrl}/purchase/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/store/`,
  });
}

function descriptionFor(item: CatalogItem): string {
  return `${item.label} Full resolution, ${item.width} × ${item.height} pixels.`;
}
