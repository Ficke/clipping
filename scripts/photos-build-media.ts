import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import type { Metadata, OutputInfo } from 'sharp';
import { z } from 'zod';
import {
  mediaProfileSchema,
  parseMetadataSidecar,
  parsePhotoManifest,
  parseSourceManifest,
  photoManifestEntrySchema,
  type PhotoManifest,
  type PhotoManifestEntry,
  type PhotoVariant,
  type ShotMetadata,
} from '../shared/media.ts';
import {
  derivativeDefinitions,
  derivativeKey,
  derivativeUrl,
  photoProfile,
  scaledHeight,
  type DerivativeDefinition,
} from './photo-profile.ts';

interface BuildMediaArgs {
  source?: string;
  album?: string;
  output?: string;
  manifest?: string;
  sourceManifest?: string;
  sourceMetadata?: string;
  previousManifest?: string;
  noUpload: boolean;
  manifestOnly: boolean;
}

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const legacyPhotoManifestSchema = z.object({
  version: z.literal(1),
  profile: mediaProfileSchema,
  album: z.string().min(1),
  photos: z.array(photoManifestEntrySchema.omit({ photoId: true })),
}).superRefine((manifest, context) => {
  const files = new Set<string>();
  for (const [index, photo] of manifest.photos.entries()) {
    if (files.has(photo.file)) {
      context.addIssue({
        code: 'custom',
        path: ['photos', index, 'file'],
        message: `duplicates file ${photo.file}`,
      });
    }
    files.add(photo.file);
  }
});
type PreviousManifest = PhotoManifest | z.infer<typeof legacyPhotoManifestSchema>;
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

const photos: PhotoManifestEntry[] = [];
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
  const responsive: PhotoManifestEntry['variants']['responsive'] = { avif: [], webp: [], jpeg: [] };
  let lightbox: PhotoVariant | undefined;
  let social: PhotoVariant | undefined;

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
  if (!lightbox || !social) fail(`${file} produced an incomplete derivative set`);
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

const manifest = parsePhotoManifest({
  version: 2,
  profile: photoProfile.version,
  album,
  photos,
}, 'generated photo manifest');
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

