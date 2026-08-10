import { describe, expect, test } from 'bun:test';
import {
  parseMetadataSidecar,
  parsePhotoManifest,
  parseSourceManifest,
  type PhotoManifest,
} from './media';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const HASH = 'a'.repeat(64);
const variant = {
  width: 640,
  height: 427,
  src: `/media/photo-v1/aa/${HASH}/responsive-640-q80.webp`,
};

function manifest(): PhotoManifest {
  return {
    version: 2,
    profile: 'photo-v1',
    album: 'lost-coast',
    photos: [{
      photoId: PHOTO_ID,
      file: 'fog.jpg',
      sourceHash: HASH,
      width: 6000,
      height: 4000,
      shot: { camera: 'X-T5', capturedAt: '2026-08-09' },
      variants: {
        responsive: { avif: [variant], webp: [variant], jpeg: [variant] },
        lightbox: variant,
        social: variant,
      },
    }],
  };
}

describe('media contracts', () => {
  test('parses complete photo, source, and sidecar records', () => {
    expect(parsePhotoManifest(manifest()).photos[0]?.photoId).toBe(PHOTO_ID);
    expect(parseSourceManifest({
      version: 1,
      album: 'lost-coast',
      photos: [{ photoId: PHOTO_ID, file: 'fog.jpg' }],
    }).photos).toHaveLength(1);
    expect(parseMetadataSidecar({
      version: 1,
      photoId: PHOTO_ID,
      file: 'fog.jpg',
      shot: { iso: 400 },
      archive: { GPSLatitude: 40.1 },
    }).shot?.iso).toBe(400);
  });

  test('rejects malformed identifiers, hashes, and duplicates', () => {
    expect(() => parseSourceManifest({
      version: 1,
      album: 'lost-coast',
      photos: [{ photoId: 'photo_bad', file: 'fog.jpg' }],
    })).toThrow(/photo ID/);
    expect(() => parsePhotoManifest({
      ...manifest(),
      photos: [{ ...manifest().photos[0]!, sourceHash: 'short' }],
    })).toThrow(/SHA-256/);
    expect(() => parsePhotoManifest({
      ...manifest(),
      photos: [manifest().photos[0]!, manifest().photos[0]!],
    })).toThrow(/duplicates/);
    expect(() => parseMetadataSidecar({ version: 2, file: 'fog.jpg' })).toThrow(/version/);
  });

  test.each(['../fog.jpg', 'nested/fog.jpg', String.raw`nested\fog.jpg`, 'fog..jpg', 'fog.tiff']) (
    'rejects unsafe or unsupported filename %s',
    (file) => {
      expect(() => parseSourceManifest({
        version: 1,
        album: 'lost-coast',
        photos: [{ photoId: PHOTO_ID, file }],
      })).toThrow(/basename/);
      expect(() => parseMetadataSidecar({ version: 1, file })).toThrow(/basename/);
    },
  );

  test('accepts the legacy sidecar shape without a photo ID', () => {
    expect(parseMetadataSidecar({ version: 1, file: 'fog.jpg' })).toEqual({
      version: 1,
      file: 'fog.jpg',
    });
  });
});
