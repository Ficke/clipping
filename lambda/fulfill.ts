import type Stripe from 'stripe';
import type { CatalogItem, DownloadCatalog } from '../src/lib/downloads';
import { requireItem } from './catalog';
import { DOWNLOAD_WINDOW_SECONDS, mintToken } from './tokens';

/**
 * Turning a paid Checkout Session into a download link.
 *
 * Both the webhook and the buyer's landing page call this, which is Stripe's
 * recommended shape: the webhook guarantees fulfillment happens even if the
 * buyer closes the tab, the landing page makes it immediate while they are still
 * there. That means it runs more than once per purchase, sometimes concurrently.
 *
 * It is safe to repeat because it writes nothing. The entitlement is derived
 * from the session, so calling it twice produces two equivalent tokens rather
 * than two of anything. The one side effect — the delivery email — is triggered
 * only from the webhook, so it happens once.
 */

export interface Fulfillment {
  status: 'paid' | 'unpaid';
  item?: CatalogItem;
  downloadUrl?: string;
  expiresAt?: number;
  /** Where Stripe says to send the file. Absent if Checkout collected no email. */
  email?: string;
}

export interface FulfillDeps {
  stripe: Stripe;
  catalog: DownloadCatalog;
  siteUrl: string;
  downloadTokenKey: string;
  now?: number;
}

export async function fulfillCheckout(
  sessionId: string,
  { stripe, catalog, siteUrl, downloadTokenKey, now = Date.now() }: FulfillDeps,
): Promise<Fulfillment> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  /*
   * `paid` is the only status that entitles a download. A delayed payment method
   * reports `unpaid` on checkout.session.completed and only becomes `paid` on
   * the later async_payment_succeeded event, so this check is what keeps an
   * unfunded bank debit from delivering the file.
   */
  if (session.payment_status !== 'paid') return { status: 'unpaid' };

  const sku = session.metadata?.sku;
  if (!sku) throw new Error(`Checkout Session ${sessionId} carries no sku in metadata`);

  const item = requireItem(catalog, sku);
  const expiresAt = Math.floor(now / 1000) + DOWNLOAD_WINDOW_SECONDS;
  const token = mintToken({ sku, sessionId, expiresAt }, downloadTokenKey);

  return {
    status: 'paid',
    item,
    expiresAt,
    downloadUrl: `${siteUrl}/api/download?t=${token}`,
    email: session.customer_details?.email ?? undefined,
  };
}
