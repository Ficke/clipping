import { isSourceHash } from '../shared/media';

export type DerivativeRole = 'responsive' | 'lightbox' | 'social';
export type DerivativeFormat = 'avif' | 'webp' | 'jpeg';

export interface DerivativeDefinition {
  role: DerivativeRole;
  format: DerivativeFormat;
  width: number;
  quality: number;
  mozjpeg: boolean;
}

export const photoProfile = {
  version: 'photo-v1',
  responsiveWidths: [640, 1080, 1600, 2000],
  formats: {
    avif: { quality: 60, mozjpeg: false },
    webp: { quality: 80, mozjpeg: false },
    jpeg: { quality: 85, mozjpeg: true },
  },
  lightbox: { width: 2000, format: 'webp', quality: 90, mozjpeg: false },
  social: { width: 1200, format: 'jpeg', quality: 85, mozjpeg: true },
} as const;

const RESPONSIVE_FORMATS = ['avif', 'webp', 'jpeg'] as const;

export function derivativeDefinitions(sourceWidth: number): DerivativeDefinition[] {
  if (!Number.isInteger(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Source width must be a positive integer');
  }
  const definitions: DerivativeDefinition[] = [];

  for (const requestedWidth of photoProfile.responsiveWidths) {
    const width = Math.min(requestedWidth, sourceWidth);
    for (const format of RESPONSIVE_FORMATS) {
      const options = photoProfile.formats[format];
      definitions.push({
        role: 'responsive',
        format,
        width,
        quality: options.quality,
        mozjpeg: options.mozjpeg,
      });
    }
  }

  definitions.push({
    role: 'lightbox',
    format: photoProfile.lightbox.format,
    width: Math.min(photoProfile.lightbox.width, sourceWidth),
    quality: photoProfile.lightbox.quality,
    mozjpeg: photoProfile.lightbox.mozjpeg,
  });
  definitions.push({
    role: 'social',
    format: photoProfile.social.format,
    width: Math.min(photoProfile.social.width, sourceWidth),
    quality: photoProfile.social.quality,
    mozjpeg: photoProfile.social.mozjpeg,
  });

  const unique = new Map<string, DerivativeDefinition>();
  for (const definition of definitions) {
    unique.set(variantName(definition), definition);
  }
  return [...unique.values()];
}

export function variantName(definition: DerivativeDefinition): string {
  const extension = definition.format === 'jpeg' ? 'jpg' : definition.format;
  return `${definition.role}-${definition.width}-q${definition.quality}.${extension}`;
}

export function derivativeKey(sourceHash: string, definition: DerivativeDefinition): string {
  if (!isSourceHash(sourceHash)) throw new Error('Cannot build a derivative key from an invalid source hash');
  return `media/${photoProfile.version}/${sourceHash.slice(0, 2)}/${sourceHash}/${variantName(definition)}`;
}

export function derivativeUrl(sourceHash: string, definition: DerivativeDefinition): string {
  return `/${derivativeKey(sourceHash, definition)}`;
}

export function scaledHeight(sourceWidth: number, sourceHeight: number, targetWidth: number): number {
  if (![sourceWidth, sourceHeight, targetWidth].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('Image dimensions must be positive integers');
  }
  return Math.max(1, Math.round((sourceHeight * targetWidth) / sourceWidth));
}
