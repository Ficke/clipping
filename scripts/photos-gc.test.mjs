import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('photo media cleanup', () => {
  test('deletes only obsolete hashes not used by any committed manifest', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photos-gc-test-'));
    temporaryDirectories.push(directory);
    const albums = path.join(directory, 'albums');
    const bin = path.join(directory, 'bin');
    const log = path.join(directory, 'aws-args');
    mkdirSync(path.join(albums, 'one'), { recursive: true });
    mkdirSync(path.join(albums, 'two'), { recursive: true });
    mkdirSync(bin);
    const liveHash = 'a'.repeat(64);
    const deadHash = 'b'.repeat(64);
    writeFileSync(path.join(albums, 'one', 'photos.json'), JSON.stringify({
      profile: 'photo-v1',
      photos: [{ sourceHash: liveHash }],
      obsoleteMedia: [
        { profile: 'photo-v1', sourceHash: liveHash },
        { profile: 'photo-v1', sourceHash: deadHash },
      ],
    }));
    writeFileSync(path.join(albums, 'two', 'photos.json'), JSON.stringify({
      profile: 'photo-v1', photos: [{ sourceHash: liveHash }],
    }));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh\nprintf '%s\n' "$@" >> ${JSON.stringify(log)}\n`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-gc.mjs'), '--albums', albums,
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEDIA_BUCKET: 'media-bucket' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('removing 1 derivative tree');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain(`media/photo-v1/bb/${deadHash}/`);
    expect(calls).not.toContain(liveHash);
  });
});
