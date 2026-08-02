import { describe, expect, test } from 'bun:test';
import { DOWNLOAD_WINDOW_SECONDS, InvalidToken, mintToken, readToken } from './tokens';

const KEY = 'a'.repeat(64);
const NOW = Date.UTC(2026, 6, 29);

function entitlement(overrides: Partial<Parameters<typeof mintToken>[0]> = {}) {
  return {
    version: 1 as const,
    orderId: 'ord_1234567890abcdef1234567890abcdef',
    photoId: 'photo_1234567890abcdef12345678',
    assetRef: `${'ab'.repeat(32)}.jpg`,
    expiresAt: Math.floor(NOW / 1000) + DOWNLOAD_WINDOW_SECONDS,
    ...overrides,
  };
}

describe('download tokens', () => {
  test('round-trips an entitlement', () => {
    const token = mintToken(entitlement(), KEY);
    expect(readToken(token, KEY, NOW)).toEqual(entitlement());
  });

  test('is URL-safe so it survives a query string unescaped', () => {
    const token = mintToken(entitlement(), KEY);
    expect(token).toBe(encodeURIComponent(token));
  });

  test('rejects a token signed with a different key', () => {
    const token = mintToken(entitlement(), KEY);
    expect(() => readToken(token, 'b'.repeat(64), NOW)).toThrow(InvalidToken);
  });

  test('rejects a tampered payload', () => {
    const token = mintToken(entitlement(), KEY);
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(entitlement({ photoId: 'photo_abcdef1234567890abcdef12' })),
    ).toString('base64url');
    expect(() => readToken(`${forged}.${signature}`, KEY, NOW)).toThrow(/signature does not match/);
  });

  test('rejects an unsigned payload', () => {
    const payload = Buffer.from(JSON.stringify(entitlement())).toString('base64url');
    expect(() => readToken(payload, KEY, NOW)).toThrow(/Malformed/);
    expect(() => readToken(`${payload}.`, KEY, NOW)).toThrow(/signature does not match/);
  });

  test('rejects a token past its expiry', () => {
    const token = mintToken(entitlement({ expiresAt: Math.floor(NOW / 1000) - 1 }), KEY);
    expect(() => readToken(token, KEY, NOW)).toThrow(/expired/);
  });

  test('honours the entitlement right up to its expiry', () => {
    const expiresAt = Math.floor(NOW / 1000) + 60;
    const token = mintToken(entitlement({ expiresAt }), KEY);
    expect(readToken(token, KEY, expiresAt * 1000 - 1).photoId).toBe('photo_1234567890abcdef12345678');
    expect(() => readToken(token, KEY, expiresAt * 1000)).toThrow(/expired/);
  });

  test('rejects a signature of the wrong length without throwing on the compare', () => {
    const [payload] = mintToken(entitlement(), KEY).split('.');
    expect(() => readToken(`${payload}.AAAA`, KEY, NOW)).toThrow(InvalidToken);
  });

  test('rejects signed payloads with an unsupported version or malformed asset', () => {
    const unsupported = mintToken(entitlement(), KEY);
    const [payload] = unsupported.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    const invalid = entitlement({ assetRef: '../albums/private.jpg' });
    expect(() => mintToken(invalid, KEY)).not.toThrow();
    expect(() => readToken(mintToken(invalid, KEY), KEY, NOW)).toThrow(/incomplete/);

    const versionPayload = Buffer.from(JSON.stringify({ ...decoded, version: 2 })).toString('base64url');
    // Re-sign through mintToken by treating the object as the compile-time v1
    // shape; readToken remains the runtime authority.
    const versionToken = mintToken({ ...decoded, version: 2 } as Parameters<typeof mintToken>[0], KEY);
    expect(versionPayload).not.toBe(payload);
    expect(() => readToken(versionToken, KEY, NOW)).toThrow(/incomplete/);
  });
});
