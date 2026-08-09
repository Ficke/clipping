import type { PhotoManifestEntry, PhotoVariant, ShotMetadata } from '../../shared/media';

export type {
  PhotoManifest,
  PhotoManifestEntry,
  PhotoVariant,
  ShotMetadata,
} from '../../shared/media';

export function srcset(variants: PhotoVariant[]): string {
  return variants.map((variant) => `${variant.src} ${variant.width}w`).join(', ');
}

/** `X-T4 · 35mm · f/2 · 1/500s · ISO 400`, omitting whatever the file lacks. */
export function formatShot(shot: ShotMetadata | undefined): string | undefined {
  if (!shot) return undefined;
  const parts = [
    shot.camera,
    shot.focalLength !== undefined && `${Math.round(shot.focalLength)}mm`,
    shot.aperture !== undefined && `f/${shot.aperture}`,
    shot.shutter !== undefined && formatShutter(shot.shutter),
    shot.iso !== undefined && `ISO ${shot.iso}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(' · ') : undefined;
}

function formatShutter(seconds: number): string {
  return seconds >= 1 ? `${seconds}s` : `1/${Math.round(1 / seconds)}s`;
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
