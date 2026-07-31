import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { catalogItem, originalKey, type DownloadCatalog } from '../src/lib/downloads';
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
  catalog: DownloadCatalog;
  now?: number;
}

export async function resolveDownload(
  token: string,
  { s3, originalsBucket, downloadTokenKey, catalog, now = Date.now() }: DownloadDeps,
): Promise<string> {
  const entitlement = readToken(token, downloadTokenKey, now);
  const item = catalogItem(catalog, entitlement.photoId);
  if (!item) throw new Error(`Photo ID ${entitlement.photoId} is absent from the fulfillment catalog`);

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: originalsBucket,
      Key: originalKey(item),
      /* Save rather than open, under a name that says where it came from. */
      ResponseContentDisposition: `attachment; filename="${downloadFilename(item)}"`,
    }),
    { expiresIn: PRESIGN_SECONDS },
  );
}

export function downloadFilename({ photoId, file }: { photoId: string; file: string }): string {
  const extension = file.match(/\.[A-Za-z0-9]+$/)?.[0].toLowerCase() ?? '.jpg';
  return `adam-ficke-${photoId}${extension}`;
}
