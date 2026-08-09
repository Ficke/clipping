import { describe, expect, test } from 'bun:test';
import {
  derivativeDefinitions,
  derivativeKey,
  photoProfile,
  scaledHeight,
} from './photo-profile';

describe('photo profile', () => {
  test('defines stable responsive, lightbox, and social variants', () => {
    const definitions = derivativeDefinitions(6000);
    expect(definitions).toHaveLength(14);
    expect(definitions.filter((definition) => definition.role === 'responsive')).toHaveLength(12);
    expect(definitions.find((definition) => definition.role === 'lightbox')).toMatchObject({
      width: 2000,
      format: 'webp',
      quality: 90,
    });
    expect(definitions.find((definition) => definition.role === 'social')).toMatchObject({
      width: 1200,
      format: 'jpeg',
      quality: 85,
    });
  });

  test('does not create duplicate upscaled variants', () => {
    const definitions = derivativeDefinitions(500);
    expect(definitions).toHaveLength(5);
    expect(definitions.every((definition) => definition.width === 500)).toBe(true);
  });

  test('uses immutable content-addressed keys', () => {
    const definition = derivativeDefinitions(6000)[0]!;
    const hash = 'ab'.repeat(32);
    expect(derivativeKey(hash, definition)).toBe(
      `media/${photoProfile.version}/ab/${hash}/responsive-640-q60.avif`,
    );
    expect(() => derivativeKey('short', definition)).toThrow(/invalid source hash/);
  });

  test('preserves aspect ratio and rejects invalid dimensions', () => {
    expect(scaledHeight(6000, 4000, 1200)).toBe(800);
    expect(() => scaledHeight(0, 4000, 1200)).toThrow(/positive integers/);
  });
});
