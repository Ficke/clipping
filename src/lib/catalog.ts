import { allPhotosOf, getAlbums, photosOf, slugOf, type Album, type AlbumPhoto } from './albums';
import {
  DOWNLOAD_PRODUCTS,
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
  /** Where the buy link points. Same-origin, so the strict CSP is unaffected. */
  href: string;
}

export function offersFor(album: Album, photo: AlbumPhoto): SellablePhoto[] {
  if (!photo.forSale || photo.priceCents === undefined) return [];
  const priceCents = photo.priceCents;
  return DOWNLOAD_PRODUCTS.map((tier) => {
    const photoId = photoIdFor(photo.image.sourceHash);
    return {
      photo,
      tier,
      priceCents,
      photoId,
      href: `/api/checkout?photo_id=${encodeURIComponent(photoId)}`,
    };
  });
}

function labelFor(album: Album, photo: AlbumPhoto, index: number, total: number): string {
  return photo.caption?.trim()
    ?? photo.alt?.trim()
    ?? `${album.data.title}, photograph ${index + 1} of ${total}`;
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
    const photos = (await photosOf(album))
      .map((photo) => ({ photo, offers: offersFor(album, photo) }))
      .filter(({ offers }) => offers.length > 0);
    if (photos.length) results.push({ album, slug: slugOf(album), photos });
  }
  return results;
}
