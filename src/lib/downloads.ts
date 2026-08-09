/**
 * Kept free of Astro and AWS imports: the site build and the commerce Lambda
 * both bundle this file. Anything needing `astro:content` belongs in
 * `albums.ts`; anything needing a secret belongs in the Lambda.
 */

import { isPhotoId } from '../../shared/ids';

export {
  CATALOG_PATH,
  CURRENCY,
  catalogItem,
  formatPrice,
  type CatalogItem,
  type DownloadCatalog,
} from '../../shared/commerce';

export { generatePhotoId, isPhotoId, type PhotoId } from '../../shared/ids';

export interface LicenseTier {
  id: string;
  /** This appears in Checkout after the photo title. */
  name: string;
  /** This short tag appears beside the price; the lists below define the grant. */
  summary: string;
  /** These are the granted uses; all other rights are reserved under NOTICE. */
  grants: readonly string[];
  restrictions: readonly string[];
}

export const COPYRIGHT_LINE = 'Copyright remains with Adam Ficke.';

/** Derive the terms so the page and receipt cannot disagree. */
export function licenseTerms(tier: LicenseTier): string {
  return `You may ${tier.grants.join(', ')}. `
    + `You may not ${tier.restrictions.join(', ')}. `
    + COPYRIGHT_LINE;
}

/**
 * Most permissive last. Adding a tier here puts it on every photo already for
 * sale — the catalog emits one entry per photo per tier.
 */
/**
 * Define one Stripe Product per rights package, not per photograph.
 */
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

export const SUPPORTED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'avif'] as const;

/** Return the stable master key that a re-export overwrites in place. */
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
