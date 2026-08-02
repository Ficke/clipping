import { describe, expect, test } from 'bun:test';
import { errorCategory, hashIdentifier } from './logging';

describe('commerce logging', () => {
  test('hashes identifiers deterministically without retaining the input', () => {
    const identifier = 'cs_test_bearer_capability';
    const hashed = hashIdentifier(identifier);
    expect(hashed).toHaveLength(16);
    expect(hashed).not.toContain(identifier);
    expect(hashIdentifier(identifier)).toBe(hashed);
  });

  test('reduces errors to a category rather than serializing details', () => {
    expect(errorCategory(new TypeError('contains a secret'))).toBe('TypeError');
    expect(errorCategory('contains a secret')).toBe('UnknownError');
  });
});
