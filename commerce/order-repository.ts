import type {
  CloseReason,
  EntitlementAudit,
  Order,
  RestorationAudit,
  RevocationAudit,
} from './orders';

export interface OrderRepository {
  create(order: Order): Promise<Order>;
  get(orderId: string): Promise<Order | undefined>;
  attachCheckoutSession(orderId: string, sessionId: string, checkoutExpiresAt: number): Promise<Order>;
  entitle(orderId: string, audit: EntitlementAudit): Promise<Order>;
  close(orderId: string, reason: CloseReason, sourceEventId?: string): Promise<Order>;
  revoke(orderId: string, audit: RevocationAudit): Promise<Order>;
  restore(orderId: string, audit: RestorationAudit): Promise<Order>;
  scanNonClosed(): Promise<Order[]>;
}

export class OrderAlreadyExists extends Error {}
export class OrderNotFound extends Error {}
