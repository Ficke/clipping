import type Stripe from 'stripe';
import { ensureEntitlement } from './entitlement';
import type { OrderRepository } from './order-repository';
import type { Order } from './orders';
import { DOWNLOAD_WINDOW_SECONDS, mintToken } from './tokens';

export interface PurchasedItem {
  photoId: string;
  albumTitle: string;
  label: string;
  previewSrc?: string;
}

export interface Fulfillment {
  status: 'paid' | 'unpaid';
  item?: PurchasedItem;
  downloadUrl?: string;
  expiresAt?: number;
}

export const CHECKOUT_RETURN_GRACE_SECONDS = 60 * 60;

export class CheckoutReturnExpired extends Error {}

export interface FulfillDeps {
  stripe: Stripe;
  orders: OrderRepository;
  siteUrl: string;
  downloadTokenKey: string;
  now?: number;
  requireFreshReturn?: boolean;
  sourceEventId?: string;
}

export async function fulfillCheckout(
  sessionId: string,
  {
    stripe,
    orders,
    siteUrl,
    downloadTokenKey,
    now = Date.now(),
    requireFreshReturn = false,
    sourceEventId,
  }: FulfillDeps,
): Promise<Fulfillment> {
  const result = await ensureEntitlement(sessionId, { stripe, orders, sourceEventId });
  if (result.status === 'pending') return { status: 'unpaid' };
  if (requireFreshReturn) assertFreshReturn(result.order, now);
  return fulfillmentForOrder(result.order, { siteUrl, downloadTokenKey, now });
}

export function fulfillmentForOrder(
  order: Order,
  {
    siteUrl,
    downloadTokenKey,
    now = Date.now(),
  }: { siteUrl: string; downloadTokenKey: string; now?: number },
): Fulfillment {
  if (order.state !== 'entitled') return { status: 'unpaid' };
  const expiresAt = Math.floor(now / 1000) + DOWNLOAD_WINDOW_SECONDS;
  const token = mintToken({
    version: 1,
    orderId: order.orderId,
    photoId: order.photoId,
    expiresAt,
  }, downloadTokenKey);
  return {
    status: 'paid',
    item: {
      photoId: order.photoId,
      albumTitle: order.albumTitle,
      label: order.label,
      ...(order.previewSrc ? { previewSrc: order.previewSrc } : {}),
    },
    expiresAt,
    downloadUrl: `${siteUrl}/api/download?t=${token}`,
  };
}

function assertFreshReturn(order: Order, now: number): void {
  if (!order.checkoutExpiresAt
    || now / 1000 > order.checkoutExpiresAt + CHECKOUT_RETURN_GRACE_SECONDS) {
    throw new CheckoutReturnExpired('Checkout return is outside its renewal window');
  }
}
