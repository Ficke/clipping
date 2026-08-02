import { describe, expect, test } from 'bun:test';
import { downloadFilename } from './download';

describe('download attachment name', () => {
  test('uses only the opaque photo ID and preserves the file type', () => {
    const name = downloadFilename({
      photoId: 'photo_3bb6020b3147d062d1f528ce',
      assetRef: `${'ab'.repeat(32)}.jpg`,
    });

    expect(name).toBe('adam-ficke-photo_3bb6020b3147d062d1f528ce.jpg');
    expect(name).not.toContain('Olympics');
    expect(name).not.toContain('DSCF7640');
  });
});
