import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { orphanedTrees, treesFromKeys } from './photo-media.mjs';

const temporaryDirectories = [];
const liveHash = 'a'.repeat(64);
const deadHash = 'b'.repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * `keys` is what the fake `aws s3api list-objects-v2` will report the media
 * bucket contains; the album manifests are what is still in use.
 */
function fixture(keys, manifests) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'photos-gc-test-'));
  temporaryDirectories.push(directory);
  const albums = path.join(directory, 'albums');
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'aws-args');
  const listing = path.join(directory, 'keys.json');
  mkdirSync(bin);
  for (const [album, manifest] of Object.entries(manifests)) {
    mkdirSync(path.join(albums, album), { recursive: true });
    writeFileSync(path.join(albums, album, 'photos.json'), JSON.stringify(manifest));
  }
  mkdirSync(albums, { recursive: true });
  writeFileSync(listing, JSON.stringify(keys));

  const fakeAws = path.join(bin, 'aws');
  writeFileSync(fakeAws, `#!/bin/sh
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
if [ "$1 $2" = "s3api list-objects-v2" ]; then cat ${JSON.stringify(listing)}; fi
`);
  chmodSync(fakeAws, 0o755);

  const run = (extra = []) => spawnSync('bun', [
    path.join(import.meta.dir, 'photos-gc.mjs'), '--albums', albums, ...extra,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEDIA_BUCKET: 'media-bucket' },
  });

  // No log file at all means aws was never invoked, which several cases assert.
  return { run, calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

const manifest = (photos) => ({ version: 2, profile: 'photo-v1', photos });
const treeKeys = (hash) => [
  `media/photo-v1/${hash.slice(0, 2)}/${hash}/responsive-640-q80.webp`,
  `media/photo-v1/${hash.slice(0, 2)}/${hash}/lightbox-2000-q90.webp`,
];

describe('photo media cleanup', () => {
  test('removes trees the bucket has that no album references', () => {
    const { run, calls } = fixture(
      [...treeKeys(liveHash), ...treeKeys(deadHash)],
      { one: manifest([{ photoId: 'photo_aaaaaaaaaaaaaaaaaaaaaaaa', sourceHash: liveHash }]) },
    );

    const result = run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('removing 1 derivative tree');
    expect(calls()).toContain(`media/photo-v1/bb/${deadHash}/`);
    expect(calls()).not.toContain(liveHash);
  });

  /* A ledger of supersessions never learned about these: the photograph left
     its album, so nothing was left to record its history on. */
  test('collects the trees of a photograph that was removed from its album', () => {
    const { run, calls } = fixture(
      [...treeKeys(liveHash), ...treeKeys(deadHash)],
      {
        one: manifest([{ photoId: 'photo_aaaaaaaaaaaaaaaaaaaaaaaa', sourceHash: liveHash }]),
        two: manifest([]),
      },
    );

    expect(run().status).toBe(0);
    expect(calls()).toContain(`media/photo-v1/bb/${deadHash}/`);
  });

  test('a hash still used by another album is never collected', () => {
    const { run, calls } = fixture(treeKeys(liveHash), {
      one: manifest([]),
      two: manifest([{ photoId: 'photo_aaaaaaaaaaaaaaaaaaaaaaaa', sourceHash: liveHash }]),
    });

    expect(run().stdout).toContain('nothing obsolete');
    expect(calls()).not.toContain('s3\nrm');
  });

  /* Comparing a bucket against manifests that failed to load would delete the
     whole media bucket. Refusing is the only safe reading of "nothing is live". */
  test('refuses to compare when no manifest references any media', () => {
    const { run, calls } = fixture(treeKeys(liveHash), { one: manifest([]) });

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to compare');
    expect(calls()).not.toContain('rm');
  });

  test('--dry-run reports without deleting', () => {
    const { run, calls } = fixture(
      [...treeKeys(liveHash), ...treeKeys(deadHash)],
      { one: manifest([{ photoId: 'photo_aaaaaaaaaaaaaaaaaaaaaaaa', sourceHash: liveHash }]) },
    );

    expect(run(['--dry-run']).stdout).toContain('would remove 1 derivative tree');
    expect(calls()).not.toContain('rm');
  });
});

describe('media key grouping', () => {
  test('groups variant keys into one tree per source hash', () => {
    expect(treesFromKeys(treeKeys(liveHash))).toEqual([`media/photo-v1/aa/${liveHash}/`]);
  });

  /* An unparseable key must never become a deletion candidate. */
  test('ignores keys that are not a profile/shard/hash tree', () => {
    expect(treesFromKeys([
      'media/photo-v1/zz/nothash/x.webp',
      `media/photo-v1/ff/${liveHash}/x.webp`,
      'something-else.txt',
      'media/photo-v1/x.webp',
    ])).toEqual([]);
  });

  test('orphans are what the bucket has minus what the manifests use', () => {
    const manifests = [manifest([{ photoId: 'photo_a', sourceHash: liveHash }])];
    expect(orphanedTrees(manifests, [...treeKeys(liveHash), ...treeKeys(deadHash)]))
      .toEqual([`media/photo-v1/bb/${deadHash}/`]);
  });
});
