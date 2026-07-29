import type Stripe from 'stripe';

/**
 * Webhook signature verification.
 *
 * Extracted from the router for one reason: it must use the *async* form.
 * Which crypto provider the Stripe SDK selects depends on the runtime, and the
 * WebCrypto provider throws rather than verifying when called synchronously. A
 * `constructEvent` here does not degrade — it rejects every webhook Stripe
 * sends, valid ones included, and fulfillment silently stops. Keeping it in one
 * covered function is what stops that regressing.
 */

export class BadSignature extends Error {}

export async function verifyWebhook(
  stripe: Stripe,
  body: string,
  signature: string,
  secret: string,
): Promise<Stripe.Event> {
  try {
    return await stripe.webhooks.constructEventAsync(body, signature, secret);
  } catch (error) {
    throw new BadSignature(error instanceof Error ? error.message : 'Unverifiable webhook');
  }
}

/** Events that can entitle a download. Anything else is acknowledged and dropped. */
export function isFulfillable(
  event: Stripe.Event,
): event is Stripe.CheckoutSessionCompletedEvent | Stripe.CheckoutSessionAsyncPaymentSucceededEvent {
  /*
   * Cards settle on `completed`; delayed methods such as bank debits arrive
   * `unpaid` there and only become payable on `async_payment_succeeded`.
   * fulfillCheckout re-reads payment_status either way, so handling both is
   * correct rather than merely defensive.
   */
  return event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.async_payment_succeeded';
}
