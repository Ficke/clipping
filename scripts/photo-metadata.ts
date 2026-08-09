import exifr from 'exifr';
import type { ExifTool } from 'exiftool-vendored';
import type { ShotMetadata } from '../shared/media';

/**
 * The only descriptive metadata allowed to survive into a purchased file.
 * ColorSpaceTags preserves the minimum EXIF color-space fields ExifTool needs
 * when there is no embedded profile; ICC_Profile preserves an embedded profile.
 */
export const fulfillmentMetadataRetain = [
  'ICC_Profile:All',
  'ColorSpaceTags',
  'Copyright',
  'CopyrightNotice',
  'Rights',
  'UsageTerms',
  'WebStatement',
  'Artist',
  'Creator',
  'By-line',
  'Credit',
  'Source',
  'CreatorContactInfo',
  'Licensor',
  'OwnerName',
];

const shotTags = [
  'Model', 'LensModel', 'FNumber', 'FocalLength', 'ExposureTime', 'ISO',
  'DateTimeOriginal', 'CreateDate',
];

/**
 * Only this deliberately small, non-sensitive subset reaches the gallery. Kept
 * as fields rather than a rendered string so the site can format or filter on
 * them; `formatShot` in src/lib/photo-manifest.ts does the rendering.
 */
export async function shotMetadata(file: string): Promise<ShotMetadata | undefined> {
  let exif: Record<string, unknown> | undefined;
  try {
    exif = await exifr.parse(file, shotTags);
  } catch {
    return undefined;
  }
  if (!exif) return undefined;

  const shot: ShotMetadata = {};
  if (exif.Model) shot.camera = String(exif.Model).trim();
  if (exif.LensModel) shot.lens = String(exif.LensModel).trim();
  if (typeof exif.FocalLength === 'number' && Number.isFinite(exif.FocalLength)) shot.focalLength = exif.FocalLength;
  if (typeof exif.FNumber === 'number' && Number.isFinite(exif.FNumber)) shot.aperture = exif.FNumber;
  if (typeof exif.ExposureTime === 'number' && Number.isFinite(exif.ExposureTime)) shot.shutter = exif.ExposureTime;
  if (typeof exif.ISO === 'number' && Number.isFinite(exif.ISO)) shot.iso = exif.ISO;
  const capturedAt = captureDate(exif.DateTimeOriginal ?? exif.CreateDate);
  if (capturedAt) shot.capturedAt = capturedAt;

  return Object.keys(shot).length ? shot : undefined;
}

/**
 * EXIF timestamps are wall-clock at the camera with no zone; exifr returns them
 * as UTC. Read them back in UTC so the date does not shift westward.
 */
export function captureDate(value: unknown): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return undefined;
  return value.toISOString().slice(0, 10);
}

const skippedTags = /^(SourceFile|errors|warnings|Directory|File[A-Z])/;
const binaryTags = /(ThumbnailImage|PreviewImage|JpgFromRaw|OtherImage)$/;

/**
 * Everything the file carries, for the archive sidecar — including GPS, which
 * is why sidecars live under their own S3 prefix and never enter git. Binary
 * payloads are dropped: they are large, and a JSON dump cannot round-trip them.
 *
 * exiftool-vendored returns timestamps as ExifDateTime rather than Date, so
 * they have to be serialized explicitly. Dropping every non-Date object would
 * silently lose DateTimeOriginal, an essential archive field.
 */
export async function archiveMetadata(exiftool: ExifTool, file: string): Promise<Record<string, unknown>> {
  const tags = await exiftool.read(file);
  const kept = Object.entries(tags)
    .filter(([key]) => !skippedTags.test(key) && !binaryTags.test(key))
    .map(([key, value]): [string, unknown] => [key, serializeTag(value)])
    .filter(([, value]) => value !== undefined);
  return Object.fromEntries(kept.sort(([left], [right]) => left.localeCompare(right)));
}

function serializeTag(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(serializeTag);
  if ('toISOString' in value && typeof value.toISOString === 'function') return value.toISOString();
  if (ArrayBuffer.isView(value)) return undefined;
  // ExifDate and ExifTime carry no toISOString; their toString is the tag value.
  if (value.constructor !== Object) return String(value);
  return value;
}
