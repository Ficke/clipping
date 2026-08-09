import type Stripe from 'stripe';
import { CURRENCY } from '../shared/commerce';
import { INTEGRATION_IDENTIFIER } from './integration';
import { OrderNotFound, type OrderRepository } from './order-repository';
import type { EntitlementAudit, Order, RestorationAudit } from './orders';

export type EntitlementResult =
  | { status: 'pending'; order: Order }
  | { status: 'entitled'; order: Order };

export interface EnsureEntitlementDeps {
  stripe: Pick<Stripe, 'checkout'>;
  orders: OrderRepository;
  sourceEventId?: string;
  integrationIdentifier?: string;
}

export class EntitlementIntegrityError extends Error {}
export class EntitlementUnavailable extends Error {
  constructor(message: string, readonly orderState?: Order['state']) {
    super(message);
  }
}

export async function ensureEntitlement(
  sessionId: string,
  {
    stripe,
    orders,
    sourceEventId,
    integrationIdentifier = INTEGRATION_IDENTIFIER,
  }: EnsureEntitlementDeps,
): Promise<EntitlementResult> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const orderId = session.client_reference_id;
  if (!orderId) throw new EntitlementIntegrityError('Checkout Session has no order reference');

  const order = await orders.get(orderId);
  if (!order) throw new OrderNotFound(`Order ${orderId} does not exist`);

  validateSession(session, order, integrationIdentifier);

  if (order.state === 'closed' || order.state === 'revoked') {
    throw new EntitlementUnavailable(`Order ${order.orderId} is unavailable`, order.state);
  }
  if (session.payment_status !== 'paid') return { status: 'pending', order };
  if (order.state === 'entitled') return { status: 'entitled', order };

  const entitled = await orders.entitle(order.orderId, sessionAudit(session, sourceEventId));
  return { status: 'entitled', order: entitled };
}

/**
 * Trusted restoration entry point. Its caller must retrieve current Stripe
 * facts and supply all three pieces of evidence; the repository still performs
 * the state change conditionally.
 */
export function restoreEntitlement(
  orders: OrderRepository,
  orderId: string,
  audit: RestorationAudit,
): Promise<Order> {
  if (!audit.evidence.disputeWon || audit.evidence.refunded || audit.evidence.currentDispute) {
    throw new EntitlementUnavailable('Stripe facts do not permit restoration');
  }
  return orders.restore(orderId, audit);
}

export function validateSession(
  session: Stripe.Checkout.Session,
  order: Order,
  integrationIdentifier = INTEGRATION_IDENTIFIER,
): void {
  const mismatch = (message: string): never => {
    throw new EntitlementIntegrityError(`Checkout Session integrity mismatch: ${message}`);
  };

  if (session.id !== order.stripeSessionId) mismatch('session ID');
  if (session.mode !== 'payment') mismatch('mode');
  if (session.client_reference_id !== order.orderId) mismatch('order reference');
  if (session.metadata?.integration !== integrationIdentifier) mismatch('integration marker');
  if (session.metadata?.order_id !== order.orderId) mismatch('order metadata');
  if (session.metadata?.photo_id !== order.photoId) mismatch('photo metadata');
  if (session.livemode !== order.livemode) mismatch('live mode');
  if (session.currency !== CURRENCY) mismatch('currency');
  if (session.amount_subtotal !== order.expectedAmount) mismatch('amount subtotal');
}

function sessionAudit(
  session: Stripe.Checkout.Session,
  sourceEventId: string | undefined,
): EntitlementAudit {
  const paymentIntent = session.payment_intent;
  return {
    ...(paymentIntent ? {
      stripePaymentIntentId: typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id,
    } : {}),
    ...(session.amount_total !== null ? { amountTotal: session.amount_total } : {}),
    ...(session.presentment_details ? {
      presentmentAmount: session.presentment_details.presentment_amount,
      presentmentCurrency: session.presentment_details.presentment_currency,
    } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
  };
}
