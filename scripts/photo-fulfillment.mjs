import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assetRefFor, fulfillmentKey } from '../src/lib/downloads.ts';

const missingObject = /404|NoSuchKey|Not Found|does not exist/i;
const preconditionFailed = /412|PreconditionFailed|precondition/i;

export function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function checksumBase64(sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid SHA-256 source hash');
  return Buffer.from(sourceHash, 'hex').toString('base64');
}

/**
 * Publish a sanitized file without ever replacing an existing key. Existing
 * objects are reusable only when S3 reports the exact expected SHA-256.
 */
export function ensureFulfillmentAsset({
  bucket,
  file,
  sourceHash,
  dryRun = false,
  aws = runAws,
}) {
  const actualHash = sha256Hex(file);
  if (actualHash !== sourceHash) {
    throw new Error(`Sanitized file hash ${actualHash} does not match manifest hash ${sourceHash}`);
  }

  const assetRef = assetRefFor(sourceHash, file);
  const key = fulfillmentKey(assetRef);
  const expectedChecksum = checksumBase64(sourceHash);
  const existing = headChecksum(bucket, key, aws);
  if (existing.found) {
    assertChecksum(key, existing.checksum, expectedChecksum);
    return { assetRef, key, action: 'reused' };
  }

  if (dryRun) return { assetRef, key, action: 'missing' };

  const uploaded = aws([
    's3api', 'put-object',
    '--bucket', bucket,
    '--key', key,
    '--body', file,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', expectedChecksum,
    '--if-none-match', '*',
  ]);
  if (uploaded.error) throw new Error(`Could not run aws: ${uploaded.error.message}`);
  if (uploaded.status !== 0) {
    // Another publisher can win between HEAD and the conditional PUT. Reuse
    // only after applying the same checksum verification as the normal path.
    if (preconditionFailed.test(uploaded.stderr ?? '')) {
      const raced = headChecksum(bucket, key, aws);
      if (raced.found) {
        assertChecksum(key, raced.checksum, expectedChecksum);
        return { assetRef, key, action: 'reused' };
      }
    }
    throw new Error((uploaded.stderr ?? '').trim() || `Could not upload s3://${bucket}/${key}`);
  }

  // S3 validates ChecksumSHA256 during PutObject; a successful response is the
  // authoritative verification for the newly created object.
  return { assetRef, key, action: 'uploaded' };
}

function headChecksum(bucket, key, aws) {
  const result = aws([
    's3api', 'head-object',
    '--bucket', bucket,
    '--key', key,
    '--checksum-mode', 'ENABLED',
    '--query', 'ChecksumSHA256',
    '--output', 'text',
  ]);
  if (result.error) throw new Error(`Could not run aws: ${result.error.message}`);
  if (result.status === 0) return { found: true, checksum: (result.stdout ?? '').trim() };
  if (missingObject.test(result.stderr ?? '')) return { found: false };
  throw new Error((result.stderr ?? '').trim() || `Could not inspect s3://${bucket}/${key}`);
}

function assertChecksum(key, actual, expected) {
  if (actual !== expected) {
    const detail = !actual || actual === 'None' ? 'has no SHA-256 checksum' : 'has a different SHA-256 checksum';
    throw new Error(`Refusing to reuse fulfillment/${key.split('/').at(-1)}: existing object ${detail}`);
  }
}

function runAws(args) {
  return spawnSync('aws', args, { encoding: 'utf8' });
}
