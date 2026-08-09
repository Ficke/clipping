import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checksumBase64, ensureMaster, sha256Hex } from './photo-master.mjs';

const PHOTO_ID = 'photo_1234567890abcdef12345678';
const BUCKET = 'originals-test';

function file(contents) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-master-test-'));
  const target = path.join(directory, 'photo.jpg');
  writeFileSync(target, contents);
  return { target, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Stands in for the aws CLI. `existing` is the SHA-256 the bucket already holds
 * for this key, or undefined when the object is absent.
 */
function fakeAws(existing) {
  const calls = [];
  const aws = (args) => {
    calls.push(args);
    if (args[1] === 'head-object') {
      return existing
        ? { status: 0, stdout: `${checksumBase64(existing)}\n` }
        : { status: 1, stderr: 'An error occurred (404) when calling HeadObject: Not Found' };
    }
    return { status: 0, stdout: '' };
  };
  return { aws, calls, puts: () => calls.filter((args) => args[1] === 'put-object') };
}

describe('publishing a master', () => {
  test('uploads when the object is absent, with type, filename and provenance', () => {
    const { target, cleanup } = file('new bytes');
    const { aws, puts } = fakeAws(undefined);
    try {
      const result = ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'japan-24',
        filename: 'DSCF1.jpg', aws,
      });

      expect(result.action).toBe('uploaded');
      expect(result.key).toBe(`photos/${PHOTO_ID}`);
      const put = puts()[0].join(' ');
      expect(put).toContain('--content-type image/jpeg');
      expect(put).toContain(`attachment; filename="adam-ficke-${PHOTO_ID}.jpg"`);
      expect(put).toContain('album=japan-24,file=DSCF1.jpg');
      expect(put).toContain('--checksum-algorithm SHA256');
    } finally {
      cleanup();
    }
  });

  test('reuses an object whose checksum already matches, uploading nothing', () => {
    const { target, cleanup } = file('same bytes');
    const { aws, puts } = fakeAws(sha256Hex(target));
    try {
      expect(ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.jpg', aws,
      }).action).toBe('reused');
      expect(puts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  /* The guard that stands between a re-export and silently overwriting the
     master that everyone who already bought this photograph downloads. */
  test('refuses to overwrite different bytes without an explicit replace', () => {
    const { target, cleanup } = file('new bytes');
    const { aws, puts } = fakeAws('f'.repeat(64));
    try {
      const result = ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.jpg', aws,
      });

      expect(result.action).toBe('differs');
      expect(puts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('replaces those bytes once replace is passed', () => {
    const { target, cleanup } = file('new bytes');
    const { aws, puts } = fakeAws('f'.repeat(64));
    try {
      expect(ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.jpg',
        replace: true, aws,
      }).action).toBe('replaced');
      expect(puts()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test('a dry run inspects but never writes', () => {
    const { target, cleanup } = file('new bytes');
    const { aws, puts } = fakeAws(undefined);
    try {
      expect(ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.jpg',
        dryRun: true, aws,
      }).action).toBe('uploaded');
      expect(puts()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  /* A hash that does not describe the file would name the object after bytes it
     does not contain, and S3 would accept the mismatched checksum claim. */
  test('rejects a source hash that does not match the file', () => {
    const { target, cleanup } = file('new bytes');
    const { aws } = fakeAws(undefined);
    try {
      expect(() => ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.jpg',
        sourceHash: 'a'.repeat(64), aws,
      })).toThrow(/does not match expected hash/);
    } finally {
      cleanup();
    }
  });

  test('refuses an unsupported output format', () => {
    const { target, cleanup } = file('new bytes');
    const { aws } = fakeAws(undefined);
    try {
      expect(() => ensureMaster({
        bucket: BUCKET, file: target, photoId: PHOTO_ID, album: 'a', filename: 'x.tiff', aws,
      })).toThrow(/Unsupported file extension/);
    } finally {
      cleanup();
    }
  });

  test('refuses a malformed photo ID rather than building a stray key', () => {
    const { target, cleanup } = file('new bytes');
    const { aws } = fakeAws(undefined);
    try {
      expect(() => ensureMaster({
        bucket: BUCKET, file: target, photoId: '../escape', album: 'a', filename: 'x.jpg', aws,
      })).toThrow(/invalid photo ID/);
    } finally {
      cleanup();
    }
  });
});
