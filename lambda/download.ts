import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fulfillmentKey } from '../src/lib/downloads';
import { readToken } from './tokens';

/**
 * Exchanging an entitlement token for the file.
 *
 * The originals bucket stays private and is never fronted by CloudFront. A buyer
 * gets a presigned URL minted on the spot, which is the only way bytes leave
 * that bucket. Because the token is checked on every download, the presigned URL
 * itself can be short-lived: a link that leaks is useful for minutes, while the
 * buyer's own link keeps working for the life of their entitlement.
 */

const PRESIGN_SECONDS = 900;

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

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: originalsBucket,
      Key: fulfillmentKey(entitlement.assetRef),
      /* Save rather than open, under a name that says where it came from. */
      ResponseContentDisposition: `attachment; filename="${downloadFilename(entitlement)}"`,
    }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

export function downloadFilename({ photoId, assetRef }: { photoId: string; assetRef: string }): string {
  const extension = assetRef.match(/\.[a-z0-9]+$/)?.[0] ?? '.jpg';
  return `adam-ficke-${photoId}${extension}`;
}
