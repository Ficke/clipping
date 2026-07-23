import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import exifr from 'exifr';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const archiveRoot = 's3://adamficke-com-originals/albums';
const manifestRoot = 's3://adamficke-com-originals/manifests';
const buildBucket = 'adamficke-com-builds';
const mediaProject = 'adamficke-com-media';
const buildPollInterval = Number.parseInt(process.env.PHOTO_BUILD_POLL_INTERVAL_MS ?? '5000', 10);
const terminalBuildStatuses = new Set(['FAILED', 'FAULT', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT']);
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const unsupportedPhotoExtensions = new Set([
  '.bmp', '.dng', '.gif', '.heic', '.heif', '.raf', '.raw', '.tif', '.tiff',
]);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const flags = new Set(['--dry-run']);
const positional = args.filter((arg) => !flags.has(arg));

if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && !flags.has(arg))) {
  fail('Usage: bun run photos:push -- [album-folder] [--dry-run]');
}

const source = resolveSource(positional[0]);
const albumDirectories = source === albumsRoot
  ? readdirSync(albumsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(albumsRoot, entry.name))
  : [source];

const preparedAlbums = [];
for (const albumDirectory of albumDirectories) {
  const images = await prepareAlbum(albumDirectory);
  if (images.length) preparedAlbums.push({ albumDirectory, images });
}

if (!preparedAlbums.length) fail(`No supported images found in ${source}`);

let sourceBundle;
for (const { albumDirectory, images } of preparedAlbums) {
  const album = path.basename(albumDirectory);
  const destination = `${archiveRoot}/${album}`;
  const syncArgs = [
    's3', 'sync', albumDirectory, destination,
    '--exclude', '*',
    '--include', '*.jpg',
    '--include', '*.jpeg',
    '--include', '*.png',
    '--include', '*.webp',
    '--include', '*.avif',
    '--delete',
    '--checksum-algorithm', 'SHA256',
  ];
  if (dryRun) syncArgs.push('--dryrun');

  console.log(`\n${dryRun ? 'Previewing' : 'Uploading'} ${images.length} image${images.length === 1 ? '' : 's'} to ${destination}`);
  run('aws', syncArgs);

  if (dryRun) {
    console.log(`Would build immutable media and write content/albums/${album}/photos.json`);
    continue;
  }

  sourceBundle ??= createSourceBundle();
  await publishMedia(album, sourceBundle);
}

if (sourceBundle) rmSync(sourceBundle.directory, { recursive: true, force: true });

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
  const album = path.basename(albumDirectory);
  if (!/^\d{4}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(album)) {
    fail(`Album folder must use YYYY-MM-slug format: ${album}`);
  }
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
  if (!candidates.length) return [];

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

  return images;
}

function createSourceBundle() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'photos-push-'));
  const archive = path.join(directory, 'source.zip');
  const commit = runCapture('git', ['rev-parse', 'HEAD']);
  run('git', ['archive', '--format=zip', `--output=${archive}`, 'HEAD']);
  const key = `source/${commit}.zip`;
  console.log(`\nUploading build source to s3://${buildBucket}/${key}`);
  run('aws', ['s3', 'cp', archive, `s3://${buildBucket}/${key}`, '--only-show-errors']);
  return { directory, key };
}

async function publishMedia(album, sourceBundle) {
  console.log(`Starting ${mediaProject} for ${album}`);
  const buildId = runCapture('aws', [
    'codebuild', 'start-build',
    '--project-name', mediaProject,
    '--source-type-override', 'S3',
    '--source-location-override', `${buildBucket}/${sourceBundle.key}`,
    '--environment-variables-override', `name=ALBUM_ID,value=${album},type=PLAINTEXT`,
    '--query', 'build.id', '--output', 'text',
  ]);
  console.log(`Waiting for ${buildId}`);
  const status = await waitForBuild(buildId);
  if (status !== 'SUCCEEDED') fail(`Media build ${buildId} finished with ${status}`);

  const manifestPath = path.join(albumsRoot, album, 'photos.json');
  run('aws', [
    's3', 'cp', `${manifestRoot}/${album}/photos.json`, manifestPath,
    '--only-show-errors',
  ]);
  console.log(`Created ${manifestPath}`);
}

async function waitForBuild(buildId) {
  while (true) {
    const status = runCapture('aws', [
      'codebuild', 'batch-get-builds', '--ids', buildId,
      '--query', 'builds[0].buildStatus', '--output', 'text',
    ]);
    if (terminalBuildStatuses.has(status)) return status;
    await delay(buildPollInterval);
  }
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
  return `---\nstoryId: ${JSON.stringify(folder)}\ntitle: ${JSON.stringify(title)}\ndate: ${date}\nlocation: ${JSON.stringify(title)}\ncover: ${images[0]}\n---\n`;
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

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

function fail(message) {
  console.error(`photos:push: ${message}`);
  process.exit(1);
}
