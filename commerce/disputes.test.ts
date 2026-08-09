import { describe, expect, test } from 'bun:test';
import type Stripe from 'stripe';
import { disputeFacts } from './disputes';

const disputes = (...statuses: Stripe.Dispute.Status[]) => statuses.map((status) => ({ status }));

describe('current Stripe dispute facts', () => {
  test('uses the Charge flag only when Stripe returns no Dispute object', () => {
    expect(disputeFacts(false, [])).toEqual({ wonDispute: false, blockingDispute: false });
    expect(disputeFacts(true, [])).toEqual({ wonDispute: false, blockingDispute: true });
  });

  test('keeps open and lost disputes blocking', () => {
    expect(disputeFacts(true, disputes('needs_response'))).toEqual({
      wonDispute: false, blockingDispute: true,
    });
    expect(disputeFacts(true, disputes('lost'))).toEqual({
      wonDispute: false, blockingDispute: true,
    });
  });

  test('allows a won or closed warning despite the historical Charge flag', () => {
    expect(disputeFacts(true, disputes('won'))).toEqual({ wonDispute: true, blockingDispute: false });
    expect(disputeFacts(true, disputes('warning_closed'))).toEqual({
      wonDispute: true, blockingDispute: false,
    });
  });

  test('keeps a mixed set blocking until every dispute is non-blocking', () => {
    expect(disputeFacts(true, disputes('won', 'under_review'))).toEqual({
      wonDispute: true, blockingDispute: true,
    });
  });
});
