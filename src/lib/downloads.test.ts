import { describe, expect, test } from 'bun:test';
import {
  catalogItem,
  formatPrice,
  licenseTerms,
  licenseTier,
  isPhotoId,
  originalKey,
  photoIdFor,
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
  test('derives one opaque ID from a source hash', () => {
    const id = photoIdFor('ab'.repeat(32));
    expect(id).toBe('photo_abababababababababababab');
    expect(isPhotoId(id)).toBe(true);
    expect(id).not.toContain('lost-coast');
  });

  test('rejects anything other than a full SHA-256 source hash', () => {
    expect(() => photoIdFor('lost-coast/DSCF1250.jpg')).toThrow(/invalid source hash/);
    expect(isPhotoId('photo_not-a-hash')).toBe(false);
  });

  test('the private catalog—not the ID—determines the S3 path', () => {
    expect(originalKey({ storyId: 'lost-coast', file: 'DSCF1250.jpg' }))
      .toBe('albums/lost-coast/DSCF1250.jpg');
  });
});

describe('catalog lookup', () => {
  const catalog: DownloadCatalog = {
    version: 2,
    generated: '2026-07-29T00:00:00.000Z',
    items: [
      {
        photoId: 'photo_1234567890abcdef12345678',
        storyId: 'lost-coast',
        file: 'DSCF1250.jpg',
        forSale: true,
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
