import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAssetRef, isPhotoId } from '../src/lib/downloads';
import { isOrderId } from './orders';

/**
 * Download entitlements, as self-contained signed tokens.
 *
 * The alternative — a row in a database keyed by Checkout Session — would make
 * this the only stateful part of the site. A token signed with a key only the
 * Lambda holds carries the same information and needs no store, which is why
 * there is still no database here.
 *
 * The token is not the S3 URL. It is exchanged for a freshly presigned URL on
 * every download, so the entitlement can outlive S3's presigning limits and the
 * presigned URL itself can stay short-lived.
 */

export interface Entitlement {
  version: 1;
  /** Local durable-order identity. */
  orderId: string;
  /** The opaque photograph identity recorded on the Stripe payment. */
  photoId: string;
  /** Immutable sanitized S3 object identity, with its file format. */
  assetRef: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

export const DOWNLOAD_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function signature(key: string, payload: string): Buffer {
  return createHmac('sha256', key).update(payload).digest();
}

export function mintToken(entitlement: Entitlement, key: string): string {
  const payload = encode(JSON.stringify(entitlement));
  return `${payload}.${encode(signature(key, payload))}`;
}

export class InvalidToken extends Error {}

/**
 * Verifies then parses — never the other way round, so a forged payload is
 * never interpreted. Expiry is checked last because an expired token is a
 * genuine entitlement that has simply aged out, and the caller may want to
 * distinguish it.
 */
export function readToken(token: string, key: string, now = Date.now()): Entitlement {
  const parts = token.split('.');
  if (parts.length !== 2) throw new InvalidToken('Malformed download token');
  const [payload, provided] = parts as [string, string];

  const expected = signature(key, payload);
  const actual = Buffer.from(provided, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvalidToken('Download token signature does not match');
  }

  let entitlement: Entitlement;
  try {
    entitlement = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidToken('Download token payload is not JSON');
  }
  if (
    entitlement?.version !== 1
    || typeof entitlement?.orderId !== 'string'
    || !isOrderId(entitlement.orderId)
    || typeof entitlement?.photoId !== 'string'
    || !isPhotoId(entitlement.photoId)
    || typeof entitlement?.assetRef !== 'string'
    || !isAssetRef(entitlement.assetRef)
    || !Number.isInteger(entitlement?.expiresAt)
  ) {
    throw new InvalidToken('Download token payload is incomplete');
  }
  if (entitlement.expiresAt * 1000 <= now) {
    throw new InvalidToken('Download link has expired');
  }
  return entitlement;
}
