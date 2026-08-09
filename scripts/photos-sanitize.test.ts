import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ExifTool, type WriteTags } from 'exiftool-vendored';
import sharp from 'sharp';

const temporaryDirectories: string[] = [];

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
    const metadataDirectory = path.join(directory, 'metadata');
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
      } as WriteTags);

      const result = spawnSync('bun', [
        path.join(import.meta.dir, 'photos-sanitize.ts'),
        '--source', sourceDirectory,
        '--output', outputDirectory,
        '--metadata', metadataDirectory,
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

      const sidecar = JSON.parse(readFileSync(path.join(metadataDirectory, 'photo.jpg.json'), 'utf8'));
      expect(sidecar.shot).toEqual({
        camera: 'X-T5', focalLength: 50, aperture: 5.6, shutter: 0.002, iso: 125,
      });

      // What the master must not keep, the archive record must.
      expect(sidecar.archive.GPSLatitude).toBeCloseTo(37.75, 4);
      expect(sidecar.archive.UserComment).toBe('private workflow note');

      // A fresh clone pulls already-sanitized masters. Re-sanitizing one has no
      // metadata to find, which is why the push refuses to overwrite a sidecar
      // that came back empty.
      const secondOutput = path.join(directory, 'second-output');
      const secondMetadata = path.join(directory, 'second-metadata');
      const second = spawnSync('bun', [
        path.join(import.meta.dir, 'photos-sanitize.ts'),
        '--source', outputDirectory,
        '--output', secondOutput,
        '--metadata', secondMetadata,
      ], { encoding: 'utf8' });
      expect(second.status).toBe(0);
      const rescanned = JSON.parse(readFileSync(path.join(secondMetadata, 'photo.jpg.json'), 'utf8'));
      expect(rescanned.shot).toBeUndefined();
      expect(rescanned.archive.GPSLatitude).toBeUndefined();
    } finally {
      await exiftool.end();
    }
  }, 20_000);
});
