/** Build lossless, metadata-minimized fulfillment files for one album. */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exiftool } from 'exiftool-vendored';
import { parseMetadataSidecar, parseSourceManifest } from '../shared/media.ts';
import { archiveMetadata, fulfillmentMetadataRetain, shotMetadata } from './photo-metadata';

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

interface SanitizeArgs {
  source: string;
  output: string;
  metadata: string;
  sourceManifest?: string;
}

const args = parseArgs(process.argv.slice(2));
const sourceDirectory = path.resolve(args.source);
const outputDirectory = path.resolve(args.output);
const metadataDirectory = path.resolve(args.metadata);
const photoIds = args.sourceManifest ? loadPhotoIds(args.sourceManifest) : new Map();

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(metadataDirectory, { recursive: true });

// The source manifest, when given, is the album's published set. A removed
// photograph's file stays on disk, and staging it would put it back in the
// build.
const files = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .filter((file) => !args.sourceManifest || photoIds.has(file))
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));

try {
  await Promise.all(files.map(async (file) => {
    const source = path.join(sourceDirectory, file);
    const destination = path.join(outputDirectory, file);

    // Read the archive record from the source, before anything is stripped.
    const archive = await archiveMetadata(exiftool, source);
    const shot = await shotMetadata(source);
    const sidecar = parseMetadataSidecar(
      { version: 1, photoId: photoIds.get(file), file, shot, archive },
      `generated metadata sidecar for ${file}`,
    );
    writeFileSync(
      path.join(metadataDirectory, `${file}.json`),
      `${JSON.stringify(sidecar, null, 2)}\n`,
    );

    copyFileSync(source, destination);
    await exiftool.deleteAllTags(destination, { retain: fulfillmentMetadataRetain });
    rmSync(`${destination}_original`, { force: true });

    // Keep upload sync stable for unchanged sources: AWS compares size and
    // modification time, while --checksum-algorithm records SHA-256 on uploads.
    const sourceStat = statSync(source);
    utimesSync(destination, sourceStat.atime, sourceStat.mtime);
    console.log(`${file}: sanitized fulfillment metadata`);
  }));
} finally {
  await exiftool.end();
}

function parseArgs(values: string[]): SanitizeArgs {
  const parsed: Partial<SanitizeArgs> = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (['--source', '--output', '--metadata', '--source-manifest'].includes(value)) {
      const next = values[++index];
      if (!next) fail(`${value} requires a value`);
      parsed[toCamel(value.slice(2)) as keyof SanitizeArgs] = next;
    }
    else fail(`Unknown argument: ${value}`);
  }
  for (const field of ['source', 'output', 'metadata'] as const) {
    if (!parsed[field]) fail(`--${field} is required`);
  }
  return parsed as SanitizeArgs;
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
}

function loadPhotoIds(input: string): Map<string, string> {
  const manifestPath = path.resolve(input);
  const manifest = parseSourceManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), manifestPath);
  return new Map(manifest.photos.map((photo) => [photo.file, photo.photoId]));
}

function fail(message: string): never {
  console.error(`photos:sanitize: ${message}`);
  process.exit(1);
}
