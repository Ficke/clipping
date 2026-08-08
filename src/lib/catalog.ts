import { allPhotosOf, getAlbums, slugOf, type Album, type AlbumPhoto } from './albums';
import {
  DOWNLOAD_PRODUCTS,
  assetRefFor,
  photoIdFor,
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

export function offersFor(
  album: Album,
  photo: AlbumPhoto,
  fallbackLabel: string,
): SellablePhoto[] {
  if (!photo.forSale || photo.priceCents === undefined) return [];
  const priceCents = photo.priceCents;
  return DOWNLOAD_PRODUCTS.map((tier) => ({
    photo,
    tier,
    priceCents,
    photoId: photoIdFor(photo.image.sourceHash),
    fallbackLabel,
  }));
}

/**
 * Counted over `allPhotosOf`, so the storefront and the catalog agree. Indexing
 * the public subset instead would number a photo differently in the button and
 * in the order record.
 */
function positionLabel(album: Album, index: number, total: number): string {
  return `${album.data.title}, photograph ${index + 1} of ${total}`;
}

function labelFor(album: Album, photo: AlbumPhoto, index: number, total: number): string {
  return photo.caption?.trim()
    ?? photo.alt?.trim()
    ?? positionLabel(album, index, total);
}

/** A photo not flagged for sale cannot be bought, whatever ID a request carries. */
export async function buildCatalog(): Promise<DownloadCatalog> {
  const albums = await getAlbums();
  const items: CatalogItem[] = [];

  for (const album of albums) {
    const photos = await allPhotosOf(album);
    for (const [index, photo] of photos.entries()) {
      if (!photo.inCatalog) continue;
      const preview = photo.image.variants.responsive.webp
        .find((variant) => variant.width >= 1080)
        ?? photo.image.variants.lightbox;
      items.push({
        photoId: photoIdFor(photo.image.sourceHash),
        assetRef: assetRefFor(photo.image.sourceHash, photo.file),
        storyId: album.data.storyId,
        file: photo.file,
        forSale: photo.forSale,
        albumTitle: album.data.title,
        label: labelFor(album, photo, index, photos.length),
        previewSrc: preview.src,
        ...(photo.priceCents !== undefined && { priceCents: photo.priceCents }),
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

  return { version: 2, generated: new Date().toISOString(), items };
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
    const all = await allPhotosOf(album);
    const photos = all
      .map((photo, index) => ({
        photo,
        offers: photo.hidden ? [] : offersFor(album, photo, positionLabel(album, index, all.length)),
      }))
      .filter(({ offers }) => offers.length > 0);
    if (photos.length) results.push({ album, slug: slugOf(album), photos });
  }
  return results;
}
