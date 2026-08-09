import exifr from 'exifr';

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
export async function shotMetadata(file) {
  let exif;
  try {
    exif = await exifr.parse(file, shotTags);
  } catch {
    return undefined;
  }
  if (!exif) return undefined;

  const shot = {};
  if (exif.Model) shot.camera = String(exif.Model).trim();
  if (exif.LensModel) shot.lens = String(exif.LensModel).trim();
  if (Number.isFinite(exif.FocalLength)) shot.focalLength = exif.FocalLength;
  if (Number.isFinite(exif.FNumber)) shot.aperture = exif.FNumber;
  if (Number.isFinite(exif.ExposureTime)) shot.shutter = exif.ExposureTime;
  if (Number.isFinite(exif.ISO)) shot.iso = exif.ISO;
  const capturedAt = captureDate(exif.DateTimeOriginal ?? exif.CreateDate);
  if (capturedAt) shot.capturedAt = capturedAt;

  return Object.keys(shot).length ? shot : undefined;
}

/**
 * EXIF timestamps are wall-clock at the camera with no zone; exifr returns them
 * as UTC. Read them back in UTC so the date does not shift westward.
 */
export function captureDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) return undefined;
  return value.toISOString().slice(0, 10);
}

/**
 * Everything the file carries, for the archive sidecar — including GPS, which
 * is why sidecars live under their own S3 prefix and never enter git. Binary
 * payloads are dropped: they are large, and a JSON dump cannot round-trip them.
 */
export async function archiveMetadata(exiftool, file) {
  const tags = await exiftool.read(file);
  const kept = Object.entries(tags).filter(([key, value]) => {
    if (key === 'SourceFile' || key === 'errors' || key === 'warnings') return false;
    if (key.startsWith('Directory') || key.startsWith('File')) return false;
    return typeof value !== 'object' || value instanceof Date || Array.isArray(value);
  });
  return Object.fromEntries(kept.sort(([left], [right]) => left.localeCompare(right)));
}
