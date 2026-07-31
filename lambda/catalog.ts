import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CATALOG_PATH, catalogItem, type CatalogItem, type DownloadCatalog } from '../src/lib/downloads';

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
  if (catalog.version !== 2 || !Array.isArray(catalog.items)) {
    throw new Error(`Download catalog ${CATALOG_PATH} is not a version 2 catalog`);
  }

  cache = { at: now, catalog };
  return catalog;
}

/** Resets the module cache. Tests only. */
export function forgetCatalog(): void {
  cache = undefined;
}

export class NotForSale extends Error {}

/**
 * Resolves an opaque photo ID and requires its current sale flag. The catalog
 * retains delisted photos so paid sessions can still resolve their originals.
 */
export function requireItem(
  catalog: DownloadCatalog,
  photoId: string,
): CatalogItem & { forSale: true; priceCents: number } {
  const item = catalogItem(catalog, photoId);
  if (!item?.forSale || !Number.isInteger(item.priceCents) || item.priceCents! <= 0) {
    throw new NotForSale(`No sale offer for photo ID ${photoId}`);
  }
  return item as CatalogItem & { forSale: true; priceCents: number };
}
