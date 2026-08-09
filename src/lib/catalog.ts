import { getAlbums, photosOf, slugOf, type Album, type AlbumPhoto } from './albums';
import {
  DOWNLOAD_PRODUCTS,
  type CatalogItem,
  type DownloadCatalog,
  type LicenseTier,
} from './downloads';

export interface SellablePhoto {
  photo: AlbumPhoto;
  tier: LicenseTier;
  priceCents: number;
  photoId: string;
  /** Used when a photo carries neither alt text nor a caption. */
  fallbackLabel: string;
}

export function offersFor(photo: AlbumPhoto, fallbackLabel: string): SellablePhoto[] {
  if (photo.priceCents === undefined) return [];
  const priceCents = photo.priceCents;
  return DOWNLOAD_PRODUCTS.map((tier) => ({
    photo,
    tier,
    priceCents,
    photoId: photo.photoId,
    fallbackLabel,
  }));
}

function positionLabel(album: Album, index: number, total: number): string {
  return `${album.data.title}, photograph ${index + 1} of ${total}`;
}

function labelFor(album: Album, photo: AlbumPhoto, index: number, total: number): string {
  return photo.caption?.trim()
    ?? photo.alt?.trim()
    ?? positionLabel(album, index, total);
}

/**
 * Only photographs actually on sale are published, so a request for anything
 * else finds nothing rather than finding an entry it has to be refused.
 */
export async function buildCatalog(): Promise<DownloadCatalog> {
  const albums = await getAlbums();
  const items: CatalogItem[] = [];

  for (const album of albums) {
    const photos = await photosOf(album);
    for (const [index, photo] of photos.entries()) {
      if (photo.priceCents === undefined) continue;
      const preview = photo.image.variants.responsive.webp
        .find((variant) => variant.width >= 1080)
        ?? photo.image.variants.lightbox;
      items.push({
        photoId: photo.photoId,
        storyId: album.data.storyId,
        file: photo.file,
        albumTitle: album.data.title,
        label: labelFor(album, photo, index, photos.length),
        previewSrc: preview.src,
        priceCents: photo.priceCents,
        width: photo.image.width,
        height: photo.image.height,
      });
    }
  }

  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.photoId)) throw new Error(`Duplicate photo ID: ${item.photoId}`);
    seen.add(item.photoId);
  }

  return { version: 3, generated: new Date().toISOString(), items };
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
    const all = await photosOf(album);
    const photos = all
      .map((photo, index) => ({
        photo,
        offers: offersFor(photo, positionLabel(album, index, all.length)),
      }))
      .filter(({ offers }) => offers.length > 0);
    if (photos.length) results.push({ album, slug: slugOf(album), photos });
  }
  return results;
}
