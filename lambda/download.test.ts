import { describe, expect, test } from 'bun:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PhotoUnavailable, resolveDownload } from './download';
import { InvalidToken, mintToken, type Entitlement } from '../commerce/tokens';

const KEY = 'download-token-key';
const BUCKET = 'originals-test';
const PHOTO_ID = 'photo_3bb6020b3147d062d1f528ce';

/**
 * Presigning is local arithmetic, so stub credentials never leave the process.
 * Only the existence check dispatches, and `present` decides what it finds.
 */
function s3(present = true): S3Client {
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAtest', secretAccessKey: 'secret' },
  });
  client.send = (async (command: unknown) => {
    if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
    if (present) return { $metadata: { httpStatusCode: 200 } };
    throw Object.assign(new Error('Not Found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
  }) as S3Client['send'];
  return client;
}

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    version: 1,
    orderId: `ord_${'1'.repeat(32)}`,
    photoId: PHOTO_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function deps(present = true) {
  return { s3: s3(present), originalsBucket: BUCKET, downloadTokenKey: KEY };
}

describe('download resolution', () => {
  test('presigns the master named by the photo ID alone', async () => {
    const url = new URL(await resolveDownload(mintToken(entitlement(), KEY), deps()));

    expect(url.hostname).toStartWith(`${BUCKET}.s3.`);
    expect(url.pathname).toBe(`/photos/${PHOTO_ID}`);
    expect(url.pathname).not.toContain('albums/');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
  });

  /* The attachment name is stored on the object, so the URL must not carry an
     override that would let a token dictate the filename. */
  test('does not override the response content disposition', async () => {
    const url = new URL(await resolveDownload(mintToken(entitlement(), KEY), deps()));

    expect(url.searchParams.get('response-content-disposition')).toBeNull();
  });

  test('reports a deleted photograph instead of presigning a URL that 404s', async () => {
    const token = mintToken(entitlement(), KEY);

    await expect(resolveDownload(token, deps(false))).rejects.toBeInstanceOf(PhotoUnavailable);
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
    swapped.photoId = 'photo_ffffffffffffffffffffffff';
    const tampered = `${Buffer.from(JSON.stringify(swapped)).toString('base64url')}.${signature}`;

    await expect(resolveDownload(tampered, deps())).rejects.toBeInstanceOf(InvalidToken);
  });
});
