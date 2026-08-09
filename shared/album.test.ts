import { describe, expect, test } from 'bun:test';
import {
  albumPhotoSchema,
  lifecycleOf,
  priceCentsFromDollars,
  priceDollarsFromCents,
} from './album';

const photo = { file: 'photo.jpg', photoId: 'photo_aaaaaaaaaaaaaaaaaaaaaaaa' };

describe('album contracts', () => {
  test('uses one lifecycle derived from the persisted removal dates', () => {
    expect(lifecycleOf({ removed: undefined, deleted: undefined })).toBe('live');
    expect(lifecycleOf({ ...photo, removed: new Date('2026-01-01') })).toBe('removed');
    expect(lifecycleOf({ ...photo, removed: new Date('2026-01-01'), deleted: new Date('2026-01-02') })).toBe('deleted');
  });

  test('rejects impossible lifecycle and sale combinations', () => {
    expect(albumPhotoSchema.safeParse({ ...photo, priceDollars: 40, removed: '2026-01-01' }).success).toBe(false);
    expect(albumPhotoSchema.safeParse({ ...photo, deleted: '2026-01-02' }).success).toBe(false);
  });

  test('converts authored dollars to durable cents without float leakage', () => {
    expect(priceCentsFromDollars(39.5)).toBe(3950);
    expect(priceDollarsFromCents(3950)).toBe(39.5);
  });
});
