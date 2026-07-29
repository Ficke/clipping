import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import exifr from 'exifr';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const archiveRoot = 's3://adamficke-com-originals/albums';
const manifestRoot = 's3://adamficke-com-originals/manifests';
const buildBucket = 'adamficke-com-builds';
const mediaProject = 'adamficke-com-media';
const mediaBucket = 'adamficke-com-media';
const manifestBucket = 'adamficke-com-originals';
const buildPollInterval = Number.parseInt(process.env.PHOTO_BUILD_POLL_INTERVAL_MS ?? '5000', 10);
const terminalBuildStatuses = new Set(['FAILED', 'FAULT', 'STOPPED', 'SUCCEEDED', 'TIMED_OUT']);
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const unsupportedPhotoExtensions = new Set([
  '.bmp', '.dng', '.gif', '.heic', '.heif', '.raf', '.raw', '.tif', '.tiff',
]);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const assumeYes = args.includes('--yes');
const forceLocal = args.includes('--local');
const flags = new Set(['--dry-run', '--yes', '--local']);
const positional = args.filter((arg) => !flags.has(arg));

if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && !flags.has(arg))) {
  fail('Usage: bun run photos:push -- [album-folder] [--dry-run] [--yes] [--local]');
}

// Prompting only makes sense on a terminal, and never during a dry run.
// PHOTOS_PUSH_PROMPT=1 forces the form on for tests, which run without a TTY.
const interactive = (Boolean(process.stdin.isTTY) || process.env.PHOTOS_PUSH_PROMPT === '1')
  && !dryRun
  && !assumeYes;

// Fail before the form is filled in rather than after.
if (!dryRun) requireAwsSession();

const source = resolveSource(positional[0]);
const albumDirectories = source === albumsRoot
  ? readdirSync(albumsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(albumsRoot, entry.name))
  : [source];

const preparedAlbums = [];
for (const albumDirectory of albumDirectories) {
  const { images, storyId } = await prepareAlbum(albumDirectory);
  if (images.length) preparedAlbums.push({ albumDirectory, images, storyId });
}

if (!preparedAlbums.length) fail(`No supported images found in ${source}`);

const buildLocally = dryRun ? false : forceLocal || await askWhereToBuild();

let sourceBundle;
for (const { albumDirectory, images, storyId } of preparedAlbums) {
  const album = storyId;
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
    console.log(`Would build immutable media and write ${path.relative(repoRoot, albumDirectory)}/photos.json`);
    continue;
  }

  if (buildLocally) {
    publishMediaLocally(album, albumDirectory);
    continue;
  }

  sourceBundle ??= createSourceBundle();
  await publishMedia(album, albumDirectory, sourceBundle);
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
    const { contents, storyId } = await scaffoldIndex(albumDirectory, images);
    console.log(`${dryRun ? 'Would create' : 'Creating'} ${indexPath}`);
    if (!dryRun) writeFileSync(indexPath, contents);
    return { images, storyId };
  }

  const existing = readFileSync(indexPath, 'utf8');
  const storyId = frontmatterValue(existing, 'storyId');
  if (!storyId) fail(`${indexPath} has no storyId`);

  const reconciled = reconcilePhotos(existing, images, path.basename(albumDirectory));
  if (reconciled !== existing) {
    console.log(`${dryRun ? 'Would update' : 'Updating'} photos in ${indexPath}`);
    if (!dryRun) writeFileSync(indexPath, reconciled);
  }

  return { images, storyId };
}

/**
 * Rebuild the `photos` list from what is on disk, keeping captions, alt text
 * and any hand-ordered sequence. New files slot into filename order when the
 * album has never been reordered, and append when it has.
 */
function reconcilePhotos(contents, images, album) {
  const { lines, body } = splitFrontmatter(contents, album);
  const { entries, span } = readPhotosBlock(lines);
  const known = new Map(entries.map((entry) => [entry.file, entry]));

  const kept = entries.filter((entry) => images.includes(entry.file));
  const dropped = entries.filter((entry) => !images.includes(entry.file));
  const added = images.filter((file) => !known.has(file));

  const wasFilenameOrdered = kept.length === 0
    || kept.map((entry) => entry.file).join('\0') === sortFilenames(kept.map((entry) => entry.file)).join('\0');
  const next = wasFilenameOrdered
    ? sortFilenames([...kept.map((entry) => entry.file), ...added]).map((file) => known.get(file) ?? { file })
    : [...kept, ...added.map((file) => ({ file }))];

  if (dropped.length) {
    console.log(`  removing ${dropped.length}: ${dropped.map((entry) => entry.file).join(', ')}`);
  }
  if (added.length) {
    console.log(`  adding ${added.length}: ${added.join(', ')}${wasFilenameOrdered ? '' : ' (appended — reorder if needed)'}`);
  }

  const rebuilt = [...lines];
  const block = serializePhotos(next);
  if (span) rebuilt.splice(span[0], span[1] - span[0], ...block);
  else rebuilt.push(...block);
  return `---\n${rebuilt.join('\n')}\n---\n${body}`;
}

