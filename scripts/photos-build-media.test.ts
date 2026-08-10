import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import type { PhotoManifestEntry, PhotoVariant } from '../shared/media';

const temporaryDirectories: string[] = [];
const PHOTO_ID = 'photo_1234567890abcdef12345678';
const ONE_ID = 'photo_aaaaaaaaaaaaaaaaaaaaaaaa';
const TWO_ID = 'photo_bbbbbbbbbbbbbbbbbbbbbbbb';

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('media manifest builder', () => {
  test('creates a deterministic manifest without AWS access', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-media-test-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'album');
    const manifest = path.join(directory, 'photos.json');
    const sourceManifest = path.join(directory, 'source.json');
    const metadataDirectory = path.join(directory, 'metadata');
    const output = path.join(directory, 'output');
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: '#765432' },
    }).jpeg().toFile(path.join(directory, 'source.jpg'));
    mkdirSync(source);
    copyFileSync(path.join(directory, 'source.jpg'), path.join(source, 'DSCF10.jpg'));
    mkdirSync(metadataDirectory);
    writeFileSync(sourceManifest, sourceManifestFor({ 'DSCF10.jpg': PHOTO_ID }));
    writeFileSync(path.join(metadataDirectory, 'DSCF10.jpg.json'), JSON.stringify({
      version: 1,
      file: 'DSCF10.jpg',
      shot: { camera: 'X-T5', focalLength: 50, aperture: 5.6, shutter: 0.002, iso: 125 },
    }));

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', manifest,
      '--output', output,
      '--source-manifest', sourceManifest,
      '--source-metadata', metadataDirectory,
      '--no-upload',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(parsed).toMatchObject({ version: 2, profile: 'photo-v1', album: '2026-08-test' });
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.photos[0]).toMatchObject({
      photoId: PHOTO_ID, file: 'DSCF10.jpg', width: 2400, height: 1600,
    });
    expect(parsed.photos[0].shot).toEqual({
      camera: 'X-T5', focalLength: 50, aperture: 5.6, shutter: 0.002, iso: 125,
    });
    expect(parsed.photos[0].variants.responsive.avif).toHaveLength(4);
    expect(parsed.photos[0].variants.lightbox.src).toMatch(/^\/media\/photo-v1\//);
    expect(parsed.photos[0].variants.social.width).toBe(1200);
    expect(filesBelow(output)).toHaveLength(14);
  });

  test('updates hashes and removes photos from regenerated manifests', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-media-update-test-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'album');
    const manifest = path.join(directory, 'photos.json');
    mkdirSync(source);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#111111' } })
      .jpeg().toFile(path.join(source, 'one.jpg'));
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#222222' } })
      .jpeg().toFile(path.join(source, 'two.jpg'));

    const previousManifest = path.join(directory, 'previous.json');
    buildManifest(source, manifest);
    const initialText = readFileSync(manifest, 'utf8');
    writeFileSync(previousManifest, initialText);
    buildManifest(source, manifest);
    expect(readFileSync(manifest, 'utf8')).toBe(initialText);
    const initial = JSON.parse(initialText);
    const initialHash = initial.photos[0].sourceHash;

    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#333333' } })
      .jpeg().toFile(path.join(source, 'one.jpg'));
    rmSync(path.join(source, 'two.jpg'));
    buildManifest(source, manifest, previousManifest);
    const updated = JSON.parse(readFileSync(manifest, 'utf8')) as { photos: Array<{ file: string; sourceHash: string }> };

    expect(updated.photos.map((photo) => photo.file)).toEqual(['one.jpg']);
    expect(updated.photos[0].sourceHash).not.toBe(initialHash);
    /* The manifest records only live media; bucket comparison finds superseded
       and departed trees. */
    expect(updated).not.toHaveProperty('obsoleteMedia');
    expect(updated.photos[0]).not.toHaveProperty('previousHashes');
  });

  test('reuses actual dimensions from the published manifest', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-media-reuse-test-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'album');
    const initialManifest = path.join(directory, 'initial.json');
    const reusedManifest = path.join(directory, 'reused.json');
    const initialOutput = path.join(directory, 'initial-output');
    const reusedOutput = path.join(directory, 'reused-output');
    const bin = path.join(directory, 'bin');
    const keys = path.join(directory, 'keys.json');
    const sourceManifest = path.join(directory, 'source.json');
    mkdirSync(source);
    mkdirSync(bin);
    writeFileSync(sourceManifest, sourceManifestFor({ 'photo.jpg': PHOTO_ID }));
    await sharp({ create: { width: 2000, height: 1333, channels: 3, background: '#abcdef' } })
      .jpeg().toFile(path.join(source, 'photo.jpg'));

    const initial = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', initialManifest,
      '--output', initialOutput,
      '--source-manifest', sourceManifest,
      '--no-upload',
    ], { encoding: 'utf8' });
    expect(initial.status).toBe(0);
    const parsed = JSON.parse(readFileSync(initialManifest, 'utf8'));
    const variants = allVariants(parsed.photos[0]);
    writeFileSync(keys, JSON.stringify(variants.map((variant) => variant.src.slice(1))));

    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3 cp" ] && printf '%s' "$3" | grep -q '/manifests/'; then
  cp ${JSON.stringify(initialManifest)} "$4"
