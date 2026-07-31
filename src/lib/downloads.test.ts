import { describe, expect, test } from 'bun:test';
import {
  catalogItem,
  formatPrice,
  licenseTerms,
  licenseTier,
  originalKey,
  parseSku,
  skuFor,
  type DownloadCatalog,
} from './downloads';

describe('license tiers', () => {
  test('every tier has a price, a summary, and both halves of the grant', () => {
    for (const tier of [licenseTier('personal')!]) {
      expect(tier.priceCents).toBeGreaterThan(0);
      expect(tier.summary.length).toBeGreaterThan(0);
      expect(tier.grants.length).toBeGreaterThan(0);
      expect(tier.restrictions.length).toBeGreaterThan(0);
    }
  });

  test('licenseTerms states both halves and who holds the copyright', () => {
    const terms = licenseTerms(licenseTier('personal')!);

    expect(terms).toContain('You may keep the file');
    expect(terms).toContain('You may not sell');
    expect(terms).toContain('Copyright stays with Adam Ficke.');
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

describe('SKUs', () => {
  test('round-trip', () => {
    const parts = { storyId: 'lost-coast', file: 'DSCF1250.jpg', license: 'personal' };
    expect(parseSku(skuFor(parts))).toEqual(parts);
  });

  test('accepts the apostrophes and digits real album ids carry', () => {
    const parts = { storyId: 'japan-24', file: "roll-'01.jpg", license: 'personal' };
    expect(parseSku(skuFor(parts))).toEqual(parts);
  });

  test('refuses a segment that would break the encoding', () => {
    expect(() => skuFor({ storyId: 'a/b', file: 'x.jpg', license: 'personal' })).toThrow(/safe path segment/);
    expect(() => skuFor({ storyId: 'ok', file: 'has space.jpg', license: 'personal' })).toThrow(/safe path segment/);
  });

  test('rejects a malformed SKU rather than guessing', () => {
    expect(() => parseSku('lost-coast/DSCF1250.jpg')).toThrow(/expected storyId/);
    expect(() => parseSku('a/b/c/d')).toThrow(/expected storyId/);
    expect(() => parseSku('../etc/personal')).toThrow(/safe path segment/);
  });

  test('a SKU cannot escape the album prefix in S3', () => {
    expect(originalKey({ storyId: 'lost-coast', file: 'DSCF1250.jpg' }))
      .toBe('albums/lost-coast/DSCF1250.jpg');
  });
});

describe('catalog lookup', () => {
  const catalog: DownloadCatalog = {
    version: 1,
    generated: '2026-07-29T00:00:00.000Z',
    items: [
      {
        sku: 'lost-coast/DSCF1250.jpg/personal',
        storyId: 'lost-coast',
        file: 'DSCF1250.jpg',
        license: 'personal',
        albumTitle: 'Lost Coast',
        label: 'Fog coming over Punta Gorda.',
        priceCents: 4000,
        width: 6000,
        height: 4000,
      },
    ],
  };

  test('finds a listed item', () => {
    expect(catalogItem(catalog, 'lost-coast/DSCF1250.jpg/personal')?.priceCents).toBe(4000);
  });

  test('returns nothing for a photo that is not for sale', () => {
    expect(catalogItem(catalog, 'lost-coast/DSCF1234.jpg/personal')).toBeUndefined();
  });
});
