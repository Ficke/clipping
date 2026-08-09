/** Build lossless, metadata-minimized fulfillment files for one album. */

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { exiftool } from 'exiftool-vendored';
import { archiveMetadata, fulfillmentMetadataRetain, shotMetadata } from './photo-metadata.mjs';

const supportedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const args = parseArgs(process.argv.slice(2));
const sourceDirectory = path.resolve(args.source);
const outputDirectory = path.resolve(args.output);
const metadataDirectory = path.resolve(args.metadata);

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(metadataDirectory, { recursive: true });

const files = readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase()))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));

try {
  await Promise.all(files.map(async (file) => {
    const source = path.join(sourceDirectory, file);
    const destination = path.join(outputDirectory, file);

    // Read the archive record from the source, before anything is stripped.
    const archive = await archiveMetadata(exiftool, source);
    const shot = await shotMetadata(source);
    writeFileSync(
      path.join(metadataDirectory, `${file}.json`),
      `${JSON.stringify({ version: 1, file, shot, archive }, null, 2)}\n`,
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (['--source', '--output', '--metadata'].includes(value)) {
      parsed[value.slice(2)] = values[++index];
    }
    else fail(`Unknown argument: ${value}`);
  }
  for (const field of ['source', 'output', 'metadata']) {
    if (!parsed[field]) fail(`--${field} is required`);
  }
  return parsed;
}

function fail(message) {
  console.error(`photos:sanitize: ${message}`);
  process.exit(1);
}