elif [ "$1 $2" = "s3api list-objects-v2" ]; then
  cat ${JSON.stringify(keys)}
fi
`);
    chmodSync(fakeAws, 0o755);

    const reused = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', reusedManifest,
      '--output', reusedOutput,
      '--source-manifest', sourceManifest,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MEDIA_BUCKET: 'media-bucket',
        MANIFEST_BUCKET: 'manifest-bucket',
      },
    });

    expect(reused.status).toBe(0);
    expect(reused.stdout).toContain('Variants: 0 generated, 14 reused');
    expect(readFileSync(reusedManifest, 'utf8')).toBe(readFileSync(initialManifest, 'utf8'));
    expect(filesBelow(reusedOutput)).toHaveLength(0);
  });

  test('rebuilds when the remote previous manifest uses the legacy format', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-media-legacy-test-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'album');
    const manifest = path.join(directory, 'photos.json');
    const output = path.join(directory, 'output');
    const sourceManifest = path.join(directory, 'source.json');
    const legacyManifest = path.join(directory, 'legacy.json');
    const seedManifest = path.join(directory, 'seed.json');
    const seedOutput = path.join(directory, 'seed-output');
    const bin = path.join(directory, 'bin');
    mkdirSync(source);
    mkdirSync(bin);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#abcdef' } })
      .jpeg().toFile(path.join(source, 'photo.jpg'));
    writeFileSync(sourceManifest, sourceManifestFor({ 'photo.jpg': PHOTO_ID }));
    const seeded = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', seedManifest,
      '--output', seedOutput,
      '--source-manifest', sourceManifest,
      '--no-upload',
    ], { encoding: 'utf8' });
    expect(seeded.status).toBe(0);
    const legacy = JSON.parse(readFileSync(seedManifest, 'utf8'));
    legacy.version = 1;
    for (const photo of legacy.photos) delete photo.photoId;
    writeFileSync(legacyManifest, JSON.stringify(legacy));

    const fakeAws = path.join(bin, 'aws');
    writeFileSync(fakeAws, `#!/bin/sh
if [ "$1 $2" = "s3 cp" ] && printf '%s' "$3" | grep -q '/manifests/'; then
  cp ${JSON.stringify(legacyManifest)} "$4"
elif [ "$1 $2" = "s3api list-objects-v2" ]; then
  printf 'null\n'
fi
`);
    chmodSync(fakeAws, 0o755);

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', manifest,
      '--output', output,
      '--source-manifest', sourceManifest,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MEDIA_BUCKET: 'media-bucket',
        MANIFEST_BUCKET: 'manifest-bucket',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Using legacy version 1 previous photo manifest');
    expect(result.stderr).toContain('output will migrate to version 2');
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({
      version: 2,
      photos: [{ photoId: PHOTO_ID, file: 'photo.jpg' }],
    });
  });

  test('rejects a malformed legacy previous manifest', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-media-bad-legacy-test-'));
    temporaryDirectories.push(directory);
    const source = path.join(directory, 'album');
    const manifest = path.join(directory, 'photos.json');
    const sourceManifest = path.join(directory, 'source.json');
    const previousManifest = path.join(directory, 'legacy.json');
    mkdirSync(source);
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#abcdef' } })
      .jpeg().toFile(path.join(source, 'photo.jpg'));
    writeFileSync(sourceManifest, sourceManifestFor({ 'photo.jpg': PHOTO_ID }));
    writeFileSync(previousManifest, JSON.stringify({
      version: 1,
      profile: 'photo-v1',
      album: '2026-08-test',
      photos: [{ file: 'photo.jpg', sourceHash: 'a'.repeat(64) }],
    }));

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.ts'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', manifest,
      '--source-manifest', sourceManifest,
      '--previous-manifest', previousManifest,
      '--manifest-only',
    ], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not read the previous photo manifest');
    expect(result.stderr).toContain('photos.0.width');
  });
});

function buildManifest(source: string, manifest: string, previousManifest?: string): void {
  const sourceManifest = path.join(path.dirname(manifest), 'build-source.json');
  writeFileSync(sourceManifest, sourceManifestFor({ 'one.jpg': ONE_ID, 'two.jpg': TWO_ID }));
  const result = spawnSync('bun', [
    path.join(import.meta.dir, 'photos-build-media.ts'),
    '--source', source,
    '--album', '2026-08-test',
    '--manifest', manifest,
    '--source-manifest', sourceManifest,
    '--manifest-only',
    ...(previousManifest ? ['--previous-manifest', previousManifest] : []),
  ], { encoding: 'utf8' });
  expect(result.status).toBe(0);
}

function sourceManifestFor(idsByFile: Record<string, string>): string {
  const photos = Object.entries(idsByFile).map(([file, photoId]) => ({ photoId, file }));
  return JSON.stringify({ version: 1, album: '2026-08-test', photos });
}

function filesBelow(directory: string): string[] {
  if (!readdirSync(directory, { withFileTypes: true }).length) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

function allVariants(photo: PhotoManifestEntry): PhotoVariant[] {
  return [
    ...Object.values(photo.variants.responsive).flat(),
    photo.variants.lightbox,
    photo.variants.social,
  ];
}
