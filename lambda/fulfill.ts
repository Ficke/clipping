import type Stripe from 'stripe';
import { catalogItem, isPhotoId, type DownloadCatalog } from '../src/lib/downloads';
import { DOWNLOAD_WINDOW_SECONDS, mintToken } from './tokens';
import { INTEGRATION_IDENTIFIER } from './integration';

/**
 * Turning a paid Checkout Session into a download link.
 *
 * The buyer's landing page calls this immediately after Checkout. It writes
 * nothing: the entitlement is derived from the paid Session, so repeating it
 * during the bounded return window produces an equivalent token.
 */

/**
 * What was bought. Stripe carries only the opaque photo ID. The catalog maps it
 * to the private original and retains delisted published photos for recovery.
 *
 * So fulfillment deliberately does not require a catalog entry. Delisting a
 * photo after a purchase must not strand someone who already paid. Purchase is
 * gated by the catalog; delivery is not.
 */
export interface PurchasedItem {
  photoId: string;
  storyId: string;
  file: string;
  albumTitle: string;
  label: string;
  previewSrc: string;
  /** Only known while the photo is listed. */
  dimensions?: { width: number; height: number };
}

export interface Fulfillment {
  status: 'paid' | 'unpaid';
  item?: PurchasedItem;
  downloadUrl?: string;
  expiresAt?: number;
}

/** A Checkout return URL is for immediate delivery, not permanent recovery. */
export const CHECKOUT_RETURN_GRACE_SECONDS = 60 * 60;

export class CheckoutReturnExpired extends Error {}

export interface FulfillDeps {
  stripe: Stripe;
  catalog: DownloadCatalog;
  siteUrl: string;
  downloadTokenKey: string;
  now?: number;
  /** Enforce the browser return window. Trusted operator reissues omit this. */
  requireFreshReturn?: boolean;
}

export async function fulfillCheckout(
  sessionId: string,
  {
    stripe,
    catalog,
    siteUrl,
    downloadTokenKey,
    now = Date.now(),
    requireFreshReturn = false,
  }: FulfillDeps,
): Promise<Fulfillment> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  return fulfillmentForSession(session, {
    catalog,
    siteUrl,
    downloadTokenKey,
    now,
    requireFreshReturn,
  });
}

export function fulfillmentForSession(
  session: Stripe.Checkout.Session,
  {
    catalog,
    siteUrl,
    downloadTokenKey,
    now = Date.now(),
    requireFreshReturn = false,
  }: Omit<FulfillDeps, 'stripe'>,
): Fulfillment {
  const sessionId = session.id;

  /*
   * `paid` is the only status that entitles a download. A delayed payment method
   * reports `unpaid` on checkout.session.completed and only becomes `paid` on
   * the later async_payment_succeeded event, so this check is what keeps an
   * unfunded bank debit from delivering the file.
   */
  if (session.payment_status !== 'paid') return { status: 'unpaid' };

  if (session.metadata?.integration !== INTEGRATION_IDENTIFIER) {
    throw new Error(`Checkout Session ${sessionId} was not created by this store`);
  }

  if (requireFreshReturn) {
    const checkoutExpiresAt = session.expires_at;
    if (!checkoutExpiresAt || now / 1000 > checkoutExpiresAt + CHECKOUT_RETURN_GRACE_SECONDS) {
      throw new CheckoutReturnExpired(`Checkout Session ${sessionId} is outside its return window`);
    }
  }

  const photoId = session.metadata?.photo_id;
  if (!photoId || !isPhotoId(photoId)) {
    throw new Error(`Checkout Session ${sessionId} carries no valid photo_id in metadata`);
  }
  const listed = catalogItem(catalog, photoId);
  if (!listed) throw new Error(`Photo ID ${photoId} is absent from the fulfillment catalog`);
  const { storyId, file } = listed;
  const item: PurchasedItem = {
    photoId,
    storyId,
    file,
    albumTitle: listed.albumTitle,
    label: listed.label,
    previewSrc: listed.previewSrc,
    dimensions: { width: listed.width, height: listed.height },
  };

  const expiresAt = Math.floor(now / 1000) + DOWNLOAD_WINDOW_SECONDS;
  const token = mintToken({ photoId, sessionId, expiresAt }, downloadTokenKey);

  return {
    status: 'paid',
    item,
    expiresAt,
    downloadUrl: `${siteUrl}/api/download?t=${token}`,
  };
}
