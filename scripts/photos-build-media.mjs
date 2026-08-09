import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import {
  derivativeDefinitions,
  derivativeKey,
  derivativeUrl,
  photoProfile,
  scaledHeight,
} from './photo-profile.mjs';

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const args = parseArgs(process.argv.slice(2));
const sourceInput = args.source ?? process.env.PHOTO_SOURCE_DIR;
if (!sourceInput) fail('Photo source directory is required through --source or PHOTO_SOURCE_DIR');
const sourceDirectory = path.resolve(sourceInput);
const album = args.album ?? process.env.ALBUM_ID ?? path.basename(sourceDirectory);
const outputDirectory = path.resolve(args.output ?? process.env.PHOTO_OUTPUT_DIR ?? '/tmp/photo-media');
const manifestPath = path.resolve(args.manifest ?? process.env.PHOTO_MANIFEST_PATH ?? '/tmp/photos.json');
const sourceManifest = loadSourceManifest(args.sourceManifest ?? process.env.PHOTO_SOURCE_MANIFEST_PATH);
const sidecarDirectory = args.sourceMetadata ?? process.env.PHOTO_SOURCE_METADATA_PATH;
const mediaBucket = process.env.MEDIA_BUCKET;
const manifestBucket = process.env.MANIFEST_BUCKET;
const noUpload = args.noUpload;
const manifestOnly = args.manifestOnly;

if (!existsSync(sourceDirectory)) fail(`Photo source directory does not exist: ${sourceDirectory}`);
if (!album) fail('Album ID is required through --album or ALBUM_ID');
if (!noUpload && (!mediaBucket || !manifestBucket)) {
  fail('MEDIA_BUCKET and MANIFEST_BUCKET are required unless --no-upload is set');
}

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(path.dirname(manifestPath), { recursive: true });

const files = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort((left, right) => filenameCollator.compare(left, right) || left.localeCompare(right));

if (!files.length) fail(`No supported photos found in ${sourceDirectory}`);

const photos = [];
let generatedCount = 0;
let reusedCount = 0;
const previousManifest = loadPreviousManifest(args.previousManifest);
const previousVariants = variantsFrom(previousManifest);
// Sanitized masters contain no capture metadata. Preserve an existing sidecar
// so rebuilding from one cannot silently drop the gallery's shot line.
const previousShot = new Map((previousManifest?.photos ?? [])
  .filter((photo) => photo.shot)
  .map((photo) => [photo.file, photo.shot]));
for (const file of files) {
  const sourcePath = path.join(sourceDirectory, file);
  const sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const metadata = await sharp(sourcePath).metadata();
  const dimensions = orientedDimensions(metadata);
  const definitions = derivativeDefinitions(dimensions.width);
  const existingKeys = noUpload || manifestOnly ? new Set() : listExistingKeys(sourceHash);
  const responsive = { avif: [], webp: [], jpeg: [] };
  let lightbox;
  let social;

  for (const definition of definitions) {
    const key = derivativeKey(sourceHash, definition);
    const src = derivativeUrl(sourceHash, definition);
    const expectedHeight = scaledHeight(dimensions.width, dimensions.height, definition.width);
    let width = definition.width;
    let height = expectedHeight;

    if (!manifestOnly && !existingKeys.has(key)) {
      const outputPath = path.join(outputDirectory, key);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      const result = await transform(sourcePath, outputPath, definition);
      width = result.width;
      height = result.height;
      generatedCount++;
    } else {
      const previous = previousVariants.get(src);
      if (previous) {
        width = previous.width;
        height = previous.height;
      } else if (!manifestOnly && existingKeys.has(key)) {
        const actual = await remoteVariantDimensions(key);
        width = actual.width;
        height = actual.height;
      }
      reusedCount++;
    }

    const variant = { width, height, src };
    if (definition.role === 'responsive') responsive[definition.format].push(variant);
    if (definition.role === 'lightbox') lightbox = variant;
    if (definition.role === 'social') social = variant;
  }

  for (const variants of Object.values(responsive)) {
    variants.sort((left, right) => left.width - right.width);
  }

  const shot = readSidecarShot(file) ?? previousShot.get(file);
  photos.push({
    photoId: requirePhotoId(file),
    file,
    sourceHash,
    width: dimensions.width,
    height: dimensions.height,
    ...(shot && { shot }),
    variants: { responsive, lightbox, social },
  });
  console.log(`${file}: ${definitions.length} variants (${generatedCount} generated total)`);
}

