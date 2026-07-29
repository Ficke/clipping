/**
 * The catalog of things that can be bought, and the rules for pricing and
 * identifying them.
 *
 * This module is deliberately free of Astro and AWS imports: the static build
 * uses it to render buy links and to emit `/downloads-catalog.json`, and the
 * commerce Lambda bundles the same file so both sides agree on what a SKU
 * means and what it costs. Anything that needs `astro:content` belongs in
 * `albums.ts`; anything that needs a secret belongs in the Lambda.
 */

/** Every price on the site. Stripe wants integer minor units, so do we. */
export const CURRENCY = 'usd';

/**
 * Stripe product tax code, which decides state-level taxability of the sale.
 *
 * `txcd_10501000` is "Digital Photographs/Images - downloaded - non
 * subscription - with permanent rights", which matches a one-time purchase of
 * a file the buyer keeps. The nearby candidate is `txcd_10505001` ("Digital
 * Finished Artwork"), which covers art supplied for reproduction — a better
 * fit if a licence ever grants commercial reproduction rights.
 *
 * Confirm the choice with a tax advisor before going live: it changes what is
 * collected in states that tax digital goods differently from artwork.
 */
export const PRODUCT_TAX_CODE = 'txcd_10501000';

export interface LicenseTier {
  id: string;
  /** Shown in Checkout as the line-item name, after the photo title. */
  name: string;
  /** One line on the buy button and the album page. */
  summary: string;
  /**
   * The grant itself, shown at checkout and repeated in the delivery email.
   * The photographs are otherwise all rights reserved (see NOTICE), so this
   * text is the entire licence the buyer receives.
   */
  terms: string;
  priceCents: number;
}

/**
 * Licence tiers, most permissive last. Adding a tier is additive: the catalog
 * emits one entry per sellable photo per tier, so a new tier appears on every
 * photo already for sale without touching album frontmatter.
 */
export const LICENSE_TIERS: readonly LicenseTier[] = [
  {
    id: 'personal',
    name: 'Full-resolution download, personal licence',
    summary: 'Full-resolution file for personal use',
    terms:
      'You may keep, print, and display this photograph for your own personal, '
      + 'non-commercial use. The licence is non-transferable and does not permit '
      + 'resale, redistribution, sublicensing, stock listing, or use in any '
      + 'commercial, promotional, or AI training context. Copyright remains with '
      + 'Adam Ficke.',
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

/**
 * Where the full-quality file lives. Mirrors the layout `photos:push` writes,
 * and the reason the originals bucket stays private: this key is only ever
 * presigned for a paying buyer, never served.
 */
export function originalKey({ storyId, file }: Pick<SkuParts, 'storyId' | 'file'>): string {
  return `albums/${storyId}/${file}`;
}

/**
 * URL slug for an album. The YYYY-MM- prefix is legacy: ids minted before the
 * folder name stopped being load-bearing carry one, newer ids do not.
 *
 * It lives here rather than in `albums.ts` because the Lambda needs it too, to
 * send a cancelled checkout back to the album it came from.
 */
export function slugForStoryId(storyId: string): string {
  return storyId.replace(/^\d{4}-\d{2}-/, '');
}

export interface CatalogItem {
  sku: string;
  storyId: string;
  file: string;
  license: string;
  /** Album title, for the Checkout line item and the delivery email. */
  albumTitle: string;
  /** Human label for this photo within the album. */
  label: string;
  priceCents: number;
  width: number;
  height: number;
}

/**
 * Published by the site build to `/downloads-catalog.json` and read by the
 * Lambda from the site bucket. It is the server-side authority on what is for
 * sale and at what price, so the checkout endpoint never trusts a price from
 * the query string.
 *
 * Publishing it with the site rather than bundling it into the Lambda is what
 * keeps content and code decoupled: putting a new album on sale is a content
 * deploy, not a Lambda deploy.
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