function serializePhotos(entries) {
  const block = ['photos:'];
  for (const entry of entries) {
    block.push(`  - file: ${entry.file}`);
    if (entry.caption) block.push(`    caption: ${JSON.stringify(entry.caption)}`);
    if (entry.alt) block.push(`    alt: ${JSON.stringify(entry.alt)}`);
  }
  return block;
}

function readPhotosBlock(lines) {
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
    const field = line.match(/^\s+(caption|alt):\s*(.*)$/);
    if (field && entries.length) entries[entries.length - 1][field[1]] = unquote(field[2]);
  }
  return { entries, span: [start, end] };
}

function splitFrontmatter(contents, album) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) fail(`${album}/index.md has no frontmatter`);
  return { lines: match[1].split('\n'), body: match[2] };
}

function frontmatterValue(contents, key) {
  const match = contents.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? unquote(match[1].trim()) : undefined;
}

function unquote(value) {
  const trimmed = value.trim();
  return /^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function sortFilenames(files) {
  return [...files].sort((a, b) => filenameCollator.compare(a, b) || a.localeCompare(b));
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

/**
 * CodeBuild is the reproducible default: it builds from HEAD in a fixed
 * container. Local is the same generator against the working tree, which is
 * much faster on a cold album because it skips the source bundle and the
 * round trip that pulls the originals back out of S3.
 */
async function askWhereToBuild() {
  if (!interactive) return false;
  const photoCount = preparedAlbums.reduce((total, entry) => total + entry.images.length, 0);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\nBuild media for ${photoCount} photo${photoCount === 1 ? '' : 's'}:`);
    console.log('  codebuild  reproducible, builds from HEAD');
    console.log('  local      faster, builds from your working tree');
    while (true) {
      const answer = (await rl.question('  where      [codebuild] ')).trim().toLowerCase();
      if (!answer || answer === 'codebuild') return false;
      if (answer === 'local') return true;
      console.log('  answer "codebuild" or "local"');
    }
  } finally {
    rl.close();
  }
}

/** Same generator CodeBuild runs; variant keys derive from the source hash. */
function publishMediaLocally(album, albumDirectory) {
  const manifestPath = path.join(albumDirectory, 'photos.json');
  console.log(`Building ${album} locally`);
  run('bun', [
    path.join(repoRoot, 'scripts', 'photos-build-media.mjs'),
    '--source', albumDirectory,
    '--album', album,
    '--manifest', manifestPath,
  ], { MEDIA_BUCKET: mediaBucket, MANIFEST_BUCKET: manifestBucket });
  console.log(`Created ${manifestPath}`);
}

async function publishMedia(album, albumDirectory, sourceBundle) {
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

  const manifestPath = path.join(albumDirectory, 'photos.json');
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

/**
 * Derive defaults from the folder name, confirm them at the prompt, and write
 * index.md. The folder is only a seed here — nothing reads it afterwards.
 */
async function scaffoldIndex(albumDirectory, images) {
  const folder = path.basename(albumDirectory);
  const match = folder.match(/^(?:(\d{4})-(\d{2})-)?(.+)$/);
  const [, year, month, rawSlug] = match;
  const title = rawSlug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toLocaleUpperCase('en') + word.slice(1))
    .join(' ');
  const fallbackDate = year ? `${year}-${month}-01` : new Date().toISOString().slice(0, 10);
  const date = await photoDate(path.join(albumDirectory, images[0])) ?? fallbackDate;

  const defaults = {
    storyId: slugify(rawSlug),
    title,
    date,
    location: '',
    cover: images[0],
  };
  if (!defaults.storyId) fail(`Cannot derive a storyId from folder name: ${folder}`);

  const answers = interactive
    ? await runForm(albumDirectory, images, defaults)
    : defaults;

  if (!dryRun) assertStoryIdAvailable(answers.storyId);

  const lines = [
    `storyId: ${JSON.stringify(answers.storyId)}`,
    `title: ${JSON.stringify(answers.title)}`,
    `date: ${answers.date}`,
    // Written on every album, even when it matches the trip date, so a story
    // posted long after the fact can never quietly backdate itself out of the
    // feed. The site orders by this; the page still shows `date`.
    `published: ${new Date().toISOString().slice(0, 10)}`,
    `location: ${JSON.stringify(answers.location)}`,
  ];
  if (answers.cover !== images[0]) lines.push(`cover: ${answers.cover}`);
  if (answers.description) lines.push(`description: ${JSON.stringify(answers.description)}`);
  if (answers.draft) lines.push('draft: true');
  lines.push(...serializePhotos(images.map((file) => ({ file }))));

  return { contents: `---\n${lines.join('\n')}\n---\n`, storyId: answers.storyId };
}

async function runForm(albumDirectory, images, defaults) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${path.basename(albumDirectory)} → new album, ${images.length} photo${images.length === 1 ? '' : 's'}`);
    const answers = { ...defaults };

    answers.storyId = await askUnique(rl, 'storyId', defaults.storyId, defaults);
    answers.title = await askRequired(rl, 'title', defaults.title);
    answers.date = await askRequired(rl, 'date', defaults.date);
    answers.cover = await askCover(rl, images, defaults.cover);
    answers.location = await askRequired(rl, 'location', '');
    answers.description = (await rl.question('  description  [] ')).trim();
    answers.draft = /^y(es)?$/i.test((await rl.question('  draft        [no] ')).trim());
    return answers;
  } finally {
    rl.close();
  }
}