const manifest = {
  version: 2,
  profile: photoProfile.version,
  album,
  photos,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (!noUpload) {
  if (generatedCount) {
    run('aws', [
      's3', 'sync', outputDirectory, `s3://${mediaBucket}`,
      '--exclude', '*', '--include', 'media/*',
      '--cache-control', 'public, max-age=31536000, immutable',
      '--only-show-errors',
    ]);
  }
  run('aws', [
    's3', 'cp', manifestPath, `s3://${manifestBucket}/manifests/${album}/photos.json`,
    '--content-type', 'application/json', '--only-show-errors',
  ]);
}

console.log(`Manifest: ${manifestPath}`);
console.log(`Variants: ${generatedCount} generated, ${reusedCount} reused`);

function loadPreviousManifest(input) {
  if (input) {
    try {
      return JSON.parse(readFileSync(path.resolve(input), 'utf8'));
    } catch (error) {
      fail(`Could not read the previous photo manifest: ${error.message}`);
    }
  }
  if (noUpload) return undefined;
  const previousPath = `${manifestPath}.previous`;
  rmSync(previousPath, { force: true });
  const result = spawnSync('aws', [
    's3', 'cp', `s3://${manifestBucket}/manifests/${album}/photos.json`, previousPath,
    '--only-show-errors',
  ], { encoding: 'utf8' });
  if (result.error) fail(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) {
    const error = result.stderr.trim();
    if (/404|NoSuchKey|Not Found|does not exist/i.test(error)) return undefined;
    fail(error || 'Could not download the previous photo manifest');
  }

  let previous;
  const previousContents = readFileSync(previousPath, 'utf8');
  rmSync(previousPath, { force: true });
  try {
    previous = JSON.parse(previousContents);
  } catch (error) {
    fail(`Could not read the previous photo manifest: ${error.message}`);
  }

  return previous;
}

function variantsFrom(manifest) {
  const variants = new Map();
  for (const photo of manifest?.photos ?? []) {
    const responsive = Object.values(photo.variants?.responsive ?? {}).flat();
    for (const variant of [...responsive, photo.variants?.lightbox, photo.variants?.social]) {
      if (variant?.src && Number.isInteger(variant.width) && Number.isInteger(variant.height)) {
        variants.set(variant.src, variant);
      }
    }
  }
  return variants;
}

async function remoteVariantDimensions(key) {
  const destination = path.join(outputDirectory, '.existing', path.basename(key));
  mkdirSync(path.dirname(destination), { recursive: true });
  run('aws', ['s3', 'cp', `s3://${mediaBucket}/${key}`, destination, '--only-show-errors']);
  const metadata = await sharp(destination).metadata();
  rmSync(destination, { force: true });
  if (!metadata.width || !metadata.height) fail(`Could not read dimensions for existing media: ${key}`);
  return { width: metadata.width, height: metadata.height };
}

function parseArgs(values) {
  const parsed = { noUpload: false, manifestOnly: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--no-upload') parsed.noUpload = true;
    else if (value === '--manifest-only') parsed.manifestOnly = true;
    else if (['--source', '--album', '--output', '--manifest', '--source-manifest', '--source-metadata', '--previous-manifest'].includes(value)) parsed[toCamel(value.slice(2))] = values[++index];
    else fail(`Unknown argument: ${value}`);
  }
  if (parsed.manifestOnly) parsed.noUpload = true;
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** Identity is authored in album frontmatter, never derived here. */
function loadSourceManifest(input) {
  if (!input) fail('A source manifest is required through --source-manifest or PHOTO_SOURCE_MANIFEST_PATH');
  const manifestPath = path.resolve(input);
  if (!existsSync(manifestPath)) fail(`Source manifest does not exist: ${manifestPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`Could not read source manifest: ${error.message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.photos)) {
    fail(`Source manifest must be a version 1 photo list: ${manifestPath}`);
  }
  return new Map(parsed.photos.map((photo) => [photo.file, photo.photoId]));
}

function requirePhotoId(file) {
  const photoId = sourceManifest.get(file);
  if (!photoId) fail(`${file} has no photo ID in the source manifest. Rerun photos:push.`);
  return photoId;
}

function readSidecarShot(file) {
  if (!sidecarDirectory) return undefined;
  const sidecar = path.join(path.resolve(sidecarDirectory), `${file}.json`);
  if (!existsSync(sidecar)) return undefined;
  try {
    return JSON.parse(readFileSync(sidecar, 'utf8')).shot;
  } catch (error) {
    fail(`Could not read metadata sidecar for ${file}: ${error.message}`);
  }
}

function orientedDimensions(metadata) {
  if (!metadata.width || !metadata.height) fail('Could not read image dimensions');
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation);
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

async function transform(source, destination, definition) {
  let pipeline = sharp(source).rotate().resize({ width: definition.width, withoutEnlargement: true });
  if (definition.format === 'avif') pipeline = pipeline.avif({ quality: definition.quality });
  if (definition.format === 'webp') pipeline = pipeline.webp({ quality: definition.quality });
  if (definition.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: definition.quality, mozjpeg: definition.mozjpeg });
  }
  const info = await pipeline.toFile(destination);
  return { width: info.width, height: info.height };
}

function listExistingKeys(sourceHash) {
  const prefix = `media/${photoProfile.version}/${sourceHash.slice(0, 2)}/${sourceHash}/`;
  const result = runCapture('aws', [
    's3api', 'list-objects-v2', '--bucket', mediaBucket, '--prefix', prefix,
    '--query', 'Contents[].Key', '--output', 'json',
  ]);
  return new Set(JSON.parse(result || '[]') ?? []);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

function fail(message) {
  console.error(`photos:build-media: ${message}`);
  process.exit(1);
}
