import { z } from 'zod';
import { isPhotoId } from './ids';

export const sourceHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 hash');
export const mediaProfileSchema = z.string().regex(
  /^[a-z0-9][a-z0-9-]*$/,
  'must contain lowercase letters, numbers, and hyphens',
);

export const shotMetadataSchema = z.object({
  camera: z.string().min(1).optional(),
  lens: z.string().min(1).optional(),
  focalLength: z.number().positive().finite().optional(),
  aperture: z.number().positive().finite().optional(),
  shutter: z.number().positive().finite().optional(),
  iso: z.number().positive().finite().optional(),
  capturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
});

export const photoVariantSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  src: z.string().startsWith('/media/'),
});

export const photoManifestEntrySchema = z.object({
  photoId: z.string().refine((value) => isPhotoId(value), 'must be a photo ID'),
  file: z.string().min(1),
  sourceHash: sourceHashSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  shot: shotMetadataSchema.optional(),
  variants: z.object({
    responsive: z.object({
      avif: z.array(photoVariantSchema).min(1),
      webp: z.array(photoVariantSchema).min(1),
      jpeg: z.array(photoVariantSchema).min(1),
    }),
    lightbox: photoVariantSchema,
    social: photoVariantSchema,
  }),
});

export const photoManifestSchema = z.object({
  version: z.literal(2),
  profile: mediaProfileSchema,
  /** Persisted name for storyId in the version 2 format. */
  album: z.string().min(1),
  photos: z.array(photoManifestEntrySchema),
}).superRefine((manifest, context) => {
  addDuplicateIssues(manifest.photos, 'photoId', context);
  addDuplicateIssues(manifest.photos, 'file', context);
});

export const sourceManifestPhotoSchema = z.object({
  photoId: z.string().refine((value) => isPhotoId(value), 'must be a photo ID'),
  file: z.string().min(1),
});

export const sourceManifestSchema = z.object({
  version: z.literal(1),
  /** Persisted name for storyId in the version 1 format. */
  album: z.string().min(1),
  photos: z.array(sourceManifestPhotoSchema),
}).superRefine((manifest, context) => {
  addDuplicateIssues(manifest.photos, 'photoId', context);
  addDuplicateIssues(manifest.photos, 'file', context);
});

export const metadataSidecarSchema = z.object({
  version: z.literal(1),
  /** Optional only for masters created before permanent photo IDs. */
  photoId: z.string().refine((value) => isPhotoId(value), 'must be a photo ID').optional(),
  file: z.string().min(1),
  shot: shotMetadataSchema.optional(),
  archive: z.record(z.string(), z.unknown()).optional(),
});

export type ShotMetadata = z.infer<typeof shotMetadataSchema>;
export type PhotoVariant = z.infer<typeof photoVariantSchema>;
export type PhotoManifestEntry = z.infer<typeof photoManifestEntrySchema>;
export type PhotoManifest = z.infer<typeof photoManifestSchema>;
export type SourceManifestPhoto = z.infer<typeof sourceManifestPhotoSchema>;
export type SourceManifest = z.infer<typeof sourceManifestSchema>;
export type MetadataSidecar = z.infer<typeof metadataSidecarSchema>;

export function parsePhotoManifest(input: unknown, source = 'photo manifest'): PhotoManifest {
  return parse(photoManifestSchema, input, source);
}

export function parseSourceManifest(input: unknown, source = 'source manifest'): SourceManifest {
  return parse(sourceManifestSchema, input, source);
}

export function parseMetadataSidecar(input: unknown, source = 'metadata sidecar'): MetadataSidecar {
  return parse(metadataSidecarSchema, input, source);
}

export function isSourceHash(value: unknown): value is string {
  return sourceHashSchema.safeParse(value).success;
}

export function isMediaProfile(value: unknown): value is string {
  return mediaProfileSchema.safeParse(value).success;
}

function parse<T>(schema: z.ZodType<T>, input: unknown, source: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
    .join('; ');
  throw new Error(`${source} is invalid (${details})`);
}

function addDuplicateIssues<T extends Record<K, string>, K extends keyof T & string>(
  values: readonly T[],
  key: K,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value[key])) {
      context.addIssue({
        code: 'custom',
        path: ['photos', index, key],
        message: `duplicates ${key} ${value[key]}`,
      });
    }
    seen.add(value[key]);
  }
}
