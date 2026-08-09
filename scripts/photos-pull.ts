/**
 * Restore album folders from S3.
 *
 * Masters are keyed by photo ID, so the committed frontmatter is what maps them
 * back to filenames. What lands is the sanitized master, not the original
 * export: capture metadata was stripped on the way up and lives in the
 * `metadata/` sidecars.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { masterKey } from '../src/lib/downloads.ts';
import {
  albumIndexes,
  frontmatterValue,
  readPhotosBlock,
  resolveAlbumIndex,
  splitFrontmatter,
} from './photo-frontmatter';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const albumsRoot = path.join(repoRoot, 'content', 'albums');
const originalsBucket = process.env.ORIGINALS_BUCKET ?? 'adamficke-com-originals';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const dryRun = args.includes('--dry-run');
const positional = args.filter((arg) => !arg.startsWith('--'));
if (positional.length > 1) fail('Usage: bun run photos:pull -- [album] [--dry-run]');

let indexes;
try {
  indexes = positional.length ? [resolveAlbumIndex(albumsRoot, positional[0])] : albumIndexes(albumsRoot);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

let pulled = 0;
for (const indexPath of indexes) {
  const contents = readFileSync(indexPath, 'utf8');
  const album = frontmatterValue(contents, 'storyId');
  const directory = path.dirname(indexPath);
  const { lines } = splitFrontmatter(contents, directory);
  const live = readPhotosBlock(lines).entries.filter((entry) => !entry.removed);
  if (!live.length) continue;

  console.log(`${dryRun ? 'Would pull' : 'Pulling'} ${live.length} photo${live.length === 1 ? '' : 's'} for ${album}`);
  if (!dryRun) mkdirSync(directory, { recursive: true });
  for (const entry of live) {
    const destination = path.join(directory, entry.file);
    if (dryRun) {
      console.log(`  ${masterKey(entry.photoId)} -> ${path.relative(repoRoot, destination)}`);
      continue;
    }
    aws(['s3', 'cp', `s3://${originalsBucket}/${masterKey(entry.photoId)}`, destination, '--only-show-errors']);
    pulled++;
  }
}

console.log(dryRun ? 'Dry run: nothing written' : `Pulled ${pulled} photo${pulled === 1 ? '' : 's'}`);

function aws(commandArgs: string[]): void {
  const result = spawnSync('aws', commandArgs, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) fail(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) fail(`aws ${commandArgs[1]} failed`);
}

function fail(message: string): never {
  console.error(`photos:pull: ${message}`);
  process.exit(1);
}
