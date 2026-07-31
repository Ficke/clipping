/**
 * Kept free of Astro and AWS imports: the site build and the commerce Lambda
 * both bundle this file. Anything needing `astro:content` belongs in
 * `albums.ts`; anything needing a secret belongs in the Lambda.
 */

export const CURRENCY = 'usd';

/**
 * Stripe product tax code, which decides state-level taxability of the sale.
 *
 * `txcd_10501000` is "Digital Photographs/Images - downloaded - non
 * subscription - with permanent rights", which matches a one-time purchase of
 * a file the buyer keeps. The nearby candidate is `txcd_10505001` ("Digital
 * Finished Artwork"), which covers art supplied for reproduction — a better
 * fit if a license ever grants commercial reproduction rights.
 *
 * Confirm the choice with a tax advisor before going live: it changes what is
 * collected in states that tax digital goods differently from artwork.
 */
export const PRODUCT_TAX_CODE = 'txcd_10501000';

export interface LicenseTier {
  id: string;
  /** Shown in Checkout as the line-item name, after the photo title. */
  name: string;
  /** Short tag beside the price. The full grant lives in the lists below. */
  summary: string;
  /** The grant itself. The photographs are otherwise all rights reserved — see NOTICE. */
  grants: readonly string[];
  restrictions: readonly string[];
  priceCents: number;
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
export const LICENSE_TIERS: readonly LicenseTier[] = [
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
    priceCents: 4000,
  },
];

const TIERS_BY_ID = new Map(LICENSE_TIERS.map((tier) => [tier.id, tier]));

export function licenseTier(id: string): LicenseTier | undefined {
  return TIERS_BY_ID.get(id);
}

/** `$40`, or `$39.50` when the cents are not round. */
export function formatPrice(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0 ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export interface SkuParts {
  storyId: string;
  file: string;
  license: string;
}

/**
 * Neither segment may contain a slash, so a SKU round-trips through a URL
 * query parameter and through a Stripe metadata value without escaping. Album
 * storyIds are slugs and `file` is a bare filename, so this holds today; the
 * guard is here so it keeps holding.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._'-]*$/;

/**
 * The identity of a purchasable item. Written into Stripe metadata at checkout
 * and read back at fulfillment, so treat it as permanent: changing the format
 * orphans the entitlement of anything sold under the old one.
 */
export function skuFor({ storyId, file, license }: SkuParts): string {
  for (const [name, value] of Object.entries({ storyId, file, license })) {
    if (!SEGMENT.test(value)) {
      throw new Error(`Cannot build a SKU: ${name} "${value}" is not a single safe path segment`);
    }
  }
  return `${storyId}/${file}/${license}`;
}

export function parseSku(sku: string): SkuParts {
  const segments = sku.split('/');
  if (segments.length !== 3) {
    throw new Error(`Malformed SKU "${sku}": expected storyId/file/license`);
  }
  const [storyId, file, license] = segments as [string, string, string];
  for (const [name, value] of Object.entries({ storyId, file, license })) {
    if (!SEGMENT.test(value)) {
      throw new Error(`Malformed SKU "${sku}": ${name} is not a safe path segment`);
    }
  }
  return { storyId, file, license };
}

/** Mirrors the layout `photos:push` writes; change one and change the other. */
export function originalKey({ storyId, file }: Pick<SkuParts, 'storyId' | 'file'>): string {
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
  sku: string;
  storyId: string;
  file: string;
  license: string;
  albumTitle: string;
  /** Human label for this photo within the album. */
  label: string;
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
  version: 1;
  generated: string;
  items: CatalogItem[];
}

export const CATALOG_PATH = 'downloads-catalog.json';

export function catalogItem(catalog: DownloadCatalog, sku: string): CatalogItem | undefined {
  return catalog.items.find((item) => item.sku === sku);
}
