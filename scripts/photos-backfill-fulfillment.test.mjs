import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checksumBase64 } from './photo-fulfillment.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'photos-backfill-test-'));
  temporaryDirectories.push(root);
  const albums = path.join(root, 'albums');
  const album = path.join(albums, 'album-folder');
  const bin = path.join(root, 'bin');
  const archive = path.join(root, 'archive.jpg');
  const log = path.join(root, 'aws.log');
  mkdirSync(album, { recursive: true });
  mkdirSync(bin);
  writeFileSync(archive, 'sanitized archive bytes');
  const sourceHash = createHash('sha256').update('sanitized archive bytes').digest('hex');
  writeFileSync(path.join(album, 'index.md'), [
    '---',
    'storyId: "backfill-test"',
    'title: "Backfill Test"',
    'date: 2099-01-01',
    'location: "Nowhere"',
    'photos:',
    '  - file: retained.jpg',
    '    forSale: true',
    '    price: 40',
    '  - file: catalog-only.jpg',
    '  - file: purged.jpg',
    '    catalog: false',
    '---',
    '',
  ].join('\n'));
  writeFileSync(path.join(album, 'photos.json'), JSON.stringify({
    version: 1,
    profile: 'photo-v1',
    album: 'backfill-test',
    photos: [
      { file: 'retained.jpg', sourceHash },
      { file: 'catalog-only.jpg', sourceHash },
      { file: 'purged.jpg', sourceHash: '0'.repeat(64) },
    ],
  }));
  return { root, albums, bin, archive, log, sourceHash };
}

function runBackfill(args, bin) {
  return spawnSync('bun', [path.join(import.meta.dir, 'photos-backfill-fulfillment.mjs'), ...args], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

describe('fulfillment backfill command', () => {
  test('dry-run verifies archived bytes and reports missing targets without writes', () => {
    const { albums, bin, archive, log, sourceHash } = fixture();
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
printf '%s ' "$@" >> ${JSON.stringify(log)}
printf '\n' >> ${JSON.stringify(log)}
if [ "$1 $2" = "s3 cp" ]; then cp ${JSON.stringify(archive)} "$4"; exit 0; fi
if [ "$1 $2" = "s3api head-object" ]; then echo "NoSuchKey" >&2; exit 1; fi
exit 99
`);
    chmodSync(fakeAws, 0o755);

    const result = runBackfill(['--dry-run', '--albums', albums, '--bucket', 'test-originals'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`WOULD_UPLOAD backfill-test/retained.jpg -> fulfillment/${sourceHash}.jpg`);
    expect(result.stdout).toContain('0 uploaded, 0 reused, 1 would upload, 0 failed');
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toContain('put-object');
    expect(calls).not.toContain('catalog-only.jpg');
    expect(calls).not.toContain('purged.jpg');
  });

  test('reuses a matching immutable target without overwriting it', () => {
    const { albums, bin, archive, log, sourceHash } = fixture();
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
printf '%s ' "$@" >> ${JSON.stringify(log)}
printf '\n' >> ${JSON.stringify(log)}
if [ "$1 $2" = "s3 cp" ]; then cp ${JSON.stringify(archive)} "$4"; exit 0; fi
if [ "$1 $2" = "s3api head-object" ]; then echo ${JSON.stringify(checksumBase64(sourceHash))}; exit 0; fi
exit 99
`);
    chmodSync(fakeAws, 0o755);

    const result = runBackfill(['--albums', albums, '--bucket', 'test-originals'], bin);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REUSED backfill-test/retained.jpg');
    expect(readFileSync(log, 'utf8')).not.toContain('put-object');
  });
});
