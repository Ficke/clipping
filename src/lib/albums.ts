import { getCollection, type CollectionEntry } from 'astro:content';
import type { PhotoManifest, PhotoManifestEntry } from './photo-manifest';

export type Album = CollectionEntry<'albums'>;

const manifests = import.meta.glob<PhotoManifest>(
  '/content/albums/*/photos.json',
  { eager: true, import: 'default' }
);

/**
 * Manifests are keyed by the storyId they declare rather than by folder,
 * because Astro slugifies folder names into `album.id` and the folder is not
 * part of an album's identity.
 */
const manifestsByStoryId = new Map<string, PhotoManifest>();
for (const [file, manifest] of Object.entries(manifests)) {
  const existing = manifestsByStoryId.get(manifest.album);
  if (existing) throw new Error(`Two manifests claim storyId ${manifest.album}: ${file}`);
  manifestsByStoryId.set(manifest.album, manifest);
}

export interface AlbumPhoto {
  file: string;
  image: PhotoManifestEntry;
  caption: string | undefined;
  alt: string | undefined;
  exif: string | undefined;
}

/**
 * URL slug, derived from storyId rather than the folder so albums can be
 * reorganised on disk. The YYYY-MM- prefix is legacy: ids minted before the
 * folder stopped being load-bearing carry one, newer ids do not.
 */
export function slugOf(album: Album): string {
  return album.data.storyId.replace(/^\d{4}-\d{2}-/, '');
}

/**
 * When the album went up, as opposed to when it was shot. Ordering and the
 * feed key off this so a trip written up two years later still surfaces as
 * new; the page itself keeps showing `date`. Albums predating the field are
 * ordered by their trip date, which is where they already sat.
 */
export function publishedAt(album: Album): Date {
  return album.data.published ?? album.data.date;
}

/** All non-draft albums, most recently published first. */
export async function getAlbums(): Promise<Album[]> {
  const albums = await getCollection('albums', ({ data }) => !data.draft);
  const storyIds = new Set<string>();
  for (const album of albums) {
    if (storyIds.has(album.data.storyId)) {
      throw new Error(`Duplicate storyId: ${album.data.storyId}`);
    }
    storyIds.add(album.data.storyId);
  }
  return albums.sort((a, b) => publishedAt(b).valueOf() - publishedAt(a).valueOf());
}

/**
 * Frontmatter `photos` joined to the generated manifest. The frontmatter array
 * is authoritative for order; the manifest is authoritative for what exists.
 */
function imagesIn(album: Album): AlbumPhoto[] {
  const manifest = manifestsByStoryId.get(album.data.storyId);
  if (!manifest) {
    throw new Error(`Album ${album.id}: no photos.json declares storyId "${album.data.storyId}". Rerun photos:push.`);
  }

  const manifestFiles = manifest.photos.map((photo) => photo.file);
  const duplicateManifestFiles = manifestFiles
    .filter((file, index) => manifestFiles.indexOf(file) !== index);
  if (duplicateManifestFiles.length) {
    throw new Error(`Album ${album.id}: photos.json has duplicate files: ${[...new Set(duplicateManifestFiles)].join(', ')}`);
  }

  const byFile = new Map(manifest.photos.map((photo) => [photo.file, photo]));
  const listed = album.data.photos.map((photo) => photo.file);
  const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index);
  const unknown = listed.filter((file) => !byFile.has(file));
  const missing = manifestFiles.filter((file) => !listed.includes(file));

  if (duplicates.length || unknown.length || missing.length) {
    const problems = [
      duplicates.length && `duplicates: ${[...new Set(duplicates)].join(', ')}`,
      unknown.length && `not in photos.json: ${unknown.join(', ')}`,
      missing.length && `absent from photos: ${missing.join(', ')}`,
    ].filter(Boolean);
    throw new Error(`Album ${album.id}: photos does not match photos.json (${problems.join('; ')}). Rerun photos:push.`);
  }

  return album.data.photos.map((photo) => {
    const image = byFile.get(photo.file)!;
    return {
      file: photo.file,
      image,
      caption: photo.caption?.trim() || undefined,
      alt: photo.alt?.trim() || undefined,
      exif: image.exif,
    };
  });
}

/** Card and social image: explicit `cover`, otherwise the first photo. */
export function coverOf(album: Album): PhotoManifestEntry {
  const photos = imagesIn(album);
  if (!album.data.cover) return photos[0]!.image;
  const hit = photos.find(({ file }) => file === album.data.cover);
  if (!hit) {
    throw new Error(`Album ${album.id}: cover "${album.data.cover}" matches no image in the folder`);
  }
  return hit.image;
}

/** Alt text for the cover, falling back to its caption then a generic label. */
export function coverAltOf(album: Album): string {
  const photos = imagesIn(album);
  const hit = album.data.cover
    ? photos.find(({ file }) => file === album.data.cover)
    : photos[0];
  return hit?.alt ?? hit?.caption ?? `Cover photograph for ${album.data.title}`;
}

/** Photos in frontmatter order. */
export async function photosOf(album: Album): Promise<AlbumPhoto[]> {
  return imagesIn(album);
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
