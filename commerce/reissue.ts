import type Stripe from 'stripe';
import { disputeFacts } from './disputes';
import { validateSession } from './entitlement';
import { fulfillmentForOrder, type Fulfillment } from './fulfill';
import type { OrderRepository } from './order-repository';

export class ReissueRefused extends Error {}

export interface ReissueDeps {
  stripe: Stripe;
  orders: OrderRepository;
  siteUrl: string;
  downloadTokenKey: string;
  now?: number;
}

/** Reissue from the durable snapshot only after checking current Stripe state. */
export async function reissueDownload(
  sessionId: string,
  { stripe, orders, siteUrl, downloadTokenKey, now }: ReissueDeps,
): Promise<Fulfillment> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge'],
  });
  const orderId = session.client_reference_id;
  if (!orderId) throw new ReissueRefused('Checkout Session has no order reference');
  const order = await orders.get(orderId);
  if (!order) throw new ReissueRefused('Durable order does not exist');
  validateSession(session, order);

  if (order.state !== 'entitled' || session.payment_status !== 'paid') {
    throw new ReissueRefused('Order is not entitled');
  }
  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') throw new ReissueRefused('PaymentIntent is not expanded');
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') throw new ReissueRefused('Charge is not expanded');
  if (charge.refunded || charge.amount_refunded > 0) throw new ReissueRefused('Charge is refunded');
  const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 });
  if (disputeFacts(charge.disputed, disputes.data).blockingDispute) {
    throw new ReissueRefused('Charge has a blocking dispute');
  }

  return fulfillmentForOrder(order, { siteUrl, downloadTokenKey, now });
}
