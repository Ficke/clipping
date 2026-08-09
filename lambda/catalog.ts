import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CATALOG_PATH, type DownloadCatalog } from '../shared/commerce';
export { NotForSale, requireItem } from '../commerce/catalog';

/**
 * Reads the catalog the site build publishes. This is the server-side authority
 * on price and on what is purchasable — the checkout endpoint never trusts an
 * amount from the request — and it is read from S3 rather than bundled so that
 * putting an album on sale is a content deploy, not a Lambda deploy.
 */

/**
 * Long enough that a burst of checkouts costs one GetObject, short enough that a
 * price change goes live within a minute of the site deploy that carried it.
 */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; catalog: DownloadCatalog } | undefined;

export async function loadCatalog(
  bucket: string,
  client: S3Client,
  now = Date.now(),
): Promise<DownloadCatalog> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.catalog;

  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: CATALOG_PATH }));
  const body = await response.Body?.transformToString();
  if (!body) throw new Error(`Download catalog ${CATALOG_PATH} is empty`);

  const catalog = JSON.parse(body) as DownloadCatalog;
  if (catalog.version !== 3 || !Array.isArray(catalog.items)) {
    throw new Error(`Download catalog ${CATALOG_PATH} is not a version 3 catalog`);
  }

  cache = { at: now, catalog };
  return catalog;
}

/** Reset the module cache between tests. */
export function forgetCatalog(): void {
  cache = undefined;
}
