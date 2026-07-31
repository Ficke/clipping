import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Shared, deliberately small parser for the `photos:` subset of album YAML.
 * Astro remains the final schema validator; these helpers only preserve and
 * update the fields owned by the photo CLIs. */

export function splitFrontmatter(contents, album = 'album') {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${album}/index.md has no frontmatter`);
  return { lines: match[1].split('\n'), body: match[2] };
}

export function readPhotosBlock(lines) {
  const start = lines.findIndex((line) => line === 'photos:');
  if (start === -1) return { entries: [], span: null };
  let end = start + 1;
  while (end < lines.length && /^\s+[-\s]/.test(lines[end])) end += 1;

  const entries = [];
  for (const line of lines.slice(start + 1, end)) {
    const item = line.match(/^\s+-\s*file:\s*(.+?)\s*$/);
    if (item) {
      entries.push({ file: unquote(item[1]) });
      continue;
    }
    const field = line.match(/^\s+(caption|alt|forSale|price|hidden|catalog):\s*(.*)$/);
    if (!field || !entries.length) continue;
    const value = unquote(field[2]);
    if (field[1] === 'forSale' || field[1] === 'hidden' || field[1] === 'catalog') {
      entries.at(-1)[field[1]] = value === 'true';
    }
    else if (field[1] === 'price') entries.at(-1).price = parsePriceDollars(value);
    else entries.at(-1)[field[1]] = value;
  }
  return { entries, span: [start, end] };
}

export function serializePhotos(entries) {
  const block = ['photos:'];
  for (const entry of entries) {
    block.push(`  - file: ${entry.file}`);
    if (entry.caption) block.push(`    caption: ${JSON.stringify(entry.caption)}`);
    if (entry.alt) block.push(`    alt: ${JSON.stringify(entry.alt)}`);
    if (entry.forSale !== undefined) block.push(`    forSale: ${entry.forSale}`);
    if (entry.price !== undefined) block.push(`    price: ${formatPriceDollars(entry.price)}`);
    if (entry.hidden !== undefined) block.push(`    hidden: ${entry.hidden}`);
    if (entry.catalog !== undefined) block.push(`    catalog: ${entry.catalog}`);
  }
  return block;
}

export function replacePhotosBlock(contents, entries, album = 'album') {
  const { lines, body } = splitFrontmatter(contents, album);
  const { span } = readPhotosBlock(lines);
  const rebuilt = [...lines];
  const block = serializePhotos(entries);
  if (span) rebuilt.splice(span[0], span[1] - span[0], ...block);
  else rebuilt.push(...block);
  return `---\n${rebuilt.join('\n')}\n---\n${body}`;
}

export function parsePriceDollars(input) {
  const normalized = String(input).trim().replace(/^\$/, '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('price must be a non-negative USD amount with at most two decimal places');
  }
  const cents = Math.round(Number(normalized) * 100);
  if (!Number.isSafeInteger(cents) || cents < 100 || cents > 1_000_000) {
    throw new Error('price must be between $1 and $10,000');
  }
  return cents / 100;
}

export function formatPriceDollars(dollars) {
  const cents = Math.round(dollars * 100);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function unquote(value) {
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

export function frontmatterValue(contents, key) {
  const match = contents.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? unquote(match[1].trim()) : undefined;
}

/** Resolve a folder name, path, storyId, or public slug to one album index. */
export function resolveAlbumIndex(albumsRoot, input) {
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
