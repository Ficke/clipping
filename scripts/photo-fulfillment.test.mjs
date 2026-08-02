import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checksumBase64, ensureFulfillmentAsset } from './photo-fulfillment.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(extension = 'jpg') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'photo-fulfillment-test-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, `photo.${extension}`);
  writeFileSync(file, 'sanitized bytes');
  const sourceHash = createHash('sha256').update('sanitized bytes').digest('hex');
  return { file, sourceHash, checksum: checksumBase64(sourceHash) };
}

describe('immutable fulfillment publishing', () => {
  test('reuses an existing object only when its SHA-256 matches', () => {
    const { file, sourceHash, checksum } = fixture('JPG');
    const calls = [];
    const result = ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash,
      aws(args) {
        calls.push(args);
        return { status: 0, stdout: `${checksum}\n`, stderr: '' };
      },
    });

    expect(result).toEqual({
      assetRef: `${sourceHash}.jpg`,
      key: `fulfillment/${sourceHash}.jpg`,
      action: 'reused',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('head-object');
  });

  test('refuses a mismatched existing object without uploading', () => {
    const { file, sourceHash } = fixture();
    const calls = [];
    expect(() => ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash,
      aws(args) {
        calls.push(args);
        return { status: 0, stdout: checksumBase64('0'.repeat(64)), stderr: '' };
      },
    })).toThrow(/different SHA-256 checksum/);
    expect(calls).toHaveLength(1);
  });

  test('refuses local bytes that do not match the committed source hash', () => {
    const { file } = fixture();
    let called = false;
    expect(() => ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash: '0'.repeat(64),
      aws() { called = true; return { status: 0, stdout: '', stderr: '' }; },
    })).toThrow(/does not match manifest hash/);
    expect(called).toBe(false);
  });

  test('uploads a missing object conditionally and verifies it', () => {
    const { file, sourceHash, checksum } = fixture();
    const calls = [];
    const result = ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash,
      aws(args) {
        calls.push(args);
        if (args.includes('head-object')) {
          return { status: 1, stdout: '', stderr: 'An error occurred (404): Not Found' };
        }
        if (args.includes('put-object')) return { status: 0, stdout: '{}', stderr: '' };
        return { status: 0, stdout: checksum, stderr: '' };
      },
    });

    expect(result.action).toBe('uploaded');
    const put = calls.find((args) => args.includes('put-object'));
    expect(put).toContain('--if-none-match');
    expect(put).toContain('--checksum-sha256');
  });

  test('surfaces upload failures and dry-run reports missing without writing', () => {
    const { file, sourceHash } = fixture();
    const missing = { status: 1, stdout: '', stderr: 'NoSuchKey' };
    const dryCalls = [];
    expect(ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash, dryRun: true,
      aws(args) { dryCalls.push(args); return missing; },
    }).action).toBe('missing');
    expect(dryCalls).toHaveLength(1);

    expect(() => ensureFulfillmentAsset({
      bucket: 'originals', file, sourceHash,
      aws(args) {
        return args.includes('head-object') ? missing : { status: 1, stdout: '', stderr: 'AccessDenied' };
      },
    })).toThrow(/AccessDenied/);
  });
});
