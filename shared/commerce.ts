/** Runtime-neutral catalog and money contracts shared by the site and commerce. */

export const CURRENCY = 'usd';

export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export interface CatalogItem {
  photoId: string;
  storyId: string;
  file: string;
  albumTitle: string;
  label: string;
  previewSrc: string;
  priceCents: number;
  width: number;
  height: number;
}

export interface DownloadCatalog {
  version: 3;
  generated: string;
  items: CatalogItem[];
}

export const CATALOG_PATH = 'downloads-catalog.json';

export function catalogItem(catalog: DownloadCatalog, photoId: string): CatalogItem | undefined {
  return catalog.items.find((item) => item.photoId === photoId);
}
