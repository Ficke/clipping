import { catalogItem, type CatalogItem, type DownloadCatalog } from '../shared/commerce';

export class NotForSale extends Error {}

export function requireItem(catalog: DownloadCatalog, photoId: string): CatalogItem {
  const item = catalogItem(catalog, photoId);
  if (!item || !Number.isInteger(item.priceCents) || item.priceCents <= 0) {
    throw new NotForSale(`No sale offer for photo ID ${photoId}`);
  }
  return item;
}
