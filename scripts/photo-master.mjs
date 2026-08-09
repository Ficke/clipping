import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  contentTypeFor,
  downloadFilename,
  masterKey,
  metadataKey,
  normalizeExtension,
} from '../src/lib/downloads.ts';

const missingObject = /404|NoSuchKey|Not Found|does not exist/i;

export function sha256Hex(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function checksumBase64(sourceHash) {
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid SHA-256 source hash');
  return Buffer.from(sourceHash, 'hex').toString('base64');
}

/**
 * Publish the one master for a photograph.
 *
 * The key is the photo ID, not a content hash, so re-exporting a photograph
 * overwrites in place and every already-issued download link starts serving the
 * new bytes. Replacing is therefore a real decision: this reports `differs` and
 * leaves the object alone unless the caller passes `replace`. Bucket versioning
 * is the undo.
 *
 * `Content-Type` and `Content-Disposition` are stored on the object because the
 * key carries no extension for the download Lambda to derive them from.
 */
export function ensureMaster({
  bucket,
  file,
  photoId,
  album,
  filename,
  sourceHash = sha256Hex(file),
  replace = false,
  dryRun = false,
  aws = runAws,
}) {
  const actualHash = sha256Hex(file);
  if (actualHash !== sourceHash) {
    throw new Error(`Sanitized file hash ${actualHash} does not match expected hash ${sourceHash}`);
  }

  const key = masterKey(photoId);
  const expectedChecksum = checksumBase64(sourceHash);
  const existing = headChecksum(bucket, key, aws);
  if (existing.found) {
    if (existing.checksum === expectedChecksum) return { photoId, key, action: 'reused' };
    if (!replace) return { photoId, key, action: 'differs', existing: existing.checksum };
  }
  if (dryRun) return { photoId, key, action: existing.found ? 'replaced' : 'uploaded' };

  const extension = normalizeExtension(filename ?? file);
  const uploaded = aws([
    's3api', 'put-object',
    '--bucket', bucket,
    '--key', key,
    '--body', file,
    '--checksum-algorithm', 'SHA256',
    '--checksum-sha256', expectedChecksum,
    '--content-type', contentTypeFor(extension),
    '--content-disposition', `attachment; filename="${downloadFilename(photoId, extension)}"`,
    '--metadata', `album=${album},file=${filename ?? ''}`,
  ]);
  if (uploaded.error) throw new Error(`Could not run aws: ${uploaded.error.message}`);
  if (uploaded.status !== 0) {
    throw new Error((uploaded.stderr ?? '').trim() || `Could not upload s3://${bucket}/${key}`);
  }

  // S3 validates ChecksumSHA256 during PutObject, so a successful response is
  // the authoritative verification for the object just written.
  return { photoId, key, action: existing.found ? 'replaced' : 'uploaded' };
}

export function putSidecar({ bucket, photoId, body, dryRun = false, aws = runAws }) {
  const key = metadataKey(photoId);
  if (dryRun) return { key, action: 'skipped' };
  const result = aws([
    's3api', 'put-object',
    '--bucket', bucket,
    '--key', key,
    '--body', body,
    '--content-type', 'application/json',
  ]);
  if (result.error) throw new Error(`Could not run aws: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || `Could not upload s3://${bucket}/${key}`);
  }
  return { key, action: 'uploaded' };
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

function runAws(args) {
  return spawnSync('aws', args, { encoding: 'utf8' });
}
