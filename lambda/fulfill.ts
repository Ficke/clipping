import type Stripe from 'stripe';
import { catalogItem, parseSku, type DownloadCatalog } from '../src/lib/downloads';
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

/**
 * What was bought. The SKU is permanent and is the whole entitlement; the
 * catalog only describes what is *currently* for sale.
 *
 * So fulfillment deliberately does not require a catalog entry. Delisting a
 * photo, or changing your mind between a bank debit being authorised and it
 * settling days later, must not strand someone who already paid — it would
 * 404 the webhook until Stripe gave up retrying, and tell the buyer their
 * purchase was unavailable. Purchase is gated by the catalog; delivery is not.
 */
export interface PurchasedItem {
  sku: string;
  storyId: string;
  file: string;
  albumTitle: string;
  /** Only known while the photo is listed. */
  dimensions?: { width: number; height: number };
}

export interface Fulfillment {
  status: 'paid' | 'unpaid';
  item?: PurchasedItem;
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

  /* Shape is still enforced: a SKU that cannot be parsed cannot name an S3 key. */
  const { storyId, file } = parseSku(sku);
  const listed = catalogItem(catalog, sku);
  const item: PurchasedItem = {
    sku,
    storyId,
    file,
    /* Falls back to the permanent id when the album is no longer listed. */
    albumTitle: listed?.albumTitle ?? storyId,
    ...(listed && { dimensions: { width: listed.width, height: listed.height } }),
  };

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
