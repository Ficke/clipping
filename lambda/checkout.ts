import type Stripe from 'stripe';
import {
  CURRENCY,
  formatPrice,
  type DownloadCatalog,
} from '../src/lib/downloads';
import { requireItem } from './catalog';
import { INTEGRATION_IDENTIFIER } from './integration';

/**
 * The browser supplies only an opaque photo ID; the price comes from the catalog. That is
 * what makes a plain `<a href>` a safe buy button, needing no signing.
 */

/** Stable by design: changing it splits the Stripe Dashboard's reporting history. */
export interface CheckoutDeps {
  stripe: Stripe;
  catalog: DownloadCatalog;
  siteUrl: string;
  /** Shared Managed Payments Product. The per-photo identity stays in metadata. */
  stripeProductId: string;
}

export async function createCheckoutSession(
  photoId: string,
  { stripe, catalog, siteUrl, stripeProductId }: CheckoutDeps,
): Promise<Stripe.Checkout.Session> {
  const item = requireItem(catalog, photoId);

  return stripe.checkout.sessions.create({
    mode: 'payment',
    /* Stripe/Link is merchant of record for this digital-goods transaction. */
    managed_payments: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
    /* No payment_method_types: omitting it lets the Dashboard decide. */
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: item.priceCents,
          /* The Product owns the license/classification; price remains ours. */
          product: stripeProductId,
        },
      },
    ],
    /* Managed Payments owns the Checkout disclosures and does not accept
     * Checkout's custom_text field. License terms remain on our storefront. */
    metadata: { photo_id: photoId, integration: INTEGRATION_IDENTIFIER },
    client_reference_id: photoId,
    payment_intent_data: {
      description: `${formatPrice(item.priceCents)} — full-resolution digital photograph (${photoId})`,
      /* Duplicate the identity onto the payment record for Dashboard search,
       * reconciliation, refunds, disputes, and manual fulfillment. */
      metadata: { photo_id: photoId, integration: INTEGRATION_IDENTIFIER },
    },
    success_url: `${siteUrl}/purchase/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/store/`,
  });
}
