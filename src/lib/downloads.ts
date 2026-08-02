/**
 * Kept free of Astro and AWS imports: the site build and the commerce Lambda
 * both bundle this file. Anything needing `astro:content` belongs in
 * `albums.ts`; anything needing a secret belongs in the Lambda.
 */

export const CURRENCY = 'usd';

export interface LicenseTier {
  id: string;
  /** Shown in Checkout as the line-item name, after the photo title. */
  name: string;
  /** Short tag beside the price. The full grant lives in the lists below. */
  summary: string;
  /** The grant itself. The photographs are otherwise all rights reserved — see NOTICE. */
  grants: readonly string[];
  restrictions: readonly string[];
}

export const COPYRIGHT_LINE = 'Copyright stays with Adam Ficke.';

/** Derived, not written twice, so the page and the receipt cannot disagree. */
export function licenseTerms(tier: LicenseTier): string {
  return `You may ${tier.grants.join(', ')}. `
    + `You may not ${tier.restrictions.join(', ')}. `
    + COPYRIGHT_LINE;
}

/**
 * Most permissive last. Adding a tier here puts it on every photo already for
 * sale — the catalog emits one entry per photo per tier.
 */
/** The one Stripe Product currently sold. Add another product here only when
 * the rights—not the photograph—differ. */
export const DOWNLOAD_PRODUCTS: readonly LicenseTier[] = [
  {
    id: 'personal',
    name: 'Full-resolution download, personal license',
    summary: 'Personal license',
    grants: [
      'keep the file and back it up',
      'print it, at any size, for your own home or as a gift',
      'display it on your own screens and personal website',
    ],
    restrictions: [
      'sell, license, or give the file to anyone else',
      'use it to promote or sell anything, your own work included',
      'list it on a stock, print-on-demand, or NFT site',
      'use it to train a machine learning model',
    ],
  },
];

const TIERS_BY_ID = new Map(DOWNLOAD_PRODUCTS.map((tier) => [tier.id, tier]));

export function licenseTier(id: string): LicenseTier | undefined {
  return TIERS_BY_ID.get(id);
}

/** `$40`, or `$39.50` when the cents are not round. */
export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

const SOURCE_HASH = /^[a-f0-9]{64}$/;
const PHOTO_ID = /^photo_[a-f0-9]{24}$/;
const ASSET_REF = /^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|avif)$/;

/** Opaque, stable identity for the exact published image bytes (96 hash bits). */
export function photoIdFor(sourceHash: string): string {
  if (!SOURCE_HASH.test(sourceHash)) throw new Error('Cannot build a photo ID from an invalid source hash');
  return `photo_${sourceHash.slice(0, 24)}`;
}

export function isPhotoId(value: string): boolean {
  return PHOTO_ID.test(value);
}

/** Stable identity for the exact sanitized fulfillment bytes and their format. */
export function assetRefFor(sourceHash: string, file: string): string {
  if (!SOURCE_HASH.test(sourceHash)) throw new Error('Cannot build an asset reference from an invalid source hash');
  const extension = file.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (!extension || !['jpg', 'jpeg', 'png', 'webp', 'avif'].includes(extension)) {
    throw new Error('Cannot build an asset reference from an unsupported file extension');
  }
  return `${sourceHash}.${extension}`;
}

export function isAssetRef(value: string): boolean {
  return ASSET_REF.test(value);
}

export function fulfillmentKey(assetRef: string): string {
  if (!isAssetRef(assetRef)) throw new Error('Cannot build a fulfillment key from an invalid asset reference');
  return `fulfillment/${assetRef}`;
}

/** Mirrors the layout `photos:push` writes; change one and change the other. */
export function originalKey({ storyId, file }: { storyId: string; file: string }): string {
  return `albums/${storyId}/${file}`;
}

/**
 * URL slug for an album. The YYYY-MM- prefix is legacy: ids minted before the
 * folder name stopped being load-bearing carry one, newer ids do not.
 */
export function slugForStoryId(storyId: string): string {
  return storyId.replace(/^\d{4}-\d{2}-/, '');
}

export interface CatalogItem {
  photoId: string;
  /** Additive in catalog v2 during the durable-commerce deployment bridge. */
  assetRef?: string;
  storyId: string;
  file: string;
  forSale: boolean;
  albumTitle: string;
  /** Human label for this photo within the album. */
  label: string;
  /** Public derivative used to confirm visually what the buyer purchased. */
  previewSrc: string;
  priceCents?: number;
  width: number;
  height: number;
}

/**
 * The server-side authority on price, so checkout never trusts the query
 * string. Published with the site rather than bundled into the Lambda, which
 * makes putting an album on sale a content deploy instead of a Lambda deploy.
 */
export interface DownloadCatalog {
  version: 2;
  generated: string;
  items: CatalogItem[];
}

export const CATALOG_PATH = 'downloads-catalog.json';

export function catalogItem(catalog: DownloadCatalog, photoId: string): CatalogItem | undefined {
  return catalog.items.find((item) => item.photoId === photoId);
}
