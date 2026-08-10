import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolvePhotoDestination } from './photo-path';

describe('photo destinations', () => {
  test('resolves supported photo basenames inside the requested directory', () => {
    const directory = path.resolve('/tmp', 'photo-destination-test');
    expect(resolvePhotoDestination(directory, 'fog.JPG')).toBe(path.join(directory, 'fog.JPG'));
  });

  test.each([
    '../escape.jpg',
    'nested/escape.jpg',
    String.raw`nested\escape.jpg`,
    'photo..jpg',
    'photo.tiff',
  ])('rejects unsafe or unsupported filename %s', (file) => {
    expect(() => resolvePhotoDestination('/tmp/photos', file)).toThrow(/Unsafe photo filename/);
  });
});
