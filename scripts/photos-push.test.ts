import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { createPushPrompts } from './photos-push-prompts';

const temporaryDirectories: string[] = [];
const temporaryAlbums: string[] = [];
const PHOTO_ID = 'photo_aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ID = 'photo_bbbbbbbbbbbbbbbbbbbbbbbb';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const directory of temporaryAlbums.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('photos push', () => {
  test('shows both master sizes before confirming a replacement', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photos-push-prompt-test-'));
    const stagedFile = path.join(directory, 'photo.jpg');
    const logs = spyOn(console, 'log').mockImplementation(() => undefined);
    temporaryDirectories.push(directory);
    writeFileSync(stagedFile, 'new master bytes');

    try {
      const prompts = createPushPrompts({
        interactive: false,
        assumeYes: false,
        albumsRoot: path.join(directory, 'albums'),
      });
      expect(await prompts.confirmReplacement('photo.jpg', PHOTO_ID, stagedFile, 331_873)).toBe(false);
      const output = logs.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(output).toContain('current: 331873 bytes');
      expect(output).toContain('new: 16 bytes');
    } finally {
      logs.mockRestore();
    }
  });

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
    writeFileSync(fakeAws, `#!/bin/sh\nprintf '%s ' "$@" >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\n`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--dry-run',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Would rename DSCF1.JPG -> DSCF1.jpg');
    expect(result.stdout).toContain('Would build immutable media');
    const awsCalls = readFileSync(log, 'utf8');
    expect(awsCalls).toContain('source.json');
    expect(awsCalls).toContain('--dryrun');
    // Nothing a push does may delete: removal is its own deliberate command.
    expect(awsCalls).not.toContain('--delete');
    expect(result.stdout).not.toContain('Starting adamficke-com-media');
    expect(existsSync(path.join(album, 'index.md'))).toBe(false);
    expect(existsSync(path.join(album, 'DSCF1.JPG'))).toBe(true);
  });

  test('polls CodeBuild until media publishing succeeds', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-publish-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    const log = path.join(temporary, 'aws-args');
    const polls = path.join(temporary, 'polls');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
      .jpeg().toFile(path.join(album, 'photo.jpg'));
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "publish-test"',
      'title: "Publish Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: photo.jpg',
      `    photoId: ${PHOTO_ID}`,
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
printf '%s ' "$@" >> ${JSON.stringify(log)}
printf '\n' >> ${JSON.stringify(log)}
if [ "$1 $2" = "codebuild start-build" ]; then
  printf 'fake-build-id\n'
elif [ "$1 $2" = "codebuild batch-get-builds" ]; then
  count=0
  [ -f ${JSON.stringify(polls)} ] && count=$(cat ${JSON.stringify(polls)})
  count=$((count + 1))
  printf '%s' "$count" > ${JSON.stringify(polls)}
  if [ "$count" -eq 1 ]; then printf 'IN_PROGRESS\n'; else printf 'SUCCEEDED\n'; fi
elif [ "$1 $2" = "s3 cp" ] && printf '%s' "$3" | grep -q '/manifests/'; then
  printf '{"album":"test","photos":[]}' > "$4"
fi
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PHOTO_BUILD_POLL_INTERVAL_MS: '1',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Waiting for fake-build-id');
    expect(readFileSync(polls, 'utf8')).toBe('2');
    expect(readFileSync(log, 'utf8')).not.toContain('codebuild wait');
    expect(readFileSync(log, 'utf8')).toContain(`photos/${PHOTO_ID}`);
    expect(readFileSync(log, 'utf8')).toContain('manifests/publish-test/source.json');
    expect(existsSync(path.join(album, 'photos.json'))).toBe(true);
  });

  test('scaffolds a new album with today as its published date', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-scaffold-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#abcdef' } })
      .jpeg().toFile(path.join(album, 'photo.jpg'));
    // No index.md: this exercises the scaffold path rather than reconciliation.
    const fakeAws = path.join(bin, 'aws');
    // A first push has no previous manifest in S3; real aws exits non-zero.
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404) when calling HeadObject: Not Found" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local', '--yes',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const index = readFileSync(path.join(album, 'index.md'), 'utf8');
    // Written unconditionally so a late post can never backdate itself out of
    // the feed by falling back to the trip date.
    expect(index).toContain(`published: ${new Date().toISOString().slice(0, 10)}`);
  });

  test('builds media locally instead of starting CodeBuild', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-local-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    const log = path.join(temporary, 'aws-args');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#654321' } })
      .jpeg().toFile(path.join(album, 'photo.jpg'));
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "local-test"',
      'title: "Local Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: photo.jpg',
      `    photoId: ${PHOTO_ID}`,
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    // A first push has no previous manifest in S3; real aws exits non-zero.
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
printf '%s ' "$@" >> ${JSON.stringify(log)}
printf '\\n' >> ${JSON.stringify(log)}
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404) when calling HeadObject: Not Found" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local', '--yes',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Building local-test locally');
    expect(existsSync(path.join(album, 'photos.json'))).toBe(true);
    const awsCalls = readFileSync(log, 'utf8');
    expect(awsCalls).not.toContain('codebuild start-build');
    // Variants and the manifest still reach the same buckets CodeBuild uses.
    expect(awsCalls).toContain('adamficke-com-media');
    expect(awsCalls).toContain('manifests/local-test/photos.json');
  });

  test('asks whether each newly added photo is for sale and records its price', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-new-sale-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    for (const file of ['existing.jpg', 'new.jpg']) {
      await sharp({ create: { width: 30, height: 20, channels: 3, background: '#234567' } })
        .jpeg().toFile(path.join(album, file));
    }
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "new-sale-test"',
      'title: "New Sale Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: existing.jpg',
      `    photoId: ${PHOTO_ID}`,
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404)" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local',
    ], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PHOTOS_PUSH_PROMPT: '1' },
      input: '55\n',
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Store settings for 1 new photo');
    const rewritten = readFileSync(path.join(album, 'index.md'), 'utf8');
    expect(rewritten).toMatch(/ {2}- file: new\.jpg\n {4}photoId: photo_[a-f0-9]{24}\n {4}price: 55/);
    expect(rewritten).not.toContain('  - file: existing.jpg\n    price');
  });

  test('keeps per-photo sale settings across a push', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-forsale-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    for (const file of ['a.jpg', 'b.jpg', 'c.jpg']) {
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
        .jpeg().toFile(path.join(album, file));
    }
    // c.jpg is new, so the list is rewritten — a.jpg's opt-out and b.jpg's
    // opt-in have to survive that rewrite.
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "forsale-test"',
      'title: "For Sale Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: a.jpg',
      `    photoId: ${PHOTO_ID}`,
      '  - file: b.jpg',
      `    photoId: ${OTHER_ID}`,
      '    caption: "Kept."',
      '    price: 55',
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404)" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local', '--yes',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const rewritten = readFileSync(path.join(album, 'index.md'), 'utf8');
    expect(rewritten).toContain(`  - file: a.jpg\n    photoId: ${PHOTO_ID}`);
    expect(rewritten).toContain(`  - file: b.jpg\n    photoId: ${OTHER_ID}\n    caption: "Kept."\n    price: 55`);
    // Non-interactive pushes safely default new files to not for sale.
    expect(rewritten).toMatch(/ {2}- file: c\.jpg\n {4}photoId: photo_[a-f0-9]{24}\n/);
    expect(rewritten).not.toContain('  - file: c.jpg\n    photoId: photo_aaaa');
  });

  test('refuses to push when a photograph vanished from the folder', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-reconcile-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    for (const file of ['a.jpg', 'b.jpg']) {
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
        .jpeg().toFile(path.join(album, file));
    }
    // A missing live file must not discard its identity or archived bytes.
    rmSync(path.join(album, 'b.jpg'));
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "reconcile-test"',
      'title: "Reconcile Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: a.jpg',
      `    photoId: ${PHOTO_ID}`,
      '    caption: "Kept."',
      '  - file: b.jpg',
      `    photoId: ${OTHER_ID}`,
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--dry-run',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('b.jpg is missing from the album folder');
    expect(result.stderr).toContain('photos:remove');
    expect(readFileSync(path.join(album, 'index.md'), 'utf8')).toContain('  - file: b.jpg');
  });

  test('keeps removed photographs listed and adds new files around them', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-removed-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    for (const file of ['a.jpg', 'c.jpg']) {
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
        .jpeg().toFile(path.join(album, file));
    }
    // b.jpg was removed, so its file is gone but its record must survive, and
    // it must not come back as a new photo with a fresh ID.
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "removed-test"',
      'title: "Removed Test"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: a.jpg',
      `    photoId: ${PHOTO_ID}`,
      '  - file: b.jpg',
      `    photoId: ${OTHER_ID}`,
      '    removed: 2099-01-02',
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404)" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local', '--yes',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const rewritten = readFileSync(path.join(album, 'index.md'), 'utf8');
    expect(rewritten).toContain(`  - file: b.jpg\n    photoId: ${OTHER_ID}\n    removed: 2099-01-02`);
    expect(rewritten).toMatch(/ {2}- file: c\.jpg\n {4}photoId: photo_[a-f0-9]{24}/);
    // The removed photograph is not rebuilt, so it stays out of the manifest.
    const manifest = JSON.parse(readFileSync(path.join(album, 'photos.json'), 'utf8')) as {
      photos: Array<{ file: string }>;
    };
    expect(manifest.photos.map((photo) => photo.file)).toEqual(['a.jpg', 'c.jpg']);
  });

  /* photos:remove leaves the file on disk, so the next push has to skip the
     photograph rather than treat a present file as intent to publish. */
  test('publishes from frontmatter, not the folder, after a removal', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-afterremove-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    const log = path.join(temporary, 'aws-args');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    for (const file of ['a.jpg', 'b.jpg']) {
      await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
        .jpeg().toFile(path.join(album, file));
    }
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "afterremove-test"',
      'title: "After Remove"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: a.jpg',
      `    photoId: ${PHOTO_ID}`,
      '  - file: b.jpg',
      `    photoId: ${OTHER_ID}`,
      '    removed: 2099-01-02',
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3api head-object" ]; then echo "An error occurred (404): Not Found" >&2; exit 1; fi
printf '%s ' "$@" >> ${JSON.stringify(log)}
printf '\n' >> ${JSON.stringify(log)}
if [ "$1 $2" = "s3 cp" ]; then
  case "$3" in
    s3://*manifests*) echo "An error occurred (404)" >&2; exit 1 ;;
  esac
fi
exit 0
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--local', '--yes',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Publishing 1 master');
    const awsCalls = readFileSync(log, 'utf8');
    expect(awsCalls).toContain(`photos/${PHOTO_ID}`);
    expect(awsCalls).not.toContain(`photos/${OTHER_ID}`);
  });

  test('refuses a storyId that would escape the archive prefix', async () => {
    const repoRoot = path.resolve(import.meta.dir, '..');
    const album = path.join(repoRoot, 'content', 'albums', `2099-01-badid-test-${process.pid}`);
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'photos-push-test-'));
    const bin = path.join(temporary, 'bin');
    temporaryAlbums.push(album);
    temporaryDirectories.push(temporary);
    mkdirSync(album);
    mkdirSync(bin);
    await sharp({ create: { width: 20, height: 10, channels: 3, background: '#123456' } })
      .jpeg().toFile(path.join(album, 'a.jpg'));
    // storyId becomes an S3 key prefix and the ALBUM_ID build variable, so a
    // traversal here would point the sync at a different prefix entirely.
    writeFileSync(path.join(album, 'index.md'), [
      '---',
      'storyId: "../../evil"',
      'title: "Bad Id"',
      'date: 2099-01-01',
      'location: "Nowhere"',
      'photos:',
      '  - file: a.jpg',
      `    photoId: ${PHOTO_ID}`,
      '---',
      '',
    ].join('\n'));
    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-push.ts'), album, '--dry-run',
    ], { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must be lowercase letters and digits');
    expect(result.stdout).not.toContain('Previewing');
  });
});
