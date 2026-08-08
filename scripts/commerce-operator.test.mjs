import { describe, expect, test } from 'bun:test';
import {
  OperatorInputError,
  assertStripeKeyMode,
  parseLinkArgs,
  parseReconcileArgs,
  parseRestoreArgs,
  tableForMode,
} from './commerce-operator.mjs';

const ORDER_ID = `ord_${'1'.repeat(32)}`;

describe('commerce operator input', () => {
  test('parses reconciliation without depending on argument order', () => {
    expect(parseReconcileArgs(['--dry-run', '--order', ORDER_ID, '--mode', 'test'])).toEqual({
      mode: 'test', orderId: ORDER_ID, dryRun: true,
    });
  });

  test('rejects malformed, duplicate, missing, and unknown reconciliation arguments', () => {
    for (const args of [
      ['--mode', 'sandbox'],
      ['--mode', 'test', '--order', 'ord_bad'],
      ['--mode', 'test', '--mode', 'live'],
      ['--mode'],
      ['--mode', 'test', '--yes'],
    ]) expect(() => parseReconcileArgs(args)).toThrow(OperatorInputError);
  });

  test('requires an exact restore command and normalizes its audit text', () => {
    expect(parseRestoreArgs([
      ORDER_ID, '--reason', '  dispute won  ', '--actor', ' operator ', '--mode', 'test',
    ])).toEqual({ orderId: ORDER_ID, actor: 'operator', reason: 'dispute won', mode: 'test' });
    for (const args of [
      [ORDER_ID, '--actor', 'operator', '--reason', 'won', '--force'],
      [ORDER_ID, '--actor', 'operator\nother', '--reason', 'won'],
      [ORDER_ID, '--actor', 'operator', '--reason', 'x'.repeat(1_001)],
      [ORDER_ID, '--actor', 'operator'],
      [ORDER_ID, '--actor', 'operator', '--reason', 'won'],
    ]) expect(() => parseRestoreArgs(args)).toThrow(OperatorInputError);
  });

  test('derives mode only from a well-formed Checkout Session ID', () => {
    expect(parseLinkArgs(['cs_test_abc_123'])).toEqual({ sessionId: 'cs_test_abc_123', mode: 'test' });
    expect(parseLinkArgs(['cs_live_abc'])).toEqual({ sessionId: 'cs_live_abc', mode: 'live' });
    expect(() => parseLinkArgs(['cs_test_ok', '--extra'])).toThrow(OperatorInputError);
  });

  test('keeps test commands away from production-shaped tables', () => {
    expect(tableForMode('test', { COMMERCE_TABLE: 'adamficke-com-commerce-dev-123' })).toBe(
      'adamficke-com-commerce-dev-123',
    );
    expect(() => tableForMode('test', {})).toThrow('COMMERCE_TABLE');
    expect(() => tableForMode('test', { COMMERCE_TABLE: 'adamficke-com-commerce-orders' })).toThrow('Refusing');
    expect(tableForMode('live', {})).toBe('adamficke-com-commerce-orders');
  });

  test('requires the configured Stripe key to match command mode', () => {
    expect(assertStripeKeyMode('rk_test_value', 'test')).toBe('rk_test_value');
    expect(assertStripeKeyMode('sk_live_value', 'live')).toBe('sk_live_value');
    expect(() => assertStripeKeyMode('rk_live_value', 'test')).toThrow('not test mode');
    expect(() => assertStripeKeyMode('not_a_key', 'live')).toThrow('not live mode');
  });
});
