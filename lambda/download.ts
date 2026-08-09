import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { masterKey } from '../src/lib/downloads';
import { readToken } from './tokens';

/**
 * Exchanging an entitlement token for the file.
 *
 * The originals bucket stays private and is never fronted by CloudFront. A buyer
 * gets a presigned URL minted on the spot, which is the only way bytes leave
 * that bucket. Because the token is checked on every download, the presigned URL
 * itself can be short-lived: a link that leaks is useful for minutes, while the
 * buyer's own link keeps working for the life of their entitlement.
 *
 * The photo ID alone locates the object, so redemption reads no order state. It
 * always serves the master as it stands now: re-exporting a photograph at a
 * higher resolution reaches every buyer, including ones holding older links.
 */

const PRESIGN_SECONDS = 900;

/** The master is gone, which only a deliberate `photos:delete` can cause. */
export class PhotoUnavailable extends Error {}

export interface DownloadDeps {
  s3: S3Client;
  originalsBucket: string;
  downloadTokenKey: string;
  now?: number;
}

export async function resolveDownload(
  token: string,
  { s3, originalsBucket, downloadTokenKey, now = Date.now() }: DownloadDeps,
): Promise<string> {
  const entitlement = readToken(token, downloadTokenKey, now);
  const key = masterKey(entitlement.photoId);

  // Say so, rather than redirecting the buyer to a presigned URL that 404s.
  try {
    await s3.send(new HeadObjectCommand({ Bucket: originalsBucket, Key: key }));
  } catch (error) {
    if (isMissing(error)) throw new PhotoUnavailable('That photograph is no longer available');
    throw error;
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: originalsBucket, Key: key }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === 'NotFound' || candidate?.$metadata?.httpStatusCode === 404;
}