function loadPreviousManifest(input?: string): PreviousManifest | undefined {
  if (input) {
    const inputPath = path.resolve(input);
    try {
      return parsePreviousManifest(JSON.parse(readFileSync(inputPath, 'utf8')), inputPath);
    } catch (error) {
      fail(`Could not read the previous photo manifest: ${errorMessage(error)}`);
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

  let previous: PreviousManifest;
  const previousContents = readFileSync(previousPath, 'utf8');
  rmSync(previousPath, { force: true });
  try {
    previous = parsePreviousManifest(JSON.parse(previousContents), previousPath);
  } catch (error) {
    fail(`Could not read the previous photo manifest: ${errorMessage(error)}`);
  }

  return previous;
}

function parsePreviousManifest(input: unknown, source: string): PreviousManifest {
  if (input && typeof input === 'object' && !Array.isArray(input)
    && (input as Record<string, unknown>).version === 1) {
    const legacy = legacyPhotoManifestSchema.safeParse(input);
    if (!legacy.success) {
      const details = legacy.error.issues
        .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
        .join('; ');
      throw new Error(`${source} is invalid (${details})`);
    }
    console.warn(`Using legacy version 1 previous photo manifest: ${source}; output will migrate to version 2`);
    return legacy.data;
  }
  return parsePhotoManifest(input, source);
}

function variantsFrom(manifest?: PreviousManifest): Map<string, PhotoVariant> {
  const variants = new Map<string, PhotoVariant>();
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

async function remoteVariantDimensions(key: string): Promise<{ width: number; height: number }> {
  const destination = path.join(outputDirectory, '.existing', path.basename(key));
  mkdirSync(path.dirname(destination), { recursive: true });
  run('aws', ['s3', 'cp', `s3://${mediaBucket}/${key}`, destination, '--only-show-errors']);
  const metadata = await sharp(destination).metadata();
  rmSync(destination, { force: true });
  if (!metadata.width || !metadata.height) fail(`Could not read dimensions for existing media: ${key}`);
  return { width: metadata.width, height: metadata.height };
}

function parseArgs(values: string[]): BuildMediaArgs {
  const parsed: BuildMediaArgs = { noUpload: false, manifestOnly: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--no-upload') parsed.noUpload = true;
    else if (value === '--manifest-only') parsed.manifestOnly = true;
    else if (['--source', '--album', '--output', '--manifest', '--source-manifest', '--source-metadata', '--previous-manifest'].includes(value)) {
      const next = values[++index];
      if (!next) fail(`${value} requires a value`);
      parsed[toCamel(value.slice(2)) as keyof Omit<BuildMediaArgs, 'noUpload' | 'manifestOnly'>] = next;
    }
    else fail(`Unknown argument: ${value}`);
  }
  if (parsed.manifestOnly) parsed.noUpload = true;
  return parsed;
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
}

/** Identity is authored in album frontmatter, never derived here. */
function loadSourceManifest(input?: string): Map<string, string> {
  if (!input) fail('A source manifest is required through --source-manifest or PHOTO_SOURCE_MANIFEST_PATH');
  const manifestPath = path.resolve(input);
  if (!existsSync(manifestPath)) fail(`Source manifest does not exist: ${manifestPath}`);
  let parsed;
  try {
    parsed = parseSourceManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  } catch (error) {
    fail(`Could not read source manifest: ${errorMessage(error)}`);
  }
  return new Map(parsed.photos.map((photo) => [photo.file, photo.photoId]));
}

function requirePhotoId(file: string): string {
  const photoId = sourceManifest.get(file);
  if (!photoId) fail(`${file} has no photo ID in the source manifest. Rerun photos:push.`);
  return photoId;
}

function readSidecarShot(file: string): ShotMetadata | undefined {
  if (!sidecarDirectory) return undefined;
  const sidecar = path.join(path.resolve(sidecarDirectory), `${file}.json`);
  if (!existsSync(sidecar)) return undefined;
  try {
    return parseMetadataSidecar(JSON.parse(readFileSync(sidecar, 'utf8')), sidecar).shot;
  } catch (error) {
    fail(`Could not read metadata sidecar for ${file}: ${errorMessage(error)}`);
  }
}

function orientedDimensions(metadata: Metadata): { width: number; height: number } {
  if (!metadata.width || !metadata.height) fail('Could not read image dimensions');
  const swapsAxes = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

async function transform(source: string, destination: string, definition: DerivativeDefinition): Promise<Pick<OutputInfo, 'width' | 'height'>> {
  let pipeline = sharp(source).rotate().resize({ width: definition.width, withoutEnlargement: true });
  if (definition.format === 'avif') pipeline = pipeline.avif({ quality: definition.quality });
  if (definition.format === 'webp') pipeline = pipeline.webp({ quality: definition.quality });
  if (definition.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: definition.quality, mozjpeg: definition.mozjpeg });
  }
  const info = await pipeline.toFile(destination);
  return { width: info.width, height: info.height };
}

function listExistingKeys(sourceHash: string): Set<string> {
  if (!mediaBucket) fail('MEDIA_BUCKET is required to list existing media');
  const prefix = `media/${photoProfile.version}/${sourceHash.slice(0, 2)}/${sourceHash}/`;
  const result = runCapture('aws', [
    's3api', 'list-objects-v2', '--bucket', mediaBucket, '--prefix', prefix,
    '--query', 'Contents[].Key', '--output', 'json',
  ]);
  const parsed: unknown = JSON.parse(result || 'null');
  if (parsed === null) return new Set();
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    fail('aws returned a malformed media object listing');
  }
  return new Set(parsed);
}

function run(command: string, commandArgs: string[]): void {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runCapture(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(result.stderr.trim() || `${command} failed`);
  return result.stdout.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  console.error(`photos:build-media: ${message}`);
  process.exit(1);
}
