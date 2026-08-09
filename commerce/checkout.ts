import type Stripe from 'stripe';
import { CURRENCY, formatPrice, type DownloadCatalog } from '../shared/commerce';
import { requireItem } from './catalog';
import { INTEGRATION_IDENTIFIER } from './integration';
import type { OrderRepository } from './order-repository';
import { createPendingOrder, type Order } from './orders';

export interface CheckoutDeps {
  stripe: Stripe;
  orders: OrderRepository;
  catalog: DownloadCatalog;
  siteUrl: string;
  stripeProductId: string;
  livemode: boolean;
  now?: number;
}

export interface CheckoutResult {
  order: Order;
  session: Stripe.Checkout.Session;
}

/** Create the durable order before making the idempotent Stripe request. */
export async function createCheckoutSession(
  photoId: string,
  {
    stripe,
    orders,
    catalog,
    siteUrl,
    stripeProductId,
    livemode,
    now = Math.floor(Date.now() / 1000),
  }: CheckoutDeps,
): Promise<CheckoutResult> {
  const item = requireItem(catalog, photoId);

  const pending = createPendingOrder({
    livemode,
    photoId,
    expectedAmount: item.priceCents,
    albumTitle: item.albumTitle,
    label: item.label,
    ...(item.previewSrc ? { previewSrc: item.previewSrc } : {}),
  }, now);
  await orders.create(pending);

  const metadata = {
    order_id: pending.orderId,
    photo_id: photoId,
    integration: INTEGRATION_IDENTIFIER,
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    managed_payments: { enabled: true },
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        unit_amount: item.priceCents,
        product: stripeProductId,
      },
    }],
    metadata,
    client_reference_id: pending.orderId,
    payment_intent_data: {
      description: `${formatPrice(item.priceCents)} — full-resolution digital photograph (${photoId})`,
      metadata,
    },
    success_url: `${siteUrl}/purchase/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${siteUrl}/store/`,
  }, { idempotencyKey: pending.orderId });

  const order = await orders.attachCheckoutSession(pending.orderId, session.id, session.expires_at);
  return { order, session };
}
