import { getCollection, type CollectionEntry } from 'astro:content';
import { slugForStoryId } from './downloads';
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
  photoId: string;
  file: string;
  image: PhotoManifestEntry;
  caption: string | undefined;
  alt: string | undefined;
  /** Set means offered as a download. See `downloads.ts`. */
  priceCents: number | undefined;
}

/**
 * URL slug, derived from storyId rather than the folder so albums can be
 * reorganized on disk.
 */
export function slugOf(album: Album): string {
  return slugForStoryId(album.data.storyId);
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

/**
 * All non-draft albums, most recently published first.
 *
 * This is the only place a photo ID can be checked across every album, and it
 * has to be: two albums claiming one ID would have the second push overwrite
 * the first album's only master.
 */
export async function getAlbums(): Promise<Album[]> {
  const albums = await getCollection('albums', ({ data }) => !data.draft);
  const storyIds = new Set<string>();
  const photoIds = new Map<string, string>();
  for (const album of albums) {
    if (storyIds.has(album.data.storyId)) {
      throw new Error(`Duplicate storyId: ${album.data.storyId}`);
    }
    storyIds.add(album.data.storyId);
    for (const photo of album.data.photos) {
      const owner = photoIds.get(photo.photoId);
      if (owner) {
        throw new Error(`Photo ID ${photo.photoId} is claimed by both ${owner} and ${album.data.storyId}`);
      }
      photoIds.set(photo.photoId, album.data.storyId);
    }
  }
  return albums.sort((a, b) => publishedAt(b).valueOf() - publishedAt(a).valueOf());
}

/**
 * Frontmatter `photos` joined to the generated manifest on `photoId`. The
 * frontmatter array is authoritative for order; the manifest is authoritative
 * for what exists. Removed photographs keep their frontmatter entry as the
 * record that they existed, and are excluded here before the two sides are
 * required to agree — the manifest only ever describes live photographs.
 */
function imagesIn(album: Album): AlbumPhoto[] {
  const manifest = manifestsByStoryId.get(album.data.storyId);
  if (!manifest) {
    throw new Error(`Album ${album.id}: no photos.json declares storyId "${album.data.storyId}". Rerun photos:push.`);
  }

  const manifestIds = manifest.photos.map((photo) => photo.photoId);
  const duplicateManifestIds = manifestIds
    .filter((photoId, index) => manifestIds.indexOf(photoId) !== index);
  if (duplicateManifestIds.length) {
    throw new Error(`Album ${album.id}: photos.json has duplicate photo IDs: ${[...new Set(duplicateManifestIds)].join(', ')}`);
  }

  const byId = new Map(manifest.photos.map((photo) => [photo.photoId, photo]));
  const live = album.data.photos.filter((photo) => !photo.removed);
  const listed = live.map((photo) => photo.photoId);
  const duplicates = listed.filter((photoId, index) => listed.indexOf(photoId) !== index);
  const unknown = listed.filter((photoId) => !byId.has(photoId));
  const missing = manifestIds.filter((photoId) => !listed.includes(photoId));
  if (duplicates.length || unknown.length || missing.length) {
    const problems = [
      duplicates.length && `duplicates: ${[...new Set(duplicates)].join(', ')}`,
      unknown.length && `not in photos.json: ${unknown.join(', ')}`,
      missing.length && `absent from photos: ${missing.join(', ')}`,
    ].filter(Boolean);
    throw new Error(`Album ${album.id}: photos does not match photos.json (${problems.join('; ')}). Rerun photos:push.`);
  }

  return live.map((photo) => ({
    photoId: photo.photoId,
    file: photo.file,
    image: byId.get(photo.photoId)!,
    caption: photo.caption?.trim() || undefined,
    alt: photo.alt?.trim() || undefined,
    priceCents: photo.price === undefined ? undefined : Math.round(photo.price * 100),
  }));
}

/** Card and social image: explicit `cover`, otherwise the first photo. */
export function coverOf(album: Album): PhotoManifestEntry {
  const photos = imagesIn(album);
  if (!photos.length) throw new Error(`Album ${album.id} has no photos left`);
  if (!album.data.cover) return photos[0]!.image;
  const hit = photos.find(({ photoId }) => photoId === album.data.cover);
  if (!hit) {
    throw new Error(`Album ${album.id}: cover "${album.data.cover}" matches no photograph in the album`);
  }
  return hit.image;
}

/** Alt text for the cover, falling back to its caption then a generic label. */
export function coverAltOf(album: Album): string {
  const photos = imagesIn(album);
  const hit = album.data.cover
    ? photos.find(({ photoId }) => photoId === album.data.cover)
    : photos[0];
  return hit?.alt ?? hit?.caption ?? `Cover photograph for ${album.data.title}`;
}

/** Live photos in frontmatter order. */
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
