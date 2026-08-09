import { generateOrderId, isOrderId, isPhotoId } from '../shared/ids';

export { generateOrderId, isOrderId } from '../shared/ids';

export const CLOSED_ORDER_TTL_SECONDS = 30 * 24 * 60 * 60;

export type OrderState = 'pending' | 'entitled' | 'closed' | 'revoked';
export type CloseReason = 'expired' | 'failed';

export interface Order {
  orderId: string;
  state: OrderState;
  closeReason?: CloseReason;
  livemode: boolean;
  photoId: string;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  expectedAmount: number;
  amountTotal?: number;
  presentmentAmount?: number;
  presentmentCurrency?: string;
  checkoutExpiresAt?: number;
  createdAt: number;
  entitledAt?: number;
  updatedAt: number;
  revokedAt?: number;
  revocationReason?: string;
  sourceEventId?: string;
  albumTitle: string;
  label: string;
  previewSrc?: string;
  /** DynamoDB TTL, present only while the order is closed. */
  deleteAfter?: number;
  restoredAt?: number;
  restoredBy?: string;
  restorationReason?: string;
}

export interface PendingOrderInput {
  livemode: boolean;
  photoId: string;
  expectedAmount: number;
  albumTitle: string;
  label: string;
  previewSrc?: string;
}

export interface EntitlementAudit {
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  amountTotal?: number;
  presentmentAmount?: number;
  presentmentCurrency?: string;
  sourceEventId?: string;
}

export interface RevocationAudit {
  reason: string;
  sourceEventId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
}

export interface RestorationEvidence {
  disputeWon: boolean;
  refunded: boolean;
  currentDispute: boolean;
}

export interface RestorationAudit {
  actor: string;
  reason: string;
  evidence: RestorationEvidence;
}

export class InvalidOrder extends Error {}

export class InvalidOrderTransition extends Error {
  constructor(
    readonly orderId: string,
    readonly from: OrderState,
    readonly to: OrderState,
  ) {
    super(`Cannot transition order ${orderId} from ${from} to ${to}`);
  }
}

export class RestorationNotAllowed extends Error {}

export function createPendingOrder(
  input: PendingOrderInput,
  now: number,
  orderId = generateOrderId(),
): Order {
  if (!isOrderId(orderId)) throw new InvalidOrder('Order ID is malformed');
  if (!isPhotoId(input.photoId)) throw new InvalidOrder('Photo ID is malformed');
  if (!Number.isInteger(input.expectedAmount) || input.expectedAmount <= 0) {
    throw new InvalidOrder('Expected amount must be a positive integer');
  }
  if (!Number.isInteger(now) || now < 0) throw new InvalidOrder('Timestamp is malformed');
  if (!input.albumTitle || !input.label) throw new InvalidOrder('Display snapshot is incomplete');

  return {
    orderId,
    state: 'pending',
    livemode: input.livemode,
    photoId: input.photoId,
    expectedAmount: input.expectedAmount,
    albumTitle: input.albumTitle,
    label: input.label,
    ...(input.previewSrc ? { previewSrc: input.previewSrc } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionToEntitled(order: Order, audit: EntitlementAudit, now: number): Order {
  if (order.state === 'entitled') return order;
  if (order.state !== 'pending') {
    throw new InvalidOrderTransition(order.orderId, order.state, 'entitled');
  }
  return {
    ...order,
    state: 'entitled',
    entitledAt: now,
    updatedAt: now,
    ...defined(audit),
  };
}

export function transitionToClosed(
  order: Order,
  reason: CloseReason,
  now: number,
  sourceEventId?: string,
): Order {
  if (order.state === 'closed') return order;
  if (order.state !== 'pending') {
    throw new InvalidOrderTransition(order.orderId, order.state, 'closed');
  }
  return {
    ...order,
    state: 'closed',
    closeReason: reason,
    updatedAt: now,
    deleteAfter: now + CLOSED_ORDER_TTL_SECONDS,
    ...(sourceEventId ? { sourceEventId } : {}),
  };
}

export function transitionToRevoked(
  order: Order,
  audit: RevocationAudit,
  now: number,
): Order {
  if (order.state === 'revoked') return order;
  if (order.state !== 'pending' && order.state !== 'entitled') {
    throw new InvalidOrderTransition(order.orderId, order.state, 'revoked');
  }
  if (!audit.reason) throw new InvalidOrder('Revocation reason is required');
  return {
    ...order,
    state: 'revoked',
    revokedAt: now,
    revocationReason: audit.reason,
    updatedAt: now,
    ...defined({
      sourceEventId: audit.sourceEventId,
      stripePaymentIntentId: audit.stripePaymentIntentId,
      stripeChargeId: audit.stripeChargeId,
    }),
  };
}

export function transitionToRestored(order: Order, audit: RestorationAudit, now: number): Order {
  if (order.state !== 'revoked') {
    throw new InvalidOrderTransition(order.orderId, order.state, 'entitled');
  }
  if (!audit.evidence.disputeWon || audit.evidence.refunded || audit.evidence.currentDispute) {
    throw new RestorationNotAllowed(
      `Order ${order.orderId} cannot be restored without a won dispute, no refund, and no current dispute`,
    );
  }
  if (!audit.actor.trim() || !audit.reason.trim()) {
    throw new RestorationNotAllowed('Restoration actor and reason are required');
  }
  return {
    ...order,
    state: 'entitled',
    entitledAt: order.entitledAt ?? now,
    updatedAt: now,
    restoredAt: now,
    restoredBy: audit.actor,
    restorationReason: audit.reason,
  };
}

function defined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}
