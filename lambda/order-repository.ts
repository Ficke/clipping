import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  CLOSED_ORDER_TTL_SECONDS,
  InvalidOrderTransition,
  RestorationNotAllowed,
  type CloseReason,
  type EntitlementAudit,
  type Order,
  type RevocationAudit,
  type RestorationAudit,
} from '../commerce/orders';
import {
  OrderAlreadyExists,
  OrderNotFound,
  type OrderRepository,
} from '../commerce/order-repository';

export { OrderAlreadyExists, OrderNotFound, type OrderRepository } from '../commerce/order-repository';

type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;
type Clock = () => number;

export class DynamoOrderRepository implements OrderRepository {
  constructor(
    private readonly tableName: string,
    private readonly client: DocumentClient,
    private readonly now: Clock = () => Math.floor(Date.now() / 1000),
  ) {}

  async create(order: Order): Promise<Order> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: order,
        ConditionExpression: 'attribute_not_exists(orderId)',
      }));
      return order;
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new OrderAlreadyExists(`Order ${order.orderId} already exists`);
      }
      throw error;
    }
  }

  async get(orderId: string): Promise<Order | undefined> {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { orderId },
      ConsistentRead: true,
    }));
    return response.Item as Order | undefined;
  }

  async scanNonClosed(): Promise<Order[]> {
    const orders: Order[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#state <> :closed',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: { ':closed': 'closed' },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }));
      orders.push(...(response.Items ?? []) as Order[]);
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return orders;
  }

  async attachCheckoutSession(
    orderId: string,
    sessionId: string,
    checkoutExpiresAt: number,
  ): Promise<Order> {
    const now = this.now();
    try {
      return await this.update(new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId },
        UpdateExpression: 'SET stripeSessionId = :sessionId, checkoutExpiresAt = :expiresAt, updatedAt = :now',
        ConditionExpression: '#state = :pending AND (attribute_not_exists(stripeSessionId) OR stripeSessionId = :sessionId)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':pending': 'pending',
          ':sessionId': sessionId,
          ':expiresAt': checkoutExpiresAt,
          ':now': now,
        },
        ReturnValues: 'ALL_NEW',
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.required(orderId);
      if (current.stripeSessionId === sessionId && current.checkoutExpiresAt === checkoutExpiresAt) {
        return current;
      }
      throw new InvalidOrderTransition(orderId, current.state, 'pending');
    }
  }

  async entitle(orderId: string, audit: EntitlementAudit): Promise<Order> {
    const now = this.now();
    const set = ['#state = :entitled', 'entitledAt = :now', 'updatedAt = :now'];
    const values: Record<string, unknown> = { ':pending': 'pending', ':entitled': 'entitled', ':now': now };
    addOptionalSet(set, values, 'stripePaymentIntentId', audit.stripePaymentIntentId);
    addOptionalSet(set, values, 'stripeChargeId', audit.stripeChargeId);
    addOptionalSet(set, values, 'amountTotal', audit.amountTotal);
    addOptionalSet(set, values, 'presentmentAmount', audit.presentmentAmount);
    addOptionalSet(set, values, 'presentmentCurrency', audit.presentmentCurrency);
    addOptionalSet(set, values, 'sourceEventId', audit.sourceEventId);

    return this.transition(
      orderId,
      'entitled',
      new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId },
        UpdateExpression: `SET ${set.join(', ')}`,
        ConditionExpression: '#state = :pending',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
  }

  async close(orderId: string, reason: CloseReason, sourceEventId?: string): Promise<Order> {
    const now = this.now();
    const set = [
      '#state = :closed',
      'closeReason = :reason',
      'updatedAt = :now',
      'deleteAfter = :deleteAfter',
    ];
    const values: Record<string, unknown> = {
      ':pending': 'pending',
      ':closed': 'closed',
      ':reason': reason,
      ':now': now,
      ':deleteAfter': now + CLOSED_ORDER_TTL_SECONDS,
    };
    addOptionalSet(set, values, 'sourceEventId', sourceEventId);
    return this.transition(
      orderId,
      'closed',
      new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId },
        UpdateExpression: `SET ${set.join(', ')}`,
        ConditionExpression: '#state = :pending',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
  }

  async revoke(orderId: string, audit: RevocationAudit): Promise<Order> {
    const now = this.now();
    const set = [
      '#state = :revoked',
      'revokedAt = :now',
      'revocationReason = :reason',
      'updatedAt = :now',
    ];
    const values: Record<string, unknown> = {
      ':pending': 'pending',
      ':entitled': 'entitled',
      ':revoked': 'revoked',
      ':reason': audit.reason,
      ':now': now,
    };
    addOptionalSet(set, values, 'sourceEventId', audit.sourceEventId);
    addOptionalSet(set, values, 'stripePaymentIntentId', audit.stripePaymentIntentId);
    addOptionalSet(set, values, 'stripeChargeId', audit.stripeChargeId);
    return this.transition(
      orderId,
      'revoked',
      new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId },
        UpdateExpression: `SET ${set.join(', ')}`,
        ConditionExpression: '#state IN (:pending, :entitled)',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
  }

  async restore(orderId: string, audit: RestorationAudit): Promise<Order> {
    if (!audit.evidence.disputeWon || audit.evidence.refunded || audit.evidence.currentDispute) {
      throw new RestorationNotAllowed('Restoration evidence does not permit entitlement');
    }
    if (!audit.actor.trim() || !audit.reason.trim()) {
      throw new RestorationNotAllowed('Restoration actor and reason are required');
    }
    const now = this.now();
    return this.transition(
      orderId,
      'entitled',
      new UpdateCommand({
        TableName: this.tableName,
        Key: { orderId },
        UpdateExpression: 'SET #state = :entitled, entitledAt = if_not_exists(entitledAt, :now), updatedAt = :now, restoredAt = :now, restoredBy = :actor, restorationReason = :reason',
        ConditionExpression: '#state = :revoked',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked',
          ':entitled': 'entitled',
          ':now': now,
          ':actor': audit.actor,
          ':reason': audit.reason,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
  }

  private async transition(
    orderId: string,
    intendedState: Order['state'],
    command: UpdateCommand,
  ): Promise<Order> {
    try {
      return await this.update(command);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.required(orderId);
      if (current.state === intendedState) return current;
      throw new InvalidOrderTransition(orderId, current.state, intendedState);
    }
  }

  private async update(command: UpdateCommand): Promise<Order> {
    const response = await this.client.send(command);
    if (!response.Attributes) throw new Error('DynamoDB update returned no order');
    return response.Attributes as Order;
  }

  private async required(orderId: string): Promise<Order> {
    const order = await this.get(orderId);
    if (!order) throw new OrderNotFound(`Order ${orderId} does not exist`);
    return order;
  }
}

function addOptionalSet(
  set: string[],
  values: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  const placeholder = `:${field}`;
  set.push(`${field} = ${placeholder}`);
  values[placeholder] = value;
}

function isConditionalFailure(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'ConditionalCheckFailedException';
}
