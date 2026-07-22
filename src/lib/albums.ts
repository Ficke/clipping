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

const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

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
  const images = Object.entries(imageModules)
    .filter(([p]) => p.startsWith(prefix))
    .map(([p, mod]) => [p.slice(prefix.length), mod.default] as [string, ImageMetadata])
    .sort(([a], [b]) => filenameCollator.compare(a, b) || a.localeCompare(b));

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
  return album.data.order.map((file) => [file, byFile.get(file)!] as [string, ImageMetadata]);
}

export function coverOf(album: Album): ImageMetadata {
  const hit = imagesIn(album).find(([file]) => file === album.data.cover);
  if (!hit) {
    throw new Error(`Album ${album.id}: cover "${album.data.cover}" matches no image in the folder`);
  }
  return hit[1];
}

/** Photos in natural filename order, or explicit frontmatter order when set. */
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
