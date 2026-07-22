import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import exifr from 'exifr';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const archiveRoot = 's3://adamficke-com-originals/albums';
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const unsupportedPhotoExtensions = new Set([
  '.bmp', '.dng', '.gif', '.heic', '.heif', '.raf', '.raw', '.tif', '.tiff',
]);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const positional = args.filter((arg) => arg !== '--dry-run');

if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--dry-run')) {
  fail('Usage: bun run photos:push -- [album-folder] [--dry-run]');
}

const source = resolveSource(positional[0]);
const albumDirectories = source === albumsRoot
  ? readdirSync(albumsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(albumsRoot, entry.name))
  : [source];

let imageCount = 0;
for (const albumDirectory of albumDirectories) {
  imageCount += await prepareAlbum(albumDirectory);
}

if (!imageCount) fail(`No supported images found in ${source}`);

const relative = path.relative(albumsRoot, source);
const destination = relative ? `${archiveRoot}/${relative.split(path.sep).join('/')}` : archiveRoot;
const syncArgs = [
  's3', 'sync', source, destination,
  '--exclude', '*',
  '--include', '*.jpg',
  '--include', '*.jpeg',
  '--include', '*.png',
  '--include', '*.webp',
  '--include', '*.avif',
];
if (dryRun) syncArgs.push('--dryrun');

console.log(`\n${dryRun ? 'Previewing' : 'Uploading'} ${imageCount} image${imageCount === 1 ? '' : 's'} to ${destination}`);
const result = spawnSync('aws', syncArgs, { stdio: 'inherit' });
if (result.error) fail(`Could not run AWS CLI: ${result.error.message}`);
process.exit(result.status ?? 1);

function resolveSource(input) {
  if (!input) return albumsRoot;
  const candidate = input.includes(path.sep) || path.isAbsolute(input)
    ? path.resolve(process.cwd(), input)
    : path.join(albumsRoot, input);
  const relative = path.relative(albumsRoot, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    fail('Album folder must be a direct child of content/albums');
  }
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    fail(`Album folder does not exist: ${candidate}`);
  }
  return candidate;
}

async function prepareAlbum(albumDirectory) {
  const entries = readdirSync(albumDirectory, { withFileTypes: true });
  const nestedImages = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findImageFiles(path.join(albumDirectory, entry.name)));
  if (nestedImages.length) {
    fail(`Images must be directly inside ${albumDirectory}, not nested in subfolders`);
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => supportedExtensions.has(path.extname(file).toLowerCase()));
  const unsupported = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => unsupportedPhotoExtensions.has(path.extname(file).toLowerCase()));
  if (unsupported.length) {
    fail(`Unsupported photo format in ${albumDirectory}: ${unsupported.join(', ')}. Export as JPEG, PNG, WebP, or AVIF.`);
  }
  if (!candidates.length) return 0;

  const normalizedNames = new Map();
  for (const file of candidates) {
    const extension = path.extname(file);
    const normalized = `${file.slice(0, -extension.length)}${extension.toLowerCase()}`;
    const key = normalized.toLocaleLowerCase('en');
    if (normalizedNames.has(key)) {
      fail(`Filename collision after normalization: ${normalizedNames.get(key)} and ${file}`);
    }
    normalizedNames.set(key, file);
  }

  const images = candidates.map((file) => {
    const extension = path.extname(file);
    const normalized = `${file.slice(0, -extension.length)}${extension.toLowerCase()}`;
    if (file !== normalized) {
      console.log(`${dryRun ? 'Would rename' : 'Renaming'} ${file} -> ${normalized}`);
      if (!dryRun) renameCaseSafely(albumDirectory, file, normalized);
    }
    return normalized;
  }).sort((a, b) => filenameCollator.compare(a, b) || a.localeCompare(b));

  const indexPath = path.join(albumDirectory, 'index.md');
  if (!existsSync(indexPath)) {
    const contents = await scaffoldIndex(albumDirectory, images);
    console.log(`${dryRun ? 'Would create' : 'Creating'} ${indexPath}`);
    if (!dryRun) writeFileSync(indexPath, contents);
  }

  return images.length;
}

function renameCaseSafely(directory, sourceName, destinationName) {
  const source = path.join(directory, sourceName);
  const destination = path.join(directory, destinationName);
  const temporary = path.join(directory, `.${sourceName}.photos-push-${process.pid}`);
  renameSync(source, temporary);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    renameSync(temporary, source);
    throw error;
  }
}

async function scaffoldIndex(albumDirectory, images) {
  const folder = path.basename(albumDirectory);
  const match = folder.match(/^(\d{4})-(\d{2})-(.+)$/);
  if (!match) fail(`Album folder must use YYYY-MM-slug format: ${folder}`);
  const [, year, month, slug] = match;
  const title = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toLocaleUpperCase('en') + word.slice(1))
    .join(' ');
  const date = await photoDate(path.join(albumDirectory, images[0])) ?? `${year}-${month}-01`;
  return `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\ncover: ${images[0]}\n---\n`;
}

async function photoDate(file) {
  try {
    const metadata = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const date = metadata?.DateTimeOriginal ?? metadata?.CreateDate;
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return undefined;
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return undefined;
  }
}

function findImageFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return findImageFiles(child);
    return supportedExtensions.has(path.extname(entry.name).toLowerCase()) ? [child] : [];
  });
}

function fail(message) {
  console.error(`photos:push: ${message}`);
  process.exit(1);
}
