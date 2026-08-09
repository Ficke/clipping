import { describe, expect, test } from 'bun:test';
import {
  resolveDevTable,
  TemporaryTableLifecycle,
  validateDevSecrets,
} from './commerce-dev-support';

describe('local commerce environment', () => {
  test('generates a collision-resistant owned table or accepts an explicit sandbox table', () => {
    expect(resolveDevTable({}, 42, 1_000)).toEqual({
      tableName: 'adamficke-com-commerce-dev-rs-42', ownsTemporaryTable: true,
    });
    expect(resolveDevTable({ COMMERCE_TABLE: 'commerce-sandbox' }, 42, 1_000)).toEqual({
      tableName: 'commerce-sandbox', ownsTemporaryTable: false,
    });
    expect(() => resolveDevTable({ COMMERCE_TABLE: 'adamficke-com-commerce-orders' })).toThrow('Refusing');
  });

  test('accepts test keys and refuses live or malformed secret documents', () => {
    expect(validateDevSecrets({ stripeApiKey: 'rk_test_value' })).toEqual({ stripeApiKey: 'rk_test_value' });
    expect(() => validateDevSecrets({ stripeApiKey: 'rk_live_value' })).toThrow('not test mode');
    expect(() => validateDevSecrets([])).toThrow('JSON object');
  });

  test('creates, waits for, and deletes its table exactly once', async () => {
    const calls: string[] = [];
    const table = new TemporaryTableLifecycle({
      tableName: 'temporary',
      create: async (name) => { calls.push(`create:${name}`); },
      waitUntilReady: async (name) => { calls.push(`wait:${name}`); },
      remove: async (name) => { calls.push(`delete:${name}`); },
    });
    await table.start();
    await Promise.all([table.stop(), table.stop()]);
    expect(calls).toEqual(['create:temporary', 'wait:temporary', 'delete:temporary']);
  });

  test('attempts cleanup when readiness fails after creation', async () => {
    const calls: string[] = [];
    const table = new TemporaryTableLifecycle({
      tableName: 'temporary',
      create: async () => { calls.push('create'); },
      waitUntilReady: async () => { calls.push('wait'); throw new Error('timeout'); },
      remove: async () => { calls.push('delete'); },
    });
    await expect(table.start()).rejects.toThrow('timeout');
    expect(calls).toEqual(['create', 'wait', 'delete']);
  });

  test('attempts cleanup when table creation has an uncertain result', async () => {
    const calls: string[] = [];
    const table = new TemporaryTableLifecycle({
      tableName: 'temporary',
      create: async () => { calls.push('create'); throw new Error('response lost'); },
      waitUntilReady: async () => { calls.push('wait'); },
      remove: async () => { calls.push('delete'); },
    });
    await expect(table.start()).rejects.toThrow('response lost');
    expect(calls).toEqual(['create', 'delete']);
  });
});
