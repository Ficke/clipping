/** Build lossless, metadata-minimized fulfillment files for one album. */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exiftool } from 'exiftool-vendored';
import { exifSummary, fulfillmentMetadataRetain } from './photo-metadata.mjs';

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const args = parseArgs(process.argv.slice(2));
const sourceDirectory = path.resolve(args.source);
const outputDirectory = path.resolve(args.output);
const metadataPath = path.resolve(args.metadata);
const previousSummaries = loadPreviousSummaries(args.previousManifest);

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(path.dirname(metadataPath), { recursive: true });

const files = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));

const summaries = {};
try {
  await Promise.all(files.map(async (file) => {
    const source = path.join(sourceDirectory, file);
    const destination = path.join(outputDirectory, file);
    const summary = await exifSummary(source) ?? previousSummaries.get(file);
    if (summary) summaries[file] = summary;

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

writeFileSync(metadataPath, `${JSON.stringify({ version: 1, photos: summaries }, null, 2)}\n`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (['--source', '--output', '--metadata', '--previous-manifest'].includes(value)) {
      parsed[toCamel(value.slice(2))] = values[++index];
    }
    else fail(`Unknown argument: ${value}`);
  }
  for (const field of ['source', 'output', 'metadata']) {
    if (!parsed[field]) fail(`--${field} is required`);
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function loadPreviousSummaries(input) {
  if (!input || !existsSync(input)) return new Map();
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(input, 'utf8'));
  } catch (error) {
    fail(`Could not read previous manifest: ${error.message}`);
  }
  return new Map((manifest.photos ?? [])
    .filter((photo) => typeof photo.file === 'string' && typeof photo.exif === 'string')
    .map((photo) => [photo.file, photo.exif]));
}

function fail(message) {
  console.error(`photos:sanitize: ${message}`);
  process.exit(1);
}
