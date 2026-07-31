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

const temporaryDirectories = [];

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
    const sourceMetadata = path.join(directory, 'source-metadata.json');
    const output = path.join(directory, 'output');
    await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: '#765432' },
    }).jpeg().toFile(path.join(directory, 'source.jpg'));
    mkdirSync(source);
    copyFileSync(path.join(directory, 'source.jpg'), path.join(source, 'DSCF10.jpg'));
    writeFileSync(sourceMetadata, JSON.stringify({
      version: 1,
      photos: { 'DSCF10.jpg': 'X-T5 · 50mm · f/5.6 · 1/500s · ISO 125' },
    }));

    const result = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.mjs'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', manifest,
      '--output', output,
      '--source-metadata', sourceMetadata,
      '--no-upload',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(parsed).toMatchObject({ version: 1, profile: 'photo-v1', album: '2026-08-test' });
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.photos[0]).toMatchObject({ file: 'DSCF10.jpg', width: 2400, height: 1600 });
    expect(parsed.photos[0].exif).toBe('X-T5 · 50mm · f/5.6 · 1/500s · ISO 125');
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

    buildManifest(source, manifest);
    const initialText = readFileSync(manifest, 'utf8');
    buildManifest(source, manifest);
    expect(readFileSync(manifest, 'utf8')).toBe(initialText);
    const initial = JSON.parse(initialText);
    const initialHash = initial.photos[0].sourceHash;

    await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#333333' } })
      .jpeg().toFile(path.join(source, 'one.jpg'));
    rmSync(path.join(source, 'two.jpg'));
    buildManifest(source, manifest);
    const updated = JSON.parse(readFileSync(manifest, 'utf8'));

    expect(updated.photos.map((photo) => photo.file)).toEqual(['one.jpg']);
    expect(updated.photos[0].sourceHash).not.toBe(initialHash);
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
    mkdirSync(source);
    mkdirSync(bin);
    await sharp({ create: { width: 2000, height: 1333, channels: 3, background: '#abcdef' } })
      .jpeg().toFile(path.join(source, 'photo.jpg'));

    const initial = spawnSync('bun', [
      path.join(import.meta.dir, 'photos-build-media.mjs'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', initialManifest,
      '--output', initialOutput,
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
      path.join(import.meta.dir, 'photos-build-media.mjs'),
      '--source', source,
      '--album', '2026-08-test',
      '--manifest', reusedManifest,
      '--output', reusedOutput,
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
});

function buildManifest(source, manifest) {
  const result = spawnSync('bun', [
    path.join(import.meta.dir, 'photos-build-media.mjs'),
    '--source', source,
    '--album', '2026-08-test',
    '--manifest', manifest,
    '--manifest-only',
  ], { encoding: 'utf8' });
  expect(result.status).toBe(0);
}

function filesBelow(directory) {
  if (!readdirSync(directory, { withFileTypes: true }).length) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(child) : [child];
  });
}

function allVariants(photo) {
  return [
    ...Object.values(photo.variants.responsive).flat(),
    photo.variants.lightbox,
    photo.variants.social,
  ];
}
