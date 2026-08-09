import { describe, expect, test } from 'bun:test';
import {
  catalogItem,
  contentTypeFor,
  downloadFilename,
  formatPrice,
  generatePhotoId,
  isPhotoId,
  licenseTerms,
  licenseTier,
  masterKey,
  metadataKey,
  normalizeExtension,
  type DownloadCatalog,
} from './downloads';

describe('license tiers', () => {
  test('every product has a summary and both halves of the grant', () => {
    for (const tier of [licenseTier('personal')!]) {
      expect(tier.summary.length).toBeGreaterThan(0);
      expect(tier.grants.length).toBeGreaterThan(0);
      expect(tier.restrictions.length).toBeGreaterThan(0);
    }
  });

  test('licenseTerms states both halves and who holds the copyright', () => {
    const terms = licenseTerms(licenseTier('personal')!);

    expect(terms).toContain('You may keep the downloaded file');
    expect(terms).toContain('You may not sell');
    expect(terms).toContain('Copyright remains with Adam Ficke.');
  });

  test('unknown tiers resolve to undefined rather than a default', () => {
    expect(licenseTier('commercial')).toBeUndefined();
  });
});

describe('prices', () => {
  test('drops trailing zeroes on whole dollars', () => {
    expect(formatPrice(4000)).toBe('$40');
  });

  test('keeps cents when they are not round', () => {
    expect(formatPrice(3950)).toBe('$39.50');
  });
});

describe('photo IDs', () => {
  test('mints opaque IDs that do not collide', () => {
    const ids = new Set(Array.from({ length: 500 }, generatePhotoId));

    expect(ids.size).toBe(500);
    for (const id of ids) expect(isPhotoId(id)).toBe(true);
  });

  /* Identity must not track the bytes: re-exporting a photograph at a higher
     resolution has to keep every already-issued download link working. */
  test('minting is independent of any file content', () => {
    expect(generatePhotoId()).not.toBe(generatePhotoId());
    expect(isPhotoId('photo_not-a-hash')).toBe(false);
    expect(isPhotoId(`photo_${'A'.repeat(24)}`)).toBe(false);
  });
});

describe('object keys', () => {
  const photoId = 'photo_1234567890abcdef12345678';

  test('the ID alone names the master, so redemption needs no lookup', () => {
    expect(masterKey(photoId)).toBe(`photos/${photoId}`);
  });

  /* Sidecars carry GPS, and the buyer Lambda is granted only `photos/*`. */
  test('metadata lives under a prefix the buyer Lambda cannot reach', () => {
    expect(metadataKey(photoId)).toBe(`metadata/${photoId}.json`);
    expect(metadataKey(photoId)).not.toStartWith('photos/');
  });

  test('refuses to build a key from anything that is not a photo ID', () => {
    expect(() => masterKey('../etc/passwd')).toThrow(/invalid photo ID/);
    expect(() => metadataKey('../etc/passwd')).toThrow(/invalid photo ID/);
  });
});

describe('stored download response', () => {
  test('normalizes the extension and maps it to a content type', () => {
    expect(normalizeExtension('DSCF1250.JPEG')).toBe('jpeg');
    expect(contentTypeFor('jpeg')).toBe('image/jpeg');
    expect(contentTypeFor('webp')).toBe('image/webp');
    expect(() => normalizeExtension('photo.tiff')).toThrow(/Unsupported file extension/);
  });

  test('names the file by opaque ID, never by album or original filename', () => {
    const name = downloadFilename('photo_3bb6020b3147d062d1f528ce', 'jpg');

    expect(name).toBe('adam-ficke-photo_3bb6020b3147d062d1f528ce.jpg');
    expect(name).not.toContain('Olympics');
    expect(name).not.toContain('DSCF7640');
  });
});

describe('catalog lookup', () => {
  const catalog: DownloadCatalog = {
    version: 3,
    generated: '2026-07-29T00:00:00.000Z',
    items: [
      {
        photoId: 'photo_1234567890abcdef12345678',
        storyId: 'lost-coast',
        file: 'DSCF1250.jpg',
        albumTitle: 'Lost Coast',
        label: 'Fog coming over Punta Gorda.',
        previewSrc: '/media/photo-lost-coast.webp',
        priceCents: 4000,
        width: 6000,
        height: 4000,
      },
    ],
  };

  test('finds a listed item', () => {
    expect(catalogItem(catalog, 'photo_1234567890abcdef12345678')?.priceCents).toBe(4000);
  });

  test('returns nothing for a photo that is not for sale', () => {
    expect(catalogItem(catalog, 'photo_000000000000000000000000')).toBeUndefined();
  });
});
