export interface PhotoVariant {
  width: number;
  height: number;
  src: string;
}

export interface PhotoManifestEntry {
  file: string;
  sourceHash: string;
  width: number;
  height: number;
  exif?: string;
  variants: {
    responsive: {
      avif: PhotoVariant[];
      webp: PhotoVariant[];
      jpeg: PhotoVariant[];
    };
    lightbox: PhotoVariant;
    social: PhotoVariant;
  };
}

export interface PhotoManifest {
  version: 1;
  profile: string;
  album: string;
  photos: PhotoManifestEntry[];
}

export function srcset(variants: PhotoVariant[]): string {
  return variants.map((variant) => `${variant.src} ${variant.width}w`).join(', ');
}

export function largestVariant(variants: PhotoVariant[]): PhotoVariant {
  const variant = variants.at(-1);
  if (!variant) throw new Error('Photo manifest has no responsive variants');
  return variant;
}
