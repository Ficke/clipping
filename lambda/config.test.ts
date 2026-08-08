import { describe, expect, test } from 'bun:test';
import { parseSecrets, parseWebhookSecrets, readEnv, readWebhookEnv } from './config';

const complete = {
  COMMERCE_SECRET_PARAM: '/adamficke-com/commerce',
  COMMERCE_TABLE: 'adamficke-com-orders',
  ORIGINALS_BUCKET: 'adamficke-com-originals',
  SITE_BUCKET: 'adamficke-com-site',
  SITE_URL: 'https://adamficke.com',
  COMMERCE_ALLOW_LEGACY_GET_CHECKOUT: 'true',
  ORIGIN_VERIFY_HEADER_NAME: 'x-commerce-origin',
  ORIGIN_VERIFY_HEADER_VALUES: 'random-origin-value',
};

describe('environment', () => {
  test('reads the wiring', () => {
    expect(readEnv(complete)).toEqual({
      secretParam: '/adamficke-com/commerce',
      tableName: 'adamficke-com-orders',
      originalsBucket: 'adamficke-com-originals',
      siteBucket: 'adamficke-com-site',
      siteUrl: 'https://adamficke.com',
      allowLegacyGetCheckout: true,
      originHeaderName: 'x-commerce-origin',
      originHeaderValues: ['random-origin-value'],
    });
  });

  test('trims a trailing slash so built URLs never double up', () => {
    expect(readEnv({ ...complete, SITE_URL: 'https://adamficke.com/' }).siteUrl)
      .toBe('https://adamficke.com');
  });

  /* Two values are live across a rotation; an empty one would accept a
     request that sent no header at all. */
  test('accepts every configured origin value and never an empty one', () => {
    expect(readEnv({ ...complete, ORIGIN_VERIFY_HEADER_VALUES: ' current , next ' }).originHeaderValues)
      .toEqual(['current', 'next']);
    expect(readEnv({ ...complete, ORIGIN_VERIFY_HEADER_VALUES: 'current,,' }).originHeaderValues)
      .toEqual(['current']);
    expect(() => readEnv({ ...complete, ORIGIN_VERIFY_HEADER_VALUES: ',' }))
      .toThrow(/ORIGIN_VERIFY_HEADER_VALUES/);
  });

  test('requires an explicit legacy GET compatibility setting', () => {
    expect(readEnv({ ...complete, COMMERCE_ALLOW_LEGACY_GET_CHECKOUT: 'false' }).allowLegacyGetCheckout)
      .toBe(false);
    expect(() => readEnv({ ...complete, COMMERCE_ALLOW_LEGACY_GET_CHECKOUT: 'yes' }))
      .toThrow(/COMMERCE_ALLOW_LEGACY_GET_CHECKOUT/);
  });

  test('fails at cold start, by name, when wiring is missing', () => {
    for (const key of Object.keys(complete)) {
      const rest: Record<string, string> = { ...complete };
      delete rest[key];
      expect(() => readEnv(rest)).toThrow(new RegExp(key));
    }
  });

  test('reads the webhook-specific wiring without buyer bucket access', () => {
    expect(readWebhookEnv({
      COMMERCE_WEBHOOK_SECRET_PARAM: '/adamficke-com/commerce-webhook',
      COMMERCE_TABLE: 'adamficke-com-orders',
      ORIGIN_VERIFY_HEADER_NAME: 'x-commerce-origin',
      ORIGIN_VERIFY_HEADER_VALUES: 'random-origin-value',
    })).toEqual({
      secretParam: '/adamficke-com/commerce-webhook',
      tableName: 'adamficke-com-orders',
      originHeaderName: 'x-commerce-origin',
      originHeaderValues: ['random-origin-value'],
    });
  });
});

describe('secrets', () => {
  const payload = JSON.stringify({
    stripeApiKey: 'rk_test_abc',
    stripeProductId: 'prod_download',
    downloadTokenKey: 'd'.repeat(64),
  });

  test('parses the fields it needs', () => {
    expect(parseSecrets(payload)).toEqual({
      stripeApiKey: 'rk_test_abc',
      stripeProductId: 'prod_download',
      downloadTokenKey: 'd'.repeat(64),
    });
  });

  test('ignores extra fields so the secret can carry future keys', () => {
    const extended = JSON.stringify({ ...JSON.parse(payload), prodigiApiKey: 'x' });
    expect(parseSecrets(extended)).not.toHaveProperty('prodigiApiKey');
  });

  test('names what is missing without quoting any value', () => {
    const partial = JSON.stringify({ stripeApiKey: 'rk_test_abc' });
    expect(() => parseSecrets(partial)).toThrow(/downloadTokenKey/);
    expect(() => parseSecrets(partial)).not.toThrow(/rk_test_abc/);
  });

  test('rejects an empty string as firmly as a missing field', () => {
    const blank = JSON.stringify({ ...JSON.parse(payload), downloadTokenKey: '' });
    expect(() => parseSecrets(blank)).toThrow(/downloadTokenKey/);
  });

  test('rejects a malformed Stripe Product ID before checkout', () => {
    const malformed = JSON.stringify({ ...JSON.parse(payload), stripeProductId: 'price_not-a-product' });
    expect(() => parseSecrets(malformed)).toThrow(/stripeProductId/);
  });

  test('rejects a secret that is not a JSON object', () => {
    expect(() => parseSecrets('rk_test_abc')).toThrow(/not valid JSON/);
    expect(() => parseSecrets('"rk_test_abc"')).toThrow(/not a JSON object/);
    expect(() => parseSecrets('null')).toThrow(/not a JSON object/);
  });

  test('parses webhook secrets with an optional overlap secret', () => {
    expect(parseWebhookSecrets(JSON.stringify({
      stripeReadApiKey: 'rk_test_read',
      stripeWebhookSecret: 'whsec_current',
      stripeWebhookSecretPrevious: 'whsec_previous',
    }))).toEqual({
      stripeReadApiKey: 'rk_test_read',
      stripeWebhookSecret: 'whsec_current',
      stripeWebhookSecretPrevious: 'whsec_previous',
    });
  });

  test('rejects a blank webhook overlap secret', () => {
    expect(() => parseWebhookSecrets(JSON.stringify({
      stripeReadApiKey: 'rk_test_read',
      stripeWebhookSecret: 'whsec_current',
      stripeWebhookSecretPrevious: '',
    }))).toThrow(/stripeWebhookSecretPrevious/);
  });
});
