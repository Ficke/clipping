import type Stripe from 'stripe';

/* `warning_closed` is an early-warning inquiry that closed without a dispute.
   It is not a win, but it blocks nothing, so `wonDispute` covers both. */
const NON_BLOCKING_STATUSES = new Set<Stripe.Dispute.Status>(['won', 'warning_closed']);

export function disputeFacts(
  chargeDisputed: boolean,
  disputes: ReadonlyArray<Pick<Stripe.Dispute, 'status'>>,
): { wonDispute: boolean; blockingDispute: boolean } {
  const wonDispute = disputes.some((dispute) => NON_BLOCKING_STATUSES.has(dispute.status));
  const blockingDispute = disputes.some((dispute) => !NON_BLOCKING_STATUSES.has(dispute.status))
    // `Charge.disputed` is historical and remains true after a win. Retain it
    // only as a fail-safe if Stripe returns no Dispute object at all.
    || (disputes.length === 0 && chargeDisputed);
  return { wonDispute, blockingDispute };
}
