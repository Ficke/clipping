import type Stripe from 'stripe';
import { disputeFacts } from './disputes';
import { ensureEntitlement, validateSession } from './entitlement';
import type { OrderRepository } from './order-repository';
import type { Order } from './orders';

export type ReconcileOutcome = 'REPAIRED' | 'UNCHANGED' | 'REVIEW' | 'FAILED';

export interface ReconcileResult {
  orderId: string;
  outcome: ReconcileOutcome;
  action: string;
  errorCategory?: string;
}

export interface ReconcileDeps {
  stripe: Stripe;
  orders: OrderRepository;
  dryRun?: boolean;
}

export async function reconcileAll({ stripe, orders, dryRun = false }: ReconcileDeps): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const order of await orders.scanNonClosed()) {
    try {
      results.push(await reconcileOrder(order, { stripe, orders, dryRun }));
    } catch (error) {
      results.push({
        orderId: order.orderId,
        outcome: 'FAILED',
        action: 'dependency_or_integrity_error',
        errorCategory: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
  return results;
}

export async function reconcileOrder(
  initial: Order,
  { stripe, orders, dryRun = false }: ReconcileDeps,
): Promise<ReconcileResult> {
  let order = initial;
  let sessionId = order.stripeSessionId;
  let attachedSession = false;
  if (!sessionId) {
    const recovered = await findSessionForOrder(stripe, order);
    if (!recovered) return result(order, 'UNCHANGED', 'session_not_found');
    sessionId = recovered.id;
    const recoveredOrder = {
      ...order,
      stripeSessionId: recovered.id,
      checkoutExpiresAt: recovered.expires_at,
    };
    // Validate every immutable field before persisting a Session found by a
    // metadata scan. This also gives dry-run the same validation input as the
    // write path instead of comparing the recovered ID with `undefined`.
    validateSession(recovered, recoveredOrder);
    order = dryRun
      ? recoveredOrder
      : await orders.attachCheckoutSession(order.orderId, recovered.id, recovered.expires_at);
    attachedSession = true;
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge'],
  });
  validateSession(session, order);

  const reversal = await reversalState(stripe, session);
  if (reversal.refunded || reversal.disputed) {
    if (order.state === 'revoked') return result(order, 'UNCHANGED', reversal.reason, attachedSession);
    if (!dryRun) {
      await orders.revoke(order.orderId, {
        reason: reversal.reason,
        stripePaymentIntentId: reversal.paymentIntentId,
        stripeChargeId: reversal.chargeId,
      });
    }
    return result(order, 'REPAIRED', `revoke:${reversal.reason}`, attachedSession);
  }
  if (order.state === 'revoked' && reversal.wonDispute) {
    return result(order, 'REVIEW', 'won_dispute_requires_manual_restore', attachedSession);
  }

  if (session.payment_status === 'paid') {
    if (order.state === 'entitled') return result(order, 'UNCHANGED', 'already_entitled', attachedSession);
    if (!dryRun) await ensureEntitlement(session.id, { stripe, orders });
    return result(order, 'REPAIRED', 'entitle', attachedSession);
  }
  if (session.status === 'expired') {
    if (!dryRun) await orders.close(order.orderId, 'expired');
    return result(order, 'REPAIRED', 'close:expired', attachedSession);
  }
  if (await hasAsyncFailure(stripe, session.id, order.createdAt)) {
    if (!dryRun) await orders.close(order.orderId, 'failed');
    return result(order, 'REPAIRED', 'close:failed', attachedSession);
  }
  return result(order, 'UNCHANGED', 'payment_pending', attachedSession);
}

async function findSessionForOrder(stripe: Stripe, order: Order): Promise<Stripe.Checkout.Session | undefined> {
  const page = stripe.checkout.sessions.list({ created: { gte: order.createdAt }, limit: 100 });
  for await (const session of page) {
    if (session.client_reference_id === order.orderId
      && session.metadata?.order_id === order.orderId
      && session.metadata?.photo_id === order.photoId) return session;
  }
  return undefined;
}

async function hasAsyncFailure(stripe: Stripe, sessionId: string, createdAt: number): Promise<boolean> {
  const page = stripe.events.list({
    type: 'checkout.session.async_payment_failed',
    created: { gte: createdAt },
    limit: 100,
  });
  for await (const event of page) {
    if ((event.data.object as { id?: string }).id === sessionId) return true;
  }
  return false;
}

async function reversalState(stripe: Stripe, session: Stripe.Checkout.Session): Promise<{
  refunded: boolean;
  disputed: boolean;
  wonDispute: boolean;
  reason: string;
  paymentIntentId?: string;
  chargeId?: string;
}> {
  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') {
    return { refunded: false, disputed: false, wonDispute: false, reason: 'none' };
  }
  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') {
    return { refunded: false, disputed: false, wonDispute: false, reason: 'none', paymentIntentId: intent.id };
  }
  const disputes = await stripe.disputes.list({ charge: charge.id, limit: 100 });
  const { wonDispute, blockingDispute: disputed } = disputeFacts(charge.disputed, disputes.data);
  const refunded = charge.refunded || charge.amount_refunded > 0;
  return {
    refunded,
    disputed,
    wonDispute,
    reason: refunded ? 'refunded' : disputed ? 'disputed' : 'none',
    paymentIntentId: intent.id,
    chargeId: charge.id,
  };
}

function result(
  order: Order,
  outcome: ReconcileOutcome,
  action: string,
  attachedSession = false,
): ReconcileResult {
  if (!attachedSession) return { orderId: order.orderId, outcome, action };
  return {
    orderId: order.orderId,
    outcome: outcome === 'UNCHANGED' ? 'REPAIRED' : outcome,
    action: action === 'payment_pending' ? 'attach_session' : `attach_session+${action}`,
  };
}
