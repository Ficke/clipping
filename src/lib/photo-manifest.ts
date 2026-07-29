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

/**
 * Srcset for the lightbox image. The narrow slots reuse the responsive WebP
 * ladder — bytes the page has usually already fetched — while the widest slot
 * stays the dedicated high-quality lightbox encode, so large displays get the
 * same file they always have.
 */
export function lightboxSrcset(photo: PhotoManifestEntry): string {
  const { lightbox, responsive } = photo.variants;
  const narrower = responsive.webp.filter((variant) => variant.width < lightbox.width);
  return srcset([...narrower, lightbox]);
}

export function largestVariant(variants: PhotoVariant[]): PhotoVariant {
  const variant = variants.at(-1);
  if (!variant) throw new Error('Photo manifest has no responsive variants');
  return variant;
}
