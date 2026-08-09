const PHOTO_ID = /^photo_[a-f0-9]{24}$/;
const ORDER_ID = /^ord_[a-f0-9]{32}$/;
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]+$/;

const PHOTO_ID_BYTES = 12;
const ORDER_ID_BYTES = 16;

/**
 * These aliases establish domain vocabulary while serialized IDs remain
 * strings. Boundary validators, rather than compile-time branding, enforce
 * their external representation.
 */
export type PhotoId = string;
export type OrderId = string;
export type CheckoutSessionId = string;
export type CommerceMode = 'test' | 'live';

type RandomBytes = (size: number) => Uint8Array;

function secureRandomBytes(size: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generatePhotoId(random: RandomBytes = secureRandomBytes): PhotoId {
  return `photo_${hex(random(PHOTO_ID_BYTES))}`;
}

export function isPhotoId(value: unknown): value is PhotoId {
  return typeof value === 'string' && PHOTO_ID.test(value);
}

export function generateOrderId(random: RandomBytes = secureRandomBytes): OrderId {
  return `ord_${hex(random(ORDER_ID_BYTES))}`;
}

export function isOrderId(value: unknown): value is OrderId {
  return typeof value === 'string' && ORDER_ID.test(value);
}

export function checkoutSessionMode(value: unknown): CommerceMode | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CHECKOUT_SESSION_ID.exec(value);
  return match?.[1] as CommerceMode | undefined;
}

export function isCheckoutSessionId(value: unknown): value is CheckoutSessionId {
  return checkoutSessionMode(value) !== undefined;
}
