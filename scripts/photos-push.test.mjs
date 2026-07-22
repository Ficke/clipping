import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const temporaryDirectories = [];
const temporaryAlbums = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const directory of temporaryAlbums.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('photos push', () => {
  test('previews authoritative album updates without starting CodeBuild', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-update-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    const log = path.join(temporary, 'aws-args');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
      .jpeg().toFile(path.join(album, 'DSCF1.JPG'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.mjs'), album, '--dry-run',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Would rename DSCF1.JPG -> DSCF1.jpg');
    expect(result.stdout).toContain('Would build immutable media');
    expect(readFileSync(log, 'utf8')).toContain('--delete\n--checksum-algorithm\nSHA256\n--dryrun');
    expect(result.stdout).not.toContain('Starting adamficke-com-media');
    expect(existsSync(path.join(album, 'index.md'))).toBe(false);
    expect(existsSync(path.join(album, 'DSCF1.JPG'))).toBe(true);
  });
});