async function ask(rl, label, fallback) {
  const shown = `  ${label.padEnd(11)}[${fallback}] `;
  const answer = (await rl.question(shown)).trim();
  return answer || fallback;
}

async function askRequired(rl, label, fallback) {
  while (true) {
    const answer = await ask(rl, label, fallback);
    if (answer) return answer;
    console.log(`  ${label} is required`);
  }
}

async function askCover(rl, images, fallback) {
  while (true) {
    const answer = await ask(rl, 'cover', fallback);
    if (images.includes(answer)) return answer;
    console.log(`  no such photo: ${answer}`);
  }
}

async function askUnique(rl, label, fallback, defaults) {
  const taken = existingStoryIds();
  let suggestion = fallback;
  if (taken.has(suggestion)) suggestion = `${fallback}-${defaults.date.slice(0, 4)}`;
  while (true) {
    const answer = slugify(await ask(rl, label, suggestion));
    if (!answer) {
      console.log('  storyId is required');
      continue;
    }
    if (taken.has(answer)) {
      console.log(`  "${answer}" is already used by another album`);
      continue;
    }
    console.log(`               → /photography/${answer.replace(/^\d{4}-\d{2}-/, '')}/`);
    return answer;
  }
}

function existingStoryIds() {
  const ids = new Set();
  for (const entry of readdirSync(albumsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(albumsRoot, entry.name, 'index.md');
    if (!existsSync(indexPath)) continue;
    const storyId = frontmatterValue(readFileSync(indexPath, 'utf8'), 'storyId');
    if (storyId) ids.add(storyId);
  }
  return ids;
}

/** Git is not the whole truth: an id can be free locally but taken in S3. */
function assertStoryIdAvailable(storyId) {
  const listing = runCapture('aws', ['s3', 'ls', `${archiveRoot}/${storyId}/`], { allowFailure: true });
  if (listing) {
    fail(`s3 already has ${archiveRoot}/${storyId}/ — choose a different storyId or remove the prefix`);
  }
}

function slugify(value) {
  return value
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function requireAwsSession() {
  const result = spawnSync('aws', ['sts', 'get-caller-identity'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) fail(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail('AWS session is not valid. Run `aws login` first.');
}

async function photoDate(file) {
  try {
    const metadata = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate']);
    const date = metadata?.DateTimeOriginal ?? metadata?.CreateDate;
    if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return undefined;
    // EXIF timestamps are wall-clock at the camera with no zone; exifr returns
    // them as UTC. Read them back in UTC so the date does not shift westward.
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
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

function run(command, commandArgs, extraEnv) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowFailure) return '';
    fail(result.stderr.trim() || `${command} failed`);
  }
  return result.stdout.trim();
}

function fail(message) {
  console.error(`photos:push: ${message}`);
  process.exit(1);
}
