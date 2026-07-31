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

/** Only this deliberately small, non-sensitive summary reaches the gallery. */
export async function exifSummary(file) {
  try {
    const exif = await exifr.parse(file, ['Model', 'FNumber', 'FocalLength', 'ExposureTime', 'ISO']);
    if (!exif) return undefined;
    const parts = [];
    if (exif.Model) parts.push(String(exif.Model).trim());
    if (exif.FocalLength) parts.push(`${Math.round(exif.FocalLength)}mm`);
    if (exif.FNumber) parts.push(`f/${exif.FNumber}`);
    if (exif.ExposureTime) parts.push(formatShutter(exif.ExposureTime));
    if (exif.ISO) parts.push(`ISO ${exif.ISO}`);
    return parts.length ? parts.join(' · ') : undefined;
  } catch {
    return undefined;
  }
}

function formatShutter(seconds) {
  if (seconds >= 1) return `${seconds}s`;
  return `1/${Math.round(1 / seconds)}s`;
}
