import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const albums = defineCollection({
  loader: glob({ pattern: '*/index.md', base: './content/albums' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    cover: z.string(),
    order: z.array(z.string()).optional(),
    description: z.string().optional(),
    captions: z.record(z.string(), z.string()).default({}),
    draft: z.boolean().default(false),
  }),
});

export const collections = { albums };
