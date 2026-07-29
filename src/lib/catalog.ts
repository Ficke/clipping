import { getAlbums, photosOf, slugOf, type Album, type AlbumPhoto } from './albums';
import {
  LICENSE_TIERS,
  skuFor,
  type CatalogItem,
  type DownloadCatalog,
  type LicenseTier,
} from './downloads';

/**
 * Joins album content to the licence tiers, producing one item per sellable
 * photo per tier. Used twice in the build: to render buy links on album pages,
 * and to publish `/downloads-catalog.json` for the commerce Lambda.
 */

export interface SellablePhoto {
  photo: AlbumPhoto;
  tier: LicenseTier;
  sku: string;
  /** Where the buy link points. Same-origin, so the strict CSP is unaffected. */
  href: string;
}

/**
 * The offers for one photo, empty when it is not for sale. `index` is the
 * photo's position in the album, used only to label the line item when a photo
 * has no caption to borrow.
 */
export function offersFor(album: Album, photo: AlbumPhoto): SellablePhoto[] {
  if (!photo.forSale) return [];
  return LICENSE_TIERS.map((tier) => {
    const sku = skuFor({ storyId: album.data.storyId, file: photo.file, license: tier.id });
    return {
      photo,
      tier,
      sku,
      href: `/api/checkout?sku=${encodeURIComponent(sku)}`,
    };
  });
}

function labelFor(album: Album, photo: AlbumPhoto, index: number, total: number): string {
  return photo.caption?.trim()
    ?? photo.alt?.trim()
    ?? `${album.data.title}, photograph ${index + 1} of ${total}`;
}

/**
 * Every offer on the site. The Lambda treats this as the authority on price
 * and on what is purchasable, so a photo missing here cannot be bought no
 * matter what SKU a request carries.
 */
export async function buildCatalog(): Promise<DownloadCatalog> {
  const albums = await getAlbums();
  const items: CatalogItem[] = [];

  for (const album of albums) {
    const photos = await photosOf(album);
    for (const [index, photo] of photos.entries()) {
      for (const offer of offersFor(album, photo)) {
        items.push({
          sku: offer.sku,
          storyId: album.data.storyId,
          file: photo.file,
          license: offer.tier.id,
          albumTitle: album.data.title,
          label: labelFor(album, photo, index, photos.length),
          priceCents: offer.tier.priceCents,
          width: photo.image.width,
          height: photo.image.height,
        });
      }
    }
  }

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sku)) throw new Error(`Duplicate download SKU: ${item.sku}`);
    seen.add(item.sku);
  }

  return { version: 1, generated: new Date().toISOString(), items };
}

/** Albums that have at least one photo for sale, newest first. */
export async function albumsWithDownloads(): Promise<{ album: Album; slug: string; offers: SellablePhoto[] }[]> {
  const albums = await getAlbums();
  const results = [];
  for (const album of albums) {
    const photos = await photosOf(album);
    const offers = photos.flatMap((photo) => offersFor(album, photo));
    if (offers.length) results.push({ album, slug: slugOf(album), offers });
  }
  return results;
}
