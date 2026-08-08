import { describe, expect, test } from 'bun:test';
import { S3Client } from '@aws-sdk/client-s3';
import { downloadFilename, resolveDownload } from './download';
import { InvalidToken, mintToken, type Entitlement } from './tokens';

const KEY = 'download-token-key';
const BUCKET = 'originals-test';
const ASSET_REF = `${'ab'.repeat(32)}.jpg`;

/* Presigning is local arithmetic, so stub credentials never leave the process. */
function s3(): S3Client {
  return new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAtest', secretAccessKey: 'secret' },
  });
}

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    version: 1,
    orderId: `ord_${'1'.repeat(32)}`,
    photoId: 'photo_3bb6020b3147d062d1f528ce',
    assetRef: ASSET_REF,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function deps() {
  return { s3: s3(), originalsBucket: BUCKET, downloadTokenKey: KEY };
}

describe('download attachment name', () => {
  test('uses only the opaque photo ID and preserves the file type', () => {
    const name = downloadFilename({
      photoId: 'photo_3bb6020b3147d062d1f528ce',
      assetRef: `${'ab'.repeat(32)}.jpg`,
    });

    expect(name).toBe('adam-ficke-photo_3bb6020b3147d062d1f528ce.jpg');
    expect(name).not.toContain('Olympics');
    expect(name).not.toContain('DSCF7640');
  });
});

describe('download resolution', () => {
  test('presigns the immutable fulfillment object, never the album original', async () => {
    const url = new URL(await resolveDownload(mintToken(entitlement(), KEY), deps()));

    expect(url.hostname).toStartWith(`${BUCKET}.s3.`);
    expect(url.pathname).toBe(`/fulfillment/${ASSET_REF}`);
    expect(url.pathname).not.toContain('albums/');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('response-content-disposition'))
      .toBe('attachment; filename="adam-ficke-photo_3bb6020b3147d062d1f528ce.jpg"');
  });

  test('refuses a token signed with a different key', async () => {
    const forged = mintToken(entitlement(), 'not-the-download-token-key');

    await expect(resolveDownload(forged, deps())).rejects.toBeInstanceOf(InvalidToken);
  });

  test('refuses an expired entitlement even though its signature is valid', async () => {
    const expired = mintToken(
      entitlement({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
      KEY,
    );

    await expect(resolveDownload(expired, deps())).rejects.toBeInstanceOf(InvalidToken);
  });

  /* A tampered payload must never reach the presigner, whatever it claims. */
  test('refuses a payload edited under a valid signature', async () => {
    const token = mintToken(entitlement(), KEY);
    const [payload, signature] = token.split('.');
    const swapped = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    swapped.assetRef = `${'cd'.repeat(32)}.jpg`;
    const tampered = `${Buffer.from(JSON.stringify(swapped)).toString('base64url')}.${signature}`;

    await expect(resolveDownload(tampered, deps())).rejects.toBeInstanceOf(InvalidToken);
  });
});
