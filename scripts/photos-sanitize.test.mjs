import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExifTool } from 'exiftool-vendored';
import sharp from 'sharp';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('fulfillment metadata sanitizer', () => {
  test('is pixel-lossless and retains only color and copyright metadata', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-sanitize-test-'));
    temporaryDirectories.push(directory);
    const sourceDirectory = path.join(directory, 'source');
    const outputDirectory = path.join(directory, 'output');
    const source = path.join(sourceDirectory, 'photo.jpg');
    const output = path.join(outputDirectory, 'photo.jpg');
    const metadata = path.join(directory, 'source-metadata.json');
    mkdirSync(sourceDirectory);

    await sharp({ create: { width: 40, height: 30, channels: 3, background: '#d04080' } })
      .withIccProfile('srgb')
      .jpeg({ quality: 95 })
      .toFile(source);

    const exiftool = new ExifTool({ maxProcs: 1 });
    try {
      await exiftool.write(source, {
        'EXIF:Model': 'X-T5',
        'EXIF:FNumber': 5.6,
        'EXIF:FocalLength': 50,
        'EXIF:ExposureTime': 0.002,
        'EXIF:ISO': 125,
        'EXIF:GPSLatitude': 37.75,
        'EXIF:GPSLongitude': -122.45,
        'EXIF:Copyright': 'Copyright Adam Ficke',
        'EXIF:Artist': 'Adam Ficke',
        'EXIF:UserComment': 'private workflow note',
      });

      const result = spawnSync('bun', [
        path.join(import.meta.dir, 'photos-sanitize.mjs'),
        '--source', sourceDirectory,
        '--output', outputDirectory,
        '--metadata', metadata,
      ], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      const tags = await exiftool.read(output);
      expect(tags.Copyright).toBe('Copyright Adam Ficke');
      expect(tags.Artist).toBe('Adam Ficke');
      expect(tags.ICCProfileName ?? tags.ProfileDescription).toBeTruthy();
      expect(tags.Model).toBeUndefined();
      expect(tags.GPSLatitude).toBeUndefined();
      expect(tags.GPSLongitude).toBeUndefined();
      expect(tags.UserComment).toBeUndefined();

      const beforePixels = await sharp(source).raw().toBuffer();
      const afterPixels = await sharp(output).raw().toBuffer();
      expect(afterPixels.equals(beforePixels)).toBe(true);

      const sidecar = JSON.parse(readFileSync(metadata, 'utf8'));
      expect(sidecar).toEqual({
        version: 1,
        photos: { 'photo.jpg': 'X-T5 · 50mm · f/5.6 · 1/500s · ISO 125' },
      });

      // A fresh clone may pull the already-sanitized archive. Preserve the
      // approved gallery line from its committed manifest on the next push.
      const secondOutput = path.join(directory, 'second-output');
      const secondMetadata = path.join(directory, 'second-source-metadata.json');
      const previousManifest = path.join(directory, 'photos.json');
      writeFileSync(previousManifest, JSON.stringify({
        photos: [{ file: 'photo.jpg', exif: sidecar.photos['photo.jpg'] }],
      }));
      const second = spawnSync('bun', [
        path.join(import.meta.dir, 'photos-sanitize.mjs'),
        '--source', outputDirectory,
        '--output', secondOutput,
        '--metadata', secondMetadata,
        '--previous-manifest', previousManifest,
      ], { encoding: 'utf8' });
      expect(second.status).toBe(0);
      expect(JSON.parse(readFileSync(secondMetadata, 'utf8'))).toEqual(sidecar);
    } finally {
      await exiftool.end();
    }
  }, 20_000);
});
