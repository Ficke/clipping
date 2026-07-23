import { getCollection, type CollectionEntry } from 'astro:content';
import type { PhotoManifest, PhotoManifestEntry } from './photo-manifest';

export type Album = CollectionEntry<'albums'>;

const manifests = import.meta.glob<PhotoManifest>(
  '/content/albums/*/photos.json',
  { eager: true, import: 'default' }
);

export interface AlbumPhoto {
  file: string;
  image: PhotoManifestEntry;
  caption: string | undefined;
  alt: string | undefined;
  exif: string | undefined;
}

const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** URL slug: album folder name without the YYYY-MM- ordering prefix. */
export function slugOf(album: Album): string {
  return album.id.replace(/^\d{4}-\d{2}-/, '');
}

/** All non-draft albums, newest first. */
export async function getAlbums(): Promise<Album[]> {
  const albums = await getCollection('albums', ({ data }) => !data.draft);
  const storyIds = new Set<string>();
  for (const album of albums) {
    if (storyIds.has(album.data.storyId)) {
      throw new Error(`Duplicate storyId: ${album.data.storyId}`);
    }
    storyIds.add(album.data.storyId);
  }
  return albums.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

function imagesIn(album: Album): [string, PhotoManifestEntry][] {
  const manifest = manifests[`/content/albums/${album.id}/photos.json`];
  if (!manifest) throw new Error(`Album ${album.id}: photos.json is missing`);
  if (manifest.album !== album.id) {
    throw new Error(`Album ${album.id}: photos.json belongs to ${manifest.album}`);
  }

  const images = manifest.photos
    .map((photo) => [photo.file, photo] as [string, PhotoManifestEntry])
    .sort(([a], [b]) => filenameCollator.compare(a, b) || a.localeCompare(b));
  const duplicateManifestFiles = images
    .map(([file]) => file)
    .filter((file, index, files) => files.indexOf(file) !== index);
  if (duplicateManifestFiles.length) {
    throw new Error(`Album ${album.id}: photos.json has duplicate files: ${[...new Set(duplicateManifestFiles)].join(', ')}`);
  }

  if (!album.data.order) return images;

  const files = new Set(images.map(([file]) => file));
  const ordered = new Set(album.data.order);
  const duplicates = album.data.order.filter((file, index) => album.data.order!.indexOf(file) !== index);
  const unknown = album.data.order.filter((file) => !files.has(file));
  const missing = images.map(([file]) => file).filter((file) => !ordered.has(file));

  if (duplicates.length || unknown.length || missing.length) {
    const problems = [
      duplicates.length && `duplicates: ${[...new Set(duplicates)].join(', ')}`,
      unknown.length && `unknown: ${unknown.join(', ')}`,
      missing.length && `missing: ${missing.join(', ')}`,
    ].filter(Boolean);
    throw new Error(`Album ${album.id}: invalid order (${problems.join('; ')})`);
  }

  const byFile = new Map(images);
  return album.data.order.map((file) => [file, byFile.get(file)!] as [string, PhotoManifestEntry]);
}

export function coverOf(album: Album): PhotoManifestEntry {
  const hit = imagesIn(album).find(([file]) => file === album.data.cover);
  if (!hit) {
    throw new Error(`Album ${album.id}: cover "${album.data.cover}" matches no image in the folder`);
  }
  return hit[1];
}

/** Photos in natural filename order, or explicit frontmatter order when set. */
export async function photosOf(album: Album): Promise<AlbumPhoto[]> {
  return imagesIn(album).map(([file, image]) => ({
    file,
    image,
    caption: album.data.captions[file],
    alt: album.data.alt[file],
    exif: image.exif,
  }));
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
