import type Stripe from 'stripe';
import type { DownloadCatalog } from '../src/lib/downloads';
import { fulfillmentForSession, type Fulfillment } from './fulfill';

export class ReissueRefused extends Error {}

export interface ReissueDeps {
  stripe: Stripe;
  catalog: DownloadCatalog;
  siteUrl: string;
  downloadTokenKey: string;
  now?: number;
}

/**
 * Trusted operator recovery for a buyer who lost an expired entitlement.
 * Unlike the browser return route, this also checks the current charge state.
 */
export async function reissueDownload(
  sessionId: string,
  { stripe, catalog, siteUrl, downloadTokenKey, now }: ReissueDeps,
): Promise<Fulfillment> {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge'],
  });

  if (session.payment_status !== 'paid') {
    throw new ReissueRefused(`Checkout Session ${sessionId} is not paid`);
  }

  const intent = session.payment_intent;
  if (!intent || typeof intent === 'string') {
    throw new ReissueRefused(`Checkout Session ${sessionId} has no expanded PaymentIntent`);
  }

  const charge = intent.latest_charge;
  if (!charge || typeof charge === 'string') {
    throw new ReissueRefused(`Checkout Session ${sessionId} has no expanded Charge`);
  }
  if (charge.disputed) {
    throw new ReissueRefused(`Checkout Session ${sessionId} has a disputed charge`);
  }
  if (charge.refunded || charge.amount_refunded > 0) {
    throw new ReissueRefused(`Checkout Session ${sessionId} has a refunded charge`);
  }

  return fulfillmentForSession(session, {
    catalog,
    siteUrl,
    downloadTokenKey,
    now,
  });
}
