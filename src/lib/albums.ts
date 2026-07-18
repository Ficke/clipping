import type { ImageMetadata } from 'astro';
import { getCollection, type CollectionEntry } from 'astro:content';
import path from 'node:path';
import exifr from 'exifr';

export type Album = CollectionEntry<'albums'>;

const imageModules = import.meta.glob<{ default: ImageMetadata }>(
  '/content/albums/*/*.{jpg,jpeg,png,webp,avif}',
  { eager: true }
);

export interface AlbumPhoto {
  file: string;
  image: ImageMetadata;
  caption: string | undefined;
  exif: string | undefined;
}

/** URL slug: album folder name without the YYYY-MM- ordering prefix. */
export function slugOf(album: Album): string {
  return album.id.replace(/^\d{4}-\d{2}-/, '');
}

/** All non-draft albums, newest first. */
export async function getAlbums(): Promise<Album[]> {
  const albums = await getCollection('albums', ({ data }) => !data.draft);
  return albums.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

function imagesIn(album: Album): [string, ImageMetadata][] {
  const prefix = `/content/albums/${album.id}/`;
  return Object.entries(imageModules)
    .filter(([p]) => p.startsWith(prefix))
    .map(([p, mod]) => [p.slice(prefix.length), mod.default] as [string, ImageMetadata])
    .sort(([a], [b]) => a.localeCompare(b));
}

export function coverOf(album: Album): ImageMetadata {
  const images = imagesIn(album);
  const hit = images.find(([file]) => file === album.data.cover);
  if (hit) return hit[1];
  if (images.length === 0) throw new Error(`Album ${album.id} has no images`);
  return images[0]![1];
}

/** Photos in filename order, with frontmatter captions and EXIF (when present). */
export async function photosOf(album: Album): Promise<AlbumPhoto[]> {
  return Promise.all(
    imagesIn(album).map(async ([file, image]) => ({
      file,
      image,
      caption: album.data.captions[file],
      exif: await exifSummary(album, file),
    }))
  );
}

async function exifSummary(album: Album, file: string): Promise<string | undefined> {
  const abs = path.join(process.cwd(), 'content/albums', album.id, file);
  try {
    const ex = await exifr.parse(abs, ['Model', 'FNumber', 'FocalLength', 'ExposureTime', 'ISO']);
    if (!ex) return undefined;
    const parts: string[] = [];
    if (ex.Model) parts.push(String(ex.Model).trim());
    if (ex.FocalLength) parts.push(`${Math.round(ex.FocalLength)}mm`);
    if (ex.FNumber) parts.push(`f/${ex.FNumber}`);
    if (ex.ExposureTime) parts.push(formatShutter(ex.ExposureTime));
    if (ex.ISO) parts.push(`ISO ${ex.ISO}`);
    return parts.length ? parts.join(' · ') : undefined;
  } catch {
    return undefined;
  }
}

function formatShutter(seconds: number): string {
  if (seconds >= 1) return `${seconds}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
