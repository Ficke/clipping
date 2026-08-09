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

export const COPYRIGHT_LINE = 'Copyright remains with Adam Ficke.';

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
    name: 'Full-resolution download with personal-use license',
    summary: 'Personal-use license',
    grants: [
      'keep the downloaded file and make backup copies',
      'make prints at any size for your own home or to give as gifts',
      'display the photograph on your own screens and personal, non-commercial website',
    ],
    restrictions: [
      'sell, sublicense, share, or otherwise distribute the digital file',
      'use the photograph in advertising, marketing, merchandise, or other commercial or promotional work, including promotion of your own work',
      'upload the photograph to a stock, print-on-demand, NFT, or similar marketplace',
      'use the photograph to train a machine-learning or artificial-intelligence model',
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

const PHOTO_ID = /^photo_[a-f0-9]{24}$/;
const PHOTO_ID_BYTES = 12;

export const SUPPORTED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const;

/**
 * Opaque, permanent identity for one photograph, minted once and written to
 * album frontmatter. Deliberately *not* derived from the bytes: re-exporting a
 * photograph at a higher resolution has to keep every issued download link
 * pointed at the same photograph.
 */
export function generatePhotoId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(PHOTO_ID_BYTES));
  return `photo_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function isPhotoId(value: string): boolean {
  return PHOTO_ID.test(value);
}

/** The one full-resolution master. Overwritten in place when a photo is re-exported. */
export function masterKey(photoId: string): string {
  if (!isPhotoId(photoId)) throw new Error('Cannot build a master key from an invalid photo ID');
  return `photos/${photoId}`;
}

/**
 * Full capture metadata, including GPS. A separate prefix from the masters so
 * the buyer Lambda's `photos/*` grant cannot reach it.
 */
export function metadataKey(photoId: string): string {
  if (!isPhotoId(photoId)) throw new Error('Cannot build a metadata key from an invalid photo ID');
  return `metadata/${photoId}.json`;
}

export function normalizeExtension(file: string): string {
  const extension = file.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (!extension || !(SUPPORTED_FORMATS as readonly string[]).includes(extension)) {
    throw new Error('Unsupported file extension');
  }
  return extension;
}

export function contentTypeFor(extension: string): string {
  return extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension}`;
}

/**
 * Stored as `Content-Disposition` on the master at upload time, because the key
 * carries no extension for the download Lambda to derive one from.
 */
export function downloadFilename(photoId: string, extension: string): string {
  return `adam-ficke-${photoId}.${extension}`;
}

/**
 * URL slug for an album. The YYYY-MM- prefix is legacy: ids minted before the
 * folder name stopped being load-bearing carry one, newer ids do not.
 */
export function slugForStoryId(storyId: string): string {
  return storyId.replace(/^\d{4}-\d{2}-/, '');
}

/** Only photographs actually on sale are published, so presence is the offer. */
export interface CatalogItem {
  photoId: string;
  storyId: string;
  file: string;
  albumTitle: string;
  /** Human label for this photo within the album. */
  label: string;
  /** Public derivative used to confirm visually what the buyer purchased. */
  previewSrc: string;
  priceCents: number;
  width: number;
  height: number;
}

/**
 * The server-side authority on price, so checkout never trusts the query
 * string. Published with the site rather than bundled into the Lambda, which
 * makes putting an album on sale a content deploy instead of a Lambda deploy.
 */
export interface DownloadCatalog {
  version: 3;
  generated: string;
  items: CatalogItem[];
}

export const CATALOG_PATH = 'downloads-catalog.json';

export function catalogItem(catalog: DownloadCatalog, photoId: string): CatalogItem | undefined {
  return catalog.items.find((item) => item.photoId === photoId);
}
