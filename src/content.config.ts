import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { albumSchema } from '../shared/album';

const albums = defineCollection({
  loader: glob({ pattern: '*/index.md', base: './content/albums' }),
  // Markdown keeps the established `price:` key; normalize it at the boundary.
  schema: z.preprocess((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const album = input as Record<string, unknown>;
    const photos = Array.isArray(album.photos)
      ? album.photos.map((photo) => {
        if (!photo || typeof photo !== 'object' || Array.isArray(photo)) return photo;
        const entry = photo as Record<string, unknown>;
        const { price, ...rest } = entry;
        return price === undefined ? rest : { ...rest, priceDollars: price };
      })
      : album.photos;
    return { ...album, photos };
  }, albumSchema),
});

export const collections = { albums };
