import { describe, expect, test } from 'bun:test';
import { parseSecrets, readEnv } from './config';

const complete = {
  COMMERCE_SECRET_ID: 'adamficke-com-commerce',
  ORIGINALS_BUCKET: 'adamficke-com-originals',
  SITE_BUCKET: 'adamficke-com-site',
  SITE_URL: 'https://adamficke.com',
  EDGE_SECRET: 'e'.repeat(48),
};

describe('environment', () => {
  test('reads the wiring', () => {
    expect(readEnv(complete)).toEqual({
      secretId: 'adamficke-com-commerce',
      originalsBucket: 'adamficke-com-originals',
      siteBucket: 'adamficke-com-site',
      siteUrl: 'https://adamficke.com',
      fromEmail: undefined,
      edgeSecret: 'e'.repeat(48),
    });
  });

  test('trims a trailing slash so built URLs never double up', () => {
    expect(readEnv({ ...complete, SITE_URL: 'https://adamficke.com/' }).siteUrl)
      .toBe('https://adamficke.com');
  });

  test('treats an empty FROM_EMAIL as unset rather than as an address', () => {
    expect(readEnv({ ...complete, FROM_EMAIL: '' }).fromEmail).toBeUndefined();
    expect(readEnv({ ...complete, FROM_EMAIL: 'prints@adamficke.com' }).fromEmail)
      .toBe('prints@adamficke.com');
  });

  test('fails at cold start, by name, when wiring is missing', () => {
    for (const key of Object.keys(complete)) {
      const rest: Record<string, string> = { ...complete };
      delete rest[key];
      expect(() => readEnv(rest)).toThrow(new RegExp(key));
    }
  });
});

describe('secrets', () => {
  const payload = JSON.stringify({
    stripeApiKey: 'rk_test_abc',
    stripeWebhookSecret: 'whsec_abc',
    downloadTokenKey: 'd'.repeat(64),
  });

  test('parses the three fields it needs', () => {
    expect(parseSecrets(payload)).toEqual({
      stripeApiKey: 'rk_test_abc',
      stripeWebhookSecret: 'whsec_abc',
      downloadTokenKey: 'd'.repeat(64),
    });
  });

  test('ignores extra fields so the secret can carry future keys', () => {
    const extended = JSON.stringify({ ...JSON.parse(payload), prodigiApiKey: 'x' });
    expect(parseSecrets(extended)).not.toHaveProperty('prodigiApiKey');
  });

  test('names what is missing without quoting any value', () => {
    const partial = JSON.stringify({ stripeApiKey: 'rk_test_abc' });
    expect(() => parseSecrets(partial)).toThrow(/stripeWebhookSecret, downloadTokenKey/);
    expect(() => parseSecrets(partial)).not.toThrow(/rk_test_abc/);
  });

  test('rejects an empty string as firmly as a missing field', () => {
    const blank = JSON.stringify({ ...JSON.parse(payload), stripeWebhookSecret: '' });
    expect(() => parseSecrets(blank)).toThrow(/stripeWebhookSecret/);
  });

  test('rejects a secret that is not a JSON object', () => {
    expect(() => parseSecrets('rk_test_abc')).toThrow(/not valid JSON/);
    expect(() => parseSecrets('"rk_test_abc"')).toThrow(/not a JSON object/);
    expect(() => parseSecrets('null')).toThrow(/not a JSON object/);
  });
});
