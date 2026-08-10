import { z } from 'zod';
import { isPhotoId, type PhotoId } from './ids';
import { photoFilenameSchema } from './media';

export const albumLifecycleStates = ['live', 'removed', 'deleted'] as const;
export type AlbumLifecycleState = (typeof albumLifecycleStates)[number];

export type PriceDollars = number;
export type PriceCents = number;

const priceDollarsSchema = z.number()
  .positive('price must be positive')
  .multipleOf(0.01, 'price must have at most two decimal places');

/**
 * Keep author-facing dollars at the album boundary; commerce uses integer
 * cents.
 */
export const albumPhotoSchema = z.object({
  file: photoFilenameSchema,
  photoId: z.string().refine(isPhotoId, 'must look like photo_<24 hex characters>'),
  caption: z.string().optional(),
  alt: z.string().optional(),
  priceDollars: priceDollarsSchema.optional(),
  removed: z.coerce.date().optional(),
  deleted: z.coerce.date().optional(),
}).superRefine((photo, context) => {
  if (photo.priceDollars !== undefined && photo.removed) {
    context.addIssue({ code: 'custom', path: ['priceDollars'], message: 'a removed photo cannot be for sale' });
  }
  if (photo.deleted && !photo.removed) {
    context.addIssue({ code: 'custom', path: ['deleted'], message: 'a photo must be removed before it is deleted' });
  }
});

export type AlbumPhoto = z.infer<typeof albumPhotoSchema>;

export const albumSchema = z.object({
  storyId: z.string().min(1),
  title: z.string().min(1),
  date: z.coerce.date(),
  published: z.coerce.date().optional(),
  location: z.string().min(1),
  photos: z.array(albumPhotoSchema).min(1),
  cover: z.string().refine(isPhotoId, 'must be a photo ID').optional(),
  description: z.string().optional(),
  draft: z.boolean().default(false),
});

/** Derive lifecycle from persisted fields instead of storing another flag. */
export function lifecycleOf(photo: Pick<AlbumPhoto, 'removed' | 'deleted'>): AlbumLifecycleState {
  if (photo.deleted) return 'deleted';
  if (photo.removed) return 'removed';
  return 'live';
}

export function priceCentsFromDollars(priceDollars: PriceDollars): PriceCents {
  const cents = Math.round(priceDollars * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('price must be a positive USD amount');
  return cents;
}

export function priceDollarsFromCents(priceCents: PriceCents): PriceDollars {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error('price cents must be a positive integer');
  return priceCents / 100;
}

export function isAlbumPhotoId(value: unknown): value is PhotoId {
  return isPhotoId(value);
}
