import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  priceCentsFromDollars,
  priceDollarsFromCents,
  type AlbumPhoto,
  type PriceDollars,
} from '../shared/album';

export type FrontmatterPhoto = Omit<AlbumPhoto, 'removed' | 'deleted'> & {
  /** ISO calendar dates are retained verbatim by the preservation parser. */
  removed?: string;
  deleted?: string;
};

/** Shared, deliberately small parser for the `photos:` subset of album YAML.
 * Astro remains the final schema validator; these helpers only preserve and
 * update the fields owned by the photo CLIs. */

export function splitFrontmatter(contents: string, album = 'album'): { lines: string[]; body: string } {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${album}/index.md has no frontmatter`);
  return { lines: match[1].split('\n'), body: match[2] };
}

export function readPhotosBlock(lines: string[]): { entries: FrontmatterPhoto[]; span: [number, number] | null } {
  const start = lines.findIndex((line) => line === 'photos:');
  if (start === -1) return { entries: [], span: null };
  let end = start + 1;
  while (end < lines.length && /^\s+[-\s]/.test(lines[end])) end += 1;

  const entries: FrontmatterPhoto[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const item = line.match(/^\s+-\s*file:\s*(.+?)\s*$/);
    if (item) {
      // The parser intentionally permits incomplete entries; Astro remains the
      // final validator for authored Markdown.
      entries.push({ file: unquote(item[1]) } as FrontmatterPhoto);
      continue;
    }
    const field = line.match(/^\s+(caption|alt|photoId|price|removed|deleted):\s*(.*)$/);
    if (!field || !entries.length) continue;
    const value = unquote(field[2]);
    const entry = entries.at(-1)!;
    if (field[1] === 'price') entry.priceDollars = parsePriceDollars(value);
    else if (field[1] === 'caption' || field[1] === 'alt' || field[1] === 'photoId'
      || field[1] === 'removed' || field[1] === 'deleted') entry[field[1]] = value;
  }
  return { entries, span: [start, end] };
}

export function serializePhotos(entries: FrontmatterPhoto[]): string[] {
  const block = ['photos:'];
  for (const entry of entries) {
    block.push(`  - file: ${entry.file}`);
    block.push(`    photoId: ${entry.photoId}`);
    if (entry.caption) block.push(`    caption: ${JSON.stringify(entry.caption)}`);
    if (entry.alt) block.push(`    alt: ${JSON.stringify(entry.alt)}`);
    if (entry.priceDollars !== undefined) block.push(`    price: ${formatPriceDollars(entry.priceDollars)}`);
    if (entry.removed) block.push(`    removed: ${entry.removed}`);
    if (entry.deleted) block.push(`    deleted: ${entry.deleted}`);
  }
  return block;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function replacePhotosBlock(contents: string, entries: FrontmatterPhoto[], album = 'album'): string {
  const { lines, body } = splitFrontmatter(contents, album);
  const { span } = readPhotosBlock(lines);
  const rebuilt = [...lines];
  const block = serializePhotos(entries);
  if (span) rebuilt.splice(span[0], span[1] - span[0], ...block);
  else rebuilt.push(...block);
  return `---\n${rebuilt.join('\n')}\n---\n${body}`;
}

export function parsePriceDollars(input: unknown): PriceDollars {
  const normalized = String(input).trim().replace(/^\$/, '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('price must be a non-negative USD amount with at most two decimal places');
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents < 100 || cents > 1_000_000) {
    throw new Error('price must be between $1 and $10,000');
  }
  return priceDollarsFromCents(cents);
}

export function formatPriceDollars(dollars: PriceDollars): string {
  const cents = priceCentsFromDollars(dollars);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

export function frontmatterValue(contents: string, key: string): string | undefined {
  const match = contents.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? unquote(match[1].trim()) : undefined;
}

export function albumIndexes(albumsRoot: string): string[] {
  return readdirSync(albumsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(albumsRoot, entry.name, 'index.md'))
    .filter((indexPath) => existsSync(indexPath));
}

/**
 * Find one photograph by ID, or by album plus filename. Identity lives in
 * frontmatter, so this never consults a generated manifest and keeps working
 * for photographs that have been removed or deleted.
 */
export function locatePhoto(albumsRoot: string, reference: string, album?: string): {
  indexPath: string; contents: string; entries: FrontmatterPhoto[]; photo: FrontmatterPhoto;
} {
  const candidates = album ? [resolveAlbumIndex(albumsRoot, album)] : albumIndexes(albumsRoot);
  const matches = [];
  for (const indexPath of candidates) {
    const contents = readFileSync(indexPath, 'utf8');
    const { lines } = splitFrontmatter(contents, path.dirname(indexPath));
    const { entries } = readPhotosBlock(lines);
    const photo = entries.find((entry) => entry.photoId === reference || entry.file === reference);
    if (photo) matches.push({ indexPath, contents, entries, photo });
  }
  if (!matches.length) throw new Error(`no photograph matches ${JSON.stringify(reference)}`);
  if (matches.length > 1) {
    throw new Error(`${reference} appears in more than one album; name the album explicitly`);
  }
  return matches[0];
}

/** Resolve a folder name, path, storyId, or public slug to one album index. */
export function resolveAlbumIndex(albumsRoot: string, input: string): string {
  if (!input) throw new Error('album is required');
  const direct = path.resolve(input);
  for (const candidate of [direct, path.join(albumsRoot, input)]) {
    const index = candidate.endsWith('index.md') ? candidate : path.join(candidate, 'index.md');
    if (existsSync(index)) return index;
  }

  const matches = [];
  for (const entry of readdirSync(albumsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = path.join(albumsRoot, entry.name, 'index.md');
    if (!existsSync(index)) continue;
    const contents = readFileSync(index, 'utf8');
    const storyId = frontmatterValue(contents, 'storyId');
    const slug = storyId?.replace(/^\d{4}-\d{2}-/, '');
    if (input === entry.name || input === storyId || input === slug) matches.push(index);
  }
  if (!matches.length) throw new Error(`no album matches ${JSON.stringify(input)}`);
  if (matches.length > 1) throw new Error(`album ${JSON.stringify(input)} is ambiguous`);
  return matches[0];
}
