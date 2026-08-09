import { describe, expect, test } from 'bun:test';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoOrderRepository, OrderAlreadyExists } from './order-repository';
import { CLOSED_ORDER_TTL_SECONDS, InvalidOrderTransition, createPendingOrder, type Order } from '../commerce/orders';

const ORDER_ID = `ord_${'1'.repeat(32)}`;

function order(state: Order['state'] = 'pending'): Order {
  return {
    ...createPendingOrder({
      livemode: false,
      photoId: 'photo_1234567890abcdef12345678',
      expectedAmount: 4_000,
      albumTitle: 'Lost Coast',
      label: 'Fog',
    }, 100, ORDER_ID),
    state,
  };
}

class ScriptedClient {
  readonly calls: unknown[] = [];
  constructor(private readonly results: Array<object | Error>) {}

  async send(command: unknown): Promise<object> {
    this.calls.push(command);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? {};
  }
}

function repo(client: ScriptedClient, now = 500): DynamoOrderRepository {
  return new DynamoOrderRepository(
    'commerce-orders',
    client as unknown as Pick<DynamoDBDocumentClient, 'send'>,
    () => now,
  );
}

function conditionalFailure(): Error {
  return Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
}

describe('DynamoDB order repository', () => {
  test('creates orders conditionally', async () => {
    const client = new ScriptedClient([{}]);
    await expect(repo(client).create(order())).resolves.toMatchObject({ state: 'pending' });
    expect(client.calls[0]).toBeInstanceOf(PutCommand);
    expect((client.calls[0] as PutCommand).input).toMatchObject({
      TableName: 'commerce-orders',
      ConditionExpression: 'attribute_not_exists(orderId)',
    });
  });

  test('reports duplicate IDs without hiding dependency failures', async () => {
    await expect(repo(new ScriptedClient([conditionalFailure()])).create(order()))
      .rejects.toBeInstanceOf(OrderAlreadyExists);
    const dependencyError = new Error('network unavailable');
    await expect(repo(new ScriptedClient([dependencyError])).create(order())).rejects.toBe(dependencyError);
  });

  test('always reads by partition key with strong consistency', async () => {
    const client = new ScriptedClient([{ Item: order() }]);
    await expect(repo(client).get(ORDER_ID)).resolves.toMatchObject({ orderId: ORDER_ID });
    expect(client.calls[0]).toBeInstanceOf(GetCommand);
    expect((client.calls[0] as GetCommand).input).toEqual({
      TableName: 'commerce-orders',
      Key: { orderId: ORDER_ID },
      ConsistentRead: true,
    });
  });

  test('scans every page while filtering closed orders', async () => {
    const second = { ...order(), orderId: `ord_${'2'.repeat(32)}` };
    const client = new ScriptedClient([
      { Items: [order()], LastEvaluatedKey: { orderId: ORDER_ID } },
      { Items: [second] },
    ]);
    await expect(repo(client).scanNonClosed()).resolves.toEqual([order(), second]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toBeInstanceOf(ScanCommand);
    expect((client.calls[0] as ScanCommand).input.FilterExpression).toBe('#state <> :closed');
    expect((client.calls[1] as ScanCommand).input.ExclusiveStartKey).toEqual({ orderId: ORDER_ID });
  });

  test('attaches a Session only to pending orders and permits an exact duplicate', async () => {
    const attached = { ...order(), stripeSessionId: 'cs_test_1', checkoutExpiresAt: 1_000 };
    const client = new ScriptedClient([{ Attributes: attached }]);
    await expect(repo(client).attachCheckoutSession(ORDER_ID, 'cs_test_1', 1_000))
      .resolves.toEqual(attached);
    const input = (client.calls[0] as UpdateCommand).input;
    expect(input.ConditionExpression).toContain('#state = :pending');
    expect(input.ConditionExpression).toContain('attribute_not_exists(stripeSessionId)');

    const raced = new ScriptedClient([conditionalFailure(), { Item: attached }]);
    await expect(repo(raced).attachCheckoutSession(ORDER_ID, 'cs_test_1', 1_000))
      .resolves.toEqual(attached);
    expect((raced.calls[1] as GetCommand).input.ConsistentRead).toBe(true);
  });

  test('concurrent entitlement converges on the committed intended state', async () => {
    const entitled = { ...order('entitled'), entitledAt: 500, updatedAt: 500 };
    const client = new ScriptedClient([conditionalFailure(), { Item: entitled }]);
    await expect(repo(client).entitle(ORDER_ID, { sourceEventId: 'evt_1' }))
      .resolves.toEqual(entitled);
    expect((client.calls[1] as GetCommand).input.ConsistentRead).toBe(true);
  });

  test('a race to a different state remains an invalid transition', async () => {
    const revoked = { ...order('revoked'), revokedAt: 499 };
    const client = new ScriptedClient([conditionalFailure(), { Item: revoked }]);
    await expect(repo(client).entitle(ORDER_ID, {})).rejects.toBeInstanceOf(InvalidOrderTransition);
  });

  test('closed orders alone receive the 30-day TTL', async () => {
    const closed = {
      ...order('closed'),
      closeReason: 'expired' as const,
      updatedAt: 500,
      deleteAfter: 500 + CLOSED_ORDER_TTL_SECONDS,
    };
    const client = new ScriptedClient([{ Attributes: closed }]);
    await expect(repo(client).close(ORDER_ID, 'expired', 'evt_expired')).resolves.toEqual(closed);
    const values = (client.calls[0] as UpdateCommand).input.ExpressionAttributeValues;
    expect(values?.[':deleteAfter']).toBe(500 + CLOSED_ORDER_TTL_SECONDS);
    expect(values?.[':sourceEventId']).toBe('evt_expired');
  });

  test('revocation is conditional from pending or entitled and idempotent at revoked', async () => {
    const revoked = { ...order('revoked'), revocationReason: 'refunded', revokedAt: 500 };
    const first = new ScriptedClient([{ Attributes: revoked }]);
    await repo(first).revoke(ORDER_ID, {
      reason: 'refunded',
      sourceEventId: 'evt_refund',
      stripePaymentIntentId: 'pi_test',
      stripeChargeId: 'ch_test',
    });
    expect((first.calls[0] as UpdateCommand).input.ConditionExpression)
      .toBe('#state IN (:pending, :entitled)');
    expect((first.calls[0] as UpdateCommand).input.ExpressionAttributeValues).toMatchObject({
      ':stripePaymentIntentId': 'pi_test',
      ':stripeChargeId': 'ch_test',
    });

    const duplicate = new ScriptedClient([conditionalFailure(), { Item: revoked }]);
    await expect(repo(duplicate).revoke(ORDER_ID, { reason: 'refunded', sourceEventId: 'evt_refund' }))
      .resolves.toEqual(revoked);
  });

  test('restoration requires verified facts and records actor, reason, and time', async () => {
    const restored = {
      ...order('entitled'),
      restoredAt: 500,
      restoredBy: 'ops',
      restorationReason: 'won dispute',
    };
    const client = new ScriptedClient([{ Attributes: restored }]);
    await expect(repo(client).restore(ORDER_ID, {
      actor: 'ops',
      reason: 'won dispute',
      evidence: { disputeWon: true, refunded: false, currentDispute: false },
    })).resolves.toEqual(restored);
    const input = (client.calls[0] as UpdateCommand).input;
    expect(input.ConditionExpression).toBe('#state = :revoked');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':actor': 'ops',
      ':reason': 'won dispute',
      ':now': 500,
    });

    const unused = new ScriptedClient([]);
    await expect(repo(unused).restore(ORDER_ID, {
      actor: 'ops',
      reason: 'open dispute',
      evidence: { disputeWon: false, refunded: false, currentDispute: true },
    })).rejects.toThrow(/evidence/);
    expect(unused.calls).toHaveLength(0);
  });
});
