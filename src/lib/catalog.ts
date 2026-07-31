import { getAlbums, photosOf, slugOf, type Album, type AlbumPhoto } from './albums';
import {
  LICENSE_TIERS,
  skuFor,
  type CatalogItem,
  type DownloadCatalog,
  type LicenseTier,
} from './downloads';

export interface SellablePhoto {
  photo: AlbumPhoto;
  tier: LicenseTier;
  sku: string;
  /** Where the buy link points. Same-origin, so the strict CSP is unaffected. */
  href: string;
}

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

/** A photo absent here cannot be bought, whatever SKU a request carries. */
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

export interface AlbumDownloads {
  album: Album;
  slug: string;
  /* Grouped, not flattened: a flat list repeats the image once per tier. */
  photos: { photo: AlbumPhoto; offers: SellablePhoto[] }[];
}

/** Albums with at least one photo for sale, newest first. */
export async function albumsWithDownloads(): Promise<AlbumDownloads[]> {
  const albums = await getAlbums();
  const results: AlbumDownloads[] = [];
  for (const album of albums) {
    const photos = (await photosOf(album))
      .map((photo) => ({ photo, offers: offersFor(album, photo) }))
      .filter(({ offers }) => offers.length > 0);
    if (photos.length) results.push({ album, slug: slugOf(album), photos });
  }
  return results;
}
